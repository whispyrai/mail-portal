const SUBJECT_SCAN_LIMIT = 500;
const BODY_SCAN_LIMIT = 20_000;
const BODY_HTML_SCAN_LIMIT = BODY_SCAN_LIMIT * 10;
const VOID_TAGS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
	"meta", "param", "source", "track", "wbr",
]);
const BLOCK_TAGS = new Set([
	"address", "article", "aside", "blockquote", "div", "footer", "header",
	"h1", "h2", "h3", "h4", "h5", "h6", "li", "main", "nav", "p",
	"section", "table", "td", "th", "tr",
]);

const ATTACHMENT_OBJECT =
	"(?:files?|documents?|reports?|invoices?|agreements?|proposals?|decks?|presentations?|spreadsheets?|workbooks?|images?|photos?|screenshots?|copies?|revisions?|pdfs?)";
const INCLUDED_ATTACHMENT = new RegExp(
	String.raw`\b(?:i|we)(?:['’]ve|\s+have|\s+just)?\s+included\s+(?:(?:the|a|an|this|that|our|my|your)\s+)?(?:[\w'’-]+\s+){0,3}${ATTACHMENT_OBJECT}\b`,
	"i",
);
const NON_ATTACHMENT_SUFFIX =
	String.raw`(?!\s+(?:importance|myself|ourselves|yourself|yourselves|themselves)\b)`;

const ATTACHMENT_INTENT = [
	new RegExp(
		String.raw`\b(?:i\s+am|we\s+are|i['’]m|we['’]re)\s+attaching\b${NON_ATTACHMENT_SUFFIX}`,
		"i",
	),
	new RegExp(
		String.raw`\b(?:i|we)(?:['’]ve|\s+have|\s+just)?\s+attached\b${NON_ATTACHMENT_SUFFIX}`,
		"i",
	),
	INCLUDED_ATTACHMENT,
	/\b(?:please|kindly)\s+(?:find|see|review)\s+(?:the\s+)?attached\b/i,
	/\b(?:see|find|review)\s+(?:the\s+)?attachments?\b(?!\s+(?:policy|settings?|rules?|guidelines?|configuration)\b)/i,
	/\battached\s+(?:is|are)\b/i,
	/\battached\b(?=\s*[:\-–—])/i,
];

function decodeCommonEntities(value: string): string {
	return value
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#(?:39|8217);|&#x(?:27|2019);|&apos;|&rsquo;/gi, "'");
}

function hasVersionedAttribute(token: string, expectedName: string): boolean {
	const opening = token.match(/^<\s*\/?\s*[a-z][a-z0-9-]*\b/i);
	if (!opening) return false;
	let index = opening[0].length;

	while (index < token.length) {
		while (/\s/.test(token[index] ?? "")) index += 1;
		if (token[index] === ">" || token[index] === "/") break;

		const nameStart = index;
		while (index < token.length && !/[\s=/>]/.test(token[index] ?? "")) {
			index += 1;
		}
		if (index === nameStart) {
			index += 1;
			continue;
		}
		const name = token.slice(nameStart, index).toLowerCase();
		while (/\s/.test(token[index] ?? "")) index += 1;

		let value: string | null = null;
		if (token[index] === "=") {
			index += 1;
			while (/\s/.test(token[index] ?? "")) index += 1;
			const quote = token[index];
			if (quote === '"' || quote === "'") {
				index += 1;
				const valueStart = index;
				while (index < token.length && token[index] !== quote) index += 1;
				value = token.slice(valueStart, index);
				if (token[index] === quote) index += 1;
			} else {
				const valueStart = index;
				while (index < token.length && !/[\s/>]/.test(token[index] ?? "")) {
					index += 1;
				}
				value = token.slice(valueStart, index);
			}
		}

		if (name === expectedName && value?.toLowerCase() === "v1") return true;
	}
	return false;
}

function boundedAuthoredText(bodyHtml: string): string {
	const source = bodyHtml.slice(0, BODY_HTML_SCAN_LIMIT);
	const stack: Array<{ tagName: string; ignored: boolean }> = [];
	let ignoredDepth = 0;
	let visible = "";
	let pendingSpace = false;

	const appendVisible = (value: string) => {
		for (const character of decodeCommonEntities(value)) {
			if (/\s/.test(character)) {
				pendingSpace = visible.length > 0;
				continue;
			}
			if (pendingSpace && visible.length < BODY_SCAN_LIMIT) visible += " ";
			pendingSpace = false;
			if (visible.length >= BODY_SCAN_LIMIT) return;
			visible += character;
		}
	};

	for (const match of source.matchAll(/<[^>]*>|[^<]+/g)) {
		if (visible.length >= BODY_SCAN_LIMIT) break;
		const token = match[0];
		if (!token.startsWith("<")) {
			if (ignoredDepth === 0) appendVisible(token);
			continue;
		}

		const parsed = token.match(/^<\s*(\/?)\s*([a-z][a-z0-9-]*)\b/i);
		if (!parsed) continue;
		const closing = parsed[1] === "/";
		const tagName = parsed[2].toLowerCase();
		if (closing) {
			while (stack.length > 0) {
				const entry = stack.pop();
				if (!entry) break;
				if (entry.ignored) ignoredDepth -= 1;
				if (entry.tagName === tagName) break;
			}
			if (ignoredDepth === 0 && BLOCK_TAGS.has(tagName)) appendVisible(" ");
			continue;
		}

		if (
			ignoredDepth === 0 &&
			tagName === "div" &&
			hasVersionedAttribute(token, "data-mail-forwarded-message")
		) break;
		const ignored =
			tagName === "blockquote" ||
			tagName === "script" ||
			tagName === "style" ||
			tagName === "template" ||
			(tagName === "div" &&
				(hasVersionedAttribute(token, "data-mail-signature") ||
					hasVersionedAttribute(token, "data-mail-quoted")));
		if (ignored) ignoredDepth += 1;
		if (ignoredDepth === 0 && (tagName === "br" || BLOCK_TAGS.has(tagName))) {
			appendVisible(" ");
		}
		if (!VOID_TAGS.has(tagName) && !/\/\s*>$/.test(token)) {
			stack.push({ tagName, ignored });
		} else if (ignored) {
			ignoredDepth -= 1;
		}
	}

	return visible.trim();
}

export function shouldWarnMissingAttachment(input: {
	subject: string;
	bodyHtml: string;
	attachments: ReadonlyArray<{
		status: string;
		disposition?: "attachment" | "inline";
	}>;
}): boolean {
	const hasReadyOrdinaryAttachment = input.attachments.some(
		(attachment) =>
			attachment.status === "ready" &&
			attachment.disposition !== "inline",
	);
	if (hasReadyOrdinaryAttachment) return false;
	const scanText = `${input.subject.slice(0, SUBJECT_SCAN_LIMIT)} ${boundedAuthoredText(input.bodyHtml)}`;
	return ATTACHMENT_INTENT.some((pattern) => pattern.test(scanText));
}

export function composeMissingAttachmentFingerprint(input: {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	bodyHtml: string;
	scheduledFor: string | null;
	attachments: ReadonlyArray<{
		localId?: string;
		filename: string;
		mimetype?: string;
		size?: number;
		status: string;
		error?: string;
		uploadId?: string;
		existing?: { emailId: string; attachmentId: string };
		disposition?: "attachment" | "inline";
		contentId?: string;
	}>;
}): string {
	return JSON.stringify({
		to: input.to,
		cc: input.cc,
		bcc: input.bcc,
		subject: input.subject,
		bodyHtml: input.bodyHtml,
		scheduledFor: input.scheduledFor,
		attachments: input.attachments.map((attachment) => ({
			localId: attachment.localId,
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			size: attachment.size,
			status: attachment.status,
			error: attachment.error,
			uploadId: attachment.uploadId,
			existing: attachment.existing,
			disposition: attachment.disposition ?? "attachment",
			contentId: attachment.contentId,
		})),
	});
}
