// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound-attachment limits and validation, shared by the worker (upload +
 * send enforcement) and the client (fast pre-upload feedback) so both agree on
 * exactly one set of rules.
 *
 * Limits are the "Moderate" tier chosen for the sales portal: generous enough
 * for proposals/decks, comfortably under SES's ~40 MB per-message ceiling after
 * base64 expansion (25 MB raw → ~33 MB encoded).
 */

export const ATTACHMENT_LIMITS = {
	/** Max number of files on a single message (compose, reply, bulk). */
	maxFiles: 10,
	/** Max size of any single file, in bytes. */
	maxFileBytes: 10 * 1024 * 1024, // 10 MB
	/** Max combined size of all files on a message, in bytes. */
	maxTotalBytes: 25 * 1024 * 1024, // 25 MB
} as const;

/**
 * File extensions Amazon SES refuses to deliver as attachments (its
 * "Unsupported attachment types" list). We reject these at upload time so the
 * rep gets an immediate, clear error instead of a deferred SES send failure.
 * Source: https://docs.aws.amazon.com/ses/latest/dg/mime-types-appendix.html
 */
export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
	"ade", "adp", "app", "asp", "bas", "bat", "cer", "chm", "cmd", "com", "cpl",
	"crt", "csh", "der", "exe", "fxp", "gadget", "hlp", "hta", "inf", "ins",
	"isp", "its", "js", "jse", "ksh", "lib", "lnk", "mad", "maf", "mag", "mam",
	"maq", "mar", "mas", "mat", "mau", "mav", "maw", "mda", "mdb", "mde", "mdt",
	"mdw", "mdz", "msc", "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml",
	"msi", "msp", "mst", "ops", "pcd", "pif", "plg", "prf", "prg", "reg", "scf",
	"scr", "sct", "shb", "shs", "sys", "ps1", "ps1xml", "ps2", "ps2xml", "psc1",
	"psc2", "tmp", "url", "vb", "vbe", "vbs", "vps", "vsmacros", "vss", "vst",
	"vsw", "vxd", "ws", "wsc", "wsf", "wsh", "xnk",
]);

/** Lowercased extension without the dot (`"report.PDF"` → `"pdf"`), or `""`. */
export function attachmentExtension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	if (dot < 0 || dot === filename.length - 1) return "";
	return filename.slice(dot + 1).toLowerCase();
}

/** A blocked extension cannot be delivered by SES. */
export function isBlockedAttachment(filename: string): boolean {
	return BLOCKED_ATTACHMENT_EXTENSIONS.has(attachmentExtension(filename));
}

/** Human-readable byte size, e.g. `"4.2 MB"`. */
export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate one file in isolation (type + per-file size). Returns an error
 * message, or `null` if the file is acceptable on its own.
 */
export function validateSingleFile(file: { filename: string; size: number }): string | null {
	if (isBlockedAttachment(file.filename)) {
		const ext = attachmentExtension(file.filename) || "this type";
		return `${file.filename}: .${ext} files can't be emailed.`;
	}
	if (file.size <= 0) {
		return `${file.filename} is empty.`;
	}
	if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
		return `${file.filename} is ${formatAttachmentSize(file.size)} — over the ${formatAttachmentSize(ATTACHMENT_LIMITS.maxFileBytes)} per-file limit.`;
	}
	return null;
}

/**
 * Validate a complete set of files (each file + count + combined size).
 * Returns an error message, or `null` if the whole set is acceptable. Used
 * server-side as the authoritative gate and client-side before sending.
 */
export function validateAttachmentSet(files: { filename: string; size: number }[]): string | null {
	if (files.length > ATTACHMENT_LIMITS.maxFiles) {
		return `Too many files: max ${ATTACHMENT_LIMITS.maxFiles} per message.`;
	}
	let total = 0;
	for (const file of files) {
		const single = validateSingleFile(file);
		if (single) return single;
		total += file.size;
	}
	if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
		return `Attachments total ${formatAttachmentSize(total)} — over the ${formatAttachmentSize(ATTACHMENT_LIMITS.maxTotalBytes)} limit.`;
	}
	return null;
}
