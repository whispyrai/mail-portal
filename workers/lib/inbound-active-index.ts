import type { InboundArchivePointer } from "../inbound-email.ts";
import {
  inboundIngressIdFromRawKey,
  isInboundRawKeyForIngress,
} from "./inbound-raw-key.ts";

type InboundActiveIndexBucket = {
  put(
    key: string,
    value: string,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
      onlyIf: { etagDoesNotMatch: string };
    },
  ): Promise<unknown | null>;
};

type InboundActiveIndexDeleter = {
  delete(key: string): Promise<unknown>;
};

export const INBOUND_ACTIVE_INDEX_PREFIX = "system/inbound-active/";
export const INBOUND_ACTIVE_INDEX_CURSOR_KEY =
  "system/inbound-active-cursor.json";

export function inboundActiveMarkerKey(rawKey: string): string {
  return `${INBOUND_ACTIVE_INDEX_PREFIX}${encodeURIComponent(rawKey)}.json`;
}

export function rawKeyFromInboundActiveMarkerKey(key: string): string | null {
  if (!key.startsWith(INBOUND_ACTIVE_INDEX_PREFIX) || !key.endsWith(".json")) {
    return null;
  }
  const encoded = key.slice(INBOUND_ACTIVE_INDEX_PREFIX.length, -".json".length);
  if (!encoded) return null;
  let rawKey: string;
  try {
    rawKey = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (
    !inboundIngressIdFromRawKey(rawKey) ||
    inboundActiveMarkerKey(rawKey) !== key
  ) {
    return null;
  }
  return rawKey;
}

export async function persistInboundActiveMarker(
  bucket: InboundActiveIndexBucket,
  pointer: InboundArchivePointer,
): Promise<void> {
  await persistInboundActiveMarkerForRawKey(
    bucket,
    pointer.rawKey,
    pointer.ingressId,
    JSON.stringify({ ...pointer }),
  );
}

export async function persistInboundActiveMarkerForRawKey(
  bucket: InboundActiveIndexBucket,
  rawKey: string,
  ingressId: string,
  value = JSON.stringify({ rawKey }),
): Promise<void> {
  if (!isInboundRawKeyForIngress(rawKey, ingressId)) {
    throw new Error("Inbound active marker identity is invalid");
  }
  await bucket.put(
    inboundActiveMarkerKey(rawKey),
    value,
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        ingressId,
        status: "active",
      },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  // A create-only loser proves that an index object already exists for this
  // immutable raw key. Reconciliation derives identity from the marker key and
  // verifies the authoritative raw object's metadata before taking action.
}

export async function clearInboundActiveMarker(
  bucket: InboundActiveIndexDeleter,
  rawKey: string,
): Promise<void> {
  await bucket.delete(inboundActiveMarkerKey(rawKey));
}
