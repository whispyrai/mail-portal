import assert from "node:assert/strict";
import test from "node:test";
import type { MailboxRow } from "../db/users-schema.ts";
import type { SemanticIndexReadiness } from "./semantic-index.ts";
import {
	SemanticSearchCapacityError,
	searchSemanticEvidence,
	type GlobalSemanticSearchDependencies,
} from "./global-semantic-search.ts";

function mailbox(address: string): MailboxRow {
	return {
		id: `mailbox-${address}`,
		address,
		type: "SHARED",
		owner_user_id: null,
		is_active: 1,
		created_at: 1,
		updated_at: 1,
	};
}

function readiness(state: SemanticIndexReadiness["state"]): SemanticIndexReadiness {
	return {
		state,
		processedMessages: 1,
		pendingJobs: state === "building" ? 1 : 0,
		submittedJobs: 0,
		sourceCurrentThrough: 1,
		currentSequence: 1,
	};
}

function setup(input?: {
	rosters?: MailboxRow[][];
	readiness?: Record<string, SemanticIndexReadiness["state"]>;
	postReadiness?: Record<string, SemanticIndexReadiness["state"]>;
	revoked?: string[];
}) {
	const rosters = input?.rosters ?? [[mailbox("one@example.com")]];
	let rosterRead = 0;
	let embeddingCalls = 0;
	const scheduled: string[] = [];
	const dependencies: GlobalSemanticSearchDependencies = {
		async listAccessibleMailboxes() {
			const roster = rosters[Math.min(rosterRead, rosters.length - 1)]!;
			rosterRead += 1;
			return roster;
		},
		async canAccessMailbox(_actor, mailboxId) {
			return !(input?.revoked ?? []).includes(mailboxId);
		},
		async readReadiness(mailboxId) {
			return readiness(input?.readiness?.[mailboxId] ?? "complete");
		},
		scheduleAdvance(mailboxId) {
			scheduled.push(mailboxId);
		},
		async embedQuery() {
			embeddingCalls += 1;
			return [1, 0];
		},
		async queryIndex({ mailboxId }) {
			return [{ vectorId: `vector-${mailboxId}`, score: mailboxId.startsWith("one") ? 0.9 : 0.8 }];
		},
		async resolveCandidates({ mailboxId, candidates }) {
			return {
				readiness: readiness(input?.postReadiness?.[mailboxId] ?? "complete"),
				candidates: candidates.map((candidate) => ({
					...candidate,
					messageId: `message-${mailboxId}`,
					subject: `Subject ${mailboxId}`,
					sender: "sender@example.com",
					recipient: mailboxId,
					date: "2026-07-13T08:00:00.000Z",
					folderId: "inbox",
					excerpt: `Evidence ${mailboxId}`,
				})),
			};
		},
	};
	return {
		dependencies,
		scheduled,
		embeddingCalls: () => embeddingCalls,
	};
}

test("semantic evidence searches complete Mailboxes once and reports building Mailboxes honestly", async () => {
	const state = setup({
		rosters: [[mailbox("one@example.com"), mailbox("two@example.com")]],
		readiness: { "two@example.com": "building" },
	});
	const response = await searchSemanticEvidence(state.dependencies, {
		actorUserId: "user-1",
		query: "contract timing",
	});
	assert.equal(response.state, "partial");
	assert.equal(response.results.length, 1);
	assert.equal(response.results[0]?.mailboxId, "one@example.com");
	assert.deepEqual(state.scheduled, ["two@example.com"]);
	assert.equal(state.embeddingCalls(), 1);
});

test("semantic evidence rechecks post-hydration readiness before a zero-result claim", async () => {
	const state = setup({ postReadiness: { "one@example.com": "building" } });
	const response = await searchSemanticEvidence(state.dependencies, {
		actorUserId: "user-1",
		query: "missing meaning",
	});
	assert.equal(response.state, "building");
	assert.deepEqual(response.results, []);
	assert.deepEqual(state.scheduled, ["one@example.com"]);
});

test("semantic evidence retries roster drift and never returns revoked Mailbox content", async () => {
	const one = mailbox("one@example.com");
	const two = mailbox("two@example.com");
	const state = setup({
		rosters: [[one, two], [one], [one], [one]],
	});
	const response = await searchSemanticEvidence(state.dependencies, {
		actorUserId: "user-1",
		query: "evidence",
	});
	assert.equal(response.accessChanged, true);
	assert.deepEqual(response.results.map((result) => result.mailboxId), ["one@example.com"]);
	assert.equal(state.embeddingCalls(), 1);

	const revoked = setup({ revoked: ["one@example.com"] });
	const revokedResponse = await searchSemanticEvidence(revoked.dependencies, {
		actorUserId: "user-1",
		query: "private evidence",
	});
	assert.equal(revokedResponse.state, "unavailable");
	assert.equal(revokedResponse.accessChanged, true);
	assert.deepEqual(revokedResponse.results, []);
});

test("semantic evidence bounds a stalled Mailbox and returns the remaining evidence", async () => {
	const state = setup({
		rosters: [[mailbox("one@example.com"), mailbox("two@example.com")]],
	});
	state.dependencies.queryIndex = async ({ mailboxId }) => {
		if (mailboxId === "one@example.com") return new Promise(() => undefined);
		return [{ vectorId: "vector-two", score: 0.8 }];
	};
	const response = await searchSemanticEvidence(state.dependencies, {
		actorUserId: "user-1",
		query: "evidence",
	}, {
		requestMs: 100,
		rosterMs: 50,
		readinessMs: 50,
		embeddingMs: 50,
		mailboxMs: 10,
	});
	assert.equal(response.state, "partial");
	assert.deepEqual(response.results.map((result) => result.mailboxId), ["two@example.com"]);
	assert.deepEqual(response.mailboxes, [
		{ mailboxId: "one@example.com", mailboxAddress: "one@example.com", state: "unavailable" },
		{ mailboxId: "two@example.com", mailboxAddress: "two@example.com", state: "complete" },
	]);
});

test("semantic evidence makes complete zero-results and capacity limits explicit", async () => {
	const state = setup();
	state.dependencies.queryIndex = async () => [];
	const response = await searchSemanticEvidence(state.dependencies, {
		actorUserId: "user-1",
		query: "no match",
	});
	assert.equal(response.state, "complete");
	assert.deepEqual(response.results, []);

	const overflow = setup({
		rosters: [Array.from({ length: 21 }, (_, index) => mailbox(`${index}@example.com`))],
	});
	await assert.rejects(searchSemanticEvidence(overflow.dependencies, {
		actorUserId: "user-1",
		query: "anything",
	}), SemanticSearchCapacityError);
	assert.equal(overflow.embeddingCalls(), 0);
});
