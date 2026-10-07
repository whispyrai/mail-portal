/**
 * Recipient addresses as people type, paste and store them, read the same way
 * by the composer and by the server.
 */

export type RecipientField = "to" | "cc" | "bcc";

export type RecipientFieldValues = Record<RecipientField, string>;

export const RECIPIENT_FIELDS: readonly RecipientField[] = ["to", "cc", "bcc"];

/**
 * The exact check zod's `.email()` applies on the send API. Mirroring it means
 * the composer flags precisely the addresses the server would reject, before
 * the writer presses Send rather than after.
 */
const EMAIL_PATTERN =
	/^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;

export function isValidRecipientAddress(address: string): boolean {
	return EMAIL_PATTERN.test(address);
}

/** Compare addresses by the bare mailbox part, so `A Name <a@x>` equals `a@x`. */
export function normalizedAddress(value: string): string {
	const trimmed = value.trim();
	const bracketed = trimmed.match(/<([^<>]+)>\s*$/)?.[1];
	return (bracketed ?? trimmed).trim().toLowerCase();
}

/** Split on separators that sit outside quoted names and angle brackets. */
function splitAddressList(text: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	let bracketed = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]!;
		if (quoted && character === "\\") {
			current += character + (text[index + 1] ?? "");
			index += 1;
			continue;
		}
		if (character === '"') quoted = !quoted;
		else if (!quoted && character === "<") bracketed = true;
		else if (!quoted && character === ">") bracketed = false;
		if (!quoted && !bracketed && /[,;\r\n]/.test(character)) {
			parts.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

function withoutMailto(value: string): string {
	return value.trim().replace(/^mailto:/i, "");
}

/**
 * Every address in what a person typed or pasted, or in an address header.
 * Display names, comments and `mailto:` are dropped, so
 * `"Hamilton, Margaret" <m@x.com>; a@y.com b@z.com` gives three addresses.
 * A piece that holds no address at all is kept as typed, so the composer can
 * show it as a recipient that needs fixing instead of silently losing it.
 */
export function parseRecipientText(text: string): string[] {
	const addresses: string[] = [];
	for (const part of splitAddressList(text)) {
		const bracketed = [...part.matchAll(/<([^<>]*)>/g)]
			.map((match) => withoutMailto(match[1] ?? ""))
			.filter(Boolean);
		if (bracketed.length > 0) {
			addresses.push(...bracketed);
			continue;
		}
		const words = part
			.replace(/\([^()]*\)/g, " ")
			.split(/\s+/)
			.map((word) => withoutMailto(word).replace(/^["']+|["']+$/g, ""))
			.filter((word) => word.includes("@"));
		addresses.push(...(words.length > 0 ? words : [part]));
	}
	return addresses;
}

/**
 * The recipients a send actually carries. An address appears once, in the
 * most visible field it was given in (To, then Cc, then Bcc), so nobody gets
 * the same message twice and a Bcc never doubles as a visible Cc.
 */
export function sendableRecipients(
	fields: RecipientFieldValues,
): Record<RecipientField, string[]> {
	const seen = new Set<string>();
	const sendable: Record<RecipientField, string[]> = { to: [], cc: [], bcc: [] };
	for (const field of RECIPIENT_FIELDS) {
		for (const address of parseRecipientText(fields[field])) {
			const key = normalizedAddress(address);
			if (seen.has(key)) continue;
			seen.add(key);
			sendable[field].push(address);
		}
	}
	return sendable;
}

