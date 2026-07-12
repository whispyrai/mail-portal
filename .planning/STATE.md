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
- Conversation Action History is live as a collapsed, read-only timeline for the selected canonical Conversation. It reuses immutable activity and authoritative outbound delivery records, exposes only fixed public event and actor labels, keeps metadata and internal identifiers private, paginates by exact canonical stored identities, and identifies who acted in Shared Mailboxes without adding assignments, comments, SLAs, or workflow state.
- The reviewable AI Search Interpreter is live as a manual translation layer over Search v2. It sees only bounded user intent, local date and timezone, and authorized folder and label identities, never mail. Strict model filters are serialized, reparsed, and production-plan validated without execution; the user reviews and edits the canonical query before an explicit Run. Intent stays out of URLs, cache is actor-private, catalog and access freshness are rechecked, and Unicode direction controls cannot deceive the review surface.
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

- `npm test`: 973/973 passing after the AI Search Interpreter and its strict compilation, no-execution, access, catalog, cost, cache, navigation, review, cancellation, Unicode, and maximum-envelope regressions.
- `npx tsc -b`: passing.
- `git diff --check`: passing.
- `npm run build`: production client and SSR artifacts built with the expected non-fatal Wrangler sandbox log-file warning.
- Initial mailbox JavaScript remains deferred at 78.15 kB raw and 21.86 kB gzip. Today is 26.55 kB raw and 8.02 kB gzip; Search results with the on-route interpreter workspace is 27.51 kB raw and 9.88 kB gzip; EmailPanel is deferred at 79.78 kB raw and 23.44 kB gzip. ComposeEmail is deferred at 498.34 kB raw and 155.52 kB gzip, while ComposeAiAssistant remains separate at 14.05 kB raw and 5.51 kB gzip. InboxTriageReview is a separate on-demand 17.10 kB raw and 6.01 kB gzip chunk.
- Local D1 migrations 0001 through 0003 applied successfully to the local Wiser database.
- Local migration 0004 application is pending because the approved Wrangler escalation was rejected after the Codex usage limit was reached. Migration SQL tests pass.
- Fresh foundation, delivery, conversation-intelligence, Snooze, follow-up reminder, Search v2, attachment-integrity, deferred-loading, draft-lifecycle, recipient-intelligence, signature, composer-input, and inline-image reviews found no P0 issues. Every reported P1 finding was fixed and covered by targeted regressions.
- Adversarial Outbox review found eight P1 issues; all eight were fixed and regression coverage was added.
- Integrated correctness, security, data-integrity, AI-cost, and UX reviews produced further P1 remediation rounds; all reported findings are fixed and covered by targeted regression tests. Independent final compose-refinement, Today-brief, AI lazy-boundary, cited Conversation Q&A, iterative reply-refinement, explainable Inbox-triage, Conversation Action History, and AI Search Interpreter re-reviews are clean at P0/P1. Search Interpreter review caught and fixed label-only broadening, private URL state, committed-result workspace intrusion, label-loading and focus gaps, Unicode bidi review deception, and maximum escaped-envelope composition.

## Next gate

Checkpoint the AI Search Interpreter, then run the next fresh capability-gap audit. Semantic search, mail-derived People and relationship intelligence, rules, and offline or realtime projection work remain gated on a permission-aware background architecture. Visual QA still requires explicit approval. The standards pass remains pending explicit scope confirmation.
