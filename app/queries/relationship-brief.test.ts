import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { RelationshipBriefResponse } from "../services/relationship-brief.ts";
import { RelationshipBriefApiError } from "../services/relationship-brief.ts";
import {
	exitRevokedMailbox,
	mailboxChangeCursorStorageKey,
} from "./mailbox-change-feed.ts";
import {
	buildRelationshipBriefMutationOptions,
	isCurrentRelationshipBriefRequest,
	relationshipBriefKey,
} from "./relationship-brief.ts";

const unavailable: RelationshipBriefResponse = { state: "unavailable" };

test("relationship brief cache is mailbox and Person scoped outside deterministic People", () => {
	assert.deepEqual(
		relationshipBriefKey("team@example.com", "person-1"),
		["relationship-brief", "team@example.com", "person-1"],
	);
});

test("manual mutations retain no inactive second copy of cited output", () => {
	const options = buildRelationshipBriefMutationOptions(new QueryClient());
	assert.equal(options.gcTime, 0);
});

test("a forbidden manual request reports the exact origin mailbox before rejecting", async () => {
	const queryClient = new QueryClient();
	const revoked: Array<[string, boolean]> = [];
	const options = buildRelationshipBriefMutationOptions(
		queryClient,
		async () => {
			throw new RelationshipBriefApiError(403, "Mailbox access changed");
		},
		() => true,
		(mailboxId, active) => revoked.push([mailboxId, active]),
	);
	const controller = new AbortController();
	await assert.rejects(
		options.mutationFn({
			mailboxId: "origin@example.com",
			personId: "person-1",
			refresh: false,
			attemptId: 1,
			signal: controller.signal,
		}),
		/changed/i,
	);
	assert.deepEqual(revoked, [["origin@example.com", true]]);
});

test("only an explicit generate or refresh mutation can request and cache a brief", async () => {
	const queryClient = new QueryClient();
	const calls: Array<[string, string, boolean, AbortSignal | undefined]> = [];
	const options = buildRelationshipBriefMutationOptions(
		queryClient,
		async (mailboxId, personId, input, signal) => {
			calls.push([mailboxId, personId, input.refresh, signal]);
			return unavailable;
		},
	);
	const variables = {
		mailboxId: "team@example.com",
		personId: "person-1",
		refresh: false,
		attemptId: 1,
		signal: new AbortController().signal,
	};
	const response = await options.mutationFn(variables);
	assert.deepEqual(calls, [["team@example.com", "person-1", false, variables.signal]]);
	options.onSuccess(response, variables);
	assert.deepEqual(
		queryClient.getQueryData(relationshipBriefKey(variables.mailboxId, variables.personId)),
		unavailable,
	);

	assert.equal(isCurrentRelationshipBriefRequest(variables, "team@example.com", "person-1"), true);
	assert.equal(isCurrentRelationshipBriefRequest(variables, "other@example.com", "person-1"), false);
	assert.equal(isCurrentRelationshipBriefRequest(undefined, "team@example.com", "person-1"), false);
});

test("an inactive old-Mailbox attempt cannot exit the current surface or cache a late result", async () => {
	const queryClient = new QueryClient();
	const revoked: Array<[string, boolean]> = [];
	let exits = 0;
	let active = false;
	const controller = new AbortController();
	const variables = {
		mailboxId: "old@example.com",
		personId: "person-old",
		refresh: false,
		attemptId: 7,
		signal: controller.signal,
	};
	const options = buildRelationshipBriefMutationOptions(
		queryClient,
		async () => {
			throw new RelationshipBriefApiError(403, "Old access changed");
		},
		() => active,
		(mailboxId, isActive) => {
			revoked.push([mailboxId, isActive]);
			exitRevokedMailbox({
				queryClient,
				mailboxId,
				storage,
				...(isActive ? { onExit: () => { exits += 1; } } : {}),
			});
		},
	);
	const cursorKey = mailboxChangeCursorStorageKey("old@example.com");
	const stored = new Map([[cursorKey, "private-cursor"]]);
	const storage = {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => { stored.set(key, value); },
		removeItem: (key: string) => { stored.delete(key); },
	};
	queryClient.setQueryData(relationshipBriefKey("old@example.com", "person-old"), {
		state: "unavailable",
	});
	queryClient.setQueryData(relationshipBriefKey("current@example.com", "person-current"), {
		state: "unavailable",
	});

	await assert.rejects(options.mutationFn(variables), /Old access changed/);
	options.onSuccess(unavailable, variables);

	assert.deepEqual(revoked, [["old@example.com", false]]);
	assert.equal(stored.has(cursorKey), false);
	assert.equal(exits, 0);
	assert.equal(
		queryClient.getQueryData(relationshipBriefKey("old@example.com", "person-old")),
		undefined,
	);
	assert.deepEqual(
		queryClient.getQueryData(relationshipBriefKey("current@example.com", "person-current")),
		unavailable,
	);

	active = true;
	await assert.rejects(options.mutationFn(variables), /Old access changed/);
	assert.deepEqual(revoked, [
		["old@example.com", false],
		["old@example.com", true],
	]);
	assert.equal(exits, 1);
});
