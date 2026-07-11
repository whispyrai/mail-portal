import { sendEmailWithOutcome } from "../email-sender.ts";
import type { Env } from "../types.ts";
import { generateMcpToken, hashToken } from "./auth.ts";
import { createCredentialRecoveryWorkflow } from "./credential-recovery.ts";
import { credentialRecoveryD1 } from "./credential-recovery-d1.ts";

export function credentialRecoveryWorkflow(env: Env) {
	return createCredentialRecoveryWorkflow({
		generateToken: generateMcpToken,
		hashToken,
		store: credentialRecoveryD1(env),
		async deliver(input) {
			const domain = (env.DOMAINS || "").split(",")[0]?.trim();
			if (!domain) return "failed";
			const outcome = await sendEmailWithOutcome(env, {
				to: input.to,
				from: `no-reply@${domain}`,
				subject: "Set up or recover your mail portal access",
				text: [
					`A secure credential setup or recovery link was requested for ${input.loginEmail}.`,
					"",
					input.recoveryUrl,
					"",
					"This link expires in 24 hours and can be used only once.",
					"If you did not expect this message, do not use the link.",
				].join("\n"),
			});
			if (outcome.kind === "accepted") return "accepted";
			if (outcome.kind === "transport_ambiguous" || outcome.kind === "invalid_success_response") {
				return "uncertain";
			}
			return "failed";
		},
	});
}
