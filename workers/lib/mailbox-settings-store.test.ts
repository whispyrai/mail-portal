import assert from "node:assert/strict";
import test from "node:test";
import {
	MailboxSettingsConflictError,
	mergeGeneralMailboxSettings,
	mergeSignatureMailboxSettings,
	updateMailboxSettings,
	type MailboxSettingsBucket,
} from "./mailbox-settings-store.ts";

function racingBucket(
	concurrentUpdate: (settings: Record<string, unknown>) => Record<string, unknown> =
		(settings) => ({ ...settings, fromName: "Concurrent admin" }),
) {
	let etag = "v1";
	let settings: Record<string, unknown> = {
		fromName: "Original",
		signature: { enabled: false, text: "Old" },
		forwarding: { enabled: true },
	};
	let conflictInjected = false;
	const bucket: MailboxSettingsBucket = {
		async get() {
			const snapshot = structuredClone(settings);
			return { etag, json: async () => snapshot };
		},
		async put(_key, value, options) {
			if (!conflictInjected) {
				conflictInjected = true;
				settings = concurrentUpdate(settings);
				etag = "v2";
			}
			if (options.onlyIf.etagMatches !== etag) return null;
			settings = JSON.parse(value);
			etag = "v3";
			return { etag };
		},
	};
	return { bucket, read: () => settings };
}

test("signature CAS retries against the latest ETag without erasing a concurrent unrelated update", async () => {
	const fixture = racingBucket();

	await updateMailboxSettings(
		fixture.bucket,
		"team@example.com",
		(current) => mergeSignatureMailboxSettings(current, { enabled: true, text: "New" }),
	);

	assert.deepEqual(fixture.read(), {
		fromName: "Concurrent admin",
		signature: { enabled: true, text: "New" },
		forwarding: { enabled: true },
	});
});

test("settings CAS stops after the bounded retry budget with a stable conflict", async () => {
	let writes = 0;
	const bucket: MailboxSettingsBucket = {
		async get() {
			return { etag: `v${writes}`, json: async () => ({ fromName: "Team" }) };
		},
		async put() {
			writes++;
			return null;
		},
	};

	await assert.rejects(
		updateMailboxSettings(bucket, "team@example.com", (settings) => settings),
		(error: unknown) =>
			error instanceof MailboxSettingsConflictError &&
			error.message === "Mailbox settings changed concurrently. Please retry.",
	);
	assert.equal(writes, 4);
});

test("general settings CAS preserves the latest signature and unrelated fields", async () => {
	const fixture = racingBucket((settings) => ({
		...settings,
		signature: { enabled: true, text: "Concurrent signature" },
	}));

	await updateMailboxSettings(
		fixture.bucket,
		"team@example.com",
		(current) => mergeGeneralMailboxSettings(current, {
			fromName: "Updated display name",
			signature: { enabled: false, text: "Stale form snapshot" },
		}),
	);

	assert.deepEqual(fixture.read(), {
		fromName: "Updated display name",
		signature: { enabled: true, text: "Concurrent signature" },
		forwarding: { enabled: true },
	});
});
