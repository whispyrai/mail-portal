import assert from "node:assert/strict";
import test from "node:test";
import { buildThreadingHeaders } from "./email-helpers.ts";

const token = "thread-t1@wiserchat.ai";

test("a reply references its original and ends References with the thread token", () => {
	assert.deepEqual(
		buildThreadingHeaders("b@mail.example", ["a@mail.example", "b@mail.example"], token),
		{
			"In-Reply-To": "<b@mail.example>",
			References: `<a@mail.example> <b@mail.example> <${token}>`,
		},
	);
});

test("answering mail we sent never emits SES's bare internal id", () => {
	const sesId = "0102019a1b2c3d4e-5f6a7b8c-0000-0000-0000-000000000000-000000";
	const headers = buildThreadingHeaders(
		sesId,
		["customer-1@mail.example", token, sesId],
		token,
	);
	assert.equal(headers["In-Reply-To"], "<customer-1@mail.example>");
	assert.equal(headers.References, `<customer-1@mail.example> <${token}>`);
	assert.doesNotMatch(JSON.stringify(headers), new RegExp(sesId));
});

test("a long thread's References stays inside the SES header limit", () => {
	const ids = Array.from(
		{ length: 40 },
		(_, index) => `CAJ${String(index).padStart(3, "0")}xV8h2kq9QnLm4Rz7Wb1Tc6Yd3Fe5Gh0Jk@mail.gmail.com`,
	);
	const headers = buildThreadingHeaders(ids.at(-1)!, ids, token);
	const references = headers.References!;
	assert.ok(`References${references}`.length <= 996, `${references.length} characters`);
	const kept = references.split(" ");
	assert.equal(kept[0], `<${ids[0]}>`, "the thread root survives");
	assert.equal(kept.at(-1), `<${token}>`, "the thread token survives");
	assert.equal(kept.at(-2), `<${ids.at(-1)}>`, "the newest message survives");
	assert.equal(headers["In-Reply-To"], `<${ids.at(-1)}>`);
});

test("a new message carries only the thread token", () => {
	assert.deepEqual(buildThreadingHeaders(null, [], token), {
		References: `<${token}>`,
	});
});

test("an oversized first id is dropped before the thread token or newest ids", () => {
	const oversizedRoot = `${"x".repeat(990)}@mail.example`;
	const headers = buildThreadingHeaders(
		"newest@mail.example",
		[oversizedRoot, "middle@mail.example", "newest@mail.example"],
		token,
	);
	assert.equal(
		headers.References,
		`<middle@mail.example> <newest@mail.example> <${token}>`,
	);
	assert.ok(`References${headers.References}`.length <= 996);
});

test("someone else's id that starts with thread- is still a real reply target", () => {
	const sesId = "0102019a1b2c3d4e-5f6a7b8c-0000-0000-0000-000000000000-000000";
	const headers = buildThreadingHeaders(
		sesId,
		["first@mail.example", "thread-77@other-service.example", token],
		token,
	);
	assert.equal(headers["In-Reply-To"], "<thread-77@other-service.example>");
});

test("a first id that nearly fills the limit never pushes out the thread token", () => {
	const longRoot = `${"y".repeat(960)}@mail.example`;
	const headers = buildThreadingHeaders(
		"newest@mail.example",
		[longRoot, "newest@mail.example"],
		token,
	);
	assert.equal(headers.References, `<newest@mail.example> <${token}>`);
});
