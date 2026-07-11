import type { Env } from "../types.ts";
import { credentialRecoveryWorkflow } from "./credential-recovery-runtime.ts";
import { recoveryAddressFor } from "./recovery-directory.ts";
import { createRecoveryRequestProcessor } from "./recovery-request.ts";
import { allowRecoveryRequest } from "./recovery-request-d1.ts";
import { getUserByEmail, updateUserRecoveryEmail } from "./users.ts";

export function recoveryRequestProcessor(env: Env) {
  return createRecoveryRequestProcessor({
    throttle: ({ email, ip }) => allowRecoveryRequest(env, { email, ip }),
    async findUser(email) {
      const user = await getUserByEmail(env, email);
      return user
        ? {
            id: user.id,
            email: user.email,
            recoveryEmail: user.recovery_email,
            ownershipConfirmedAt: user.ownership_confirmed_at,
          }
        : null;
    },
    resolveDirectoryAddress: (email) =>
      recoveryAddressFor(env.ACCOUNT_RECOVERY_DIRECTORY, email, env.DOMAINS),
    syncRecoveryAddress: (userId, recoveryEmail) =>
      updateUserRecoveryEmail(env, userId, recoveryEmail),
    issue: (input) => credentialRecoveryWorkflow(env).issue(input),
  });
}
