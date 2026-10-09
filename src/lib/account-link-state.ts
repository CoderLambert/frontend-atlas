export type SocialProvider = "github" | "google";
export type PendingAccountLink = { accountId: string; provider: SocialProvider };

export function isSocialProvider(value: unknown): value is SocialProvider {
  return value === "github" || value === "google";
}

export function isConfirmedAccountLink(input: {
  result: string | null;
  callbackProvider: string | null;
  pending: PendingAccountLink | null;
  accountId: string | null;
  linkedProviders: readonly SocialProvider[];
}) {
  return input.result === "success"
    && isSocialProvider(input.callbackProvider)
    && input.pending !== null
    && input.pending.accountId === input.accountId
    && input.pending.provider === input.callbackProvider
    && input.linkedProviders.includes(input.callbackProvider);
}
