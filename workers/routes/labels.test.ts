import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
	handleCreateLabel,
	handleDeleteLabel,
	handleListLabels,
	handleMutateLabels,
	handleUpdateLabel,
} from "./labels.ts";

function appWith(stub: Record<string, (...args: any[]) => any>) {
	const app = new Hono<any>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub);
		c.set("session", { sub: "user-1" });
		await next();
	});
	app.get("/labels", handleListLabels as never);
	app.post("/labels", handleCreateLabel as never);
	app.put("/labels/:labelId", handleUpdateLabel as never);
	app.delete("/labels/:labelId", handleDeleteLabel as never);
	app.post("/label-mutations", handleMutateLabels as never);
	return app;
}

test("active mailbox members can create, list, update, and delete mailbox labels", async () => {
	const calls: unknown[][] = [];
	const app = appWith({
		async getAutomationTargetUsage() { return []; },
		async listLabels() { return [{ id: "label-1", name: "Priority", color: "red" }]; },
		async createLabel(...args: unknown[]) { calls.push(["create", ...args]); return { id: "label-1", name: "Priority", color: "red" }; },
		async updateLabel(...args: unknown[]) { calls.push(["update", ...args]); return { id: "label-1", name: "Urgent", color: "orange" }; },
		async deleteLabel(...args: unknown[]) { calls.push(["delete", ...args]); return true; },
	});
	assert.equal((await app.request("/labels")).status, 200);
	assert.equal((await app.request("/labels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Priority", color: "red" }) })).status, 201);
	assert.equal((await app.request("/labels/label-1", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Urgent", color: "orange" }) })).status, 200);
	assert.equal((await app.request("/labels/label-1", { method: "DELETE" })).status, 204);
	assert.equal(calls.length, 3);
	assert.deepEqual((calls[0]![3] as { kind: string; id: string }), { kind: "user", id: "user-1" });
});

test("label deletion reports the bounded Automation target conflict", async () => {
	let deleted = false;
	const app = appWith({
		async getAutomationTargetUsage() { return ["Vendor invoices"]; },
		async deleteLabel() { deleted = true; return true; },
	});
	const response = await app.request("/labels/label-1", { method: "DELETE" });
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Target is used by Automation Rule: Vendor invoices",
		code: "RULE_TARGET_IN_USE",
	});
	assert.equal(deleted, false);
});

test("label mutations validate bounded targets and preserve partial mailbox results", async () => {
	const app = appWith({
		async mutateLabels(command: unknown, actor: unknown) {
			assert.deepEqual(command, {
				labelId: "label-1",
				action: "apply",
				targets: [{ emailId: "email-1", folderId: "inbox" }],
			});
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return { status: "completed", results: [{ emailId: "email-1", status: "updated", affectedCount: 1 }] };
		},
	});
	const response = await app.request("/label-mutations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			labelId: "label-1",
			action: "apply",
			targets: [{ emailId: "email-1", folderId: "inbox" }],
		}),
	});
	assert.equal(response.status, 200);
	assert.equal((await response.json() as any).results[0].status, "updated");

	const invalid = await app.request("/label-mutations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ labelId: "label-1", action: "apply", targets: [] }),
	});
	assert.equal(invalid.status, 400);
});
