import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	classMethodText,
	parseTypescriptSource,
} from "../testing/typescript-source.ts";

test("outbound preflight finishes before an immediately dispatched provider attempt", async () => {
	const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
	const method = classMethodText(
		parseTypescriptSource(source, "index.ts"),
		"processOutboundAlarm",
	);
	const authorization = method.indexOf(
		"await this.#outboundActorStillAuthorized",
	);
	const quota = method.indexOf("this.#dispatchQuotaPlan");
	const attachments = method.indexOf("await this.#loadOutboundAttachments");
	const preparation = method.indexOf("await prepareSesSend");
	const begin = method.indexOf("service.beginProviderAttempt");
	const beginEnd = method.indexOf(");", begin) + 2;
	const dispatch = method.indexOf(
		"const observed = await dispatchPreparedSesSend(preparation.prepared);",
	);

	assert.ok(authorization >= 0);
	assert.ok(quota > authorization);
	assert.ok(attachments > quota);
	assert.ok(preparation > attachments);
	assert.ok(begin > preparation);
	assert.ok(beginEnd > begin);
	assert.ok(dispatch > beginEnd);
	assert.equal(method.slice(beginEnd, dispatch).trim(), "");
	assert.doesNotMatch(
		method.slice(begin, dispatch),
		/await|console\.|#recordActivity|#scheduleAlarm/,
	);
	assert.doesNotMatch(method, /message:\s*observed\.detail/);
});

test("the isolated outbound lane runs first and owns its final rearm", async () => {
	const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
	const parsed = parseTypescriptSource(source, "index.ts");
	const alarm = classMethodText(parsed, "alarm");
	const outbound = alarm.indexOf("await runOutboundAlarmLane");
	const importPromotion = alarm.indexOf(
		"await this.#processImportPromotionIntents",
	);
	assert.ok(outbound >= 0);
	assert.ok(importPromotion > outbound);
	assert.equal(alarm.match(/#processOutboundAlarm/g)?.length, 1);

	const processOutbound = classMethodText(parsed, "processOutboundAlarm");
	assert.doesNotMatch(processOutbound, /#ensureOutboundAlarm/);
	assert.match(
		processOutbound,
		/#scheduleAlarmAt\(Date\.parse\(preflight\.delivery\.leaseExpiresAt!\)\)/,
	);
});
