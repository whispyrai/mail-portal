type CanaryResult =
	| {
			status: "accepted";
			probeId: string;
			rawBytes: number;
			messageId: string;
			observedRawBytes?: number;
	  }
	| {
			status: "failed";
			probeId: string;
			rawBytes: number;
			observedRawBytes?: number;
	  };

interface CanaryEnvironment {
	CANARY_AUTH_TOKEN?: string;
	CANARY_DESTINATION?: string;
	CANARY_RECIPIENT?: string;
	CANARY_RUN_ID?: string;
	CANARY_SENDER?: string;
	CANARY_STATE: {
		get(key: string): Promise<string | null>;
		put(
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		): Promise<void>;
	};
	EMAIL: {
		send(message: unknown): Promise<{ messageId: string }>;
	};
}

interface CanaryEmailMessage {
	from: string;
	to: string;
	raw: ReadableStream<Uint8Array>;
	rawSize: number;
	headers: Headers;
	setReject(reason: string): void;
	forward(
		destination: string,
		headers?: Headers,
	): Promise<{ messageId: string }>;
}

interface CanaryExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
}

interface EmailMessageFactory {
	(
		from: string,
		to: string,
		raw: ReadableStream<Uint8Array>,
	): Promise<unknown>;
}

const ABOVE_GENERAL_LIMIT = Math.ceil(5.1 * 1024 * 1024);
const NEAR_INBOUND_LIMIT = 24_960_359;
const GENERAL_LIMIT_BYTES = 5 * 1024 * 1024;
const MAX_TRANSPORT_SIZE_DELTA = 1024 * 1024;
const RESULT_TTL_SECONDS = 10 * 60;
const RUN_ID_PATTERN = /^canary-(?:wiser|whispyr)-[a-f0-9]{16}$/u;
const PROBE_SUFFIXES = new Map([
	["forward-above-general-limit", ABOVE_GENERAL_LIMIT],
	["forward-near-inbound-limit", NEAR_INBOUND_LIMIT],
	["send-above-general-limit", ABOVE_GENERAL_LIMIT],
	["send-near-inbound-limit", NEAR_INBOUND_LIMIT],
]);

function jsonResponse(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

function requiredConfiguration(env: CanaryEnvironment) {
	const values = {
		authToken: env.CANARY_AUTH_TOKEN,
		destination: env.CANARY_DESTINATION,
		recipient: env.CANARY_RECIPIENT,
		runId: env.CANARY_RUN_ID,
		sender: env.CANARY_SENDER,
	};
	if (
		!values.authToken ||
		!values.destination ||
		!values.recipient ||
		!values.runId ||
		!values.sender ||
		!RUN_ID_PATTERN.test(values.runId)
	) {
		return null;
	}
	return values as {
		authToken: string;
		destination: string;
		recipient: string;
		runId: string;
		sender: string;
	};
}

function expectedProbeBytes(
	runId: string,
	probeId: string | null,
	lane: "forward" | "send",
) {
	if (!probeId?.startsWith(`${runId}-${lane}-`)) return null;
	const suffix = probeId.slice(runId.length + 1);
	return PROBE_SUFFIXES.get(suffix) ?? null;
}

async function secureEqual(left: string, right: string) {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(left)),
		crypto.subtle.digest("SHA-256", encoder.encode(right)),
	]);
	const leftBytes = new Uint8Array(leftHash);
	const rightBytes = new Uint8Array(rightHash);
	let difference = leftBytes.length ^ rightBytes.length;
	for (let index = 0; index < leftBytes.length; index += 1) {
		difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}

async function authorized(request: Request, token: string) {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) return false;
	return secureEqual(header.slice("Bearer ".length), token);
}

function resultKey(probeId: string) {
	return `result:${probeId}`;
}

function acceptableForwardRawSize(expectedBytes: number, observedBytes: number) {
	return (
		Number.isSafeInteger(observedBytes) &&
		observedBytes > GENERAL_LIMIT_BYTES &&
		Math.abs(observedBytes - expectedBytes) <= MAX_TRANSPORT_SIZE_DELTA
	);
}

async function storeResult(
	env: CanaryEnvironment,
	context: CanaryExecutionContext,
	result: CanaryResult,
) {
	context.waitUntil(
		env.CANARY_STATE.put(resultKey(result.probeId), JSON.stringify(result), {
			expirationTtl: RESULT_TTL_SECONDS,
		}),
	);
}

export function createCanaryWorker({
	createEmailMessage,
}: {
	createEmailMessage: EmailMessageFactory;
}) {
	return {
		async email(
			message: CanaryEmailMessage,
			env: CanaryEnvironment,
			context: CanaryExecutionContext,
		) {
			const config = requiredConfiguration(env);
			const probeId = message.headers.get("X-Canary-Probe-ID");
			const claimedBytes = Number(message.headers.get("X-Canary-Raw-Bytes"));
			const expectedBytes = config
				? expectedProbeBytes(config.runId, probeId, "forward")
				: null;
			if (
				!config ||
				message.from.toLowerCase() !== config.sender.toLowerCase() ||
				message.to.toLowerCase() !== config.recipient.toLowerCase() ||
				expectedBytes === null ||
				claimedBytes !== expectedBytes ||
				!acceptableForwardRawSize(expectedBytes, message.rawSize)
			) {
				message.setReject("Canary envelope did not match");
				return;
			}

			try {
				const result = await message.forward(config.destination);
				if (!result.messageId?.trim()) throw new Error("Missing message ID");
				await storeResult(env, context, {
					status: "accepted",
					probeId,
					rawBytes: expectedBytes,
					messageId: result.messageId,
					observedRawBytes: message.rawSize,
				});
			} catch {
				await storeResult(env, context, {
					status: "failed",
					probeId,
					rawBytes: expectedBytes,
					observedRawBytes: message.rawSize,
				});
			}
		},

		async fetch(request: Request, env: CanaryEnvironment) {
			const config = requiredConfiguration(env);
			if (!config) return jsonResponse({ error: "Canary is not configured" }, 503);
			if (!(await authorized(request, config.authToken))) {
				return jsonResponse({ error: "Unauthorized" }, 401);
			}

			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") {
				return jsonResponse({ status: "ready", runId: config.runId });
			}
			if (request.method === "GET" && url.pathname === "/status") {
				const probeId = url.searchParams.get("probe");
				if (
					expectedProbeBytes(config.runId, probeId, "forward") === null
				) {
					return jsonResponse({ error: "Invalid probe" }, 400);
				}
				const result = await env.CANARY_STATE.get(resultKey(probeId!));
				return result
					? new Response(result, {
							status: 200,
							headers: {
								"Cache-Control": "no-store",
								"Content-Type": "application/json; charset=utf-8",
							},
						})
					: jsonResponse({ status: "pending", probeId }, 202);
			}
			if (request.method !== "POST" || url.pathname !== "/send") {
				return jsonResponse({ error: "Not found" }, 404);
			}

			const probeId = request.headers.get("X-Canary-Probe-ID");
			const claimedBytes = Number(request.headers.get("X-Canary-Raw-Bytes"));
			const contentLength = Number(request.headers.get("Content-Length"));
			const expectedBytes = expectedProbeBytes(config.runId, probeId, "send");
			if (
				request.headers.get("Content-Type") !== "message/rfc822" ||
				!request.body ||
				expectedBytes === null ||
				claimedBytes !== expectedBytes ||
				contentLength !== expectedBytes
			) {
				return jsonResponse({ error: "Canary fixture did not match" }, 400);
			}

			try {
				const message = await createEmailMessage(
					config.sender,
					config.destination,
					request.body,
				);
				const result = await env.EMAIL.send(message);
				if (!result.messageId?.trim()) throw new Error("Missing message ID");
				return jsonResponse({
					status: "accepted",
					probeId,
					rawBytes: expectedBytes,
					messageId: result.messageId,
				});
			} catch {
				return jsonResponse(
					{ status: "failed", probeId, rawBytes: expectedBytes },
					502,
				);
			}
		},
	};
}

const worker = createCanaryWorker({
	async createEmailMessage(from, to, raw) {
		const { EmailMessage } = await import("cloudflare:email");
		return new EmailMessage(from, to, raw);
	},
});

export default worker;
