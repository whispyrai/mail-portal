import type { ActivityActor } from "./activity.ts";

export const RESOURCE_CREATE_REPLAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export type ResourceCreateKind = "folder" | "label" | "saved_view";
export type ResourceCreateState = "active" | "superseded" | "unavailable";

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function resourceCreateOperationKey(input: {
  kind: ResourceCreateKind;
  mailboxId: string;
  actor: ActivityActor;
  operationId: string;
}): Promise<string> {
  return sha256([
    "mail-resource-create",
    1,
    input.kind,
    input.mailboxId.toLowerCase(),
    input.actor.kind,
    input.actor.id ?? null,
    input.operationId,
  ]);
}

export function resourceCreateFingerprint(input: {
  kind: ResourceCreateKind;
  payload: unknown;
}): Promise<string> {
  return sha256(["mail-resource-create-intent", 1, input.kind, input.payload]);
}

export function resourceCreateReplayCutoff(now: number): string {
  return new Date(now - RESOURCE_CREATE_REPLAY_WINDOW_MS).toISOString();
}
