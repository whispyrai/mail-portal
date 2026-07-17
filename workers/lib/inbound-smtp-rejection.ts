// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export const INBOUND_SMTP_REJECTION_ORIGIN = "smtp_ingress" as const;

export const INBOUND_SMTP_REJECTION_ERROR_CODES = [
  "ALL_DURABILITY_PATHS_FAILED",
  "FALLBACK_RECIPIENT_INVALID",
  "FALLBACK_RECIPIENT_OR_SIZE_INVALID",
  "MAILBOX_INACTIVE",
  "MAILBOX_UNAVAILABLE",
  "MAILBOX_VERIFICATION_FAILED",
  "RAW_SIZE_INVALID",
  "RECIPIENT_DOMAIN_INVALID",
  "RECIPIENT_NOT_ALLOWED",
] as const;

export type InboundSmtpRejectionErrorCode =
  (typeof INBOUND_SMTP_REJECTION_ERROR_CODES)[number];

const inboundSmtpRejectionErrorCodes = new Set<string>(
  INBOUND_SMTP_REJECTION_ERROR_CODES,
);

export function isInboundSmtpRejectionErrorCode(
  value: unknown,
): value is InboundSmtpRejectionErrorCode {
  return (
    typeof value === "string" &&
    inboundSmtpRejectionErrorCodes.has(value)
  );
}

export function hasExactInboundSmtpRejectionAuthority(
  value: Record<string, unknown>,
): boolean {
  return (
    value.state === "rejected" &&
    value.rejectionOrigin === INBOUND_SMTP_REJECTION_ORIGIN &&
    isInboundSmtpRejectionErrorCode(value.errorCode)
  );
}
