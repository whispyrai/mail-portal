import assert from "node:assert/strict";
import test from "node:test";

import {
	resolveEmailListReadState,
	resolveEmailListRefetchInterval,
} from "./email-list-read-state.ts";

test("an initial failure is not presented as a loaded or empty folder", () => {
	assert.deepEqual(
		resolveEmailListReadState({
			hasResolvedData: false,
			isError: true,
		}),
		{
			content: "initial-error",
			showRefreshError: false,
		},
	);
});

test("a refresh failure preserves the last resolved folder truth", () => {
	assert.deepEqual(
		resolveEmailListReadState({
			hasResolvedData: true,
			isError: true,
		}),
		{
			content: "resolved",
			showRefreshError: true,
		},
	);
});

test("a successful retry clears both initial and refresh error presentation", () => {
	const retrying = resolveEmailListReadState({
		hasResolvedData: false,
		isError: true,
	});
	const recovered = resolveEmailListReadState({
		hasResolvedData: true,
		isError: false,
	});

	assert.equal(retrying.content, "initial-error");
	assert.deepEqual(recovered, {
		content: "resolved",
		showRefreshError: false,
	});
});

test("initial loading and a genuine resolved empty result remain distinct", () => {
	assert.deepEqual(
		resolveEmailListReadState({
			hasResolvedData: false,
			isError: false,
		}),
		{
			content: "loading",
			showRefreshError: false,
		},
	);
	assert.deepEqual(
		resolveEmailListReadState({
			hasResolvedData: true,
			isError: false,
		}),
		{
			content: "resolved",
			showRefreshError: false,
		},
	);
});

test("automatic polling pauses on failure and a manual recovery re-arms it", () => {
	assert.equal(
		resolveEmailListRefetchInterval({ isError: true, interval: 30_000 }),
		false,
	);
	assert.equal(
		resolveEmailListRefetchInterval({ isError: false, interval: 30_000 }),
		30_000,
	);
});
