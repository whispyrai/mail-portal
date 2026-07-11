export const CREDENTIAL_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;

export type CredentialRecoveryIssue = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  issuedBy?: string;
  purpose: "setup" | "recovery";
  createdAt: number;
};

export type CredentialRecoveryStore = {
  issue(record: CredentialRecoveryIssue): Promise<void>;
  consume(input: {
    tokenHash: string;
    now: number;
    passwordHash: string;
    passwordSalt: string;
    mcpTokenHash: string | null;
  }): Promise<{
    userId: string;
    loginEmail: string;
    outcome: "claimed" | "recovered";
  } | null>;
};

export function createCredentialRecoveryWorkflow(deps: {
  now?: () => number;
  generateToken: () => string;
  hashToken: (token: string) => Promise<string>;
  store: CredentialRecoveryStore;
  deliver: (input: {
    to: string;
    loginEmail: string;
    recoveryUrl: string;
    expiresAt: number;
  }) => Promise<"accepted" | "uncertain" | "failed">;
}) {
  const now = deps.now ?? Date.now;
  return {
    async issue(input: {
      userId: string;
      loginEmail: string;
      recoveryEmail: string;
      issuedBy?: string;
      origin: string;
      purpose: "setup" | "recovery";
    }) {
      const token = deps.generateToken();
      const createdAt = now();
      const expiresAt = createdAt + CREDENTIAL_RECOVERY_TTL_MS;
      await deps.store.issue({
        id: `recovery_${crypto.randomUUID()}`,
        userId: input.userId,
        tokenHash: await deps.hashToken(token),
        expiresAt,
        issuedBy: input.issuedBy,
        purpose: input.purpose,
        createdAt,
      });
      const recoveryUrl = `${input.origin}/account/recover?token=${encodeURIComponent(token)}`;
      const delivery = await deps.deliver({
        to: input.recoveryEmail,
        loginEmail: input.loginEmail,
        recoveryUrl,
        expiresAt,
      });
      return { delivery, expiresAt };
    },
    async consume(input: {
      token: string;
      passwordHash: string;
      passwordSalt: string;
      mcpTokenHash: string | null;
    }) {
      return deps.store.consume({
        tokenHash: await deps.hashToken(input.token),
        now: now(),
        passwordHash: input.passwordHash,
        passwordSalt: input.passwordSalt,
        mcpTokenHash: input.mcpTokenHash,
      });
    },
  };
}
