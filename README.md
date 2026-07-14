<div align="center">
  <h1>Mail Portal</h1>
  <p><em>Self-hosted team email — send/receive, bulk send, and a manual AI assistant, on Cloudflare Workers + AWS SES. One brand-parameterized codebase, one isolated deploy per brand.</em></p>
</div>

A fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) (Apache 2.0). Users log in with email + password, send and receive from `firstname@<brand-domain>`, do light bulk send (mail merge), and use a manually-invoked AI assistant.

This is a **shared, brand-parameterized platform**: source is shared, but each brand deploys as its own isolated Cloudflare Worker (own D1, Durable Objects, R2, KV, SES identity, secrets, and domain) via a named Wrangler environment. Brands are selected at build time with `CLOUDFLARE_ENV` - e.g. `npm run deploy:whispyr` or `npm run deploy:wiser`. Whispyr (`mail.whispyrcrm.com`) is live; Wiser (`mail.wiserchat.ai`) is isolated in `env.wiser` and follows the Wiser go-live runbook.

Design + decisions live in the second brain: the shared platform in `~/Documents/hesham-os/wiserchat/initiatives/team-mail-portal/`, Whispyr history in `~/Documents/hesham-os/whispyr-sales/initiatives/sales-mail-portal/`.

## What changed from upstream

| Area          | Upstream                                      | This fork                                                                                 |
| ------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Outbound      | Cloudflare Email Sending (`env.EMAIL.send()`) | **AWS SES** (API v2 `SendEmail`, Simple content) via `aws4fetch`                          |
| Auth          | Cloudflare Access                             | **Email + password**, hand-rolled (PBKDF2 + JWT cookie via `jose`), roles `AGENT`/`ADMIN` |
| Authorization | None (any authed user → any mailbox)          | **Per-mailbox**: a rep sees only their mailbox; an admin sees all                         |
| Users         | implicit (Access)                             | **D1 `users` table** + `/admin/users` console                                             |
| AI model      | Kimi K2.5                                     | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, **manual-only** (auto-draft removed)          |
| MCP (`/mcp`)  | open to any authed user                       | **per-user bearer token**; reads admin=all/agent=own, writes own-only                     |
| Bulk send     | -                                             | **CSV mail merge** with a DO alarm scheduler (`/bulk`)                                    |
| Apex landing  | -                                             | separate static site on Vercel (this Worker serves `mail.` only)                          |

## Architecture

Single Cloudflare Worker (Hono + React Router v7 SSR). Per-mailbox state in Durable Objects (SQLite via Drizzle); attachments in R2; global users in D1. Inbound via Cloudflare Email Routing (catch-all → Worker). Outbound via AWS SES (`eu-west-2`). Threading is SES-proof via an app-controlled `References` token (SES rewrites `Message-ID`).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars.whispyr   # for Whispyr local dev
cp .dev.vars.example .dev.vars.wiser     # for Wiser local dev
npm run dev:whispyr                      # Cloudflare Access is bypassed in dev; auth gate still runs
npm run dev:wiser                        # uses only .dev.vars.wiser, not the generic file
```

Do not use one generic `.dev.vars` for both brands. Wrangler loads `.dev.vars.<environment>` exclusively when it exists, which keeps local secrets isolated by brand. `npm run typecheck`, `npm run typecheck:wiser`, `npm run verify:env:whispyr`, and `npm run verify:env:wiser` should pass before deploying brand work.

## One-time Zoho import

The admin-only importer restores exported `.eml` history into a mailbox that has
already been provisioned. It preserves dates, threads, folders, and attachments;
Trash and Spam are excluded, and re-running the same export is safe.

Keep the admin password out of command arguments. Capture it with a hidden shell
prompt, export it only for the importer process, then remove it:

```bash
read -s IMPORT_PASSWORD
export IMPORT_PASSWORD
node scripts/import-zoho.mjs \
  --base https://mail.wiserchat.ai \
  --email hesham@wiserchat.ai \
  --mailbox hello@wiserchat.ai \
  --dir ./zoho-export/hello
unset IMPORT_PASSWORD
```

Repeat for `contact@wiserchat.ai`. The driver exits non-zero if any message fails. The full Wiser migration/cutover order is in [`docs/wiser-go-live-runbook.md`](docs/wiser-go-live-runbook.md).

## Deploy (production runbook — Whispyr environment)

Each brand is a named Wrangler environment in `wrangler.jsonc` (`env.whispyr`, …), deployed by baking the env at build time. The steps below are the Whispyr environment; a new brand repeats them against its own resources under a new `env.<brand>` block. Prerequisites: a Cloudflare account with `whispyrcrm.com`, and the existing AWS SES production account in `eu-west-2`.

1. **D1 database**

   ```bash
   npx wrangler d1 create sales_portal_users
   ```

   Copy the returned `database_id` into `wrangler.jsonc` (`d1_databases[0].database_id`), then apply the schema:

   ```bash
   npx wrangler d1 migrations apply sales_portal_users --remote
   ```

   Apply all migrations through
   `0010_create_agent_connection_revocations.sql` before deploying the current
   Worker. Migration 0010 creates the durable Agent connection-reconciliation
   outbox and lifecycle triggers required by live access revocation. Apply the
   migration before enabling the current minutely reconciliation and hourly AI
   cache-retention schedules. The application fails closed when required D1
   authorization or reconciliation state is unavailable.

2. **R2 bucket**

   ```bash
   npx wrangler r2 bucket create sales-mail-portal
   ```

3. **Secrets**

   ```bash
   npx wrangler secret put AWS_ACCESS_KEY_ID       # SES IAM user (ses:SendEmail)
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   npx wrangler secret put SES_EVENT_WEBHOOK_SECRET
   npx wrangler secret put JWT_SECRET              # openssl rand -base64 48
   npx wrangler secret put ADMIN_BOOTSTRAP_EMAIL   # e.g. hesham@whispyrcrm.com
   npx wrangler secret put ACCOUNT_RECOVERY_DIRECTORY
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   ```

   `ACCOUNT_RECOVERY_DIRECTORY` is a platform-operator managed JSON object that
   maps each normalized portal email to the user's external recovery email. For
   example: `{"member@whispyrcrm.com":"member@personal.example"}`. Application
   administrators cannot enter or change these addresses. New users remain pending
   until they consume the emailed setup link; claimed users request recovery from
   the sign-in page and receive a generic response that does not reveal account
   existence.
   `AWS_REGION` and `DOMAINS` are plain vars already set in `wrangler.jsonc`.

4. **Deploy** — provisions the Worker and the `mail.whispyrcrm.com` custom domain (the `routes` entry in `env.whispyr`). `CLOUDFLARE_ENV=whispyr` is baked in by the script, so the build resolves the `env.whispyr` block and the deploy lands on the `sales-mail-portal` Worker:

   ```bash
   npm run deploy:whispyr
   ```

5. **Inbound — Cloudflare Email Routing** (dashboard → `whispyrcrm.com` → Email Routing): enable it (accept the MX records), then add a **catch-all** rule that delivers to this Worker.

6. **Outbound — AWS SES** (`eu-west-2`): add `whispyrcrm.com` as a verified domain identity. SES issues 3 DKIM CNAMEs — add them to Cloudflare DNS. Then add:
   - `TXT whispyrcrm.com` → `v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net -all`
   - `TXT _dmarc.whispyrcrm.com` → `v=DMARC1; p=quarantine; rua=mailto:hesham@whispyrcrm.com`

7. **First admin** — visit `https://mail.whispyrcrm.com/login` and sign in with `ADMIN_BOOTSTRAP_EMAIL` + a password (≥12 chars). With zero users, this bootstraps the first `ADMIN` account and provisions its mailbox. Then create reps at `/admin/users`.

8. **MCP (optional)** - connect through the OAuth flow at `https://mail.whispyrcrm.com/mcp`. A connection can access only the Personal and Shared Mailboxes available to that live user. Mail tools are limited to read, search, and reviewable Draft creation; sending and destructive actions stay in the portal.

## Deploy (production runbook - Wiser environment)

Wiser has its own named Wrangler environment, resources, secrets, SES identity, and DNS/routing sequence. Use [`docs/wiser-go-live-runbook.md`](docs/wiser-go-live-runbook.md) for the exact approval-gated end-to-end launch checklist.

## License

Apache 2.0 — see [LICENSE](LICENSE). Based on [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox).
