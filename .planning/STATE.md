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
- Mailbox-wide Snooze is live with a protected folder, message or anchored-conversation scope, local-time controls, explicit Return and Undo, bounded durable alarms, authoritative inbound reply wake, attribution, keyboard and touch actions, and stale-detail reconciliation for automatic or teammate wake.
- Private follow-up reminders now have an owner-scoped D1 contract, immutable create and mutation replay, canonical stored-mail anchors, atomic access-aware inbound completion, and an idempotent Durable Object retry queue. Routes, client controls, and the Today workspace are the next integration gate.
- The first adversarial Outbox review and all integrated foundation, intelligence, Snooze, and reminder-persistence review rounds are complete. Every reported P1 finding has a regression fix.

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

- `npm test`: 456/456 passing.
- `npx tsc -b`: passing.
- `git diff --check`: passing.
- `npm run build:wiser`: production client and SSR artifacts built; Wrangler emitted the expected non-fatal sandbox log-file warning, missing-local-secrets warning, and a 530 kB main mailbox chunk warning.
- Local D1 migrations 0001 through 0003 applied successfully to the local Wiser database.
- Local migration 0004 application is pending because the approved Wrangler escalation was rejected after the Codex usage limit was reached. Migration SQL tests pass.
- Fresh foundation, delivery, conversation-intelligence, Snooze, and follow-up reminder reviews found no P0 issues. Every reported P1 finding was fixed and covered by targeted regressions.
- Adversarial Outbox review found eight P1 issues; all eight were fixed and regression coverage was added.
- Integrated correctness, security, and AI-cost reviews produced two further P1 remediation rounds; all reported findings are fixed and covered by targeted regression tests.

## Next gate

Commit the reviewed checkpoint, then mount private follow-up reminder routes and controls, build the Today workspace, deepen search and composition, split the 529 kB mailbox bundle, and continue approved visual QA work. The standards pass remains pending explicit scope confirmation.
