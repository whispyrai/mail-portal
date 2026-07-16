# Wiser Team Mail Portal Go-Live Runbook

This runbook is for WISER-242, the Wiser deployment of the shared Mail Portal codebase. It intentionally separates local verification from production mutations. Do not run the production-changing steps until the exact target and action have been approved.

## Production Shape

- App domain: `mail.wiserchat.ai`
- Inbound mail domain: `wiserchat.ai`. The locked direct-cutover plan does not use a temporary test domain.
- Launch mailboxes: `hesham@wiserchat.ai` (ADMIN/personal), `hello@wiserchat.ai`, `contact@wiserchat.ai`
- Unknown recipients: permanent SMTP reject via the Worker email handler
- Cloudflare Worker: `wiser-mail-portal`
- D1 database: `wiser_mail_portal_users` (`87c3de98-d31b-4ec3-8e05-d26b4dc71d92`)
- Attachment R2 bucket: `wiser-mail-portal`
- Authoritative raw-mail R2 bucket: `wiser-mail-raw-archive`
- Isolated raw-mail development preview bucket: `wiser-mail-raw-archive-preview`
- Inbound Queue: `wiser-mail-inbound`
- Dead-letter Queue: `wiser-mail-inbound-dlq`
- Terminal-ledger parking Queue: `wiser-mail-inbound-parking`
- Archive reconciler: every five minutes
- OAuth KV namespace: `wiser-mail-portal-oauth` (`c934d803c2f8430d9088f4a5d9f29d55`)
- AWS region: `eu-west-2`
- SES identity: `wiserchat.ai`

## Ordered Launch Path

The launch has three ordered stages. Do not interleave them:

1. Complete local verification and all separately approved production
   provisioning while Zoho still owns apex inbound mail. This includes the
   rebuilt Whispyr and Wiser artifact checks, read-only inventory, approved D1
   migration, approved resource and secret changes, deploy, admin/mailbox setup,
   outbound proof, push proof, and Zoho history import.
2. Request a separate approval naming the `wiserchat.ai` apex MX and Email
   Routing cutover. Only then change apex routing.
3. Validate production inbound delivery, isolation, rejection, recovery,
   monitoring, and rollback readiness before declaring go-live complete.

## Approval Gates

Each of these is a separate production mutation and needs explicit approval before execution:

1. Create any missing Wiser R2 bucket or Queue, or update the locked 14-day
   Queue retention.
2. Decide the raw R2 lifecycle and Bucket Lock behavior, then mutate either
   policy under a separate approval.
3. Apply remote D1 migrations to `wiser_mail_portal_users`.
4. Create or update the dedicated Wiser SES IAM credentials.
5. Deploy `wiser-mail-portal`.
6. Write Worker production secrets.
7. Create or change the Cloudflare custom domain, DNS, or Email Routing records.
8. Import Zoho exports into production mailboxes.
9. Change apex `wiserchat.ai` MX away from Zoho.
10. Disable or delete Zoho mailboxes/routing after final reconciliation.
11. Push a deployment branch, create or merge a PR, or change the deployed branch.

## Stage 1: Pre-Cutover Verification And Provisioning

### Local Preflight

Run these before any production mutation:

```bash
npm install
npm run assets:wiser
npm test
npm run typecheck
npm run typecheck:wiser
npm run verify:env:whispyr
npm run verify:env:wiser
npm run deploy:whispyr -- --dry-run --outdir /tmp/mail-portal-dry-run/whispyr
npm run deploy:wiser -- --dry-run --outdir /tmp/mail-portal-dry-run/wiser
```

Each `verify:env` command rebuilds its brand before inspecting the resolved
`build/server/wrangler.json`; together they rebuild and verify both brands. The
verifier prints bounded progress and owns a detailed
`script-logs/verify-built-environment-<brand>-<timestamp>.log` file. The Wiser
artifact must contain only `wiser-mail-portal`, `wiser_mail_portal_users`, the
`wiser-mail-portal` attachment bucket, the isolated
`wiser-mail-raw-archive`/`wiser-mail-raw-archive-preview` pair, the three Wiser
Queues, Wiser OAuth KV, Workers AI, the three Durable Object bindings, and the
single `mail.wiserchat.ai` route. `DOMAINS` must be exactly `wiserchat.ai` with no
`test.wiserchat.ai` reference. Scheduled triggers must be exactly `* * * * *`,
`*/5 * * * *`, and `17 * * * *`. The isolated dry-run output directories prevent
one brand's bundle from overwriting the other's evidence. Each dry-run must use
the redirected artifact and contain no resource belonging to the other brand.

### Cloudflare Database

After explicit approval for the Wiser production database, run:

```bash
npx wrangler d1 migrations apply DB --env wiser --remote
```

Apply every migration through `0011_create_saved_view_create_operations.sql`
before deploying the Worker version or Cron Trigger configuration in this
checkpoint. The ordering is mandatory because user, membership, and mailbox
lifecycle writes enqueue Agent connection reconciliation through migration 0010
triggers, while saved-view creation relies on the migration 0011 idempotency
ledger.

Validate with a read-only query:

```bash
npx wrangler d1 execute DB --env wiser --remote --command "SELECT type, name FROM sqlite_master WHERE name IN ('agent_connection_revocations', 'saved_view_create_operations', 'users_enqueue_agent_connection_reconciliation', 'mailbox_memberships_enqueue_agent_connection_reconciliation', 'mailboxes_enqueue_agent_connection_reconciliation') ORDER BY type, name"
```

The result must contain the `agent_connection_revocations` and
`saved_view_create_operations` tables and all three named triggers. This
`sqlite_master` SELECT is the strictly read-only migration proof. Do not use
`wrangler d1 migrations list` for preflight because the installed CLI may create
the migration ledger it is meant to inspect. Quiz tables may exist because the
migration directory is shared, but Wiser keeps the quiz feature disabled with
`FEATURES=[]`.

### Scheduled Maintenance

The deployment artifact must contain exactly three schedules:

- `* * * * *` drains durable Agent connection-reconciliation work. Work that
  fails during the invocation or remains immediately due fails that Cron turn,
  while the D1 outbox retains future-backoff items for later retries. Monitor the
  outbox separately because deferred work does not make every interim turn fail.
- `*/5 * * * *` reconciles authoritative raw R2 receipts with Queue and Mailbox
  projection state. It repairs safe gaps and durably records anomalies that need
  operator review.
- `17 * * * *` deletes expired AI response-cache rows in bounded batches. A
  remaining backlog fails the invocation instead of being hidden.

After an approved deploy, inspect Cron Trigger invocation logs without exposing
mail content or credentials. Verify all three schedules invoke the Worker and that
`agent_connection_revocations` reaches zero after an approved disposable
revocation drill. Do not modify a real user's credentials solely to create this
probe.

### Read-Only Cloudflare Inventory

Before requesting any production mutation, run the Wrangler 4.74 read-only
inspection commands:

```bash
npx wrangler r2 bucket info wiser-mail-portal --env wiser
npx wrangler r2 bucket info wiser-mail-raw-archive --env wiser
npx wrangler r2 bucket info wiser-mail-raw-archive-preview --env wiser
npx wrangler r2 bucket lifecycle list wiser-mail-raw-archive --env wiser
npx wrangler r2 bucket lock list wiser-mail-raw-archive --env wiser
npx wrangler queues info wiser-mail-inbound --env wiser
npx wrangler queues info wiser-mail-inbound-dlq --env wiser
npx wrangler queues info wiser-mail-inbound-parking --env wiser
```

The exact Queue graph is `wiser-mail-inbound` → `wiser-mail-inbound-dlq` →
`wiser-mail-inbound-parking`. The primary and DLQ consumers each use batch size
1, concurrency 1, batch timeout 5 seconds, and 10 retries; their retry delays are
1 and 60 seconds. The parking consumer uses batch size 1, concurrency 1, batch
timeout 5 seconds, 100 retries, and a 3600-second delay, with no further DLQ.
All three Queues are product-locked to 14-day retention.

`wrangler queues info` proves that a Queue exists, but it cannot prove retention
or consumer settings. Confirm retention separately in the Cloudflare control
plane; the rebuilt artifact verifier proves the configured consumer settings and
edges. Queue creation and retention updates are production mutations requiring
separate approval.

Raw R2 lifecycle and Bucket Lock retention are not product-locked. The read-only
list commands establish current state only. Before apex cutover, choose and
record the retention behavior as a future product decision, then obtain separate
approval before any lifecycle or lock mutation. No retention value or executable
mutation placeholder in this runbook is approved for use.

### AWS SES

`wiserchat.ai` must remain verified in SES `eu-west-2`, with DKIM successful, account out of sandbox, and custom MAIL FROM `mail.wiserchat.ai` successful before launch.

Create a dedicated Wiser IAM access key with least privilege for SES send only. The policy should allow `ses:SendEmail` against the Wiser SES identity and should restrict From addresses to `*@wiserchat.ai` where AWS condition keys are available. Do not reuse Whispyr SES keys.

Production secrets required by `env.wiser`:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
SES_EVENT_WEBHOOK_SECRET
JWT_SECRET
EMERGENCY_FORWARD_TO
ADMIN_BOOTSTRAP_EMAIL
ACCOUNT_RECOVERY_DIRECTORY
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
```

Use `ADMIN_BOOTSTRAP_EMAIL=hesham@wiserchat.ai`. Generate `JWT_SECRET` with at least 48 random base64 bytes. Generate a separate high-entropy `SES_EVENT_WEBHOOK_SECRET`. Store the approved JSON mapping from portal addresses to external recovery addresses in `ACCOUNT_RECOVERY_DIRECTORY`. Generate one VAPID keypair for Wiser push.

### First Deploy And Secrets

Wrangler validates `secrets.required` on deploy. For the first production deploy, use a temporary secrets file so the Worker is deployed with its required secrets in one operation:

```bash
umask 077
SECRETS_FILE="$(mktemp /tmp/wiser-mail-portal-secrets.XXXXXX)"
$EDITOR "$SECRETS_FILE"
npm run deploy:wiser -- --secrets-file "$SECRETS_FILE"
rm "$SECRETS_FILE"
```

The temporary file must use dotenv syntax and contain only the nine secret names
above. Do not commit it, paste it into tickets, or store it in the repo.
`.secrets*` is ignored as an extra local guard, but `/tmp` is preferred.

For secret rotation after the Worker exists, use:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID --env wiser
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env wiser
npx wrangler secret put SES_EVENT_WEBHOOK_SECRET --env wiser
npx wrangler secret put JWT_SECRET --env wiser
npx wrangler secret put EMERGENCY_FORWARD_TO --env wiser
npx wrangler secret put ADMIN_BOOTSTRAP_EMAIL --env wiser
npx wrangler secret put ACCOUNT_RECOVERY_DIRECTORY --env wiser
npx wrangler secret put VAPID_PUBLIC_KEY --env wiser
npx wrangler secret put VAPID_PRIVATE_KEY --env wiser
```

Note: `wrangler secret put` creates and deploys a new Worker version immediately. Use `wrangler versions secret put` only if we deliberately move to staged Workers versions/gradual deployments.

### HTTP Smoke Test

After deploy:

```bash
curl -I https://mail.wiserchat.ai/login
curl -s https://mail.wiserchat.ai/manifest.webmanifest
```

The manifest must use Wiser icons and Wiser theme values. The login page must render Wiser branding, not Whispyr.

### First Admin And Mailboxes

1. Visit `https://mail.wiserchat.ai/login`.
2. Sign in as `hesham@wiserchat.ai` with the chosen password to bootstrap the first ADMIN user.
3. In `/admin/users`, create or confirm:
   - `hello@wiserchat.ai`
   - `contact@wiserchat.ai`
4. Confirm each mailbox opens and creates its Durable Object state.
5. Confirm no non-launch mailbox exists.

Do not enable catch-all routing to production until these mailboxes exist. The inbound handler rejects unprovisioned recipients.

### Outbound Proof

From the production UI, send:

- `hesham@wiserchat.ai` to an external mailbox.
- `hello@wiserchat.ai` to an external mailbox.
- `contact@wiserchat.ai` to an external mailbox.
- A reply from one Wiser mailbox to a received thread.

Confirm SPF, DKIM, and DMARC pass in the external recipient headers. Confirm sent mail appears in the correct mailbox and does not leak across mailboxes.

### Push Proof

Use the repository's Playwright runner for browser validation at desktop and
mobile widths:

1. Install/enable notifications from `mail.wiserchat.ai`.
2. Confirm the subscription is stored in the user settings view.
3. Receive a message for a subscribed mailbox.
4. Confirm the notification uses Wiser icon/badge assets.
5. Disable notifications and confirm no new push is sent.

### Zoho Import

Export each Zoho mailbox as `.eml`. Keep exports outside the repo. Import only after the corresponding production mailbox exists:

```bash
read -s IMPORT_PASSWORD
export IMPORT_PASSWORD
node scripts/import-zoho.mjs \
  --base https://mail.wiserchat.ai \
  --email hesham@wiserchat.ai \
  --mailbox hello@wiserchat.ai \
  --dir /path/to/zoho-export/hello
unset IMPORT_PASSWORD
```

Repeat for `contact@wiserchat.ai`. The approved history scope is only `hello@wiserchat.ai` and `contact@wiserchat.ai`; importing `hesham@wiserchat.ai` requires a new explicit product decision. Re-running the same export is safe; the importer is expected to skip duplicates. Reconcile counts by folder, spot-check attachments, and confirm Trash/Spam are excluded.

## Stage 2: Separately Approved Apex MX Cutover

Only after Stage 1 outbound proof, import reconciliation, the raw R2 policy
decision and approved application, and a separate same-turn approval naming the
apex routing mutations:

1. Record current Zoho MX/TXT records and TTLs.
2. Lower relevant TTLs if needed and wait for propagation.
3. Enable Cloudflare Email Routing for `wiserchat.ai`.
4. Add a catch-all routing rule to `wiser-mail-portal`.
5. Replace Zoho MX records with Cloudflare Email Routing MX records.
6. Preserve/adjust SPF so both SES outbound and Cloudflare inbound forwarding needs are covered while the transition is active.
7. Stop. Stage 2 changes routing only; perform all live-message proof in Stage 3.

## Stage 3: Production Validation And Monitoring

After the apex cutover is active, validate only production addresses under the
approved external test-message scope:

1. Confirm the active apex catch-all delivers to `wiser-mail-portal`.
2. Send to `hesham@wiserchat.ai`, `hello@wiserchat.ai`, and
   `contact@wiserchat.ai`; confirm exact mailbox isolation and authoritative raw
   receipts.
3. Send to an unknown apex recipient and confirm permanent SMTP rejection.
4. Send a Bcc-only message and confirm routing uses the SMTP envelope recipient,
   not the visible `To` header.
5. Confirm the Queue graph drains normally and the parking Queue stays empty.
6. Monitor Worker logs, Cloudflare Email Routing activity, SES send metrics, and
   external inbox headers.

Do not create or operate `test.wiserchat.ai` mailboxes or Email Routing records.

### Inbound Monitoring And Recovery

Raw R2 is the receipt source of truth. Receipt sidecars live at
`receipts/<ingressId>.json`; the receipt privately identifies the exact archived
message. Exact R2 keys and provider details stay internal and never appear in
structured logs. Queue and Mailbox storage are projections.

During proof and cutover, monitor these conditions:

- Any `RAW_ARCHIVE_FAILED`, `RAW_ARCHIVE_SIZE_MISMATCH`, `RAW_ARCHIVE_CHECKSUM_UNAVAILABLE`, `RAW_ARCHIVE_CHECKSUM_MISMATCH`, or `RAW_ARCHIVE_CHECKSUM_PREPARATION_FAILED`: page immediately. Confirm the same `ingressId` then records either `direct_mailbox_fallback` status `succeeded`, or `emergency_forward` status `succeeded`. If neither exists, confirm `smtp_rejection` status `rejected` and investigate all three failed paths.
- Any `dead_letter_pending`, `dead_lettered`, `quarantined`, `STORED_PROJECTION_MISSING`, `ADMISSION_DECISION_MISSING`, `TERMINAL_FALLBACK_LEDGER_FAILED`, `RECONCILIATION_RUN_FAILED`, or `ARCHIVE_RECONCILIATION_FAILED`: investigate the same day. `dead_letter_pending` means Cloudflare has not yet confirmed the DLQ consumer. `dead_lettered` means the DLQ consumer or reconciler durably recorded the terminal failure. The DLQ consumer records that failure in both the R2 receipt and an independent Mailbox Durable Object ledger when available; either durable commit prevents the failure from disappearing. Neither state is automatically re-enqueued.
- Any `QUEUE_ENQUEUE_FAILED`: confirm a later `archive re-enqueued` and then `message acknowledged` for the same `ingressId`.
- Any `R2_DERIVED_UPLOAD_INTEGRITY_FAILED`: page the mail operator. The exact raw MIME remains authoritative, but the Mailbox projection needs retry or audited replay.
- Any `R2_DELETION_OUTBOX_FAILED`: investigate until a later `R2 deletion batch completed` proves cleanup. Mail is already deleted from the user view, but superseded attachment/body objects remain pending in the Mailbox Durable Object outbox.
- Non-zero backlog in either primary Queue or DLQ must be explained before declaring inbound healthy. Any message in a parking Queue is an immediate incident. Wiser uses `wiser-mail-inbound`, `wiser-mail-inbound-dlq`, and `wiser-mail-inbound-parking`. Whispyr uses `sales-mail-inbound`, `sales-mail-inbound-dlq`, and `sales-mail-inbound-parking`. Parking consumers retry terminal ledger persistence up to the platform maximum 100 times with an hourly delay.
- Normal-path success is proved by `raw_archive` status `succeeded`, followed by either `queue_enqueue` status `succeeded` or `archive_reconcile` status `reenqueued`, and finally `mailbox_projection` status `succeeded` or `duplicate`. A raw-archive incident is recovered only by a successful direct Mailbox fallback or successful emergency forwarding for the same `ingressId`.

The reconciler walks the raw archive with a conditionally updated continuation
cursor so old pages cannot starve and overlapping cron runs cannot move the
cursor backward. It automatically re-enqueues `archived` and `admitted`
receipts, plus `enqueued` or `retrying` receipts stale for at least fifteen
minutes. It never re-enqueues `dead_letter_pending`, `dead_lettered`, `deleted`,
`quarantined`, or `rejected` receipts. Before trusting stale dead-letter state,
it checks authoritative Mailbox truth in this order: deletion tombstone,
existing Message projection, then the independent terminal-failure ledger. A
Mailbox terminal ledger reconstructs `dead_lettered`; a stale
`dead_letter_pending` receipt without that ledger remains pending, creates
durable `pending_operator_review` anomaly evidence, and is not re-enqueued.
Elapsed time alone never creates terminal truth. A genuinely missing `stored`
projection reports `STORED_PROJECTION_MISSING`. Conditional receipt writes
prevent reconciliation from overwriting a state concurrently advanced by
another worker. An object-level failure is written to a durable failure ledger
before the main cursor advances. If the ledger write also fails, the cursor
stays on the page.

Raw objects without a receipt are never auto-admitted. Reconciliation writes `system/reconciliation-anomalies/<encoded-raw-key>.json` and a server-derived `system/inbound-recovery-pointers/<ingressId>.json`. The recovery pointer contains the immutable R2 identity validated from raw-object metadata and lets an operator use the normal audited recovery command without supplying a raw key. Do not manufacture or edit recovery pointers manually.

Messages whose selected body exceeds 512 KiB keep a bounded preview in the Mailbox Durable Object and store the complete UTF-8 body in attempt-scoped R2 objects. Attachment objects are also attempt-scoped. Unknown-length decoded streams use R2 multipart upload with one bounded 5 MiB part buffer because workerd requires a declared length for a one-shot R2 stream. Every derived R2 write verifies the returned byte length before the SQL projection can commit.

Deleting an email atomically tombstones the ingress identity and inserts all attachment/body object keys into the Mailbox Durable Object `r2_deletion_outbox`. Its alarm deletes objects idempotently and retries failures with exponential backoff. Never bypass the Mailbox delete operation with direct R2 deletion.

For a manual recovery, first inspect the receipt without modifying it:

```bash
npx wrangler r2 object get wiser-mail-raw-archive/receipts/<ingressId>.json --env wiser --remote --pipe
```

After confirming the intended mailbox in the receipt, recover with the dedicated one-message command. It sends only the ingress identity and target mailbox to the server. The authenticated admin endpoint loads the receipt and exact raw object directly from R2, validates the pointer schema, mailbox, size, ETag, and object version, then preserves the original `ingressId`. Do not use the Zoho importer because its historical-import identity would create a second Message when a live projection partially succeeded.

```bash
read -s IMPORT_PASSWORD
export IMPORT_PASSWORD
node scripts/recover-inbound.mjs \
  --base https://mail.wiserchat.ai \
  --email hesham@wiserchat.ai \
  --mailbox <target-mailbox@wiserchat.ai> \
  --ingress-id <ingressId>
unset IMPORT_PASSWORD
```

The command accepts only the approved HTTPS Wiser and Whispyr mail portal origins, applies a 15-second login timeout and a 60-second timeout to each of three recovery attempts, prints bounded progress to the terminal, and writes complete request and response detail to `script-logs/recover-inbound-<timestamp>.log`. It does not download raw message content to the operator machine or write secrets to the log. Before the Mailbox is touched, the server writes a unique append-only `system/recovery-audits/<ingressId>/<auditId>-requested.json` object. It reports success only after writing the matching `-completed.json` object with the result and authenticated operator. A receipt-level recovery summary is best effort because a concurrent Queue transition may supersede it; the append-only audit objects remain authoritative.

Verify the Message and attachments in the target Mailbox, then record the
`auditId`, `ingressId`, terminal receipt state, recovery result, operator, and log
path in the incident record. Keep exact R2 identities inside the private receipt
and server-side recovery flow. Never delete or overwrite the R2 raw object or
recovery audit objects as part of replay.

Before either environment is deployed, create or verify all three Queues, set message retention to the paid-plan maximum 14 days, and verify every binding and consumer. Cloudflare may create a missing configured DLQ during deployment, so pre-creation and inspection prevent an unreviewed resource from appearing implicitly. Queue creation, retention changes, secret changes, and deployment require separate same-turn approval. Set the `EMERGENCY_FORWARD_TO` secret only after `heshamelmahdi@gmail.com` is a verified Cloudflare Email Routing destination.

## Rollback

Rollback before Zoho decommission:

1. Restore recorded Zoho MX records for `wiserchat.ai`.
2. Disable or bypass the Cloudflare Email Routing rule for apex.
3. Leave `mail.wiserchat.ai` running for UI access and data inspection unless a Worker incident specifically requires rollback.
4. Re-run live receive tests against Zoho and confirm no new mail is landing in the Worker.

Do not delete Wiser D1/R2/KV resources during rollback. Preserve imported mail and logs for reconciliation.
Do not delete the raw-mail bucket, Queue, DLQ, receipt sidecars, or raw objects during rollback.

## Post-Go-Live Cleanup

After an agreed observation window:

1. Run a final Zoho delta export and import.
2. Reconcile message counts and spot-check important threads.
3. Confirm `DOMAINS` remains exactly `wiserchat.ai` and that no temporary test-domain routing exists.
4. Decommission Zoho routing/mailboxes only after explicit approval.
5. Write the final launch note in `~/Documents/hesham-os/wiserchat/logs/notes/`.

## Stop Conditions

Stop and rollback or ask for direction if any of these happen:

- Wiser build or dry-run references a Whispyr resource.
- Unknown recipients are accepted instead of rejected.
- Any route other than the approved apex catch-all receives live Wiser mail.
- SES headers fail DKIM or SPF for Wiser.
- The UI shows Whispyr branding on `mail.wiserchat.ai`.
- Imported mail count reconciliation fails without an explained duplicate/skip reason.
- Any raw archive write fails or the raw object size does not match the Email Worker envelope size.
- The inbound Queue, DLQ, or parking Queue is missing, paused unexpectedly, has the wrong retention, or has an unexplained backlog.
- A receipt reports `dead_lettered`, `quarantined`, or `STORED_PROJECTION_MISSING` without an active incident and verified recovery decision.
- Apex cutover is requested before raw R2 lifecycle and Bucket Lock behavior is
  product-locked, recorded, separately approved, and applied.
- Any secret appears in terminal output, files under git, Jira, or documentation.
