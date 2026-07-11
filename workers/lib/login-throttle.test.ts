import assert from "node:assert/strict";
import test from "node:test";
import {
	createLoginThrottle,
	type LoginThrottleRow,
	type LoginThrottleStore,
} from "./login-throttle.ts";

function memoryStore(): LoginThrottleStore {
	const rows = new Map<string, LoginThrottleRow>();
	const leases = new Map<
		string,
		Array<{ key: string; maxFailures: number; expiresAt: number }>
	>();
	return {
		async admit(input) {
			for (const [id, active] of leases) {
				const current = active.filter((lease) => lease.expiresAt > input.now);
				if (current.length === 0) leases.delete(id);
				else leases.set(id, current);
			}
			let retryAt = input.now + 1_000;
			for (const bucket of input.buckets) {
				const row = rows.get(bucket.key);
				const failures =
					row && row.windowStartedAt > input.now - input.windowMs
						? row.failureCount
						: 0;
				const active = [...leases.values()]
					.flat()
					.filter((lease) => lease.key === bucket.key);
				if ((row?.lockedUntil ?? 0) > input.now || failures + active.length >= bucket.maxFailures) {
					retryAt = Math.max(
						retryAt,
						row?.lockedUntil ?? 0,
						...active.map((lease) => lease.expiresAt),
					);
					return { allowed: false, retryAfterMs: retryAt - input.now };
				}
			}
			leases.set(
				input.attemptId,
				input.buckets.map((bucket) => ({
					key: bucket.key,
					maxFailures: bucket.maxFailures,
					expiresAt: input.now + input.leaseMs,
				})),
			);
			return { allowed: true, retryAfterMs: 0 };
		},
		async finish(input) {
			const active = leases.get(input.attemptId);
			if (!active) return;
			if (input.outcome === "failure") {
				for (const lease of active) {
					const previous = rows.get(lease.key);
					const withinWindow =
						previous && previous.windowStartedAt > input.now - input.windowMs;
					const failureCount = withinWindow ? previous.failureCount + 1 : 1;
					rows.set(lease.key, {
						key: lease.key,
						failureCount,
						windowStartedAt: withinWindow ? previous.windowStartedAt : input.now,
						lockedUntil:
							(previous?.lockedUntil ?? 0) > input.now
								? previous!.lockedUntil
								: failureCount >= lease.maxFailures
									? input.now + input.lockMs
									: 0,
					});
				}
			}
			leases.delete(input.attemptId);
		},
		async prune(olderThan) {
			for (const [key, row] of rows) {
				if (row.windowStartedAt < olderThan) rows.delete(key);
			}
		},
	};
}

test("five failed passwords lock the account bucket for fifteen minutes", async () => {
	let now = 1_000_000;
	const throttle = createLoginThrottle(memoryStore(), { now: () => now });
	const identity = {
		email: "member@wiserchat.ai",
		ip: "203.0.113.10",
		secret: "test-secret",
	};

	for (let attempt = 1; attempt <= 5; attempt++) {
		const admission = await throttle.admit(identity);
		assert.equal(admission.allowed, true);
		if (!admission.allowed) assert.fail("attempt should be admitted");
		await throttle.recordFailure(admission.attempt);
	}

	assert.deepEqual(await throttle.admit(identity), {
		allowed: false,
		retryAfterSeconds: 900,
	});

	now += 900_000;
	assert.equal((await throttle.admit(identity)).allowed, true);
});

test("twenty failures across account names lock the source IP bucket", async () => {
	const throttle = createLoginThrottle(memoryStore(), { now: () => 2_000_000 });
	for (let attempt = 0; attempt < 20; attempt++) {
		const admission = await throttle.admit({
			email: `guess-${attempt}@wiserchat.ai`,
			ip: "203.0.113.20",
			secret: "test-secret",
		});
		assert.equal(admission.allowed, true);
		if (!admission.allowed) assert.fail("attempt should be admitted");
		await throttle.recordFailure(admission.attempt);
	}

	assert.deepEqual(
		await throttle.admit({
			email: "another-guess@wiserchat.ai",
			ip: "203.0.113.20",
			secret: "test-secret",
		}),
		{ allowed: false, retryAfterSeconds: 900 },
	);
});

test("a successful sign-in releases only its admitted attempt", async () => {
	const throttle = createLoginThrottle(memoryStore(), { now: () => 3_000_000 });
	const identity = {
		email: "member@wiserchat.ai",
		ip: "203.0.113.30",
		secret: "test-secret",
	};
	for (let attempt = 0; attempt < 4; attempt++) {
		const admission = await throttle.admit(identity);
		assert.equal(admission.allowed, true);
		if (!admission.allowed) assert.fail("attempt should be admitted");
		await throttle.recordFailure(admission.attempt);
	}

	const successful = await throttle.admit(identity);
	assert.equal(successful.allowed, true);
	if (!successful.allowed) assert.fail("attempt should be admitted");
	await throttle.recordSuccess(successful.attempt);
	assert.equal((await throttle.admit(identity)).allowed, true);
});

test("parallel admission never leases more password checks than the account cap", async () => {
	const throttle = createLoginThrottle(memoryStore(), {
		now: () => 4_000_000,
		createId: () => crypto.randomUUID(),
	});
	const identity = {
		email: "member@wiserchat.ai",
		ip: "203.0.113.40",
		secret: "test-secret",
	};

	const admissions = await Promise.all(
		Array.from({ length: 20 }, () => throttle.admit(identity)),
	);
	const allowed = admissions.filter((result) => result.allowed);

	assert.equal(allowed.length, 5);
	assert.equal(admissions.filter((result) => !result.allowed).length, 15);
});
