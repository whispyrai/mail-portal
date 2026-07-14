import type { Env } from "../types.ts";
import {
	LiveReadAuthorizationError,
	LiveReadAuthorizationUnavailableError,
	runLiveAuthorizedRead,
} from "./live-authorized-read.ts";
import { hasExactLiveMailboxAccess } from "./live-mailbox-authorization.ts";

export type AgentFrameAccessDependencies = {
	hasExactAccess(
		env: Env,
		mailboxId: string,
		userId: string,
		sessionVersion: number,
	): Promise<boolean>;
};

type AgentOutputMessage = string | ArrayBuffer | ArrayBufferView;

const AGENT_ADMISSION_OUTPUT_LIMITS = {
	maxMessages: 64,
	maxBytes: 256 * 1024,
} as const;

function agentOutputMessageBytes(message: AgentOutputMessage): number {
	return typeof message === "string"
		? new TextEncoder().encode(message).byteLength
		: message.byteLength;
}

export function quarantineAgentOutput(connection: {
	send(message: AgentOutputMessage): void;
}): { release(): void; discard(): void } {
	const ownDescriptor = Object.getOwnPropertyDescriptor(connection, "send");
	const send = connection.send.bind(connection);
	const pending: AgentOutputMessage[] = [];
	let pendingBytes = 0;
	let restored = false;
	Object.defineProperty(connection, "send", {
		configurable: true,
		writable: true,
		value: (message: AgentOutputMessage) => {
			pendingBytes += agentOutputMessageBytes(message);
			if (
				pending.length >= AGENT_ADMISSION_OUTPUT_LIMITS.maxMessages ||
				pendingBytes > AGENT_ADMISSION_OUTPUT_LIMITS.maxBytes
			) {
				throw new Error("Agent admission output exceeded its safe bound");
			}
			pending.push(message);
		},
	});
	const restore = () => {
		if (restored) return;
		restored = true;
		if (ownDescriptor) Object.defineProperty(connection, "send", ownDescriptor);
		else delete (connection as { send?: unknown }).send;
	};
	return {
		release() {
			restore();
			for (const message of pending.splice(0)) send(message);
		},
		discard() {
			restore();
			pending.length = 0;
		},
	};
}

const productionDependencies: AgentFrameAccessDependencies = {
	hasExactAccess: hasExactLiveMailboxAccess,
};

export function parseBoundSessionVersion(value: string | null): number | undefined {
	if (value === null) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function agentActorTag(userId: string): string {
	return `actor:${userId}`;
}

export function unauthorizedAgentConnectionIds(
	connections: Iterable<{
		id: string;
		state: { liveAuthorized?: boolean } | null;
	}>,
	alreadyExcluded: readonly string[] = [],
): string[] {
	const excluded = new Set(alreadyExcluded);
	for (const connection of connections) {
		if (connection.state?.liveAuthorized !== true) excluded.add(connection.id);
	}
	return [...excluded];
}

export function agentConnectionIdsToReconcile(
	connections: Iterable<{
		id: string;
		state: {
			actorUserId?: string;
			actorSessionVersion?: number;
		} | null;
	}>,
	userId: string,
	currentSessionVersion: number | null,
): string[] {
	const ids: string[] = [];
	for (const connection of connections) {
		if (connection.state?.actorUserId !== userId) continue;
		if (
			currentSessionVersion === null ||
			connection.state.actorSessionVersion !== currentSessionVersion
		) {
			ids.push(connection.id);
		}
	}
	return ids;
}

type ReconciledAgentConnection = {
	id: string;
	state: {
		actorUserId?: string;
		actorSessionVersion?: number;
		liveAuthorized?: boolean;
	} | null;
	setState(state: {
		actorUserId?: string;
		actorSessionVersion?: number;
		liveAuthorized?: boolean;
	}): void;
	close(code: number, reason: string): void;
};

export async function reconcileAgentActorConnections(options: {
	connections: readonly ReconciledAgentConnection[];
	userId: string;
	resolveCurrentSessionVersion(): Promise<number | null>;
	onSessionVersionResolved?(currentSessionVersion: number | null): void;
	onAuthorizationUnavailable?(): void;
}): Promise<void> {
	const previouslyAuthorized = new Set<string>();
	for (const connection of options.connections) {
		if (connection.state?.liveAuthorized === true) {
			previouslyAuthorized.add(connection.id);
		}
		connection.setState({ ...connection.state, liveAuthorized: false });
	}
	let currentSessionVersion: number | null;
	try {
		currentSessionVersion = await options.resolveCurrentSessionVersion();
	} catch (error) {
		options.onAuthorizationUnavailable?.();
		throw error;
	}
	options.onSessionVersionResolved?.(currentSessionVersion);
	const staleConnectionIds = new Set(
		agentConnectionIdsToReconcile(
			options.connections,
			options.userId,
			currentSessionVersion,
		),
	);
	for (const connection of options.connections) {
		if (staleConnectionIds.has(connection.id)) {
			connection.close(4403, "Mail access revoked");
			continue;
		}
		if (previouslyAuthorized.has(connection.id)) {
			connection.setState({ ...connection.state, liveAuthorized: true });
		}
	}
}

export async function reconcileAgentMailboxConnections(options: {
	connections: readonly ReconciledAgentConnection[];
	resolveAuthorizedConnectionIds(): Promise<ReadonlySet<string>>;
	onAuthorizedConnectionIdsResolved?(
		authorizedConnectionIds: ReadonlySet<string>,
	): void;
	onAuthorizationUnavailable?(): void;
}): Promise<void> {
	const previouslyAuthorized = new Set<string>();
	for (const connection of options.connections) {
		if (connection.state?.liveAuthorized === true) {
			previouslyAuthorized.add(connection.id);
		}
		connection.setState({ ...connection.state, liveAuthorized: false });
	}
	let authorizedConnectionIds: ReadonlySet<string>;
	try {
		authorizedConnectionIds = await options.resolveAuthorizedConnectionIds();
	} catch (error) {
		options.onAuthorizationUnavailable?.();
		throw error;
	}
	options.onAuthorizedConnectionIdsResolved?.(authorizedConnectionIds);
	for (const connection of options.connections) {
		if (!authorizedConnectionIds.has(connection.id)) {
			connection.close(4403, "Mailbox access revoked");
			continue;
		}
		if (previouslyAuthorized.has(connection.id)) {
			connection.setState({ ...connection.state, liveAuthorized: true });
		}
	}
}

/** Agent sockets never use the legacy generation-one fallback for missing state. */
export async function hasLiveAgentMailboxAccess(
	env: Env,
	mailboxId: string,
	actorUserId: string | undefined,
	actorSessionVersion: number | undefined,
	dependencies: AgentFrameAccessDependencies = productionDependencies,
): Promise<boolean> {
	if (!actorUserId || actorSessionVersion === undefined) return false;
	return dependencies.hasExactAccess(
		env,
		mailboxId,
		actorUserId,
		actorSessionVersion,
	);
}

export async function runAuthorizedAgentFrame(options: {
	authorize(): Promise<boolean>;
	markAuthorized?(): void;
	markUnauthorized(): void;
	close(code: number, reason: string): void;
	delegate(): Promise<void>;
}): Promise<void> {
	options.markUnauthorized();
	try {
		if (!(await options.authorize())) {
			options.close(4403, "Mail access revoked");
			return;
		}
	} catch {
		options.close(1011, "Mail authorization unavailable");
		return;
	}
	options.markAuthorized?.();
	await options.delegate();
}

export async function runAuthorizedAgentAdmission(options: {
	authorize(): Promise<boolean>;
	markAuthorized(): void;
	markUnauthorized(): void;
	releaseQuarantinedOutput(): void;
	discardQuarantinedOutput(): void;
	reportUnexpectedError(error: unknown): void;
	close(code: number, reason: string): void;
	delegate(): Promise<void>;
}): Promise<void> {
	try {
		await runLiveAuthorizedRead(options.authorize, async () => {
			await options.delegate();
		});
		options.markAuthorized();
		options.releaseQuarantinedOutput();
	} catch (error) {
		options.markUnauthorized();
		options.discardQuarantinedOutput();
		if (error instanceof LiveReadAuthorizationError) {
			options.close(4403, "Mail access revoked");
			return;
		}
		if (error instanceof LiveReadAuthorizationUnavailableError) {
			options.close(1011, "Mail authorization unavailable");
			return;
		}
		options.close(1011, "Agent connection unavailable");
		options.reportUnexpectedError(error);
	}
}
