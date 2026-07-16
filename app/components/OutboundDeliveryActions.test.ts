import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
	new URL("./OutboundDeliveryActions.tsx", import.meta.url),
	"utf8",
);

test("Outbox controls expose keyboard and touch accessible action state", () => {
	assert.match(component, /type="button"/);
	assert.match(component, /aria-label=\{action\.label\}/);
	assert.match(component, /min-h-11/);
	assert.match(component, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
	assert.match(component, /aria-live="polite"/);
	assert.match(component, /aria-busy=\{isPending\}/);
	assert.match(component, /role="alert"/);
	assert.match(component, /lastErrorCode/);
	assert.match(component, /sr-only sm:not-sr-only sm:block/);
	assert.match(component, /Retry anyway/);
});

test("unknown delivery retry requires explicit duplicate-risk confirmation", () => {
	assert.match(component, /requiresDuplicateRiskConfirmation/);
	assert.match(component, /window\.confirm/);
	assert.match(component, /could send a duplicate/);
});

test("Outbox controls are persistent in list and detail renderers", () => {
	const list = readFileSync(new URL("../routes/email-list.tsx", import.meta.url), "utf8");
	const detail = readFileSync(new URL("./EmailPanel.tsx", import.meta.url), "utf8");
	assert.match(list, /<OutboundDeliveryActions[\s\S]*?compact/);
	assert.doesNotMatch(list, /group-hover:flex[\s\S]*?<OutboundDeliveryActions/);
	assert.match(list, /unknown: "Uncertain"/);
	assert.match(detail, /<OutboundDeliveryActions/);
	assert.match(detail, /useOutboundDeliveries/);
});
