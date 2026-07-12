# Rebuild State

## Current phase

Phase 3: premium mail client, with Phase 4 cost-control foundation running in parallel.

## Active work

- Safety and lifecycle foundation implemented: Trash and restore are reversible, draft discard is explicit, attachment cleanup is durable, protected/non-empty folders are safe, mailbox deactivation retains data, and state changes are attributable.
- Personal and Shared Mailbox authorization is live across browser routes, agent, MCP, push, bulk jobs, settings management, inbound delivery, and admin membership APIs. Administrator role alone does not grant content access.
- Truthful Outbox is live across compose, reply, forward, MCP, agent-compatible tools, and bulk sends. Immutable snapshots, idempotency, Send Later, Undo, provider ambiguity, retry budgets, draft retention, and delivery attempts are durable.
- Outbox UI shows live delivery states, immediate Undo, retry, and explicit duplicate-risk confirmation for ambiguous outcomes.
- Push subscriptions are user-scoped and safely rebound after migration. OAuth quiz operations use dedicated scopes and live identity checks.
- Shared Mailbox administration UI is implemented.
- AI cost controls now cover one-shot drafting and chat streaming, use token-aware reconciliation, reap stale reservations, bound model and tool context, cache by environment and mailbox, and expose an audited administrator review surface. Draft verification is deterministic and makes no model call.
- Browser mutations enforce exact origin, login attempts are durably throttled, and password reset revokes browser, OAuth/MCP generation, and legacy MCP credentials.
- Keyboard navigation and triage, thread-level delivery highlights, folder-scoped conversation actions, persistent Outbox controls, and per-message remote-image privacy are implemented.
- Multi-select batch triage, an accessible command palette, responsive and reduced-motion hardening, a DST-safe Send Later interface, mailbox-wide labels, and personal Saved Views are implemented.
- Account ownership now uses a platform-operator recovery directory, pending-to-claimed setup, owner-initiated recovery, immutable audit, and durable deactivation revocation.
- Evidence-backed conversation intelligence is live end to end with a dedicated bounded mailbox projection, actual attachment object-size enforcement, cited structured output, mailbox-scoped caching, cheap-tier cost accounting, explicit refresh, and a read-only detail card. Draft, Outbox, and internal snapshots are excluded.
- Cited Ask This Conversation is live as a manual, stateless, actor-private AI workflow. The model may select only exact bounded excerpts from the current authorized Conversation, the server proves each excerpt against exactly one cited Message or attachment field, and the UI renders escaped quoted evidence with exact-source focus. Live access and evidence fingerprints are rechecked across cache, provider, persistence, and response boundaries.
- Mailbox-wide Snooze is live with a protected folder, message or anchored-conversation scope, local-time controls, explicit Return and Undo, bounded durable alarms, authoritative inbound reply wake, attribution, keyboard and touch actions, and stale-detail reconciliation for automatic or teammate wake.
- Private follow-up reminders now run end to end through owner-scoped routes, canonical stored-mail anchors, bounded previews, per-mailbox controls, and a private Today workspace. Inbound replies complete reminders atomically and access-aware retry remains durable.
- Search v2 is live with a strict server-authoritative grammar, deterministic relevance, filename search, centered snippets, stable pagination, Saved View fidelity, explicit error recovery, and Cloudflare-specific SQL bind and LIKE-pattern bounds.
- Composer attachment handling fails closed and preserves authoritative attachment identity, inline disposition, and Content-ID through reopen, repeated draft save, one-click Send Draft, promotion, delivery, rollback, and cleanup.
- Composer draft lifecycle is now durable: debounced version-aware autosave, response-loss-safe first create, source-revision delivery uniqueness, save-state visibility, safe close/navigation, recovery across lazy/runtime failure, versioned discard, revoked-access exit, truthful terminal replay, and zero-copy unchanged attachments.
- Mailbox-local recipient intelligence is live. Only authoritative live inbound and provider-accepted outbound mail can teach bounded idempotent suggestions; legacy ambiguity and admin imports fail closed. To, Cc, and Bcc use the accessible mailbox-scoped combobox with pinned-origin self and duplicate filtering.
- Per-mailbox signatures have strict bounded settings routes, Shared administrator management without content access, R2 ETag compare-and-swap, revision-safe Settings UI, escaped line-preserving marked insertion, Draft and recovery authority, forward placement, delayed manual recovery, and AI preservation.
- Composer keyboard flow now includes native form-owned Cmd/Ctrl+Enter send and Cmd/Ctrl+S save. A deterministic authored-content scanner warns about likely forgotten attachments without reading signatures, quoted replies, or forwarded content.
- Composer file admission is same-tick safe and attempt-owned. Paste, drop, retry, removal, reset, hydration, recovery, and unmount abort stale work while preserving ordinary browser text and HTML paste behavior.
- Inline images are live end to end. Paste, drop, and toolbar insertion create managed canonical CID nodes with trusted local or authenticated previews, while strict server-side body-to-attachment validation runs after authoritative resolution and before every Draft or Outbox mutation.
- Compose initialization and delivery planning now live in independently tested deep modules. Draft authority, Reply-All self exclusion, signature placement, fail-closed attachments, missing-attachment confirmation, schedule validation, and delivery identity remain unchanged while the central hook is smaller.
- One-shot AI drafting routes now authenticate before consuming request bodies, stream-enforce strict 2 KiB and 12 KiB limits, reject unknown input, preserve safe budget explanations, redact arbitrary provider failures, and attribute work to the signed-in actor. Reply mail is isolated as bounded untrusted evidence, and the prompt/cache version was advanced.
- Contextual AI compose refinement is live for new mail with explicit Generate, Refine, Polish, Shorter, More formal, and Friendlier actions. It may replace only authored subject/body content, rejects stale responses and unsafe inline-image drafts, preserves signatures and forwarded tails, shares exact client/server byte and model-envelope validation, and never changes recipients, attachments, schedule, mailbox identity, or delivery state.
- Iterative AI reply refinement is live for Reply and Reply All with Generate, Refine, Polish, Shorter, More formal, and Friendlier actions grounded in the current authorized Conversation. It may replace only the authored reply body, keeps recipients, subject, attachments, schedule, signature, quoted history, source Message, and delivery state authoritative, rejects stale local or server evidence, uses actor-private caching, and carries a server-owned human-review requirement because generated prose is never mailbox state.
- Explainable Inbox triage is live as a manually triggered, actor-private review workflow for the exact visible Inbox page. The cheap model may propose only cited Archive or Mark read suggestions. It cannot mutate mail, every apply uses the existing user-attributed deterministic batch command, and current canonical Conversation identity is required so changed threads fail closed. Shared Mailbox copy makes mailbox-wide effects explicit.
- The proactive cited AI Today brief is live per mailbox. It merges the signed-in actor's private due reminders with mailbox-wide unread Inbox conversations, deterministically bounds and de-duplicates evidence, ranks at most five cited focus items, and leaves every mailbox or reminder action manual. Shared Mailbox cache scope is actor-private, generation claims are durable across Worker isolates, claims renew during inference, and access plus source fingerprints are revalidated before cache use, provider start, cache write, and response.
- Rich composer and conversation-detail code are deferred from initial mailbox load. Local error boundaries, cancel/back/reload paths, pending Escape, and SSR-safe defaults keep slow or failed chunks recoverable.
- The first adversarial Outbox review and all integrated foundation, intelligence, Snooze, reminders, Search v2, attachment-integrity, bundle-splitting, draft-lifecycle, recipient-intelligence, and signature review rounds are complete. Every reported P1 finding has a regression fix.

## Public test seams

- Mailbox and email HTTP APIs.
- Durable Object public mailbox methods where no HTTP seam exists.
- Authenticated inbox, Conversation, compose, settings, admin, and search journeys.
- Agent/MCP tools only through their public action interfaces.
- Delivery and activity state as visible to an authorized user/operator.

## Fixed point

- Branch: `wiser-235-team-mail-portal`
- Starting commit: `2f126b5`
- Pre-existing untracked path to preserve: `.claude/`

## Verification baseline

- Automated tests: 82 passing before rebuild work.
- Wiser typecheck: passing before rebuild work.
- Wiser production build: passing before rebuild work.
- Authenticated visual teardown: still required.

## Current verification

- `npm test`: 904/904 passing after explainable Inbox triage and its production-seam regressions.
- `npx tsc -b`: passing.
- `git diff --check`: passing.
- `npm run build`: production client and SSR artifacts built with the expected non-fatal Wrangler sandbox log-file warning.
- Initial mailbox JavaScript remains deferred at 77.56 kB raw and 21.69 kB gzip. Today is 26.51 kB raw and 8.01 kB gzip; EmailPanel is deferred at 68.56 kB raw and 20.10 kB gzip. ComposeEmail is deferred at 498.25 kB raw and 155.50 kB gzip, while ComposeAiAssistant remains separate at 14.01 kB raw and 5.50 kB gzip. InboxTriageReview is a separate on-demand 17.06 kB raw and 6.00 kB gzip chunk.
- Local D1 migrations 0001 through 0003 applied successfully to the local Wiser database.
- Local migration 0004 application is pending because the approved Wrangler escalation was rejected after the Codex usage limit was reached. Migration SQL tests pass.
- Fresh foundation, delivery, conversation-intelligence, Snooze, follow-up reminder, Search v2, attachment-integrity, deferred-loading, draft-lifecycle, recipient-intelligence, signature, composer-input, and inline-image reviews found no P0 issues. Every reported P1 finding was fixed and covered by targeted regressions.
- Adversarial Outbox review found eight P1 issues; all eight were fixed and regression coverage was added.
- Integrated correctness, security, data-integrity, AI-cost, and UX reviews produced further P1 remediation rounds; all reported findings are fixed and covered by targeted regression tests. Independent final compose-refinement, Today-brief, AI lazy-boundary, cited Conversation Q&A, iterative reply-refinement, and explainable Inbox-triage re-reviews are clean at P0/P1. Inbox triage review caught and fixed a normalized Worker-to-Durable-Object request mismatch, missing canonical Conversation identity on singleton actions, and non-dismissible lazy failure/loading lifecycles.

## Next gate

Checkpoint explainable Inbox triage, then run a fresh capability-gap audit to choose the next bounded high-leverage slice. Semantic search remains deferred until the permission-aware indexing and background-projection architecture is locked. Visual QA still requires explicit approval. The standards pass remains pending explicit scope confirmation.
