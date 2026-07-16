export type InboundDerivedContentCleanupRequest = {
  emailId: string;
  projectionAttemptId: string;
  keys: string[];
};

export type InboundDerivedContentCleanupCandidate = {
  r2Key: string;
  byteLength: number;
};

export type InboundDerivedContentCleanupProofRequest = {
  emailId: string;
  projectionAttemptId: string;
  objects: InboundDerivedContentCleanupCandidate[];
};

export type InboundDerivedContentCleanupInput =
  | InboundDerivedContentCleanupRequest
  | InboundDerivedContentCleanupProofRequest;

type CleanupCandidateWithOptionalLength = {
  r2Key: string;
  byteLength: number | null;
};

export function classifyInboundDerivedContentCleanup(
  candidates: CleanupCandidateWithOptionalLength[],
  observedSizes: ReadonlyMap<string, number | null>,
  ownedSizes: ReadonlyMap<string, number>,
) {
  const queued: CleanupCandidateWithOptionalLength[] = [];
  let retained = 0;
  let absent = 0;
  for (const candidate of candidates) {
    const observedSize = observedSizes.get(candidate.r2Key);
    if (observedSize === undefined) {
      throw new Error("Inbound cleanup observation is incomplete");
    }
    if (
      observedSize !== null &&
      candidate.byteLength !== null &&
      observedSize !== candidate.byteLength
    )
      throw new Error("Inbound cleanup object proof is inconsistent");
    const ownedSize = ownedSizes.get(candidate.r2Key);
    if (ownedSize !== undefined) {
      if (candidate.byteLength !== null && candidate.byteLength !== ownedSize)
        throw new Error("Inbound cleanup ownership proof is inconsistent");
      retained += 1;
      continue;
    }
    if (observedSize === null) absent += 1;
    else queued.push(candidate);
  }
  return { queued, retained, absent };
}

export function classifyInboundProjectionDerivedContent(
  candidates: InboundDerivedContentCleanupCandidate[],
  ownedSizes: ReadonlyMap<string, number>,
  identity: { emailId: string; projectionAttemptId: string },
): { ownedKeys: string[]; cleanupKeys: string[] } {
  const ownedKeys: string[] = [];
  const cleanupKeys: string[] = [];
  const candidateKeys = new Set(candidates.map(({ r2Key }) => r2Key));
  const currentAttemptPrefixes = [
    `attachments/${identity.emailId}/${identity.projectionAttemptId}/`,
    `email-bodies/${identity.emailId}/${identity.projectionAttemptId}/`,
  ];
  for (const r2Key of ownedSizes.keys()) {
    if (
      currentAttemptPrefixes.some((prefix) => r2Key.startsWith(prefix)) &&
      !candidateKeys.has(r2Key)
    ) {
      throw new Error("Inbound projection ownership proof is incomplete");
    }
  }
  for (const candidate of candidates) {
    const ownedSize = ownedSizes.get(candidate.r2Key);
    if (ownedSize === undefined) {
      cleanupKeys.push(candidate.r2Key);
      continue;
    }
    if (ownedSize !== candidate.byteLength) {
      throw new Error("Inbound projection ownership proof is inconsistent");
    }
    ownedKeys.push(candidate.r2Key);
  }
  return { ownedKeys, cleanupKeys };
}

const PROJECTION_ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONNEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;

export function projectionAttemptIdFromDerivedContentKey(
  emailId: string,
  r2Key: string,
): string | null {
  const segments = r2Key.split("/");
  if (
    segments[1] !== emailId ||
    !segments[2] ||
    !PROJECTION_ATTEMPT_ID.test(segments[2])
  ) {
    return null;
  }
  if (
    segments[0] === "email-bodies" &&
    segments.length === 4 &&
    /^(0|[1-9]\d*)\.body$/.test(segments[3]) &&
    Number(segments[3].slice(0, -5)) <= 511
  ) {
    return segments[2];
  }
  if (
    segments[0] === "attachments" &&
    segments.length === 5 &&
    validAttachmentSuffix(emailId, `${segments[3]}/${segments[4]}`)
  ) {
    return segments[2];
  }
  return null;
}

function validAttachmentSuffix(emailId: string, suffix: string): boolean {
  const segments = suffix.split("/");
  if (segments.length !== 2) return false;
  const [attachmentId, filename] = segments;
  const expectedAttachmentPrefix = `${emailId}-`;
  if (!attachmentId.startsWith(expectedAttachmentPrefix)) return false;
  const index = attachmentId.slice(expectedAttachmentPrefix.length);
  if (!NONNEGATIVE_INTEGER.test(index) || Number(index) > 511) {
    return false;
  }
  return (
    filename.length > 0 &&
    !/[\\:*?"<>|\x00-\x1f]/.test(filename) &&
    new TextEncoder().encode(filename).byteLength <= 240
  );
}

function validateIdentity(input: {
  emailId: unknown;
  projectionAttemptId: unknown;
}): asserts input is { emailId: string; projectionAttemptId: string } {
  if (
    typeof input.emailId !== "string" ||
    !/^[A-Za-z0-9_-]{1,300}$/.test(input.emailId) ||
    typeof input.projectionAttemptId !== "string" ||
    !PROJECTION_ATTEMPT_ID.test(input.projectionAttemptId)
  )
    throw new Error("Inbound derived-content cleanup request is invalid");
}

function validateKeys(
  emailId: string,
  projectionAttemptId: string,
  keys: unknown,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(keys) ||
    (!allowEmpty && keys.length < 1) ||
    keys.length > 512
  ) {
    throw new Error("Inbound derived-content cleanup request is invalid");
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (
      typeof keys[index] !== "string" ||
      new TextEncoder().encode(keys[index]).byteLength > 1024
    )
      throw new Error("Inbound derived-content cleanup key is invalid");
  }
  const uniqueKeys = [...new Set(keys as string[])];
  if (uniqueKeys.length !== keys.length) {
    throw new Error("Inbound derived-content cleanup keys must be unique");
  }
  const attachmentPrefix = `attachments/${emailId}/${projectionAttemptId}/`;
  const bodyPrefix = `email-bodies/${emailId}/${projectionAttemptId}/`;
  for (const key of uniqueKeys) {
    const validAttachment =
      key.startsWith(attachmentPrefix) &&
      validAttachmentSuffix(emailId, key.slice(attachmentPrefix.length));
    const bodySuffix = key.startsWith(bodyPrefix)
      ? key.slice(bodyPrefix.length)
      : null;
    const validBody =
      bodySuffix !== null &&
      /^(0|[1-9]\d*)\.body$/.test(bodySuffix) &&
      Number(bodySuffix.slice(0, -5)) <= 511;
    if (!validAttachment && !validBody) {
      throw new Error("Inbound derived-content cleanup key is invalid");
    }
  }
  return uniqueKeys;
}

export function validateInboundDerivedContentCleanupRequest(
  input: InboundDerivedContentCleanupRequest,
): string[] {
  if (!input || typeof input !== "object")
    throw new Error("Inbound derived-content cleanup request is invalid");
  validateIdentity(input);
  return validateKeys(input.emailId, input.projectionAttemptId, input.keys);
}

export function validateInboundDerivedContentCleanupProof(
  input: InboundDerivedContentCleanupProofRequest,
): InboundDerivedContentCleanupCandidate[] {
  return validateProof(input, false);
}

export function validateInboundDerivedContentProjectionProof(
  input: InboundDerivedContentCleanupProofRequest,
): InboundDerivedContentCleanupCandidate[] {
  return validateProof(input, true);
}

function validateProof(
  input: InboundDerivedContentCleanupProofRequest,
  allowEmpty: boolean,
): InboundDerivedContentCleanupCandidate[] {
  if (!input || typeof input !== "object" || !Array.isArray(input.objects)) {
    throw new Error("Inbound derived-content cleanup proof is invalid");
  }
  validateIdentity(input);
  const keys = validateKeys(
    input.emailId,
    input.projectionAttemptId,
    input.objects.map((object) =>
      object && typeof object === "object" ? object.r2Key : object,
    ),
    allowEmpty,
  );
  for (let index = 0; index < input.objects.length; index += 1) {
    const object = input.objects[index];
    if (
      !object ||
      typeof object !== "object" ||
      Array.isArray(object) ||
      object.r2Key !== keys[index] ||
      !Number.isSafeInteger(object.byteLength) ||
      object.byteLength < 0
    )
      throw new Error(
        "Inbound derived-content cleanup object proof is invalid",
      );
  }
  return input.objects.map((object) => ({ ...object }));
}
