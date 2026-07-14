import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { Env } from "../types.ts";
import type { SessionClaims } from "../lib/auth.ts";
import { bulkPage } from "./bulk.ts";

type BulkPageContext = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

test("bulk page keeps one immutable operation across an unconfirmed retry", async () => {
	const app = new Hono<BulkPageContext>();
	app.use("*", async (c, next) => {
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.get("/bulk", bulkPage);
	const response = await app.request(
		"http://mail.example.com/bulk",
		undefined,
		{
			BRAND: "wiser",
		} as never,
	);
	const html = await response.text();

	assert.equal(response.status, 200);
	assert.match(html, /operationId: crypto\.randomUUID\(\)/);
	assert.match(html, /body: JSON\.stringify\(pendingSubmission\)/);
	assert.match(html, /window\.sessionStorage/);
	assert.match(html, /recoverPendingOperation/);
	assert.match(html, /\/operations\//);
	assert.match(html, /\/reserve'/);
	assert.match(html, /storePendingOperation\(candidateSubmission\.operationId\)/);
	assert.match(html, /JSON\.stringify\(\{ operationId, reservationRequestedAt \}\)/);
	assert.match(html, /markReservationRequested\(operationId\)/);
	assert.match(html, /clearPendingOperation/);
	assert.match(html, /ATTACH = \[\];[\s\S]*renderAttach\(\);[\s\S]*j\.status === 'failed'/);
	assert.match(html, /confirmationMode === 'uncertain'/);
	assert.doesNotMatch(html, /sessionStorage\.setItem\([^\n]*JSON\.stringify\(candidateSubmission\)/);
	assert.match(html, /Retry safely/);
	assert.match(html, /Preparing one durable job/);
	assert.match(html, /file\.size > CFG\.bulkLimits\.requestBytes/);
	assert.match(
		html,
		/new TextEncoder\(\)\.encode\(JSON\.stringify\(candidateSubmission\)\)/,
	);
	assert.match(html, /ROWS\.length > CFG\.bulkLimits\.maxRecipients/);
	assert.match(html, /new Set\(header\)\.size !== header\.length/);
	assert.match(html, /response\.status === 429/);
	assert.match(html, /Start a new submission after/);
	assert.match(html, /clearPendingOperation\(pendingSubmission\.operationId\)/);
	assert.match(html, /cancelPendingReservation/);
	assert.match(html, /submitConfirmText.*tabindex="-1"/);
	assert.match(html, /label for="csv"/);
	assert.match(html, /'Remove ' \+ a\.filename/);
	assert.match(html, /function attachFailed\(\)/);
	assert.match(html, /Retry or remove every failed attachment before sending/);
	assert.match(html, /<ul id="attachList"[^>]*aria-label="Attachments"/);
	assert.match(html, /id="attachStatus"[^>]*role="status"[^>]*aria-live="polite"/);
	assert.doesNotMatch(html, /id="attachList"[^>]*role="status"/);
	assert.match(html, /localId: crypto\.randomUUID\(\), file/);
	assert.match(html, /function uploadAttachmentEntry\(entry\)/);
	assert.match(html, /encodeURIComponent\(entry\.localId\)/);
	assert.match(html, /method: 'PUT'/);
	assert.match(html, /'Retry ' \+ a\.filename/);
	assert.match(html, /uploadAttachmentEntry\(a\)/);
	assert.match(html, /function attachmentRetryAdmissionError\(entry\)/);
	assert.match(html, /const admissionError = attachmentRetryAdmissionError\(entry\)/);
	assert.match(html, /a\.controller\?\.abort\(\)/);
	assert.doesNotMatch(html, /if \(a\.status !== 'uploading'\)/);
	assert.match(html, /Attachments \(' \+ names\.length \+ '\): ' \+ names\.join/);
	assert.match(html, /\$\('sendBtn'\)\.focus\(\)/);
	assert.match(html, /charCodeAt\(0\) === 0xFEFF/);
	assert.match(html, /A quoted CSV value is not closed/);
	assert.match(html, /aria-valuenow/);
	assert.match(html, /errorsTruncated/);
	assert.match(html, /r\.status === 401 \|\| r\.status === 403/);
	assert.match(html, /if \(r\.status === 404\)/);
	assert.match(html, /The operation identity is preserved/);
	assert.match(html, /CFG\.bulkLimits\.reservationTtlMs/);
	assert.match(html, /response\.status === 202 && result\.state === 'reserved'/);
	assert.doesNotMatch(
		html,
		/sessionStorage[\s\S]{0,300}subject|sessionStorage[\s\S]{0,300}recipients/,
	);
	assert.doesNotMatch(html, /if \(!confirm\(/);
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script);
	const validatorSource = script.match(
		/function isConfirmedAttachmentUploadResponse\(result, entry\) \{[\s\S]*?\n\}/,
	)?.[0];
	assert.ok(validatorSource);
	const validate = new Function(
		`${validatorSource}; return isConfirmedAttachmentUploadResponse;`,
	)() as (
		result: unknown,
		entry: { localId: string; file: { size: number } },
	) => boolean;
	const entry = {
		localId: "95f6a780-cb27-4df2-a9da-49347f7c3d22",
		file: { size: 3 },
	};
	const valid = {
		uploadId: entry.localId,
		filename: "report.pdf",
		mimetype: "application/pdf",
		size: 3,
		replayed: false,
	};
	assert.equal(validate(valid, entry), true);
	for (const malformed of [
		null,
		{},
		{ ...valid, uploadId: "other" },
		{ ...valid, filename: "" },
		{ ...valid, filename: 7 },
		{ ...valid, mimetype: "" },
		{ ...valid, mimetype: 7 },
		{ ...valid, size: 4 },
		{ ...valid, replayed: "false" },
	]) {
		assert.equal(validate(malformed, entry), false);
	}
	assert.match(
		html,
		/else if \(!isConfirmedAttachmentUploadResponse\(result, entry\)\)/,
	);
	assert.doesNotThrow(() => new Function(script));
});
