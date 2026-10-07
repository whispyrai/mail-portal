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

/**
 * Where one recipient ends and the next begins: every comma, semicolon and
 * line break outside a quoted name (escapes included), an angle-bracket
 * address and a parenthesised comment, so `"Hamilton, Margaret" <m@x>` and
 * `Ada (Sales, EMEA) <a@x>` each stay one recipient.
 */
export function recipientSeparatorPositions(text: string): number[] {
	const positions: number[] = [];
	let quoted = false;
	let bracketed = false;
	let commentDepth = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]!;
		if ((quoted || commentDepth > 0) && character === "\\") {
			index += 1;
		} else if (quoted) {
			if (character === '"') quoted = false;
		} else if (commentDepth > 0) {
			if (character === "(") commentDepth += 1;
			else if (character === ")") commentDepth -= 1;
		} else if (bracketed) {
			if (character === ">") bracketed = false;
		} else if (character === '"') {
			quoted = true;
		} else if (character === "(") {
			commentDepth = 1;
		} else if (character === "<") {
			bracketed = true;
		} else if (/[,;\r\n]/.test(character)) {
			positions.push(index);
		}
	}
	return positions;
}

function splitAddressList(text: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (const position of [...recipientSeparatorPositions(text), text.length]) {
		parts.push(text.slice(start, position).trim());
		start = position + 1;
	}
	return parts.filter(Boolean);
}

function withoutMailto(value: string): string {
	return value.trim().replace(/^mailto:/i, "");
}

/** Blank out quoted names and comments, keeping every other character in place. */
function withoutNamesAndComments(part: string): string {
	const blank = (match: string) => " ".repeat(match.length);
	let visible = part.replace(/"(?:[^"\\]|\\.)*"/g, blank);
	for (let previous = ""; previous !== visible; ) {
		previous = visible;
		visible = visible.replace(/\((?:[^()\\]|\\.)*\)/g, blank);
	}
	return visible;
}

/**
 * Every address in what a person typed or pasted, or in an address header,
 * in the order written. Display names, comments and `mailto:` are dropped, so
 * `"Hamilton, Margaret" <m@x.com>; a@y.com b@z.com` gives three addresses and
 * so does `Alice <a@x.com> b@y.com c@z.com`. A piece that holds no address at
 * all is kept as typed, so the composer can show it as a recipient that needs
 * fixing instead of silently losing it.
 */
export function parseRecipientText(text: string): string[] {
	const addresses: string[] = [];
	for (const part of splitAddressList(text)) {
		const found = [
			...withoutNamesAndComments(part).matchAll(/<([^<>]*)>|[^\s<>]+/g),
		].flatMap((match) => {
			if (match[1] !== undefined) {
				const address = withoutMailto(match[1]);
				return address ? [address] : [];
			}
			const word = withoutMailto(match[0]).replace(/^["']+|["']+$/g, "");
			return word.includes("@") ? [word] : [];
		});
		addresses.push(...(found.length > 0 ? found : [part]));
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

