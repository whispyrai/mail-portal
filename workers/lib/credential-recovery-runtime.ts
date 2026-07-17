import type { Env } from "../types.ts";
import { generateMcpToken, hashToken } from "./auth.ts";
import { createCredentialRecoveryWorkflow } from "./credential-recovery.ts";
import { credentialRecoveryD1 } from "./credential-recovery-d1.ts";

export function credentialRecoveryWorkflow(
  env: Env,
  options: { now?: () => number } = {},
) {
	return createCredentialRecoveryWorkflow({
		now: options.now,
		generateToken: generateMcpToken,
		hashToken,
		store: credentialRecoveryD1(env),
	});
}
