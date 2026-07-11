import { normalizeMailAddress } from "./mail-address.ts";

export type RecoveryRequestUser = {
  id: string;
  email: string;
  recoveryEmail: string | null;
  ownershipConfirmedAt: number | null;
};

export function createRecoveryRequestProcessor(deps: {
  throttle: (input: { email: string; ip: string }) => Promise<boolean>;
  findUser: (email: string) => Promise<RecoveryRequestUser | null>;
  resolveDirectoryAddress: (email: string) => string;
  syncRecoveryAddress: (userId: string, recoveryEmail: string) => Promise<void>;
  issue: (input: {
    purpose: "recovery";
    userId: string;
    loginEmail: string;
    recoveryEmail: string;
    issuedBy?: undefined;
    origin: string;
  }) => Promise<unknown>;
}) {
  return {
    async process(input: {
      email: string;
      ip: string;
      origin: string;
    }): Promise<void> {
      const email = normalizeMailAddress(input.email);
      if (!email) return;
      if (!(await deps.throttle({ email, ip: input.ip }))) return;
      const user = await deps.findUser(email);
      if (!user?.ownershipConfirmedAt) return;

      let recoveryEmail: string;
      try {
        recoveryEmail = deps.resolveDirectoryAddress(user.email);
      } catch {
        return;
      }
      if (user.recoveryEmail !== recoveryEmail) {
        await deps.syncRecoveryAddress(user.id, recoveryEmail);
      }
      await deps.issue({
        purpose: "recovery",
        userId: user.id,
        loginEmail: user.email,
        recoveryEmail,
        issuedBy: undefined,
        origin: input.origin,
      });
    },
  };
}
