# Wiser Team Mail Portal Go-Live Runbook

This runbook is for WISER-242, the Wiser deployment of the shared Mail Portal codebase. It intentionally separates local verification from production mutations. Do not run the production-changing steps until the exact target and action have been approved.

## Production Shape

- App domain: `mail.wiserchat.ai`
- Inbound mail domain: `wiserchat.ai`. The locked direct-cutover plan does not use a temporary test domain.
- Launch mailboxes: `hesham@wiserchat.ai` (ADMIN/personal), `hello@wiserchat.ai`, `contact@wiserchat.ai`
- Unknown recipients: permanent SMTP reject via the Worker email handler
- Cloudflare Worker: `wiser-mail-portal`
- D1 database: `wiser_mail_portal_users` (`87c3de98-d31b-4ec3-8e05-d26b4dc71d92`)
- R2 bucket: `wiser-mail-portal`
- OAuth KV namespace: `wiser-mail-portal-oauth` (`c934d803c2f8430d9088f4a5d9f29d55`)
- AWS region: `eu-west-2`
- SES identity: `wiserchat.ai`

## Approval Gates

Each of these is a separate production mutation and needs explicit approval before execution:

1. Apply remote D1 migrations to `wiser_mail_portal_users`.
2. Create or update the dedicated Wiser SES IAM credentials.
3. Deploy `wiser-mail-portal`.
4. Write Worker production secrets.
5. Create or change Cloudflare custom domain/DNS/Email Routing records.
6. Import Zoho exports into production mailboxes.
7. Change apex `wiserchat.ai` MX away from Zoho.
8. Disable or delete Zoho mailboxes/routing after final reconciliation.
9. Push a deployment branch, create or merge a PR, or change the deployed branch.

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

The Wiser build must say it is using `.dev.vars.wiser`, and the deploy dry-run must say it is using the redirected `build/server/wrangler.json`. The binding summary must list only Wiser resources: `wiser-mail-portal`, `wiser_mail_portal_users`, `wiser-mail-portal`, `c934d803c2f8430d9088f4a5d9f29d55`, and `mail.wiserchat.ai`. Its `DOMAINS` value must be exactly `wiserchat.ai`, and its scheduled triggers must be exactly `* * * * *` plus `17 * * * *`.

## Cloudflare Database

After explicit approval for the Wiser production database, run:

```bash
npx wrangler d1 migrations apply DB --env wiser --remote
```

Apply every migration through `0010_create_agent_connection_revocations.sql`
before deploying the Worker version or Cron Trigger configuration in this
checkpoint. The ordering is mandatory because user, membership, and mailbox
lifecycle writes enqueue Agent connection reconciliation through migration 0010
triggers.

Validate with a read-only query:

```bash
npx wrangler d1 execute DB --env wiser --remote --command "SELECT type, name FROM sqlite_master WHERE name IN ('agent_connection_revocations', 'users_enqueue_agent_connection_reconciliation', 'mailbox_memberships_enqueue_agent_connection_reconciliation', 'mailboxes_enqueue_agent_connection_reconciliation') ORDER BY type, name"
```

The result must contain the `agent_connection_revocations` table and all three
named triggers. Quiz tables may exist because the migration directory is shared,
but Wiser keeps the quiz feature disabled with `FEATURES=[]`.

## Scheduled Maintenance

The deployment artifact must contain exactly two schedules:

- `* * * * *` drains durable Agent connection-reconciliation work. Work that
  fails during the invocation or remains immediately due fails that Cron turn,
  while the D1 outbox retains future-backoff items for later retries. Monitor the
  outbox separately because deferred work does not make every interim turn fail.
- `17 * * * *` deletes expired AI response-cache rows in bounded batches. A
  remaining backlog fails the invocation instead of being hidden.

After an approved deploy, inspect Cron Trigger invocation logs without exposing
mail content or credentials. Verify both schedules invoke the Worker and that
`agent_connection_revocations` reaches zero after an approved disposable
revocation drill. Do not modify a real user's credentials solely to create this
probe.

## AWS SES

`wiserchat.ai` must remain verified in SES `eu-west-2`, with DKIM successful, account out of sandbox, and custom MAIL FROM `mail.wiserchat.ai` successful before launch.

Create a dedicated Wiser IAM access key with least privilege for SES send only. The policy should allow `ses:SendEmail` against the Wiser SES identity and should restrict From addresses to `*@wiserchat.ai` where AWS condition keys are available. Do not reuse Whispyr SES keys.

Production secrets required by `env.wiser`:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
SES_EVENT_WEBHOOK_SECRET
JWT_SECRET
ADMIN_BOOTSTRAP_EMAIL
ACCOUNT_RECOVERY_DIRECTORY
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
```

Use `ADMIN_BOOTSTRAP_EMAIL=hesham@wiserchat.ai`. Generate `JWT_SECRET` with at least 48 random base64 bytes. Generate a separate high-entropy `SES_EVENT_WEBHOOK_SECRET`. Store the approved JSON mapping from portal addresses to external recovery addresses in `ACCOUNT_RECOVERY_DIRECTORY`. Generate one VAPID keypair for Wiser push.

## First Deploy And Secrets

Wrangler validates `secrets.required` on deploy. For the first production deploy, use a temporary secrets file so the Worker is deployed with its required secrets in one operation:

```bash
umask 077
SECRETS_FILE="$(mktemp /tmp/wiser-mail-portal-secrets.XXXXXX)"
$EDITOR "$SECRETS_FILE"
npm run deploy:wiser -- --secrets-file "$SECRETS_FILE"
rm "$SECRETS_FILE"
```

The temporary file must use dotenv syntax and contain only the eight secret names above. Do not commit it, paste it into tickets, or store it in the repo. `.secrets*` is ignored as an extra local guard, but `/tmp` is preferred.

For secret rotation after the Worker exists, use:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID --env wiser
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env wiser
npx wrangler secret put SES_EVENT_WEBHOOK_SECRET --env wiser
npx wrangler secret put JWT_SECRET --env wiser
npx wrangler secret put ADMIN_BOOTSTRAP_EMAIL --env wiser
npx wrangler secret put ACCOUNT_RECOVERY_DIRECTORY --env wiser
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

## Production Email Routing Validation

The apex cutover is active. Validate only the production addresses after explicit
approval for the external test messages:

1. Confirm the active apex catch-all delivers to `wiser-mail-portal`.
2. Send to each approved launch mailbox and confirm exact mailbox isolation.
3. Send to an unknown apex recipient and confirm permanent SMTP rejection.
4. Send a Bcc-only message and confirm routing uses the SMTP envelope recipient,
   not the visible `To` header.

Do not create or operate `test.wiserchat.ai` mailboxes or Email Routing records.

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

For a future cutover replay or rollback recovery, only after outbound proof,
import reconciliation, and user approval:

1. Record current Zoho MX/TXT records and TTLs.
2. Lower relevant TTLs if needed and wait for propagation.
3. Enable Cloudflare Email Routing for `wiserchat.ai`.
4. Add a catch-all routing rule to `wiser-mail-portal`.
5. Replace Zoho MX records with Cloudflare Email Routing MX records.
6. Preserve/adjust SPF so both SES outbound and Cloudflare inbound forwarding needs are covered while the transition is active.
7. Send live messages to `hesham@wiserchat.ai`, `hello@wiserchat.ai`, and `contact@wiserchat.ai`.
8. Send to an unknown live recipient and confirm permanent SMTP reject.
9. Monitor Worker logs, Cloudflare Email Routing activity, SES send metrics, and external inbox headers.

## Rollback

Rollback before Zoho decommission:

1. Restore recorded Zoho MX records for `wiserchat.ai`.
2. Disable or bypass the Cloudflare Email Routing rule for apex.
3. Leave `mail.wiserchat.ai` running for UI access and data inspection unless a Worker incident specifically requires rollback.
4. Re-run live receive tests against Zoho and confirm no new mail is landing in the Worker.

Do not delete Wiser D1/R2/KV resources during rollback. Preserve imported mail and logs for reconciliation.

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
- Any secret appears in terminal output, files under git, Jira, or documentation.
