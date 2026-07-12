import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const control = read("./WorkspaceViewControl.tsx");
const header = read("./Header.tsx");
const mailbox = read("../routes/mailbox.tsx");

test("the header exposes a Kumo workspace View popover", () => {
	assert.match(control, /import \{ Button, Popover \} from "@cloudflare\/kumo"/);
	assert.match(control, /<Popover>/);
	assert.match(control, /<Popover\.Trigger asChild>/);
	assert.match(control, /positionMethod="fixed"/);
	assert.match(control, /aria-label="Mail workspace view"/);
	assert.match(control, /min-h-11 min-w-11/);
	assert.match(control, />\s*View\s*</);
	assert.match(header, /import WorkspaceViewControl/);
	assert.match(header, /<WorkspaceViewControl \/>/);
});

test("the narrow header keeps utilities in a touch-sized overflow menu", () => {
	assert.match(header, /<DropdownMenu>/);
	assert.match(header, /aria-label="More mail actions"/);
	assert.match(header, /className="min-h-11 min-w-11"/);
	assert.match(header, /md:hidden/);
	assert.match(header, /hidden shrink-0 items-center gap-1 xl:flex/);
	assert.match(header, /xl:hidden/);
	assert.match(header, /More mail actions[\s\S]*?Sign out/);
});

test("density, width, and intelligence are accessible radio groups with touch targets", () => {
	assert.equal(control.match(/<fieldset/g)?.length, 3);
	assert.match(control, /<legend[^>]*>Density<\/legend>/);
	assert.match(control, /<legend[^>]*>List width<\/legend>/);
	assert.match(control, /<legend[^>]*>Intelligence panel<\/legend>/);
	assert.match(control, /type="radio"/);
	assert.match(control, /name="mail-density"/);
	assert.match(control, /name="list-pane-width"/);
	assert.match(control, /name="conversation-intelligence"/);
	assert.match(control, /min-h-11/);
	assert.match(control, /focus-within:ring-2/);
	assert.match(control, /LIST_PANE_WIDTH_PRESETS/);
	assert.match(control, /Custom/);
	assert.match(control, /isCustomListPaneWidth/);
	assert.match(control, /setMailDensity/);
	assert.match(control, /setListPaneWidth/);
	assert.match(control, /setConversationIntelligenceExpanded/);
});

test("width choices explain responsive behavior and preferences hydrate client-side", () => {
	assert.match(control, /md:hidden/);
	assert.match(control, /On phones, mail stays single-column/);
	assert.match(mailbox, /hydrateWorkspacePreferences/);
	assert.match(
		mailbox,
		/useEffect\(\(\) => \{[\s\S]*?hydrateAgentPanel\(\);[\s\S]*?hydrateWorkspacePreferences\(\);/,
	);
});
