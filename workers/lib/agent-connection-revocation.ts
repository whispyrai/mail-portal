import type { Env } from "../types.ts";

type AgentConnectionControl = {
	reconcileActor(userId: string): Promise<void>;
	reconcileMailbox(): Promise<void>;
};

export type AgentConnectionRevocationDependencies = {
	getAgent(mailboxId: string): Promise<AgentConnectionControl>;
};

export function createAgentConnectionRevoker(
	dependencies: AgentConnectionRevocationDependencies,
) {
	return {
		async reconcileActor(mailboxId: string, userId: string): Promise<void> {
			const agent = await dependencies.getAgent(mailboxId.toLowerCase());
			await agent.reconcileActor(userId);
		},

		async reconcileMailbox(mailboxId: string): Promise<void> {
			const agent = await dependencies.getAgent(mailboxId.toLowerCase());
			await agent.reconcileMailbox();
		},
	};
}

export function agentConnectionRevoker(env: Env) {
	return createAgentConnectionRevoker({
		async getAgent(mailboxId) {
			const { getAgentByName } = await import("agents");
			return getAgentByName(env.EMAIL_AGENT, mailboxId);
		},
	});
}
