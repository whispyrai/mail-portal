import {
	RECIPIENT_MEMORY_LIMITS,
	type RecipientSuggestion,
} from "../../shared/recipient-suggestions.ts";
import {
	isValidRecipientAddress,
	normalizedAddress,
	parseRecipientText,
	RECIPIENT_FIELDS,
	recipientSeparatorPositions,
	sendableRecipients,
	type RecipientField,
	type RecipientFieldValues,
} from "../../shared/recipient-addresses.ts";

/**
 * Split typed text at its last separator: everything before it is finished
 * and becomes recipients, the rest is still being typed. A comma inside a
 * quoted name, an angle-bracket address or a comment does not count.
 */
export function splitFinishedRecipients(text: string): {
	finished: string;
	pending: string;
} {
	const last = recipientSeparatorPositions(text).at(-1);
	return last === undefined
		? { finished: "", pending: text }
		: {
				finished: text.slice(0, last),
				pending: text.slice(last + 1).trimStart(),
			};
}

/** Append addresses to a field, skipping any the field already holds. */
export function mergeRecipients(
	existing: readonly string[],
	additions: readonly string[],
): string[] {
	const merged = [...existing];
	const seen = new Set(existing.map(normalizedAddress));
	for (const address of additions) {
		const key = normalizedAddress(address);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		merged.push(address.trim());
	}
	return merged;
}

export function serializeRecipients(addresses: readonly string[]): string {
	return addresses.join(", ");
}

/**
 * Why these recipients cannot be sent, in words a writer can act on, or null
 * when they can. Checked before every send so the server never has to reject
 * an address the composer already knew was wrong.
 */
export function recipientProblem(fields: RecipientFieldValues): string | null {
	const sendable = sendableRecipients(fields);
	if (sendable.to.length === 0) {
		return sendable.cc.length + sendable.bcc.length > 0
			? "Add at least one recipient in To."
			: "Add at least one recipient.";
	}
	const invalid = RECIPIENT_FIELDS.flatMap((field) =>
		sendable[field].filter((address) => !isValidRecipientAddress(address)),
	);
	if (invalid.length > 0) {
		const quoted = invalid.map((address) => `“${address}”`).join(", ");
		return invalid.length === 1
			? `${quoted} is not a valid email address. Fix or remove it before sending.`
			: `${quoted} are not valid email addresses. Fix or remove them before sending.`;
	}
	// The limit counts To, Cc and Bcc together, as the send API and SES do.
	const limit = RECIPIENT_MEMORY_LIMITS.maxRecipientsPerMessage;
	const total = sendable.to.length + sendable.cc.length + sendable.bcc.length;
	if (total > limit) {
		return `This message has ${total} recipients. One message can go to at most ${limit} people across To, Cc and Bcc.`;
	}
	return null;
}

/**
 * Values of one header from the stored `raw_headers` JSON. Received mail stores
 * the parsed `[{ key, value }]` list; anything else (sent mail keeps its own
 * snapshot there) has no headers to read.
 */
export function storedHeaderValues(
	rawHeaders: string | null | undefined,
	name: string,
): string[] {
	if (!rawHeaders) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawHeaders);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const wanted = name.toLowerCase();
	return parsed.flatMap((header) =>
		header &&
		typeof header === "object" &&
		typeof header.key === "string" &&
		typeof header.value === "string" &&
		header.key.toLowerCase() === wanted
			? [header.value]
			: [],
	);
}

export interface ReplySource {
	sender: string;
	recipient?: string | null;
	cc?: string | null;
	raw_headers?: string | null;
}

/**
 * Who a reply goes to, following what mail clients have taught people to
 * expect:
 * - Reply answers the Reply-To address when the sender set one (forms, lists,
 *   help desks), and the sender otherwise.
 * - Reply all adds everyone else the message was addressed to, and keeps the
 *   Cc list as Cc.
 * - Answering a message you sent yourself continues it, so it goes back to
 *   the people it went to instead of to you.
 * The mailbox itself is never a recipient unless nobody else is left.
 */
export function replyRecipientFields(input: {
	original: ReplySource;
	mailboxAddress: string;
	all: boolean;
}): { to: string; cc: string } {
	const { original, all } = input;
	const self = normalizedAddress(input.mailboxAddress);
	const isSelf = (address: string) =>
		self !== "" && normalizedAddress(address) === self;
	const originalTo = parseRecipientText(original.recipient ?? "");
	const originalCc = parseRecipientText(original.cc ?? "");
	const replyTo = storedHeaderValues(original.raw_headers, "reply-to")
		.flatMap(parseRecipientText)
		.filter(isValidRecipientAddress);
	const fromSelf = isSelf(original.sender);

	const sender = parseRecipientText(original.sender);
	// Our own message goes back to its To list, or to its Cc list when it was
	// addressed only by Cc.
	const ownRecipients = originalTo.length > 0 ? originalTo : originalCc;
	const primary = fromSelf
		? ownRecipients
		: replyTo.length > 0
			? replyTo
			: sender;
	const toCandidates = all && !fromSelf ? [...primary, ...originalTo] : primary;
	let to = mergeRecipients([], toCandidates.filter((address) => !isSelf(address)));
	let cc = all
		? mergeRecipients(to, originalCc.filter((address) => !isSelf(address))).slice(to.length)
		: [];
	if (to.length === 0 && cc.length > 0) {
		[to, cc] = [cc, []];
	} else if (to.length === 0) {
		to = mergeRecipients([], primary.length > 0 ? primary : sender);
	}
	return { to: serializeRecipients(to), cc: serializeRecipients(cc) };
}

export function filterRecipientSuggestions(
	suggestions: readonly RecipientSuggestion[],
	input: RecipientFieldValues & {
		mailboxAddress: string;
	},
): RecipientSuggestion[] {
	const excluded = new Set<string>([normalizedAddress(input.mailboxAddress)]);
	for (const field of RECIPIENT_FIELDS) {
		for (const address of parseRecipientText(input[field])) {
			excluded.add(normalizedAddress(address));
		}
	}
	return suggestions.filter(({ address }) => !excluded.has(normalizedAddress(address)));
}

export type RecipientComboboxAction =
	| { kind: "move"; index: number }
	| { kind: "accept"; index: number }
	| { kind: "close" }
	| { kind: "ignored" };

export function applyRecipientComboboxKeyEvent(
	event: {
		key: string;
		preventDefault: () => void;
		stopPropagation: () => void;
	},
	currentIndex: number,
	optionCount: number,
	isOpen: boolean,
): RecipientComboboxAction {
	const action = nextRecipientComboboxAction(
		event.key,
		currentIndex,
		optionCount,
		isOpen,
	);
	if (action.kind === "close") {
		event.preventDefault();
		event.stopPropagation();
	} else if (action.kind === "move" ||
		(action.kind === "accept" && event.key !== "Tab")) {
		event.preventDefault();
	}
	return action;
}

export function nextRecipientComboboxAction(
	key: string,
	currentIndex: number,
	optionCount: number,
	isOpen = optionCount > 0,
): RecipientComboboxAction {
	if (key === "Escape") return isOpen ? { kind: "close" } : { kind: "ignored" };
	if (optionCount <= 0) return { kind: "ignored" };
	if (key === "ArrowDown") {
		return { kind: "move", index: (currentIndex + 1 + optionCount) % optionCount };
	}
	if (key === "ArrowUp") {
		return {
			kind: "move",
			index: currentIndex <= 0 ? optionCount - 1 : currentIndex - 1,
		};
	}
	if ((key === "Enter" || key === "Tab") && currentIndex >= 0) {
		return { kind: "accept", index: currentIndex };
	}
	return { kind: "ignored" };
}
