const INGRESS_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function padded(value: number): string {
  return String(value).padStart(2, "0");
}

function isCanonicalUtcMinute(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
): boolean {
  const timestamp = `${year}-${month}-${day}T${hour}:${minute}:00.000Z`;
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === timestamp;
}

export function inboundRawMinutePrefix(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Inbound raw archive minute is invalid");
  }
  return [
    "raw",
    String(value.getUTCFullYear()).padStart(4, "0"),
    padded(value.getUTCMonth() + 1),
    padded(value.getUTCDate()),
    padded(value.getUTCHours()),
    padded(value.getUTCMinutes()),
    "",
  ].join("/");
}

export function inboundRawArchiveKey(
  archivedAt: Date,
  ingressId: string,
): string {
  if (!INGRESS_ID_PATTERN.test(ingressId)) {
    throw new Error("Inbound ingress identity is invalid");
  }
  return `${inboundRawMinutePrefix(archivedAt)}${ingressId}.eml`;
}

export function inboundIngressIdFromRawKey(rawKey: string): string | null {
  const match =
    /^raw\/(\d{4})\/(\d{2})\/(\d{2})(?:\/(\d{2})\/(\d{2}))?\/([A-Za-z0-9_-]+)\.eml$/.exec(
      rawKey,
    );
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", ingressId] =
    match;
  if (!isCanonicalUtcMinute(year, month, day, hour, minute)) return null;
  return ingressId;
}

export function isInboundRawKeyForIngress(
  rawKey: string,
  ingressId: string,
): boolean {
  return (
    INGRESS_ID_PATTERN.test(ingressId) &&
    inboundIngressIdFromRawKey(rawKey) === ingressId
  );
}
