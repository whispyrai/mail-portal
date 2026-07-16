import type { InboundArchivePointer } from "../inbound-email.ts";
import { arrayBufferToHex } from "./checksum.ts";
import { MAX_EMAIL_SIZE } from "./store-email.ts";

export function inboundRawArchiveMatchesPointer(
  raw: {
    key: string;
    version: string;
    size: number;
    etag: string;
    customMetadata?: Record<string, string>;
    checksums?: { sha256?: ArrayBuffer };
  },
  pointer: InboundArchivePointer,
): boolean {
  if (
    raw.key !== pointer.rawKey ||
    raw.size !== pointer.rawSize ||
    raw.size <= 0 ||
    raw.size > MAX_EMAIL_SIZE ||
    raw.etag !== pointer.etag ||
    raw.version !== pointer.version ||
    raw.customMetadata?.schemaVersion !== String(pointer.schemaVersion) ||
    raw.customMetadata?.ingressId !== pointer.ingressId ||
    raw.customMetadata?.mailboxId !== pointer.mailboxId ||
    raw.customMetadata?.rawSize !== String(pointer.rawSize) ||
    raw.customMetadata?.archivedAt !== pointer.archivedAt
  ) {
    return false;
  }
  if (pointer.rawSha256 === undefined) return true;
  return (
    raw.customMetadata?.rawSha256 === pointer.rawSha256 &&
    raw.checksums?.sha256 !== undefined &&
    arrayBufferToHex(raw.checksums.sha256) === pointer.rawSha256
  );
}
