import assert from "node:assert/strict";
import test from "node:test";

import { renderAdminAiCostPage } from "./admin-ai-cost-page.ts";

const brand = {
	id: "wiser",
	appName: "Wiser Mail",
	mailDomain: "example.com",
	logoPath: "/logo.svg",
	accent: "#3b82f6",
} as never;

test("AI cost page exposes spend, reserved usage, and the locked review gates", () => {
	const html = renderAdminAiCostPage(
		brand,
		{
			environment: "wiser",
			monthKey: "2026-07",
			spentMicros: 12_500_000,
			reservedMicros: 500_000,
			approvedBudgetMicros: 50_000_000,
			alertEmittedAt: null,
		},
		{
			environment: "wiser",
			alertThresholdMicros: 25_000_000,
			reviewThresholdMicros: 50_000_000,
			cheapModel: "cheap",
			strongModel: "strong",
		},
	);

	assert.match(html, /AI cost controls/);
	assert.match(html, /\$12\.50/);
	assert.match(html, /\$0\.50 reserved/);
	assert.match(html, /\$25 alert/);
	assert.match(html, /\$50 review gate/);
	assert.match(html, /action="\/admin\/ai-cost\/review"/);
	assert.match(html, /name="reason"/);
});
