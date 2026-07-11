const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const ACCOUNT_MAX_FAILURES = 5;
const IP_MAX_FAILURES = 20;
const ATTEMPT_LEASE_MS = 60 * 1000;

export interface LoginThrottleRow {
	key: string;
	failureCount: number;
	windowStartedAt: number;
	lockedUntil: number;
}

export interface LoginThrottleStore {
	admit(input: {
		attemptId: string;
		buckets: LoginThrottleBucket[];
		now: number;
		windowMs: number;
		leaseMs: number;
	}): Promise<{ allowed: boolean; retryAfterMs: number }>;
	finish(input: {
		attemptId: string;
		outcome: "success" | "failure";
		now: number;
		windowMs: number;
		lockMs: number;
	}): Promise<void>;
	prune(olderThan: number): Promise<void>;
}

export interface LoginIdentity {
	email: string;
	ip: string;
	secret: string;
}

export type LoginThrottleBucket = { key: string; maxFailures: number };

export type LoginAttempt = { id: string };

async function opaqueKey(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
	);
	let binary = "";
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function bucketsFor(identity: LoginIdentity): Promise<LoginThrottleBucket[]> {
	const email = identity.email.trim().toLowerCase();
	const ip = identity.ip.trim() || "unknown";
	const [accountKey, ipKey] = await Promise.all([
		opaqueKey(identity.secret, `login:account:${email}`),
		opaqueKey(identity.secret, `login:ip:${ip}`),
	]);
	return [
		{ key: accountKey, maxFailures: ACCOUNT_MAX_FAILURES },
		{ key: ipKey, maxFailures: IP_MAX_FAILURES },
	];
}

export function createLoginThrottle(
	store: LoginThrottleStore,
	options: { now?: () => number; createId?: () => string } = {},
) {
	const now = options.now ?? Date.now;
	const createId = options.createId ?? (() => crypto.randomUUID());
	return {
		async admit(identity: LoginIdentity): Promise<
			| { allowed: true; attempt: LoginAttempt }
			| { allowed: false; retryAfterSeconds: number }
		> {
			const timestamp = now();
			const buckets = await bucketsFor(identity);
			await store.prune(timestamp - 24 * 60 * 60 * 1000);
			const attempt = { id: createId() };
			const admission = await store.admit({
				attemptId: attempt.id,
				buckets,
				now: timestamp,
				windowMs: WINDOW_MS,
				leaseMs: ATTEMPT_LEASE_MS,
			});
			return admission.allowed
				? { allowed: true, attempt }
				: {
						allowed: false,
						retryAfterSeconds: Math.max(
							1,
							Math.ceil(admission.retryAfterMs / 1000),
						),
					};
		},

		async recordFailure(attempt: LoginAttempt): Promise<void> {
			await store.finish({
				attemptId: attempt.id,
				outcome: "failure",
				now: now(),
				windowMs: WINDOW_MS,
				lockMs: LOCK_MS,
			});
		},

		async recordSuccess(attempt: LoginAttempt): Promise<void> {
			await store.finish({
				attemptId: attempt.id,
				outcome: "success",
				now: now(),
				windowMs: WINDOW_MS,
				lockMs: LOCK_MS,
			});
		},
	};
}
