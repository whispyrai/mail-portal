import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("cached mailbox signatures initialize once at the pinned origin while Draft bodies remain authoritative", () => {
	const form = read("../hooks/useComposeForm.ts");
	const initialization = read("../lib/compose-initialization.ts");
	assert.match(form, /useMailboxSignatureSettings\(composeMailboxId\)/);
	assert.match(form, /signatureSnapshotRef/);
	assert.match(initialization, /insertComposeSignature/);
	assert.match(initialization, /FORWARDED_MESSAGE_MARKER/);
	assert.doesNotMatch(form, /getSignatureBlock/);
	assert.doesNotMatch(form, /currentMailbox\?\.settings.*signature/);
	const draftBranch = initialization.match(
		/if \(draft\) \{([\s\S]*?)\n\t\}\n\n\tif \(!original\)/,
	)?.[1];
	assert.ok(draftBranch);
	assert.match(draftBranch, /body: draft\.body \|\| ""/);
	assert.doesNotMatch(draftBranch, /insertComposeSignature|withInitialSignature/);
});

test("late signatures distinguish pristine programmatic insertion from dirty manual insertion", () => {
	const form = read("../hooks/useComposeForm.ts");
	const compose = read("./ComposeEmail.tsx");
	const editor = read("./RichTextEditor.tsx");
	assert.match(form, /planDelayedComposeSignature/);
	assert.match(form, /bodyUserDirtyRef/);
	assert.match(form, /setBodyProgrammatically/);
	assert.match(form, /handleBodyChange/);
	assert.match(form, /canInsertSignature/);
	assert.match(form, /insertSignature/);
	assert.match(compose, /onChange=\{handleBodyChange\}/);
	assert.match(compose, />\s*Insert signature\s*</);
	assert.match(compose, /aria-label="Insert signature"/);
	assert.match(editor, /setContent\(value, \{ emitUpdate: false \}\)/);
	assert.match(form, /shouldCaptureProgrammaticComposeChange/);
	assert.match(
		form,
		/hasDraftIdentity: Boolean\(draftIdentityRef\.current\)[\s\S]*?phase: lifecycleRef\.current\.phase[\s\S]*?hasUnobservedUserChange/,
	);
});

test("AI replacement, recovery, and route changes preserve the compose-session signature snapshot", () => {
	const form = read("../hooks/useComposeForm.ts");
	const compose = read("./ComposeEmail.tsx");
	assert.match(form, /replaceAiAuthoredContent/);
	assert.match(form, /const applyAiBody = useCallback/);
	assert.match(
		form,
		/replaceAiAuthoredContent\(snapshotRef\.current\.body, nextAiBody\)/,
	);
	assert.match(form, /bodyUserDirtyRef\.current = true/);
	assert.match(
		compose,
		/if \(typeof draft\.body === "string"\) applyAiBody\(draft\.body\)/,
	);
	assert.doesNotMatch(compose, /if \(draft\.body\) setBody\(draft\.body\)/);

	// The origin mailbox is pinned for the lifetime of the compose session, and
	// only the first resolved settings response is accepted.
	assert.match(form, /useMailboxSignatureSettings\(composeMailboxId\)/);
	assert.match(form, /signatureResolutionHandledRef\.current/);
	assert.match(form, /signatureSnapshotRef\.current = signature/);
	assert.match(
		form,
		/signatureResolutionHandledRef\.current = true;[\s\S]*?planDelayedComposeSignature/,
	);

	// Recovery is selected before normal signature initialization, so an
	// already-marked recovered body remains byte-for-byte authoritative.
	assert.match(form, /const initialFields = recovery\s*\? \{/);
	assert.match(form, /body: recovery\.body/);
	assert.match(
		form,
		/bodyUserDirtyRef\.current = Boolean\(recovery \|\| composeOptions\.draftEmail\)/,
	);
});
