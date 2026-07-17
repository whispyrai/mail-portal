import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { link, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	inspectArtifactLockResidue,
	removeStaleArtifactLockResidue,
} from "./manage-artifact-lock.mjs";

async function writeResidue(directory, pid, residueKind = "pair") {
	const lockPath = join(directory, ".mail-portal-artifact.lock");
	const token = randomBytes(32).toString("hex");
	const startedAt = Date.now() - 10_000;
	const common = {
		version: 1,
		token,
		pid,
		brand: "wiser",
		mode: "deploy",
		startedAt,
	};
	if (residueKind !== "guard") {
		await writeFile(lockPath, JSON.stringify({ ...common, kind: "primary" }), {
			mode: 0o600,
		});
	}
	if (residueKind !== "primary") {
		await writeFile(
			`${lockPath}.guard`,
			JSON.stringify({ ...common, kind: "guard" }),
			{ mode: 0o600 },
		);
	}
	return { lockPath, startedAt };
}

test("inspect reports active locks without exposing or changing their token", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-inspect-lock-"));
	const { lockPath } = await writeResidue(directory, process.pid);
	const before = await readFile(lockPath, "utf8");
	const inspection = inspectArtifactLockResidue(lockPath);
	assert.equal(inspection.processState, "active");
	assert.equal(inspection.pid, process.pid);
	assert.equal(inspection.brand, "wiser");
	assert.equal(inspection.mode, "deploy");
	assert.equal(inspection.residueKind, "pair");
	assert.equal("token" in inspection, false);
	assert.equal("primary" in inspection, false);
	assert.equal("guard" in inspection, false);
	assert.equal(await readFile(lockPath, "utf8"), before);
});

test("removal requires a dead PID and exact prior PID and startedAt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-remove-lock-"));
	const deadPid = 2_147_483_647;
	const { lockPath, startedAt } = await writeResidue(directory, deadPid);
	assert.throws(
		() =>
			removeStaleArtifactLockResidue({
				lockPath,
				expectedPid: deadPid,
				expectedStartedAt: startedAt + 1,
			}),
		/do not match/i,
	);
	const result = removeStaleArtifactLockResidue({
		lockPath,
		expectedPid: deadPid,
		expectedStartedAt: startedAt,
	});
	assert.equal(result.pid, deadPid);
	await assert.rejects(stat(lockPath));
	await assert.rejects(stat(`${lockPath}.guard`));
});

test("active and hard-linked lock files are never removed", async () => {
	const activeDirectory = await mkdtemp(join(tmpdir(), "mail-portal-active-lock-"));
	const active = await writeResidue(activeDirectory, process.pid);
	assert.throws(
		() =>
			removeStaleArtifactLockResidue({
				lockPath: active.lockPath,
				expectedPid: process.pid,
				expectedStartedAt: active.startedAt,
			}),
		/still active/i,
	);
	assert.equal((await stat(active.lockPath)).nlink, 1);

	const linkedDirectory = await mkdtemp(join(tmpdir(), "mail-portal-link-lock-"));
	const linked = await writeResidue(linkedDirectory, 2_147_483_647);
	await link(linked.lockPath, join(linkedDirectory, "extra-link"));
	assert.throws(
		() => inspectArtifactLockResidue(linked.lockPath),
		/single-link/i,
	);
	assert.equal((await stat(linked.lockPath)).nlink, 2);
});

for (const residueKind of ["primary", "guard"]) {
	test(`a stale lone ${residueKind} crash residue is exactly inspectable and removable`, async () => {
		const directory = await mkdtemp(
			join(tmpdir(), `mail-portal-lone-${residueKind}-`),
		);
		const deadPid = 2_147_483_647;
		const { lockPath, startedAt } = await writeResidue(
			directory,
			deadPid,
			residueKind,
		);
		const inspection = inspectArtifactLockResidue(lockPath);
		assert.deepEqual(
			{
				pid: inspection.pid,
				brand: inspection.brand,
				mode: inspection.mode,
				startedAt: inspection.startedAt,
				processState: inspection.processState,
				residueKind: inspection.residueKind,
			},
			{
				pid: deadPid,
				brand: "wiser",
				mode: "deploy",
				startedAt,
				processState: "stale",
				residueKind,
			},
		);
		assert.equal("token" in inspection, false);

		const result = removeStaleArtifactLockResidue({
			lockPath,
			expectedPid: deadPid,
			expectedStartedAt: startedAt,
		});
		assert.equal(result.residueKind, residueKind);
		await assert.rejects(stat(lockPath));
		await assert.rejects(stat(`${lockPath}.guard`));
	});

	test(`an active lone ${residueKind} residue is never removed`, async () => {
		const directory = await mkdtemp(
			join(tmpdir(), `mail-portal-active-lone-${residueKind}-`),
		);
		const { lockPath, startedAt } = await writeResidue(
			directory,
			process.pid,
			residueKind,
		);
		assert.throws(
			() =>
				removeStaleArtifactLockResidue({
					lockPath,
					expectedPid: process.pid,
					expectedStartedAt: startedAt,
				}),
			/still active/i,
		);
		const retainedPath =
			residueKind === "primary" ? lockPath : `${lockPath}.guard`;
		assert.equal((await stat(retainedPath)).nlink, 1);
	});
}
