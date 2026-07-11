import {
  isAddressInConfiguredMailDomains,
  normalizeMailAddress,
} from "./mail-address.ts";

export class RecoveryDirectoryError extends Error {
  constructor(message = "Account recovery is not configured for this user") {
    super(message);
    this.name = "RecoveryDirectoryError";
  }
}

/**
 * Resolve the platform-operator managed recovery directory. The application
 * administrator never receives or modifies this secret.
 */
export function recoveryAddressFor(
  rawDirectory: string | undefined,
  portalEmail: string,
  configuredDomains: string | undefined,
): string {
  const normalizedPortal = normalizeMailAddress(portalEmail);
  if (!normalizedPortal || !rawDirectory) throw new RecoveryDirectoryError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDirectory);
  } catch {
    throw new RecoveryDirectoryError("Account recovery directory is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RecoveryDirectoryError("Account recovery directory is invalid");
  }

  const normalized = new Map<string, string>();
  for (const [portal, external] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const normalizedKey = normalizeMailAddress(portal);
    const normalizedExternal =
      typeof external === "string" ? normalizeMailAddress(external) : null;
    if (
      !normalizedKey ||
      !normalizedExternal ||
      isAddressInConfiguredMailDomains(normalizedExternal, configuredDomains) ||
      normalized.has(normalizedKey)
    ) {
      throw new RecoveryDirectoryError("Account recovery directory is invalid");
    }
    normalized.set(normalizedKey, normalizedExternal);
  }

  const address = normalized.get(normalizedPortal);
  if (!address) throw new RecoveryDirectoryError();
  return address;
}

export function maskedRecoveryAddress(
  address: string | null | undefined,
): string {
  if (!address) return "Not configured";
  const [local, domain] = address.split("@");
  if (!local || !domain) return "Configured";
  const [domainName, ...suffixParts] = domain.split(".");
  const suffix = suffixParts.length ? `.${suffixParts.join(".")}` : "";
  return `${local.slice(0, 1)}•••@${domainName.slice(0, 1)}•••${suffix}`;
}
