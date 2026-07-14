import assert from "node:assert/strict";
import test from "node:test";
import {
	LiveReadAuthorizationError,
	LiveReadAuthorizationUnavailableError,
	runLiveAuthorizedMutation,
	runLiveAuthorizedRead,
} from "./live-authorized-read.ts";

test("live-authorized reads require access before storage work", async () => {
	let reads = 0;
	await assert.rejects(
		() => runLiveAuthorizedRead(async () => false, async () => {
			reads += 1;
			return "private mail";
		}),
		LiveReadAuthorizationError,
	);
	assert.equal(reads, 0);
});

test("live-authorized mutations never turn a committed result into a false failure", async () => {
	let checks = 0;
	assert.deepEqual(
		await runLiveAuthorizedMutation(
			async () => {
				checks += 1;
				return true;
			},
			async () => ({ draftId: "draft-1" }),
		),
		{ draftId: "draft-1" },
	);
	assert.equal(checks, 1);

	let mutations = 0;
	await assert.rejects(
		() => runLiveAuthorizedMutation(async () => false, async () => {
			mutations += 1;
		}),
		LiveReadAuthorizationError,
	);
	assert.equal(mutations, 0);
});

test("live-authorized reads discard successful output after in-flight revocation", async () => {
	let checks = 0;
	await assert.rejects(
		() => runLiveAuthorizedRead(
			async () => ++checks === 1,
			async () => ({ subject: "private mail" }),
		),
		LiveReadAuthorizationError,
	);
	assert.equal(checks, 2);
});

test("revocation wins over a concurrent private storage failure", async () => {
	let checks = 0;
	await assert.rejects(
		() => runLiveAuthorizedRead(
			async () => ++checks === 1,
			async () => {
				throw new Error("private storage detail");
			},
		),
		LiveReadAuthorizationError,
	);
});

test("authorized reads preserve successful values and storage failures", async () => {
	assert.deepEqual(
		await runLiveAuthorizedRead(async () => true, async () => ({ id: "mail-1" })),
		{ id: "mail-1" },
	);
	await assert.rejects(
		() => runLiveAuthorizedRead(async () => true, async () => {
			throw new TypeError("storage unavailable");
		}),
		TypeError,
	);
});

test("post-read authorization outages suppress private results and storage failures", async () => {
	for (const read of [
		async () => ({ subject: "private mail" }),
		async () => {
			throw new Error("private storage detail");
		},
	]) {
		let checks = 0;
		await assert.rejects(
			() => runLiveAuthorizedRead(
				async () => {
					checks += 1;
					if (checks === 2) throw new Error("private SQL detail");
					return true;
				},
				read,
			),
			(error: unknown) => {
				assert.ok(error instanceof LiveReadAuthorizationUnavailableError);
				assert.doesNotMatch(error.message, /private/);
				return true;
			},
		);
	}
});
