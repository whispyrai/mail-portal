import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchRelationshipBrief,
	RelationshipBriefApiError,
} from "./relationship-brief.ts";

const ready = {
	state: "generated",
	fingerprint: "fingerprint-1",
	generatedAt: "2026-07-12T10:00:00.000Z",
	brief: {
		topics: [{
			text: "Renewal timing",
			citations: [{
				messageId: "message-1",
				folderId: "inbox",
				subject: "Renewal",
				sentAt: "2026-07-12T09:00:00.000Z",
			}],
		}],
		openQuestions: [{
			askedBy: "them",
			text: "Can the start date move?",
			citations: [{
				messageId: "message-1",
				folderId: "inbox",
				subject: "Renewal",
				sentAt: "2026-07-12T09:00:00.000Z",
			}],
		}],
		commitments: [],
		importantConversations: [],
		suggestedNextStep: {
			text: "Review the requested date before replying.",
			citations: [{
				messageId: "message-1",
				folderId: "inbox",
				subject: "Renewal",
				sentAt: "2026-07-12T09:00:00.000Z",
			}],
			requiresHumanReview: true,
		},
		requiresHumanReview: true,
	},
};

test("relationship brief is requested only through the encoded explicit POST action", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const controller = new AbortController();
	const response = await fetchRelationshipBrief(
		"team+sales@example.com",
		"person/one",
		{ refresh: false },
		async (url, init) => {
			capturedUrl = String(url);
			capturedInit = init;
			return new Response(JSON.stringify(ready), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
		controller.signal,
	);

	assert.equal(
		capturedUrl,
		"/api/v1/mailboxes/team%2Bsales%40example.com/people/person%2Fone/relationship-brief",
	);
	assert.equal(capturedInit?.method, "POST");
	assert.equal(capturedInit?.body, JSON.stringify({ refresh: false }));
	assert.equal(capturedInit?.signal, controller.signal);
	assert.deepEqual(response, ready);
});

test("relationship brief parser rejects model-shaped links and non-fixed review claims", async () => {
	for (const invalid of [
		{ ...ready, brief: { ...ready.brief, requiresHumanReview: false } },
		{
			...ready,
			brief: {
				...ready.brief,
				topics: [{
					...ready.brief.topics[0],
					citations: [{ ...ready.brief.topics[0].citations[0], href: "/unsafe" }],
				}],
			},
		},
	]) {
		await assert.rejects(
			fetchRelationshipBrief("team@example.com", "person-1", { refresh: true }, async () =>
				new Response(JSON.stringify(invalid), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})),
			/invalid/i,
		);
	}
});

test("relationship brief preserves a direct forbidden status for synchronous surface exit", async () => {
	await assert.rejects(
		fetchRelationshipBrief("team@example.com", "person-1", { refresh: false }, async () =>
			new Response(JSON.stringify({ error: "Mailbox access changed" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			})),
		(error) => {
			assert.ok(error instanceof RelationshipBriefApiError);
			assert.equal(error.status, 403);
			assert.equal(error.message, "Mailbox access changed");
			return true;
		},
	);
});
