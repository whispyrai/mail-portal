import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const inbound = readFileSync(new URL("../inbound-email.ts", import.meta.url), "utf8");
const inboundQueue = readFileSync(new URL("../inbound-queue.ts", import.meta.url), "utf8");
const liveInboundProjection = readFileSync(
	new URL("../lib/live-inbound-projection.ts", import.meta.url),
	"utf8",
);

test("only atomic live Inbox creation can enqueue durable push work", () => {
	assert.match(source, /transactionSync\([\s\S]*enqueuePushNotification/);
	assert.match(source, /folderId !== Folders\.INBOX[\s\S]*RecipientMemoryOrigins\.LIVE_INBOUND/);
	assert.doesNotMatch(inbound, /\.firePush\(/);
	assert.match(liveInboundProjection, /pushNotificationFor:[\s\S]*buildPushPayload/);
	assert.match(inbound, /liveInboundProjectionOptions\(/);
	assert.match(inboundQueue, /liveInboundProjectionOptions\(/);
});
