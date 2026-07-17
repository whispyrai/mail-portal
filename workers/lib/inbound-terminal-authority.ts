// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { hasExactInboundSmtpRejectionAuthority } from "./inbound-smtp-rejection.ts";

export type InboundTerminalAuthorityRequirement =
  | "deleted_projection"
  | "provider_accepted"
  | "raw_integrity_mismatch"
  | "smtp_rejected"
  | "stored_projection";

/**
 * Classifies the independent authority a structurally valid exact receipt
 * still needs. State names alone are never terminal proof.
 */
export function inboundTerminalAuthorityRequirement(
  receipt: Record<string, unknown>,
): InboundTerminalAuthorityRequirement | null {
  if (
    receipt.state === "forwarded" &&
    receipt.providerAccepted === true
  ) {
    return "provider_accepted";
  }
  if (hasExactInboundSmtpRejectionAuthority(receipt)) {
    return "smtp_rejected";
  }
  if (
    receipt.state === "quarantined" &&
    receipt.errorCode === "RAW_ARCHIVE_INTEGRITY_MISMATCH"
  ) {
    return "raw_integrity_mismatch";
  }
  if (receipt.state === "stored") return "stored_projection";
  if (receipt.state === "deleted") return "deleted_projection";
  return null;
}
