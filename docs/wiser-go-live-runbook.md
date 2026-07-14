# Wiser Team Mail Portal Go-Live Runbook

This runbook is for WISER-242, the Wiser deployment of the shared Mail Portal codebase. It intentionally separates local verification from production mutations. Do not run the production-changing steps until the exact target and action have been approved.

## Production Shape

- App domain: `mail.wiserchat.ai`
- Inbound mail domains during proof: `test.wiserchat.ai`, then `wiserchat.ai` after MX cutover approval
- Launch mailboxes: `hesham@wiserchat.ai` (ADMIN/personal), `hello@wiserchat.ai`, `contact@wiserchat.ai`
- Unknown recipients: permanent SMTP reject via the Worker email handler
- Cloudflare Worker: `wiser-mail-portal`
- D1 database: `wiser_mail_portal_users` (`87c3de98-d31b-4ec3-8e05-d26b4dc71d92`)
- Attachment R2 bucket: `wiser-mail-portal`
- Authoritative raw-mail R2 bucket: `wiser-mail-raw-archive`
- Isolated raw-mail development preview bucket: `wiser-mail-raw-archive-preview`
- Inbound Queue: `wiser-mail-inbound`
- Dead-letter Queue: `wiser-mail-inbound-dlq`
- Archive reconciler: every five minutes
- OAuth KV namespace: `wiser-mail-portal-oauth` (`c934d803c2f8430d9088f4a5d9f29d55`)
- AWS region: `eu-west-2`
- SES identity: `wiserchat.ai`

## Approval Gates

Each of these is a separate production mutation and needs explicit approval before execution:

1. Apply remote D1 migrations to `wiser_mail_portal_users`.
2. Create or update the dedicated Wiser SES IAM credentials.
3. Create `wiser-mail-raw-archive`, `wiser-mail-raw-archive-preview`, `wiser-mail-inbound`, and `wiser-mail-inbound-dlq`.
4. Apply the approved raw retention, lifecycle, and Bucket Lock policy.
5. Deploy `wiser-mail-portal` with the new bindings and consumer.
6. Write Worker production secrets.
7. Create or change Cloudflare custom domain/DNS/Email Routing records.
8. Import Zoho exports into production mailboxes.
9. Change apex `wiserchat.ai` MX away from Zoho.
10. Disable or delete Zoho mailboxes/routing after final reconciliation.

## Local Preflight

Run these before any production mutation:

```bash
npm install
npm run assets:wiser
npm test
npm run typecheck
npm run typecheck:wiser
npm run verify:env:whispyr
npm run verify:env:wiser
npm run deploy:wiser -- --dry-run
```

The Wiser build must say it is using `.dev.vars.wiser`, and the deploy dry-run must say it is using the redirected `build/server/wrangler.json`. The binding summary must list only Wiser resources: `wiser-mail-portal`, `wiser_mail_portal_users`, `wiser-mail-portal`, `wiser-mail-raw-archive`, `wiser-mail-inbound`, `wiser-mail-inbound-dlq`, `c934d803c2f8430d9088f4a5d9f29d55`, and `mail.wiserchat.ai`.

## Durable Inbound Resources

These commands mutate Cloudflare production state. Run them only after explicit approval naming the Wiser account and each resource:

```bash
npx wrangler r2 bucket create wiser-mail-raw-archive
npx wrangler r2 bucket create wiser-mail-raw-archive-preview
npx wrangler queues create wiser-mail-inbound
npx wrangler queues create wiser-mail-inbound-dlq
```

Both raw buckets must stay private. The preview bucket isolates remote development from the production archive and must never receive production routing. The exact production retention duration is a separate product decision and must be approved before rollout. After that decision, apply matching lifecycle and lock rules to the production `raw/` prefix. The lifecycle expiry must never be earlier than the lock retention:

```bash
npx wrangler r2 bucket lock add wiser-mail-raw-archive raw-retention raw/ --retention-days <approved-retention-days>
npx wrangler r2 bucket lifecycle add wiser-mail-raw-archive raw-expiry raw/ --expire-days <approved-retention-days>
```

Then verify both rules without changing them:

```bash
npx wrangler r2 bucket lock list wiser-mail-raw-archive
npx wrangler r2 bucket lifecycle list wiser-mail-raw-archive
npx wrangler queues info wiser-mail-inbound
npx wrangler queues info wiser-mail-inbound-dlq
```

Do not deploy until all four resources exist and the lock/lifecycle output matches the approved policy.

## Cloudflare Database

Approved remote command:

```bash
npx wrangler d1 migrations apply DB --env wiser --remote
```

Validate with a read-only query:

```bash
npx wrangler d1 execute DB --env wiser --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
```

Expected tables include `users`. Quiz tables may exist because the migration directory is shared, but Wiser keeps the quiz feature disabled with `FEATURES=[]`.

## AWS SES

`wiserchat.ai` must remain verified in SES `eu-west-2`, with DKIM successful, account out of sandbox, and custom MAIL FROM `mail.wiserchat.ai` successful before launch.

Create a dedicated Wiser IAM access key with least privilege for SES send only. The policy should allow `ses:SendEmail` against the Wiser SES identity and should restrict From addresses to `*@wiserchat.ai` where AWS condition keys are available. Do not reuse Whispyr SES keys.

Production secrets required by `env.wiser`:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
JWT_SECRET
EMERGENCY_FORWARD_TO
ADMIN_BOOTSTRAP_EMAIL
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
```

Use `ADMIN_BOOTSTRAP_EMAIL=hesham@wiserchat.ai`. Generate `JWT_SECRET` with at least 48 random base64 bytes. Generate one VAPID keypair for Wiser push. Set `EMERGENCY_FORWARD_TO` to the independent Gmail destination recorded in the private inbound-durability ADR. Before deployment, add that destination to Cloudflare Email Routing and complete its verification email. An unverified destination makes the final fallback fail.

## First Deploy And Secrets

Wrangler validates `secrets.required` on deploy. For the first production deploy, use a temporary secrets file so the Worker is deployed with its required secrets in one operation:

```bash
umask 077
SECRETS_FILE="$(mktemp /tmp/wiser-mail-portal-secrets.XXXXXX)"
$EDITOR "$SECRETS_FILE"
npm run deploy:wiser -- --secrets-file "$SECRETS_FILE"
rm "$SECRETS_FILE"
```

The temporary file must use dotenv syntax and contain only the seven secret names above. Do not commit it, paste it into tickets, or store it in the repo. `.secrets*` is ignored as an extra local guard, but `/tmp` is preferred.

For secret rotation after the Worker exists, use:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID --env wiser
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env wiser
npx wrangler secret put JWT_SECRET --env wiser
npx wrangler secret put EMERGENCY_FORWARD_TO --env wiser
npx wrangler secret put ADMIN_BOOTSTRAP_EMAIL --env wiser
npx wrangler secret put VAPID_PUBLIC_KEY --env wiser
npx wrangler secret put VAPID_PRIVATE_KEY --env wiser
```

Note: `wrangler secret put` creates and deploys a new Worker version immediately. Use `wrangler versions secret put` only if we deliberately move to staged Workers versions/gradual deployments.

## HTTP Smoke Test

After deploy:

```bash
curl -I https://mail.wiserchat.ai/login
curl -s https://mail.wiserchat.ai/manifest.webmanifest
```

The manifest must use Wiser icons and Wiser theme values. The login page must render Wiser branding, not Whispyr.

## First Admin And Mailboxes

1. Visit `https://mail.wiserchat.ai/login`.
2. Sign in as `hesham@wiserchat.ai` with the chosen password to bootstrap the first ADMIN user.
3. In `/admin/users`, create or confirm:
   - `hello@wiserchat.ai`
   - `contact@wiserchat.ai`
4. Confirm each mailbox opens and creates its Durable Object state.
5. Confirm no non-launch mailbox exists.

Do not enable catch-all routing to production until these mailboxes exist. The inbound handler rejects unprovisioned recipients.

## Email Routing Proof

Before apex cutover, use `test.wiserchat.ai` only:

1. Add Cloudflare Email Routing for `test.wiserchat.ai`.
2. Create a catch-all routing rule that delivers to `wiser-mail-portal`.
3. Send test messages to the three launch recipients at `test.wiserchat.ai` only if matching mailboxes are intentionally created for that proof, or use an approved temporary test mailbox.
4. Send to an unknown test recipient and confirm permanent SMTP reject.
5. Send a Bcc-only message and confirm routing uses the SMTP envelope recipient, not the visible `To` header.

If the proof needs `hello@test.wiserchat.ai` or similar, create those as temporary mailboxes and delete them before apex go-live, or use one dedicated approved test mailbox. Do not silently create production `wiserchat.ai` mailboxes from inbound mail.

## Outbound Proof

From the production UI, send:

- `hesham@wiserchat.ai` to an external mailbox.
- `hello@wiserchat.ai` to an external mailbox.
- `contact@wiserchat.ai` to an external mailbox.
- A reply from one Wiser mailbox to a received thread.

Confirm SPF, DKIM, and DMARC pass in the external recipient headers. Confirm sent mail appears in the correct mailbox and does not leak across mailboxes.

## Push Proof

In Chrome and Safari where practical:

1. Install/enable notifications from `mail.wiserchat.ai`.
2. Confirm the subscription is stored in the user settings view.
3. Receive a message for a subscribed mailbox.
4. Confirm the notification uses Wiser icon/badge assets.
5. Disable notifications and confirm no new push is sent.

## Zoho Import

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

Repeat for `contact@wiserchat.ai` and any approved `hesham@wiserchat.ai` history. Re-running the same export is safe; the importer is expected to skip duplicates. Reconcile counts by folder, spot-check attachments, and confirm Trash/Spam are excluded.

## Apex MX Cutover

Only after staging proof, outbound proof, import reconciliation, and user approval:

1. Record current Zoho MX/TXT records and TTLs.
2. Lower relevant TTLs if needed and wait for propagation.
3. Enable Cloudflare Email Routing for `wiserchat.ai`.
4. Add a catch-all routing rule to `wiser-mail-portal`.
5. Replace Zoho MX records with Cloudflare Email Routing MX records.
6. Preserve/adjust SPF so both SES outbound and Cloudflare inbound forwarding needs are covered while the transition is active.
7. Send live messages to `hesham@wiserchat.ai`, `hello@wiserchat.ai`, and `contact@wiserchat.ai`.
8. Send to an unknown live recipient and confirm permanent SMTP reject.
9. Monitor Worker logs, Cloudflare Email Routing activity, SES send metrics, and external inbox headers.

## Inbound Monitoring And Recovery

Raw R2 is the receipt source of truth. Receipt sidecars live at `receipts/<ingressId>.json`; exact messages live at the `rawKey` recorded in that sidecar and in structured Worker logs. Queue and Mailbox storage are projections.

During proof and cutover, monitor these conditions:

- Any `RAW_ARCHIVE_FAILED`, `RAW_ARCHIVE_SIZE_MISMATCH`, `RAW_ARCHIVE_CHECKSUM_UNAVAILABLE`, `RAW_ARCHIVE_CHECKSUM_MISMATCH`, or `RAW_ARCHIVE_CHECKSUM_PREPARATION_FAILED`: page immediately. Confirm the same `ingressId` then records either `direct_mailbox_fallback` status `succeeded`, or `emergency_forward` status `succeeded`. If neither exists, confirm `smtp_rejection` status `rejected` and investigate all three failed paths.
- Any `dead_letter_pending`, `dead_lettered`, `quarantined`, `STORED_PROJECTION_MISSING`, `ADMISSION_DECISION_MISSING`, `TERMINAL_FALLBACK_LEDGER_FAILED`, `RECONCILIATION_RUN_FAILED`, or `ARCHIVE_RECONCILIATION_FAILED`: investigate the same day. `dead_letter_pending` means Cloudflare has not yet confirmed the DLQ consumer. `dead_lettered` means the DLQ consumer or reconciler durably recorded the terminal failure. The DLQ consumer records that failure in both the R2 receipt and an independent Mailbox Durable Object ledger when available; either durable commit prevents the failure from disappearing. Neither state is automatically re-enqueued.
- Any `QUEUE_ENQUEUE_FAILED`: confirm a later `archive re-enqueued` and then `message acknowledged` for the same `ingressId`.
- Any `R2_DERIVED_UPLOAD_INTEGRITY_FAILED`: page the mail operator. The exact raw MIME remains authoritative, but the Mailbox projection needs retry or audited replay.
- Any `R2_DELETION_OUTBOX_FAILED`: investigate until a later `R2 deletion batch completed` proves cleanup. Mail is already deleted from the user view, but superseded attachment/body objects remain pending in the Mailbox Durable Object outbox.
- Non-zero backlog in either primary Queue or DLQ must be explained before declaring inbound healthy. Any message in a parking Queue is an immediate incident. Wiser uses `wiser-mail-inbound`, `wiser-mail-inbound-dlq`, and `wiser-mail-inbound-parking`. Whispyr uses `sales-mail-inbound`, `sales-mail-inbound-dlq`, and `sales-mail-inbound-parking`. Parking consumers retry terminal ledger persistence up to the platform maximum 100 times with an hourly delay.
- Normal-path success is proved by `raw_archive` status `succeeded`, followed by either `queue_enqueue` status `succeeded` or `archive_reconcile` status `reenqueued`, and finally `mailbox_projection` status `succeeded` or `duplicate`. A raw-archive incident is recovered only by a successful direct Mailbox fallback or successful emergency forwarding for the same `ingressId`.

The reconciler walks the raw archive with a conditionally updated continuation cursor so old pages cannot starve and overlapping cron runs cannot move the cursor backward. It automatically re-enqueues `archived` and `admitted` receipts, plus `enqueued` or `retrying` receipts stale for at least fifteen minutes. It never re-enqueues `dead_letter_pending`, `dead_lettered`, `deleted`, `quarantined`, or `rejected` receipts. A stale `dead_letter_pending` receipt is conditionally terminalized as `dead_lettered`. A Mailbox terminal-failure ledger entry also reconstructs `dead_lettered` after an R2 receipt outage. Deletion tombstones become terminal `deleted` receipts before re-enqueue, while a genuinely missing `stored` projection reports `STORED_PROJECTION_MISSING` for operator review. Conditional receipt writes prevent reconciliation from overwriting a state concurrently advanced by another worker. An object-level failure is written to a durable failure ledger before the main cursor advances. If the ledger write also fails, the cursor stays on the page.

Raw objects without a receipt are never auto-admitted. Reconciliation writes `system/reconciliation-anomalies/<encoded-raw-key>.json` and a server-derived `system/inbound-recovery-pointers/<ingressId>.json`. The recovery pointer contains the immutable R2 identity validated from raw-object metadata and lets an operator use the normal audited recovery command without supplying a raw key. Do not manufacture or edit recovery pointers manually.

Messages whose selected body exceeds 512 KiB keep a bounded preview in the Mailbox Durable Object and store the complete UTF-8 body in attempt-scoped R2 objects. Attachment objects are also attempt-scoped. Unknown-length decoded streams use R2 multipart upload with one bounded 5 MiB part buffer because workerd requires a declared length for a one-shot R2 stream. Every derived R2 write verifies the returned byte length before the SQL projection can commit.

Deleting an email atomically tombstones the ingress identity and inserts all attachment/body object keys into the Mailbox Durable Object `r2_deletion_outbox`. Its alarm deletes objects idempotently and retries failures with exponential backoff. Never bypass the Mailbox delete operation with direct R2 deletion.

For a manual recovery, first inspect the receipt without modifying it:

```bash
npx wrangler r2 object get wiser-mail-raw-archive/receipts/<ingressId>.json --remote --pipe
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

Verify the Message and attachments in the target Mailbox, then record the `auditId`, `ingressId`, `rawKey`, terminal receipt state, recovery result, operator, and log path in the incident record. Never delete or overwrite the R2 raw object or recovery audit objects as part of replay.

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
3. Remove temporary `test.wiserchat.ai` Email Routing and any temporary test mailboxes.
4. Consider a follow-up config change to remove `test.wiserchat.ai` from `DOMAINS` after proof is no longer needed.
5. Decommission Zoho routing/mailboxes only after explicit approval.
6. Write the final launch note in `~/Documents/hesham-os/wiserchat/logs/notes/`.

## Stop Conditions

Stop and rollback or ask for direction if any of these happen:

- Wiser build or dry-run references a Whispyr resource.
- Unknown recipients are accepted instead of rejected.
- A test route receives live apex mail before cutover approval.
- SES headers fail DKIM or SPF for Wiser.
- The UI shows Whispyr branding on `mail.wiserchat.ai`.
- Imported mail count reconciliation fails without an explained duplicate/skip reason.
- Any raw archive write fails or the raw object size does not match the Email Worker envelope size.
- The inbound Queue or DLQ is missing, paused unexpectedly, or has an unexplained backlog.
- A receipt reports `dead_lettered`, `quarantined`, or `STORED_PROJECTION_MISSING` without an active incident and verified recovery decision.
- The raw bucket has no approved lifecycle and Bucket Lock policy.
- Any secret appears in terminal output, files under git, Jira, or documentation.
