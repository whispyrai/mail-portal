import assert from "node:assert/strict";
import test from "node:test";
import {
	agentConnectionIdsToReconcile,
	agentActorTag,
	hasLiveAgentMailboxAccess,
	parseBoundSessionVersion,
	quarantineAgentOutput,
	reconcileAgentActorConnections,
	reconcileAgentMailboxConnections,
	runAuthorizedAgentAdmission,
	runAuthorizedAgentFrame,
	unauthorizedAgentConnectionIds,
} from "./agent-frame-authorization.ts";

test("agent session generations must be explicit positive integers", () => {
	assert.equal(parseBoundSessionVersion(null), undefined);
	assert.equal(parseBoundSessionVersion(""), undefined);
	assert.equal(parseBoundSessionVersion("0"), undefined);
	assert.equal(parseBoundSessionVersion("1.5"), undefined);
	assert.equal(parseBoundSessionVersion("2"), 2);
});

test("agent access rejects missing bound identity before authorization storage", async () => {
	let calls = 0;
	const dependencies = {
		hasExactAccess: async () => {
			calls += 1;
			return true;
		},
	};
	assert.equal(
		await hasLiveAgentMailboxAccess({} as never, "team@example.com", "user-1", undefined, dependencies),
		false,
	);
	assert.equal(calls, 0);
});

test("agent access requires both the exact live session and mailbox grant", async () => {
	const dependencies = {
		hasExactAccess: async () => true,
	};
	assert.equal(
		await hasLiveAgentMailboxAccess({} as never, "team@example.com", "user-1", 2, dependencies),
		true,
	);
	assert.equal(
		await hasLiveAgentMailboxAccess(
			{} as never,
			"team@example.com",
			"user-1",
			2,
			{ hasExactAccess: async () => false },
		),
		false,
	);
});

test("agent frame guard closes revoked and unavailable sockets before delegation", async () => {
	for (const [authorize, expected] of [
		[async () => false, [4403, "Mail access revoked"]],
		[async () => { throw new Error("private SQL detail"); }, [1011, "Mail authorization unavailable"]],
	] as const) {
		let delegated = false;
		let authorized = true;
		let closed: readonly unknown[] | undefined;
		await runAuthorizedAgentFrame({
			authorize,
			markUnauthorized: () => { authorized = false; },
			close: (...args) => { closed = args; },
			delegate: async () => { delegated = true; },
		});
		assert.equal(delegated, false);
		assert.equal(authorized, false);
		assert.deepEqual(closed, expected);
	}
});

test("agent frame guard delegates only after live authorization", async () => {
	const order: string[] = [];
	let delegated = false;
	await runAuthorizedAgentFrame({
		authorize: async () => true,
		markAuthorized: () => order.push("authorized"),
		markUnauthorized: () => order.push("pending"),
		close: () => assert.fail("authorized frame must remain open"),
		delegate: async () => { delegated = true; order.push("delegated"); },
	});
	assert.equal(delegated, true);
	assert.deepEqual(order, ["pending", "authorized", "delegated"]);
});

test("agent admission stays quarantined through pre and post authorization", async () => {
	for (const mode of ["pre-revoked", "post-revoked", "unavailable"] as const) {
		let checks = 0;
		let authorized = false;
		let delegated = false;
		let released = false;
		let discarded = false;
		let closed: readonly unknown[] | undefined;
		await runAuthorizedAgentAdmission({
			authorize: async () => {
				checks += 1;
				if (mode === "unavailable") throw new Error("private SQL detail");
				return mode === "pre-revoked" ? false : checks === 1;
			},
			markAuthorized: () => { authorized = true; },
			markUnauthorized: () => { authorized = false; },
			releaseQuarantinedOutput: () => { released = true; },
			discardQuarantinedOutput: () => { discarded = true; },
			reportUnexpectedError: () => assert.fail("authorization errors are expected"),
			close: (...args) => { closed = args; },
			delegate: async () => { delegated = true; },
		});
		assert.equal(authorized, false);
		assert.equal(delegated, mode === "post-revoked");
		assert.equal(released, false);
		assert.equal(discarded, true);
		assert.deepEqual(
			closed,
			mode === "unavailable"
				? [1011, "Mail authorization unavailable"]
				: [4403, "Mail access revoked"],
		);
	}

	const order: string[] = [];
	await runAuthorizedAgentAdmission({
		authorize: async () => true,
		markAuthorized: () => order.push("authorized"),
		markUnauthorized: () => order.push("unauthorized"),
		releaseQuarantinedOutput: () => order.push("released"),
		discardQuarantinedOutput: () => order.push("discarded"),
		reportUnexpectedError: () => assert.fail("authorized admission must not fail"),
		close: () => assert.fail("authorized admission must remain open"),
		delegate: async () => { order.push("delegated"); },
	});
	assert.deepEqual(order, ["delegated", "authorized", "released"]);
});

test("Agent admission output remains buffered until release and is discardable", () => {
	const sent: string[] = [];
	const inheritedSend = function (this: unknown, message: string) {
		assert.ok(this);
		sent.push(message);
	};
	const prototype = { send: inheritedSend };
	const connection = Object.create(prototype) as { send(message: string): void };
	const released = quarantineAgentOutput(connection);
	connection.send("identity");
	connection.send("resume");
	assert.deepEqual(sent, []);
	released.release();
	assert.deepEqual(sent, ["identity", "resume"]);
	assert.equal(Object.hasOwn(connection, "send"), false);

	const discarded = quarantineAgentOutput(connection);
	connection.send("private-state");
	discarded.discard();
	assert.deepEqual(sent, ["identity", "resume"]);
	connection.send("live");
	assert.deepEqual(sent, ["identity", "resume", "live"]);
});

test("Agent admission fails closed when delegated output exceeds its bound", async () => {
	const sent: string[] = [];
	const connection = { send: (message: string) => sent.push(message) };
	const output = quarantineAgentOutput(connection);
	let authorized = false;
	let closed: readonly unknown[] | undefined;
	let reported: unknown;
	await runAuthorizedAgentAdmission({
		authorize: async () => true,
		markAuthorized: () => { authorized = true; },
		markUnauthorized: () => { authorized = false; },
		releaseQuarantinedOutput: output.release,
		discardQuarantinedOutput: output.discard,
		reportUnexpectedError: (error) => { reported = error; },
		close: (...args) => { closed = args; },
		delegate: async () => {
			for (let index = 0; index < 65; index += 1) connection.send(`${index}`);
		},
	});
	assert.equal(authorized, false);
	assert.ok(reported instanceof Error);
	assert.deepEqual(closed, [1011, "Agent connection unavailable"]);
	assert.deepEqual(sent, []);
	connection.send("restored");
	assert.deepEqual(sent, ["restored"]);
});

test("postcheck revocation discards inherited Agent protocol output", async () => {
	const sent: string[] = [];
	const connection = { send: (message: string) => sent.push(message) };
	const output = quarantineAgentOutput(connection);
	let checks = 0;
	let closed: readonly unknown[] | undefined;
	await runAuthorizedAgentAdmission({
		authorize: async () => (checks += 1) === 1,
		markAuthorized: () => assert.fail("revoked admission must stay quarantined"),
		markUnauthorized: () => {},
		releaseQuarantinedOutput: output.release,
		discardQuarantinedOutput: output.discard,
		reportUnexpectedError: () => assert.fail("revocation is an expected outcome"),
		close: (...args) => { closed = args; },
		delegate: async () => {
			connection.send("identity");
			connection.send("private-state");
			assert.deepEqual(sent, []);
		},
	});
	assert.equal(checks, 2);
	assert.deepEqual(sent, []);
	assert.deepEqual(closed, [4403, "Mail access revoked"]);
});

test("broadcast quarantine excludes legacy and unvalidated connections", () => {
	assert.equal(agentActorTag("user-1"), "actor:user-1");
	assert.deepEqual(
		unauthorizedAgentConnectionIds([
			{ id: "legacy", state: {} },
			{ id: "pending", state: { liveAuthorized: false } },
			{ id: "live", state: { liveAuthorized: true } },
		], ["caller-excluded"]),
		["caller-excluded", "legacy", "pending"],
	);
});

test("Agent reconciliation preserves only the current authorized session generation", () => {
	const connections = [
		{ id: "legacy", state: { actorUserId: "user-1" } },
		{ id: "stale", state: { actorUserId: "user-1", actorSessionVersion: 2 } },
		{ id: "current", state: { actorUserId: "user-1", actorSessionVersion: 3 } },
		{ id: "other", state: { actorUserId: "user-2", actorSessionVersion: 1 } },
	];
	assert.deepEqual(
		agentConnectionIdsToReconcile(connections, "user-1", 3),
		["legacy", "stale"],
	);
	assert.deepEqual(
		agentConnectionIdsToReconcile(connections, "user-1", null),
		["legacy", "stale", "current"],
	);
});

function reconciledConnection(
	id: string,
	state: {
		actorUserId?: string;
		actorSessionVersion?: number;
		liveAuthorized?: boolean;
	},
) {
	const closed: Array<readonly [number, string]> = [];
	return {
		id,
		state,
		closed,
		setState(next: typeof state) {
			this.state = next;
		},
		close(code: number, reason: string) {
			closed.push([code, reason]);
		},
	};
}

test("actor reconciliation quarantines during lookup and restores only the live generation", async () => {
	const current = reconciledConnection("current", {
		actorUserId: "user-1",
		actorSessionVersion: 3,
		liveAuthorized: true,
	});
	const stale = reconciledConnection("stale", {
		actorUserId: "user-1",
		actorSessionVersion: 2,
		liveAuthorized: true,
	});
	const pending = reconciledConnection("pending", {
		actorUserId: "user-1",
		actorSessionVersion: 3,
		liveAuthorized: false,
	});
	let resolveVersion!: (value: number | null) => void;
	const version = new Promise<number | null>((resolve) => { resolveVersion = resolve; });
	const reconciliation = reconcileAgentActorConnections({
		connections: [current, stale, pending],
		userId: "user-1",
		resolveCurrentSessionVersion: () => version,
	});
	assert.equal(current.state.liveAuthorized, false);
	assert.equal(stale.state.liveAuthorized, false);
	resolveVersion(3);
	await reconciliation;
	assert.equal(current.state.liveAuthorized, true);
	assert.equal(pending.state.liveAuthorized, false);
	assert.deepEqual(stale.closed, [[4403, "Mail access revoked"]]);
});

test("actor reconciliation lookup failure leaves targeted sockets quarantined", async () => {
	const connection = reconciledConnection("live", {
		actorUserId: "user-1",
		actorSessionVersion: 3,
		liveAuthorized: true,
	});
	await assert.rejects(() => reconcileAgentActorConnections({
		connections: [connection],
		userId: "user-1",
		resolveCurrentSessionVersion: async () => {
			throw new Error("private D1 detail");
		},
	}));
	assert.equal(connection.state.liveAuthorized, false);
	assert.deepEqual(connection.closed, []);
});

test("mailbox reconciliation restores only exact current grants", async () => {
	const valid = reconciledConnection("valid", {
		actorUserId: "user-1",
		actorSessionVersion: 3,
		liveAuthorized: true,
	});
	const revoked = reconciledConnection("revoked", {
		actorUserId: "user-2",
		actorSessionVersion: 1,
		liveAuthorized: true,
	});
	const pending = reconciledConnection("pending", {
		actorUserId: "user-1",
		actorSessionVersion: 3,
		liveAuthorized: false,
	});
	await reconcileAgentMailboxConnections({
		connections: [valid, revoked, pending],
		resolveAuthorizedConnectionIds: async () => new Set(["valid", "pending"]),
	});
	assert.equal(valid.state.liveAuthorized, true);
	assert.equal(pending.state.liveAuthorized, false);
	assert.deepEqual(revoked.closed, [[4403, "Mailbox access revoked"]]);
});
