# Wiser Team Mail Portal Go-Live Runbook

This runbook is for WISER-242, the Wiser deployment of the shared Mail Portal codebase. It intentionally separates local verification from production mutations. Do not run the production-changing steps until the exact target and action have been approved.

## Production Shape

- App domain: `mail.wiserchat.ai`
- Inbound mail domains during proof: `test.wiserchat.ai`, then `wiserchat.ai` after MX cutover approval
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
9. Commit and push the implementation.

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

The Wiser build must say it is using `.dev.vars.wiser`, and the deploy dry-run must say it is using the redirected `build/server/wrangler.json`. The binding summary must list only Wiser resources: `wiser-mail-portal`, `wiser_mail_portal_users`, `wiser-mail-portal`, `c934d803c2f8430d9088f4a5d9f29d55`, and `mail.wiserchat.ai`.

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
ADMIN_BOOTSTRAP_EMAIL
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
```

Use `ADMIN_BOOTSTRAP_EMAIL=hesham@wiserchat.ai`. Generate `JWT_SECRET` with at least 48 random base64 bytes. Generate one VAPID keypair for Wiser push.

## First Deploy And Secrets

Wrangler validates `secrets.required` on deploy. For the first production deploy, use a temporary secrets file so the Worker is deployed with its required secrets in one operation:

```bash
umask 077
SECRETS_FILE="$(mktemp /tmp/wiser-mail-portal-secrets.XXXXXX)"
$EDITOR "$SECRETS_FILE"
npm run deploy:wiser -- --secrets-file "$SECRETS_FILE"
rm "$SECRETS_FILE"
```

The temporary file must use dotenv syntax and contain only the six secret names above. Do not commit it, paste it into tickets, or store it in the repo. `.secrets*` is ignored as an extra local guard, but `/tmp` is preferred.

For secret rotation after the Worker exists, use:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID --env wiser
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env wiser
npx wrangler secret put JWT_SECRET --env wiser
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
- Any secret appears in terminal output, files under git, Jira, or documentation.
