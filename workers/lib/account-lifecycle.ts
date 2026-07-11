export type AccountLifecycleStore = {
  deactivate(input: {
    userId: string;
    passwordHash: string;
    passwordSalt: string;
    at: number;
  }): Promise<{ mailboxIds: string[] }>;
  activate(userId: string): Promise<void>;
};

export function createAccountLifecycle(deps: {
  store: AccountLifecycleStore;
  generateReplacementPassword: () => Promise<{ hash: string; salt: string }>;
  purgePush: (userId: string, mailboxId: string) => Promise<void>;
  now?: () => number;
}) {
  return {
    async deactivate(userId: string) {
      const replacement = await deps.generateReplacementPassword();
      const result = await deps.store.deactivate({
        userId,
        passwordHash: replacement.hash,
        passwordSalt: replacement.salt,
        at: (deps.now ?? Date.now)(),
      });
      const cleanup = await Promise.allSettled(
        result.mailboxIds.map((mailboxId) => deps.purgePush(userId, mailboxId)),
      );
      return {
        ...result,
        pushCleanupFailedMailboxIds: result.mailboxIds.filter(
          (_mailboxId, index) => cleanup[index]?.status === "rejected",
        ),
      };
    },

    async activate(userId: string) {
      await deps.store.activate(userId);
    },
  };
}
