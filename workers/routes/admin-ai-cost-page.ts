// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type {
	AiCostControlConfig,
	AiMonthLedger,
} from "../lib/ai-cost-control.ts";
import { escapeHtml } from "../lib/email-helpers.ts";
import { brandLogo, pageShell, type BrandConfig } from "./brand.ts";

type Flash = { tone: "ok" | "err"; message: string };

export function renderAdminAiCostPage(
	brand: BrandConfig,
	month: AiMonthLedger,
	config: AiCostControlConfig,
	flash?: Flash,
): string {
	const total = month.spentMicros + month.reservedMicros;
	const percent = Math.min(100, (total / month.approvedBudgetMicros) * 100);
	const needsReview = total >= config.reviewThresholdMicros;
	const alertReached = total >= config.alertThresholdMicros;
	const minimumHigherCap =
		(Math.max(month.approvedBudgetMicros, config.reviewThresholdMicros) + 10_000) /
		1_000_000;
	const flashHtml = flash
		? `<div class="flash ${flash.tone}">${escapeHtml(flash.message)}</div>`
		: "";

	return pageShell(
		brand,
		`AI cost controls · ${brand.appName}`,
		`<div class="wrap">
		<div class="brandbar">${brandLogo(brand, { href: "/" })}
			<div class="row" style="gap:8px">
				<a class="btn secondary" style="padding:8px 12px;border-radius:10px;font-size:13px" href="/admin/mailboxes">Mailboxes</a>
				<a class="btn secondary" style="padding:8px 12px;border-radius:10px;font-size:13px" href="/admin/users">Users</a>
			</div>
		</div>
		<h1 style="margin-top:14px">AI cost controls</h1>
		<p style="color:var(--muted)">Live monthly usage for <strong>${escapeHtml(month.environment)}</strong> in ${escapeHtml(month.monthKey)}. Routine AI uses the cheap model. Strong-model escalation pauses at the alert threshold.</p>
		${flashHtml}
		<div class="card">
			<div class="row" style="align-items:flex-end">
				<div><label>Recorded spend</label><div style="font-size:30px;font-weight:750">${money(month.spentMicros)}</div></div>
				<div><label>In flight</label><div style="font-size:20px;font-weight:700">${money(month.reservedMicros)} reserved</div></div>
				<div><label>Approved cap</label><div style="font-size:20px;font-weight:700">${money(month.approvedBudgetMicros)}</div></div>
			</div>
			<div style="height:10px;background:var(--border);border-radius:999px;overflow:hidden;margin-top:18px"><div style="height:100%;width:${percent.toFixed(2)}%;background:var(--accent)"></div></div>
			<p style="font-size:13px;color:var(--muted);margin-bottom:0">${money(config.alertThresholdMicros, 0)} alert · ${money(config.reviewThresholdMicros, 0)} review gate · ${alertReached ? "strong AI paused" : "strong AI available for approved escalations"} · ${needsReview ? "paid AI paused pending review" : "paid AI available"}</p>
		</div>
		<div class="card">
			<h2 style="font-size:16px;margin-top:0">Administrator budget review</h2>
			<p style="color:var(--muted);font-size:14px">Raising the cap is explicit, month-scoped, and recorded with your identity and reason. Enter a cap above both current usage and the current approved cap.</p>
			<form method="post" action="/admin/ai-cost/review">
				<div class="row">
					<div><label>New monthly cap (USD)</label><input name="capUsd" type="number" min="${minimumHigherCap.toFixed(2)}" step="0.01" required></div>
					<div><label>Review reason</label><input name="reason" type="text" minlength="10" maxlength="500" required placeholder="Why additional paid AI is approved"></div>
				</div>
				<button type="submit">Approve higher cap</button>
			</form>
		</div>
	</div>`,
	);
}

function money(micros: number, fractionDigits = 2): string {
	return `$${(micros / 1_000_000).toFixed(fractionDigits)}`;
}
