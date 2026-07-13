import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { useUIStore } from "../hooks/useUIStore.ts";
import { ApiError } from "../services/api.ts";
import { FollowUpReminderApiError } from "../services/follow-up-reminders.ts";
import {
	isGlobalTodayAuthorizationError,
	purgeRemovedGlobalTodayMailboxes,
	recoverGlobalTodayReminderError,
} from "./global-today-recovery.ts";
import {
	readSemanticSearchSession,
	writeSemanticSearchSession,
} from "./semantic-search-session.ts";

test("a real reminder 403 purges scoped caches, aggregate data, and selected UI state", () => {
	const queryClient = new QueryClient();
	queryClient.setQueryData(["emails", "revoked@example.com"], { secret: true });
	queryClient.setQueryData(["emails", "kept@example.com"], { safe: true });
	queryClient.setQueryData(["global-today", "UTC"], { aggregate: true });
	queryClient.setQueryData(["global-today-brief", "UTC"], { sensitiveGuidance: true });
	useUIStore.getState().selectEmail("message-1");

	const feedback = recoverGlobalTodayReminderError(
		new FollowUpReminderApiError(403, "Forbidden", "FORBIDDEN"),
		"revoked@example.com",
		queryClient,
	);

	assert.equal(queryClient.getQueryData(["emails", "revoked@example.com"]), undefined);
	assert.deepEqual(queryClient.getQueryData(["emails", "kept@example.com"]), { safe: true });
	assert.equal(queryClient.getQueryData(["global-today", "UTC"]), undefined);
	assert.equal(queryClient.getQueryData(["global-today-brief", "UTC"]), undefined);
	assert.equal(useUIStore.getState().selectedEmailId, null);
	assert.equal(feedback.offerRefresh, undefined);
});

test("a reminder conflict retains the row cache and offers safe refresh", () => {
	const queryClient = new QueryClient();
	queryClient.setQueryData(["global-today", "UTC"], { row: "retained" });
	const feedback = recoverGlobalTodayReminderError(
		new FollowUpReminderApiError(409, "Conflict", "STATE_CONFLICT"),
		"team@example.com",
		queryClient,
	);
	assert.deepEqual(queryClient.getQueryData(["global-today", "UTC"]), { row: "retained" });
	assert.equal(feedback.offerRefresh, true);
});

test("a reminder 401 clears every cached Mailbox and routes to sign-in", () => {
	const queryClient = new QueryClient();
	queryClient.setQueryData(["emails", "team@example.com"], { secret: true });
	queryClient.setQueryData(["global-today", "UTC"], { aggregate: true });
	useUIStore.getState().selectEmail("message-1");
	writeSemanticSearchSession({
		actorEmail: "operator@example.com",
		createdAt: "2026-07-13T10:00:00.000Z",
		draftQuery: "private plan",
		submittedQuery: "private plan",
		response: { state: "complete", accessChanged: false, results: [], mailboxes: [] },
		expandedResultIds: [],
		scrollTop: 0,
	});
	const feedback = recoverGlobalTodayReminderError(
		new FollowUpReminderApiError(401, "Unauthorized"),
		"team@example.com",
		queryClient,
	);
	assert.equal(queryClient.getQueryCache().getAll().length, 0);
	assert.equal(useUIStore.getState().selectedEmailId, null);
	assert.equal(readSemanticSearchSession(), null);
	assert.equal(feedback.redirectTo, "/login");
});

test("roster diff purges only disappeared Mailbox state while preserving the fresh aggregate", () => {
	const queryClient = new QueryClient();
	queryClient.setQueryData(["emails", "revoked@example.com"], { secret: true });
	queryClient.setQueryData(["global-today", "UTC"], { fresh: true });
	queryClient.setQueryData(["global-today-brief", "UTC"], { sensitiveGuidance: true });
	assert.deepEqual(
		purgeRemovedGlobalTodayMailboxes(
			queryClient,
			new Set(["revoked@example.com", "kept@example.com"]),
			new Set(["kept@example.com"]),
		),
		["revoked@example.com"],
	);
	assert.equal(queryClient.getQueryData(["emails", "revoked@example.com"]), undefined);
	assert.deepEqual(queryClient.getQueryData(["global-today", "UTC"]), { fresh: true });
	assert.equal(queryClient.getQueryData(["global-today-brief", "UTC"]), undefined);
});

test("only aggregate authorization failures discard mounted sensitive content", () => {
	assert.equal(isGlobalTodayAuthorizationError(new ApiError(401, { error: "Unauthorized" })), true);
	assert.equal(isGlobalTodayAuthorizationError(new ApiError(403, { error: "Forbidden" })), true);
	assert.equal(isGlobalTodayAuthorizationError(new ApiError(502, { error: "Unavailable" })), false);
});
