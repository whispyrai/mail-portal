import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_INBOUND_DERIVED_GENERATION,
	MAX_INBOUND_EMAIL_BYTES,
	projectInboundDerivedContentManifest,
} from "./inbound-projection-contract.ts";

function liveManifest() {
	return {
		status: "live_inbound" as const,
		generation: 2,
		lastRepairMarkerId: "marker_12345678",
		attachments: [
			{
				id: "attachment-1",
				r2Key: "attachments/mail-123/attempt-1/file.bin",
				byteLength: 10,
			},
		],
		bodyObjects: [
			{
				id: "body-1",
				r2Key: "email-bodies/mail-123/attempt-1/0.body",
				byteLength: 20,
			},
		],
	};
}

test("inbound derived-content manifests project exact closed Mailbox truth", () => {
	const source = liveManifest();
	const projected = projectInboundDerivedContentManifest(source, "mail-123");
	assert.deepEqual(projected, source);
	assert.notEqual(projected, source);
	for (const status of ["deleted", "missing", "not_live_inbound"] as const) {
		assert.deepEqual(
			projectInboundDerivedContentManifest({ status }, "mail-123"),
			{ status },
		);
		assert.equal(
			projectInboundDerivedContentManifest({ status, poison: true }, "mail-123"),
			null,
		);
	}
});

test("inbound derived-content manifests reject poisoned known fields", () => {
	const source = liveManifest();
	const poisoned = [
		{ ...source, generation: MAX_INBOUND_DERIVED_GENERATION + 1 },
		{ ...source, lastRepairMarkerId: "../../marker" },
		{ ...source, privatePayload: "poison" },
		{
			...source,
			attachments: [{ ...source.attachments[0], r2Key: "attachments/other-mail/file.bin" }],
		},
		{
			...source,
			bodyObjects: [{ ...source.bodyObjects[0], r2Key: "email-bodies/other-mail/0.body" }],
		},
		{
			...source,
			attachments: [{ ...source.attachments[0], byteLength: MAX_INBOUND_EMAIL_BYTES + 1 }],
		},
		{
			...source,
			attachments: [{ ...source.attachments[0], id: { privatePayload: "poison" } }],
		},
		{
			...source,
			attachments: [{ ...source.attachments[0], id: "attachment\npoison" }],
		},
		{
			...source,
			attachments: [{ ...source.attachments[0], privatePayload: "poison" }],
		},
		{
			...source,
			attachments: [
				source.attachments[0],
				{
					...source.attachments[0],
					r2Key: "attachments/mail-123/attempt-1/duplicate-id.bin",
				},
			],
		},
		{
			...source,
			attachments: [
				source.attachments[0],
				{ ...source.attachments[0], id: "attachment-2" },
			],
		},
		{
			...source,
			bodyObjects: [{ ...source.bodyObjects[0], id: source.attachments[0].id }],
		},
		{
			...source,
			attachments: Array.from({ length: 513 }, (_, index) => ({
				id: `attachment-${index}`,
				r2Key: `attachments/mail-123/attempt-1/${index}.bin`,
				byteLength: 1,
			})),
		},
	] as unknown[];
	for (const candidate of poisoned) {
		assert.equal(projectInboundDerivedContentManifest(candidate, "mail-123"), null);
	}
	assert.equal(projectInboundDerivedContentManifest(source, "../mail-123"), null);
});
