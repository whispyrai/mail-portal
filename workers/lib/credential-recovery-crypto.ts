const CREDENTIAL_RECOVERY_KEY_VERSION = 1 as const;

export class CredentialRecoveryKeyUnavailableError extends Error {
  constructor() {
    super("Credential recovery payload key is unavailable");
    this.name = "CredentialRecoveryKeyUnavailableError";
  }
}

export class CredentialRecoveryKeyVersionError extends Error {
  constructor() {
    super("Credential recovery payload key version is unsupported");
    this.name = "CredentialRecoveryKeyVersionError";
  }
}

export class CredentialRecoveryPayloadCorruptError extends Error {
  constructor() {
    super("Credential recovery payload authentication or shape is invalid");
    this.name = "CredentialRecoveryPayloadCorruptError";
  }
}

export function isRetryableCredentialRecoveryCryptoError(
  error: unknown,
): boolean {
  return (
    error instanceof CredentialRecoveryKeyUnavailableError ||
    error instanceof CredentialRecoveryKeyVersionError
  );
}

export type EncryptedCredentialRecoveryPayload = {
  keyVersion: number;
  iv: string;
  ciphertext: string;
};

type PayloadIdentity = {
  kind: "request" | "delivery";
  id: string;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new CredentialRecoveryPayloadCorruptError();
  }
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CredentialRecoveryPayloadCorruptError();
  }
}

function payloadAad(identity: PayloadIdentity): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `mail-portal:credential-recovery:v${CREDENTIAL_RECOVERY_KEY_VERSION}:${identity.kind}:${identity.id}`,
  );
}

async function payloadKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new CredentialRecoveryKeyUnavailableError();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `mail-portal:credential-recovery:key:v${CREDENTIAL_RECOVERY_KEY_VERSION}\0${secret}`,
    ),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCredentialRecoveryPayload(
  secret: string,
  payload: Record<string, unknown>,
  identity: PayloadIdentity,
): Promise<EncryptedCredentialRecoveryPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv.buffer,
      additionalData: payloadAad(identity).buffer,
    },
    await payloadKey(secret),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return {
    keyVersion: CREDENTIAL_RECOVERY_KEY_VERSION,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

export async function decryptCredentialRecoveryPayload<T>(
  secret: string,
  payload: EncryptedCredentialRecoveryPayload,
  identity: PayloadIdentity,
): Promise<T> {
  if (payload.keyVersion !== CREDENTIAL_RECOVERY_KEY_VERSION) {
    throw new CredentialRecoveryKeyVersionError();
  }
  const iv = base64UrlDecode(payload.iv);
  if (iv.byteLength !== 12) throw new CredentialRecoveryPayloadCorruptError();
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv.buffer,
        additionalData: payloadAad(identity).buffer,
      },
      await payloadKey(secret),
      base64UrlDecode(payload.ciphertext).buffer,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (error) {
    if (isRetryableCredentialRecoveryCryptoError(error)) throw error;
    throw new CredentialRecoveryPayloadCorruptError();
  }
}

export async function opaqueCredentialRecoveryRef(
  secret: string,
  scope: "account" | "ip",
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`credential-recovery:${scope}:v1:${value}`),
  );
  return base64UrlEncode(new Uint8Array(signature));
}
