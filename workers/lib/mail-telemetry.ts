import { arrayBufferToHex } from "./checksum.ts";

export type MailTelemetryRefKind =
	| "attempt"
	| "audit"
	| "ingress"
	| "message"
	| "object"
	| "queue";

export async function mailTelemetryRef(
	kind: MailTelemetryRefKind,
	canonicalValue: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`mail-telemetry:v1\0${kind}\0${canonicalValue}`,
		),
	);
	return arrayBufferToHex(digest).slice(0, 16);
}

export async function mailTelemetryLogRef(
	kind: MailTelemetryRefKind,
	canonicalValue: string,
): Promise<string> {
	try {
		return await mailTelemetryRef(kind, canonicalValue);
	} catch {
		return "unavailable";
	}
}
