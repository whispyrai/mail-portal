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
import { pageShell, brandLogo } from "./brand";
import type { Env } from "../types";

type Ctx = Context<{ Bindings: Env; Variables: { session?: SessionClaims } }>;

function renderBulk(mailbox: string, apiBase: string): string {
	// mailbox + apiBase are injected as a JSON island the page script reads.
	const cfg = JSON.stringify({ mailbox, apiBase }).replace(/</g, "\\u003c");
	return pageShell(
		"Bulk send · Whispyr Mail",
		`<div class="wrap">
  <div class="brandbar">${brandLogo({ href: "/" })}
    <div class="row"><a href="/">← Inbox</a> <form method="post" action="/logout" style="margin:0"><button class="sm secondary" type="submit">Sign out</button></form></div>
  </div>
  <h1 style="margin:0 0 4px">Bulk send</h1>
  <p class="muted">Sending from <code>${mailbox}</code>. Max 200 recipients per job; messages are throttled ~2s apart. Keep daily volume modest while we watch deliverability.</p>

  <div class="card">
    <label>1. Recipients CSV <span class="muted">(must include an <code>email</code> column; other columns become <code>{{placeholders}}</code>)</span></label>
    <input type="file" id="csv" accept=".csv,text/csv">
    <p id="csvInfo" class="muted" style="margin-top:10px"></p>
    <div id="csvPreview" style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:10px"></div>
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
</div>`,
	);
}

export function bulkPage(c: Ctx) {
	const session = c.get("session");
	if (!session) return c.redirect("/login", 302);
	const mailbox = session.mailbox;
	const apiBase = `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/bulk`;
	return c.html(renderBulk(mailbox, apiBase));
}
