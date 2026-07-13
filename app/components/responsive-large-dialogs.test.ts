import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const indexStyleSheet = readFileSync(`${appDirectory}/index.css`, "utf8");
const emailPanelDialogs = readFileSync(
	`${appDirectory}/components/email-panel/EmailPanelDialogs.tsx`,
	"utf8",
);
const emailListRoute = readFileSync(
	`${appDirectory}/routes/email-list.tsx`,
	"utf8",
);

test("every large portal dialog can shrink inside a mobile viewport", () => {
	const violations: string[] = [];

	for (const relativePath of globSync("**/*.tsx", { cwd: appDirectory })) {
		const source = readFileSync(`${appDirectory}/${relativePath}`, "utf8");
		const dialogTags = source.match(/<Dialog(?!\.)\b[\s\S]*?>/g) ?? [];

		for (const tag of dialogTags) {
			if (
				tag.includes('size="lg"') &&
				(!tag.includes("min-w-0") || !tag.includes("sm:min-w-[32rem]"))
			) {
				violations.push(relativePath);
			}
		}
	}

	assert.deepEqual(
		violations,
		[],
		`Large dialogs must shrink on mobile and restore Kumo's 32rem desktop minimum: ${violations.join(", ")}`,
	);
});

test("dialog portals render above persistent application chrome", () => {
	assert.match(
		indexStyleSheet,
		/body > \[data-base-ui-portal\]:has\(> \[role="dialog"\]\)\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*60;/s,
	);
});

test("toast feedback renders above open dialogs", () => {
	assert.match(
		indexStyleSheet,
		/body > \[data-base-ui-portal\]:has\(> \[role="region"\]\[aria-label="Notifications"\]\)\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*70;/s,
	);
});

test("source headers become wrapping cards below the desktop breakpoint", () => {
	assert.match(emailPanelDialogs, /className="[^"]*space-y-2[^"]*sm:hidden/);
	assert.match(emailPanelDialogs, /className="[^"]*hidden[^"]*sm:table/);
	assert.match(emailPanelDialogs, /break-all/);
	assert.doesNotMatch(emailPanelDialogs, /<Dialog\.Close[^>]*>\s*<Button/);
});

test("email panel dialogs preserve titles and actions in short viewports", () => {
	assert.equal(
		(emailPanelDialogs.match(/max-h-\[calc\(100dvh-1rem\)\]/g) ?? []).length,
		2,
	);
	assert.match(
		emailPanelDialogs,
		/<Dialog\.Title className="min-w-0 shrink-0 break-all">[\s\S]*?previewImage\?\.filename/,
	);
	assert.match(
		emailPanelDialogs,
		/h-\[min\(744px,calc\(100dvh-1rem\)\)\]/,
	);
	assert.match(
		emailPanelDialogs,
		/className="relative h-full min-h-0 w-full"[\s\S]*?className="absolute inset-0 h-full w-full rounded object-contain shadow-sm"/,
	);
	assert.equal(
		(emailPanelDialogs.match(/mt-4 flex shrink-0/g) ?? []).length,
		2,
	);
});

test("lazy triage states keep the same structured modal frame as the review", () => {
	assert.match(
		emailListRoute,
		/function InboxTriageReviewLoadingFallback[\s\S]*?<header[\s\S]*?<Loader size="lg" \/>[\s\S]*?<footer/,
	);
	assert.match(
		emailListRoute,
		/function InboxTriageReviewLoadError[\s\S]*?<header[\s\S]*?role="alert"[\s\S]*?<footer/,
	);
	assert.match(
		emailListRoute,
		/function InboxTriageReviewLoadError[\s\S]*?className="min-h-11 w-full sm:w-auto"[\s\S]*?Try again/,
	);
});
