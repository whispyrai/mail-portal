export class BoundedUrlencodedFormError extends Error {
  constructor() {
    super("URL-encoded form is invalid or exceeds its bounds");
    this.name = "BoundedUrlencodedFormError";
  }
}

type FieldRule = { required: boolean; maxBytes: number };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Read a form incrementally and allocate no application buffer beyond maxBytes. */
export async function readBoundedUrlencodedForm<
  Rules extends Record<string, FieldRule>,
>(
  request: Request,
  input: { maxBytes: number; fields: Rules },
): Promise<{ [Key in keyof Rules]: string | undefined }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    throw new BoundedUrlencodedFormError();
  }
  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > input.maxBytes
    ) {
      throw new BoundedUrlencodedFormError();
    }
  }

  const boundedBuffer = new Uint8Array(input.maxBytes);
  let totalBytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.byteLength > input.maxBytes - totalBytes) {
          await reader.cancel();
          throw new BoundedUrlencodedFormError();
        }
        boundedBuffer.set(part.value, totalBytes);
        totalBytes += part.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(
      boundedBuffer.subarray(0, totalBytes),
    );
  } catch {
    throw new BoundedUrlencodedFormError();
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(serialized)) {
    throw new BoundedUrlencodedFormError();
  }
  try {
    for (const pair of serialized.split("&")) {
      const separator = pair.indexOf("=");
      const encodedKey = separator < 0 ? pair : pair.slice(0, separator);
      const encodedValue = separator < 0 ? "" : pair.slice(separator + 1);
      decodeURIComponent(encodedKey.replace(/\+/g, " "));
      decodeURIComponent(encodedValue.replace(/\+/g, " "));
    }
  } catch {
    throw new BoundedUrlencodedFormError();
  }

  const params = new URLSearchParams(serialized);
  const output = Object.create(null) as Record<string, string | undefined>;
  for (const key of params.keys()) {
    if (!Object.hasOwn(input.fields, key) || params.getAll(key).length !== 1) {
      throw new BoundedUrlencodedFormError();
    }
    const rule = input.fields[key]!;
    const value = params.get(key) ?? "";
    if (byteLength(value) > rule.maxBytes) {
      throw new BoundedUrlencodedFormError();
    }
    output[key] = value;
  }
  for (const [key, rule] of Object.entries(input.fields)) {
    if (rule.required && !Object.hasOwn(output, key)) {
      throw new BoundedUrlencodedFormError();
    }
  }
  return output as { [Key in keyof Rules]: string | undefined };
}
