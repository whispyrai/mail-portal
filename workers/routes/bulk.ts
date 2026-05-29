// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Worker-rendered bulk send (mail merge) page (F-06). A rep uploads a CSV,
// writes a template with {{column}} placeholders, previews the first rendered
// email, and sends. Sending is handled server-side by the MailboxDO alarm
// scheduler; this page posts the job and polls progress. Scoped to the caller's
// own mailbox via the session. All dynamic content is rendered via textContent /
// DOM nodes (never innerHTML) to avoid any XSS from CSV data.

import type { Context } from "hono";
import type { SessionClaims } from "../lib/auth";
import type { Env } from "../types";

type Ctx = Context<{ Bindings: Env; Variables: { session?: SessionClaims } }>;

const CSS = `
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0b1020; color:#e7ecf5; }
a { color:#6ea8fe; text-decoration:none; }
.wrap { max-width:860px; margin:0 auto; padding:28px 20px 64px; }
.topbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
h1 { font-size:22px; letter-spacing:-.02em; margin:0; }
.muted { color:#8595b5; font-size:13px; }
.card { background:#141b2e; border:1px solid #243049; border-radius:14px; padding:20px; margin:16px 0; }
label { display:block; font-size:13px; color:#c4cfe6; margin:0 0 6px; }
input[type=text], textarea { width:100%; padding:10px 12px; border-radius:9px; border:1px solid #2c3958; background:#0e1626; color:#e7ecf5; font-size:14px; font-family:inherit; }
textarea { min-height:170px; resize:vertical; line-height:1.5; }
input[type=file] { color:#c4cfe6; font-size:13px; }
button { padding:10px 16px; border:0; border-radius:9px; background:#3b82f6; color:#fff; font-weight:600; cursor:pointer; font-size:14px; }
button.secondary { background:#22304d; }
button:disabled { opacity:.5; cursor:not-allowed; }
table { width:100%; border-collapse:collapse; font-size:12px; margin-top:10px; }
th,td { text-align:left; padding:6px 8px; border-bottom:1px solid #233049; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px; }
th { color:#9aa7c2; }
code { background:#0e1626; border:1px solid #2c3958; padding:2px 6px; border-radius:6px; }
.pill { color:#9bf0c4; }
.err { color:#ffb3c1; }
.preview { background:#0e1626; border:1px solid #2c3958; border-radius:10px; padding:14px; white-space:pre-wrap; font-size:13px; }
.bar { height:8px; background:#0e1626; border-radius:999px; overflow:hidden; border:1px solid #2c3958; }
.bar > span { display:block; height:100%; background:#3b82f6; width:0%; transition:width .3s; }
.hide { display:none; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
`;

function renderBulk(mailbox: string, apiBase: string): string {
	// mailbox + apiBase are injected as a JSON island the page script reads.
	const cfg = JSON.stringify({ mailbox, apiBase }).replace(/</g, "\\u003c");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Bulk send · Whispyr Mail</title><style>${CSS}</style></head><body><div class="wrap">
  <div class="topbar">
    <h1>Bulk send</h1>
    <div class="row"><a href="/">← Inbox</a> <form method="post" action="/logout" style="margin:0"><button class="secondary" type="submit">Sign out</button></form></div>
  </div>
  <p class="muted">Sending from <code>${mailbox}</code>. Max 200 recipients per job; messages are throttled ~2s apart. Keep daily volume modest while we watch deliverability.</p>

  <div class="card">
    <label>1. Recipients CSV <span class="muted">(must include an <code>email</code> column; other columns become <code>{{placeholders}}</code>)</span></label>
    <input type="file" id="csv" accept=".csv,text/csv">
    <p id="csvInfo" class="muted" style="margin-top:10px"></p>
    <div id="csvPreview"></div>
  </div>

  <div class="card">
    <label for="subject">2. Subject</label>
    <input type="text" id="subject" placeholder="Quick question about {{company}}">
    <label for="body" style="margin-top:14px">Body <span class="muted">(plain text; use {{column}} to personalize)</span></label>
    <textarea id="body" placeholder="Hi {{first_name}},&#10;&#10;I saw {{company}} is growing fast ...&#10;&#10;Worth a quick 20-minute call?"></textarea>
    <div class="row" style="margin-top:14px">
      <button class="secondary" id="previewBtn" type="button">Preview first email</button>
      <button id="sendBtn" type="button" disabled>Send all</button>
      <span id="status" class="muted"></span>
    </div>
  </div>

  <div class="card hide" id="previewCard">
    <label>Preview (row 1)</label>
    <p class="muted" style="margin:0 0 6px">Subject: <span id="pvSubject"></span></p>
    <div class="preview" id="pvBody"></div>
  </div>

  <div class="card hide" id="progressCard">
    <label>Progress</label>
    <div class="bar"><span id="barFill"></span></div>
    <p id="progressText" class="muted" style="margin-top:10px"></p>
    <div id="errorList" class="err" style="font-size:12px"></div>
  </div>

<script>
const CFG = ${cfg};
let ROWS = [], COLUMNS = [];
const $ = (id) => document.getElementById(id);

function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i+1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ""; }
    else if (ch === '\\n' || ch === '\\r') {
      if (ch === '\\r' && text[i+1] === '\\n') i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function buildTable(header, rows) {
  const t = document.createElement('table');
  const hr = document.createElement('tr');
  header.forEach(h => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
  t.appendChild(hr);
  rows.forEach(r => {
    const tr = document.createElement('tr');
    header.forEach(h => { const td = document.createElement('td'); td.textContent = r[h] ?? ''; tr.appendChild(td); });
    t.appendChild(tr);
  });
  return t;
}

$('csv').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const grid = parseCSV(await file.text());
  const info = $('csvInfo');
  if (grid.length < 2) { info.textContent = 'CSV needs a header row and at least one recipient.'; info.className = 'err'; return; }
  const header = grid[0].map(h => h.trim());
  COLUMNS = header;
  ROWS = grid.slice(1).filter(r => r.some(c => c.trim() !== "")).map(r => {
    const obj = {}; header.forEach((h, i) => obj[h] = (r[i] ?? "").trim()); return obj;
  });
  const hasEmail = header.includes('email');
  info.className = hasEmail ? 'pill' : 'err';
  info.textContent = (hasEmail ? ROWS.length + ' recipients' : "No 'email' column found.") + '  ·  columns: ' + header.join(', ');
  $('csvPreview').replaceChildren(buildTable(header, ROWS.slice(0, 3)));
  $('sendBtn').disabled = !(hasEmail && ROWS.length > 0);
});

function render(tpl, row) { return tpl.replace(/\\{\\{\\s*([\\w.-]+)\\s*\\}\\}/g, (_, k) => row[k] ?? ""); }

$('previewBtn').addEventListener('click', () => {
  if (!ROWS.length) { alert('Upload a CSV first.'); return; }
  $('pvSubject').textContent = render($('subject').value, ROWS[0]);
  $('pvBody').textContent = render($('body').value, ROWS[0]);
  $('previewCard').classList.remove('hide');
});

async function poll(jobId) {
  $('progressCard').classList.remove('hide');
  for (;;) {
    const r = await fetch(CFG.apiBase + '/' + jobId, { credentials: 'same-origin' });
    if (!r.ok) { $('progressText').textContent = 'Lost track of the job.'; return; }
    const j = await r.json();
    const done = j.sent + j.failed;
    $('barFill').style.width = Math.round(done / j.total * 100) + '%';
    $('progressText').textContent = done + ' / ' + j.total + ' processed — ' + j.sent + ' sent, ' + j.failed + ' failed (' + j.status + ')';
    const list = $('errorList'); list.replaceChildren();
    (j.errors || []).slice(0, 10).forEach(e => { const d = document.createElement('div'); d.textContent = e.email + ': ' + e.error; list.appendChild(d); });
    if (j.status === 'done') { $('status').textContent = 'Done.'; $('sendBtn').disabled = false; return; }
    await new Promise(res => setTimeout(res, 2000));
  }
}

$('sendBtn').addEventListener('click', async () => {
  const subject = $('subject').value.trim();
  const body = $('body').value;
  if (!subject) { alert('Subject is required.'); return; }
  if (!body.trim()) { alert('Body is required.'); return; }
  if (!ROWS.length) { alert('Upload a CSV first.'); return; }
  if (!confirm('Send to ' + ROWS.length + ' recipients from ' + CFG.mailbox + '?')) return;
  $('sendBtn').disabled = true;
  $('status').textContent = 'Submitting…';
  const r = await fetch(CFG.apiBase, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, text: body, recipients: ROWS }),
  });
  const j = await r.json();
  if (!r.ok) { $('status').textContent = j.error || 'Failed to start'; $('status').className = 'err'; $('sendBtn').disabled = false; return; }
  $('status').textContent = 'Sending…';
  poll(j.jobId);
});
</script>
</div></body></html>`;
}

export function bulkPage(c: Ctx) {
	const session = c.get("session");
	if (!session) return c.redirect("/login", 302);
	const mailbox = session.mailbox;
	const apiBase = `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/bulk`;
	return c.html(renderBulk(mailbox, apiBase));
}
