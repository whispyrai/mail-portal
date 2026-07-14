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
import type { SessionClaims } from "../lib/auth.ts";
import {
	pageShell,
	brandLogo,
	resolveBrand,
	type BrandConfig,
} from "./brand.ts";
import type { Env } from "../types.ts";
import { ATTACHMENT_LIMITS } from "../../shared/attachments.ts";
import {
	BULK_LIMITS,
	BULK_RESERVATION_TTL_MS,
} from "../lib/bulk-job-admission.ts";

type Ctx = Context<{ Bindings: Env; Variables: { session?: SessionClaims } }>;

function renderBulk(
	brand: BrandConfig,
	mailbox: string,
	apiBase: string,
	uploadBase: string,
): string {
	// Injected as a JSON island the page script reads.
	const cfg = JSON.stringify({
		mailbox,
		apiBase,
		uploadBase,
		limits: ATTACHMENT_LIMITS,
		bulkLimits: {
			...BULK_LIMITS,
			reservationTtlMs: BULK_RESERVATION_TTL_MS,
		},
	}).replace(/</g, "\\u003c");
	return pageShell(
		brand,
		`Bulk send · ${brand.appName}`,
		`<div class="wrap bulk-page">
  <style>
    .bulk-preview-cards{display:none}
    .bulk-preview-card{border:1px solid var(--line);border-radius:12px;padding:12px}
    .bulk-preview-field{display:grid;grid-template-columns:minmax(88px,35%) minmax(0,1fr);gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
    .bulk-preview-field:last-child{border-bottom:0}
    .bulk-preview-field dt{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
    .bulk-preview-field dd{margin:0;min-width:0;overflow-wrap:anywhere}
    .bulk-page label code{white-space:nowrap}
    #attachList{list-style:none;margin:8px 0 0;padding:0}
    .bulk-attachment{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:13px;margin-top:6px;min-width:0}
    .bulk-attachment-name{min-width:0;max-width:100%;overflow-wrap:anywhere}
    .bulk-attachment-meta{min-width:0;overflow-wrap:anywhere}
    .bulk-attachment-error{color:var(--danger);font-weight:500}
    .bulk-attachment button{min-height:44px}
    @media (max-width:640px){
      .bulk-preview-table{display:none}
      .bulk-preview-cards{display:grid;gap:10px}
      .bulk-actions,.bulk-confirm-actions{display:grid;grid-template-columns:1fr;width:100%}
      .bulk-actions button,.bulk-confirm-actions button{width:100%}
      .bulk-actions #status{grid-column:1;overflow-wrap:anywhere}
    }
    @media (max-width:360px){
      .bulk-preview-field{grid-template-columns:1fr;gap:4px}
    }
  </style>
  <div class="brandbar">${brandLogo(brand, { href: "/" })}
    <div class="row"><a href="/">← Inbox</a> <form method="post" action="/logout" style="margin:0"><button class="sm secondary" type="submit">Sign out</button></form></div>
  </div>
  <h1 style="margin:0 0 4px">Bulk send</h1>
  <p class="muted">Sending from <code>${mailbox}</code>. Max 200 recipients per job; messages are throttled ~2s apart. Keep daily volume modest while we watch deliverability.</p>

  <div class="card">
    <label for="csv">1. Recipients CSV <span class="muted">(must include an <code>email</code> column; other columns become <code>{{placeholders}}</code>)</span></label>
    <input type="file" id="csv" accept=".csv,text/csv">
    <p id="csvInfo" class="muted" role="status" aria-live="polite" style="margin-top:10px"></p>
    <div id="csvPreview" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <label for="subject">2. Subject</label>
    <input type="text" id="subject" maxlength="${BULK_LIMITS.subjectChars}" placeholder="Quick question about {{company}}">
    <label for="body" style="margin-top:14px">Body <span class="muted">(plain text; use {{column}} to personalize)</span></label>
    <textarea id="body" maxlength="${BULK_LIMITS.bodyChars}" placeholder="Hi {{first_name}},&#10;&#10;I saw {{company}} is growing fast ...&#10;&#10;Worth a quick 20-minute call?"></textarea>
    <label for="attach" style="margin-top:14px">Attachment <span class="muted">(optional; the same file(s) are attached to every recipient)</span></label>
    <input type="file" id="attach" multiple>
    <ul id="attachList" aria-label="Attachments"></ul>
    <p id="attachStatus" class="muted" role="status" aria-live="polite" style="margin:8px 0 0"></p>
    <div class="row bulk-actions" style="margin-top:14px">
      <button class="secondary" id="previewBtn" type="button">Preview first email</button>
      <button id="sendBtn" type="button" disabled>Send all</button>
      <span id="status" class="muted" role="status" aria-live="polite"></span>
    </div>
    <div class="flash warn hide" id="submitConfirm" role="region" aria-labelledby="submitConfirmText" style="margin-top:14px">
      <strong id="submitConfirmText" tabindex="-1"></strong>
      <div class="row bulk-confirm-actions" style="margin-top:10px">
        <button class="secondary" id="cancelSubmitBtn" type="button">Edit submission</button>
        <button id="confirmSubmitBtn" type="button">Confirm and queue</button>
      </div>
    </div>
  </div>

  <div class="card hide" id="previewCard">
    <label>Preview (row 1)</label>
    <p class="muted" style="margin:0 0 6px">Subject: <span id="pvSubject"></span></p>
    <div class="preview" id="pvBody"></div>
  </div>

  <div class="card hide" id="progressCard" role="region" aria-labelledby="progressLabel" tabindex="-1">
    <label id="progressLabel">Progress</label>
    <div class="bar" id="progressBar" role="progressbar" aria-labelledby="progressLabel" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="barFill"></span></div>
    <p id="progressText" class="muted" role="status" aria-live="polite" style="margin-top:10px"></p>
    <div id="errorList" class="err hide" style="font-size:12px"></div>
  </div>

<script>
const CFG = ${cfg};
let ROWS = [], COLUMNS = [];
let ATTACH = [];
let pendingSubmission = null;
let submissionLocked = false;
let confirmInFlight = false;
let activePollJobId = null;
let confirmationMessage = '';
let confirmationMode = 'confirm';
let lastProgressAnnouncement = '';
let lastErrorSignature = '';
let reservationConfirmed = false;
let recoveryTimer = null;
const $ = (id) => document.getElementById(id);
const OPERATION_STORAGE_KEY = 'mail-portal:bulk-operation:' + encodeURIComponent(CFG.mailbox);

function pendingOperationStorage() {
  try { return window.sessionStorage; } catch { return null; }
}
function parsePendingOperation(raw) {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object') return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.operationId)) return null;
    if (record.reservationRequestedAt !== null && (!Number.isFinite(record.reservationRequestedAt) || record.reservationRequestedAt <= 0)) return null;
    return { operationId: record.operationId, reservationRequestedAt: record.reservationRequestedAt };
  } catch { return null; }
}
function storePendingOperation(operationId, reservationRequestedAt = null) {
  try {
    const storage = pendingOperationStorage();
    if (!storage) return false;
    const value = JSON.stringify({ operationId, reservationRequestedAt });
    storage.setItem(OPERATION_STORAGE_KEY, value);
    return storage.getItem(OPERATION_STORAGE_KEY) === value;
  } catch { return false; }
}
function readPendingOperation() {
  try { return parsePendingOperation(pendingOperationStorage()?.getItem(OPERATION_STORAGE_KEY) ?? null); } catch { return null; }
}
function markReservationRequested(operationId) {
  const current = readPendingOperation();
  if (!current || current.operationId !== operationId) return false;
  return storePendingOperation(operationId, current.reservationRequestedAt ?? Date.now());
}
function clearPendingOperation(expectedOperationId) {
  try {
    const storage = pendingOperationStorage();
    if (!storage) return;
    const current = parsePendingOperation(storage.getItem(OPERATION_STORAGE_KEY));
    if (!expectedOperationId || current?.operationId === expectedOperationId) {
      storage.removeItem(OPERATION_STORAGE_KEY);
    }
  } catch {}
}

function canSubmit() {
  return COLUMNS.includes('email') && ROWS.length > 0 && !attachUploading() && !attachFailed();
}
function updateSendAvailability() {
  $('sendBtn').disabled = submissionLocked || !canSubmit();
}
function setSubmissionLocked(locked) {
  submissionLocked = locked;
  ['csv', 'subject', 'body', 'attach', 'previewBtn'].forEach(id => { $(id).disabled = locked; });
  updateSendAvailability();
  renderAttach();
}

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], field = "", inQ = false, closedQuote = false;
  const finishField = () => { row.push(field); field = ""; closedQuote = false; };
  const finishRow = () => {
    finishField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i+1] === '"') { field += '"'; i++; }
        else { inQ = false; closedQuote = true; }
      } else field += ch;
    } else if (closedQuote) {
      if (ch === ',') finishField();
      else if (ch === '\\n' || ch === '\\r') {
        if (ch === '\\r' && text[i+1] === '\\n') i++;
        finishRow();
      } else throw new Error('Unexpected character after a quoted CSV value.');
    } else if (ch === '"') {
      if (field !== '') throw new Error('A quoted CSV value must start at the beginning of a field.');
      inQ = true;
    } else if (ch === ',') finishField();
    else if (ch === '\\n' || ch === '\\r') {
      if (ch === '\\r' && text[i+1] === '\\n') i++;
      finishRow();
    } else field += ch;
  }
  if (inQ) throw new Error('A quoted CSV value is not closed.');
  if (field !== "" || row.length || closedQuote) finishRow();
  return rows;
}

function buildPreview(header, rows) {
  const preview = document.createElement('div');
  const tableWrap = document.createElement('div');
  tableWrap.className = 'tablewrap bulk-preview-table';
  const t = document.createElement('table');
  const hr = document.createElement('tr');
  header.forEach(h => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
  t.appendChild(hr);
  rows.forEach(r => {
    const tr = document.createElement('tr');
    header.forEach(h => { const td = document.createElement('td'); td.textContent = r[h] ?? ''; tr.appendChild(td); });
    t.appendChild(tr);
  });
  tableWrap.appendChild(t);
  preview.appendChild(tableWrap);

  const cards = document.createElement('div');
  cards.className = 'bulk-preview-cards';
  rows.forEach((r, index) => {
    const card = document.createElement('dl');
    card.className = 'bulk-preview-card';
    card.setAttribute('aria-label', 'Recipient ' + (index + 1));
    header.forEach(h => {
      const field = document.createElement('div');
      field.className = 'bulk-preview-field';
      const label = document.createElement('dt'); label.textContent = h;
      const value = document.createElement('dd'); value.textContent = r[h] ?? '';
      field.append(label, value); card.appendChild(field);
    });
    cards.appendChild(card);
  });
  preview.appendChild(cards);
  return preview;
}

$('csv').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const info = $('csvInfo');
  const rejectCsv = (message) => {
    ROWS = []; COLUMNS = [];
    info.textContent = message; info.className = 'err';
    $('csvPreview').replaceChildren(); updateSendAvailability();
  };
  if (file.size > CFG.bulkLimits.requestBytes) {
    rejectCsv('CSV is over the ' + Math.round(CFG.bulkLimits.requestBytes / 1024) + ' KB request limit.'); return;
  }
  let grid;
  try {
    grid = parseCSV(await file.text());
  } catch (error) {
    rejectCsv(error instanceof Error ? error.message : 'CSV formatting is invalid.'); return;
  }
  if (grid.length < 2) {
    rejectCsv('CSV needs a header row and at least one recipient.'); return;
  }
  const header = grid[0].map(h => h.trim());
  if (header.length > CFG.bulkLimits.maxColumns) {
    rejectCsv('CSV has too many columns. Max ' + CFG.bulkLimits.maxColumns + '.'); return;
  }
  if (header.some(h => !h || h.length > CFG.bulkLimits.columnNameChars)) {
    rejectCsv('Every CSV column needs a short, non-empty name.'); return;
  }
  if (new Set(header).size !== header.length) {
    rejectCsv('CSV column names must be unique.'); return;
  }
  const dataRows = grid.slice(1).filter(r => r.some(c => c.trim() !== ""));
  if (dataRows.length === 0) {
    rejectCsv('CSV needs at least one recipient.'); return;
  }
  if (dataRows.some(r => r.length > header.length)) {
    rejectCsv('A CSV row has more values than the header.'); return;
  }
  COLUMNS = header;
  ROWS = dataRows.map(r => {
    const obj = {}; header.forEach((h, i) => obj[h] = (r[i] ?? "").trim()); return obj;
  });
  if (ROWS.length > CFG.bulkLimits.maxRecipients) {
    rejectCsv('CSV has too many recipients. Max ' + CFG.bulkLimits.maxRecipients + ' per job.'); return;
  }
  if (ROWS.some(row => Object.values(row).some(value => value.length > CFG.bulkLimits.recipientValueChars))) {
    rejectCsv('A CSV value is too long. Shorten it and try again.'); return;
  }
  const hasEmail = header.includes('email');
  const validEmails = hasEmail && ROWS.every(row => row.email && row.email.length <= CFG.bulkLimits.emailChars && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email));
  info.className = hasEmail ? 'pill' : 'err';
  if (!validEmails) {
    rejectCsv(hasEmail ? "Every row needs a valid email address." : "No 'email' column found."); return;
  }
  info.textContent = ROWS.length + ' recipients  ·  columns: ' + header.join(', ');
  $('csvPreview').replaceChildren(buildPreview(header, ROWS.slice(0, 3)));
  updateSendAvailability();
});

function render(tpl, row) { return tpl.replace(/\\{\\{\\s*([\\w.-]+)\\s*\\}\\}/g, (_, k) => row[k] ?? ""); }

$('previewBtn').addEventListener('click', () => {
  if (!ROWS.length) { reportValidation('Upload a valid CSV first.', 'csv'); return; }
  $('pvSubject').textContent = render($('subject').value, ROWS[0]);
  $('pvBody').textContent = render($('body').value, ROWS[0]);
  $('previewCard').classList.remove('hide');
});

// ---- Shared attachment(s): uploaded once, attached to every recipient ----
function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return Math.round(b/1024) + ' KB'; return (b/1048576).toFixed(1) + ' MB'; }
function attachUploading() { return ATTACH.some(a => a.status === 'uploading'); }
function attachFailed() { return ATTACH.some(a => a.status === 'error' || a.status === 'rejected'); }
function acceptedAttachments(exceptEntry = null) {
  return ATTACH.filter(a => a !== exceptEntry && a.status !== 'error' && a.status !== 'rejected');
}
function attachmentAdmissionError(file, exceptEntry = null) {
  const accepted = acceptedAttachments(exceptEntry);
  if (accepted.length >= CFG.limits.maxFiles) return 'You can attach at most ' + CFG.limits.maxFiles + ' files.';
  if (file.size > CFG.limits.maxFileBytes) return 'This file is over the per-file attachment limit.';
  const total = accepted.reduce((sum, attachment) => sum + attachment.size, 0) + file.size;
  if (total > CFG.limits.maxTotalBytes) return 'This file would exceed the total attachment limit.';
  return '';
}
function attachmentRetryAdmissionError(entry) {
  return attachmentAdmissionError(entry.file, entry);
}
function announceAttachment(message) {
  $('attachStatus').textContent = message;
}
function confirmationSummary() {
  const names = ATTACH.filter(a => a.status === 'ready').map(a => a.filename);
  const attachmentSummary = names.length
    ? ' Attachments (' + names.length + '): ' + names.join(', ') + '.'
    : ' No attachments.';
  return 'Queue one bulk job for ' + pendingSubmission.recipients.length + ' recipients from ' + CFG.mailbox + '?' + attachmentSummary;
}
function renderAttach() {
  const box = $('attachList'); box.replaceChildren();
  ATTACH.forEach(a => {
    const row = document.createElement('li');
    row.className = 'bulk-attachment';
    const name = document.createElement('span'); name.className = 'bulk-attachment-name'; name.textContent = a.filename; row.appendChild(name);
    const meta = document.createElement('span');
    const hasError = a.status === 'error' || a.status === 'rejected';
    meta.className = 'bulk-attachment-meta ' + (hasError ? 'bulk-attachment-error' : 'muted');
    meta.textContent = a.status === 'uploading' ? 'uploading…' : hasError ? (a.error || 'failed') : fmtSize(a.size);
    row.appendChild(meta);
    if (a.status === 'error' && a.file) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'sm secondary'; retry.textContent = 'Retry';
      retry.setAttribute('aria-label', 'Retry ' + a.filename);
      retry.disabled = submissionLocked;
      retry.addEventListener('click', () => {
        if (submissionLocked) return;
        void uploadAttachmentEntry(a);
      });
      row.appendChild(retry);
    }
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'sm secondary'; rm.textContent = 'Remove';
    rm.setAttribute('aria-label', 'Remove ' + a.filename);
    rm.disabled = submissionLocked;
    rm.addEventListener('click', () => {
      if (submissionLocked) return;
      a.controller?.abort();
      a.attempt = (a.attempt || 0) + 1;
      ATTACH = ATTACH.filter(x => x !== a);
      announceAttachment(a.filename + ' was removed.');
      renderAttach(); updateSendAvailability();
    });
    row.appendChild(rm);
    box.appendChild(row);
  });
}
function isConfirmedAttachmentUploadResponse(result, entry) {
  return result !== null
    && typeof result === 'object'
    && result.uploadId === entry.localId
    && typeof result.filename === 'string'
    && Boolean(result.filename)
    && typeof result.mimetype === 'string'
    && Boolean(result.mimetype)
    && result.size === entry.file.size
    && typeof result.replayed === 'boolean';
}
async function uploadAttachmentEntry(entry) {
  if (submissionLocked || entry.status === 'uploading') return;
  if (entry.status === 'error') {
    const admissionError = attachmentRetryAdmissionError(entry);
    if (admissionError) {
      entry.error = admissionError;
      announceAttachment(entry.filename + ' cannot be retried yet. ' + admissionError);
      renderAttach(); updateSendAvailability();
      return;
    }
  }
  entry.status = 'uploading';
  entry.error = '';
  entry.attempt = (entry.attempt || 0) + 1;
  const attempt = entry.attempt;
  const controller = new AbortController();
  entry.controller = controller;
  announceAttachment('Uploading ' + entry.filename + '…');
  renderAttach(); updateSendAvailability();
  try {
    const params = new URLSearchParams({ filename: entry.file.name, type: entry.file.type || 'application/octet-stream' });
    const response = await fetch(CFG.uploadBase + '/' + encodeURIComponent(entry.localId) + '?' + params.toString(), {
      method: 'PUT', credentials: 'same-origin', signal: controller.signal,
      headers: { 'Content-Type': entry.file.type || 'application/octet-stream' }, body: entry.file,
    });
    const result = await response.json().catch(() => ({}));
    if (!ATTACH.includes(entry) || entry.attempt !== attempt) return;
    if (!response.ok) {
      entry.status = 'error';
      entry.error = result.error || 'upload failed';
      announceAttachment(entry.filename + ' could not be uploaded. Retry or remove it.');
    } else if (!isConfirmedAttachmentUploadResponse(result, entry)) {
      entry.status = 'error';
      entry.error = 'The attachment upload response could not be confirmed.';
      announceAttachment(entry.filename + ' could not be confirmed. Retry or remove it.');
    } else {
      entry.status = 'ready';
      entry.uploadId = result.uploadId;
      entry.filename = result.filename;
      entry.size = result.size;
      announceAttachment(entry.filename + ' is ready.');
    }
  } catch (error) {
    if (!ATTACH.includes(entry) || entry.attempt !== attempt || controller.signal.aborted) return;
    entry.status = 'error';
    entry.error = 'upload failed';
    announceAttachment(entry.filename + ' could not be uploaded. Retry or remove it.');
  } finally {
    if (entry.attempt === attempt) entry.controller = null;
    renderAttach(); updateSendAvailability();
  }
}
$('attach').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []); e.target.value = '';
  const uploads = [];
  for (const file of files) {
    const admissionError = attachmentAdmissionError(file);
    if (admissionError) {
      ATTACH.push({ localId: crypto.randomUUID(), file, filename: file.name, size: file.size, status: 'rejected', error: admissionError });
      announceAttachment(file.name + ' was rejected. ' + admissionError);
      continue;
    }
    const entry = { localId: crypto.randomUUID(), file, filename: file.name, size: file.size, status: 'pending' };
    ATTACH.push(entry);
    uploads.push(entry);
  }
  renderAttach(); updateSendAvailability();
  uploads.forEach(entry => { void uploadAttachmentEntry(entry); });
});

function setConfirmationState(message, mode, moveFocus = false) {
  confirmationMessage = message;
  confirmationMode = mode;
  $('submitConfirmText').textContent = message;
  $('submitConfirm').classList.remove('hide');
  $('cancelSubmitBtn').classList.toggle('hide', mode === 'uncertain');
  $('cancelSubmitBtn').disabled = confirmInFlight;
  $('confirmSubmitBtn').classList.toggle('hide', mode === 'definitive');
  $('confirmSubmitBtn').disabled = confirmInFlight;
  $('confirmSubmitBtn').textContent = mode === 'uncertain' ? 'Retry safely' : 'Confirm and queue';
  if (moveFocus) {
    const target = mode === 'definitive' ? $('cancelSubmitBtn') : $('submitConfirmText');
    target.focus();
  }
}

function scheduleOperationRecovery(delayMs = 3000) {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void recoverPendingOperation();
  }, delayMs);
}

async function recoverPendingOperation() {
  const pendingOperation = readPendingOperation();
  if (!pendingOperation) {
    clearPendingOperation();
    return;
  }
  const { operationId, reservationRequestedAt } = pendingOperation;
  setSubmissionLocked(true);
  $('status').className = 'muted';
  $('status').textContent = 'Recovering the last bulk operation safely…';
  try {
    const response = await fetch(CFG.apiBase + '/operations/' + encodeURIComponent(operationId), { credentials: 'same-origin' });
    if (readPendingOperation()?.operationId !== operationId) return;
    if (response.status === 404) {
      const uncertaintyEndsAt = (reservationRequestedAt ?? 0) + CFG.bulkLimits.reservationTtlMs;
      if (reservationRequestedAt && Date.now() < uncertaintyEndsAt) {
        $('status').textContent = 'The reservation is still being confirmed. Editing remains locked while this page retries safely.';
        scheduleOperationRecovery();
        return;
      }
      clearPendingOperation(operationId);
      reservationConfirmed = false;
      pendingSubmission = null;
      setSubmissionLocked(false);
      $('status').textContent = 'No reserved or admitted bulk operation was found. You can prepare a new one.';
      return;
    }
    if (response.status === 401 || response.status === 403) {
      $('status').className = 'err';
      $('status').textContent = response.status === 401
        ? 'Your session ended. Reload this page to sign in again. The operation identity is preserved.'
        : 'Your access to this Mailbox ended. The operation identity is preserved for safe recovery.';
      setSubmissionLocked(true);
      return;
    }
    if (response.status === 410) {
      clearPendingOperation(operationId);
      reservationConfirmed = false;
      pendingSubmission = null;
      setSubmissionLocked(false);
      $('status').className = 'err';
      $('status').textContent = 'The unused bulk reservation expired. Review the submission and start again.';
      return;
    }
    if (!response.ok) throw new Error('operation recovery unavailable');
    const recovered = await response.json();
    if (response.status === 202 && recovered.state === 'reserved') {
      reservationConfirmed = true;
      if (pendingSubmission?.operationId === operationId) {
        setConfirmationState(confirmationSummary(), 'confirm', true);
        $('status').textContent = 'Reservation secured. Review the final recipient count before queueing.';
      } else {
        $('status').textContent = 'A bulk reservation was recovered without message content. It will unlock safely when the reservation expires.';
        const expiresAt = Date.parse(recovered.expiresAt || '');
        scheduleOperationRecovery(Number.isFinite(expiresAt) ? Math.max(500, Math.min(3000, expiresAt - Date.now())) : 3000);
      }
      return;
    }
    $('status').textContent = 'Recovered the last bulk operation.';
    void poll(recovered.jobId);
  } catch {
    $('status').className = 'err';
    $('status').textContent = 'The last bulk operation cannot be checked yet. This page will keep it locked and retry.';
    scheduleOperationRecovery();
  }
}

function clearConfirmation() {
  $('submitConfirm').classList.add('hide');
  $('cancelSubmitBtn').classList.remove('hide');
  $('confirmSubmitBtn').classList.remove('hide');
}

function announceProgress(message) {
  if (message === lastProgressAnnouncement) return;
  lastProgressAnnouncement = message;
  $('progressText').textContent = message;
}

async function poll(jobId) {
  if (activePollJobId === jobId) return;
  activePollJobId = jobId;
  lastProgressAnnouncement = '';
  lastErrorSignature = '';
  $('progressCard').classList.remove('hide');
  $('progressCard').focus();
      try {
    for (;;) {
      try {
        const r = await fetch(CFG.apiBase + '/' + jobId, { credentials: 'same-origin' });
        if (r.status === 401 || r.status === 403) {
          const terminalMessage = r.status === 401
            ? 'Your session ended. Reload this page to sign in again and view this job.'
            : 'Your access to this Mailbox ended. Ask a Mailbox owner before continuing.';
          announceProgress(terminalMessage);
          $('status').className = 'err';
          $('status').textContent = terminalMessage;
          setSubmissionLocked(true);
          return;
        }
        if (r.status === 404) {
          announceProgress('The job projection is unavailable. Recovering its authoritative operation identity…');
          $('status').className = 'err';
          $('status').textContent = 'The job cannot be read yet. Editing remains locked while recovery retries.';
          setSubmissionLocked(true);
          scheduleOperationRecovery(1000);
          return;
        }
        if (!r.ok) throw new Error('progress unavailable');
        const j = await r.json();
        const enqueued = j.enqueued ?? j.sent ?? 0;
        const done = enqueued + j.failed;
        const percentage = Math.round(done / Math.max(1, j.total) * 100);
        $('barFill').style.width = percentage + '%';
        $('progressBar').setAttribute('aria-valuenow', String(percentage));
        $('progressBar').setAttribute('aria-valuetext', done + ' of ' + j.total + ' recipients processed');
        const list = $('errorList');
        const visibleErrors = j.errors || [];
        const errorCount = Number.isFinite(j.errorCount) ? j.errorCount : visibleErrors.length;
        const errorSignature = JSON.stringify([errorCount, Boolean(j.errorsTruncated), visibleErrors]);
        if (errorSignature !== lastErrorSignature) {
          lastErrorSignature = errorSignature;
          list.replaceChildren();
          list.classList.toggle('hide', errorCount === 0);
          visibleErrors.forEach(e => {
            const d = document.createElement('div');
            d.textContent = (e.email ? e.email + ': ' : '') + e.error;
            list.appendChild(d);
          });
          if (j.errorsTruncated || errorCount > visibleErrors.length) {
            const summary = document.createElement('div');
            summary.textContent = 'Showing ' + visibleErrors.length + ' of ' + errorCount + ' queueing errors.';
            list.appendChild(summary);
          }
        }
        if (j.status === 'preparing') {
          announceProgress('Preparing one durable job. This page will recover it automatically if the first request was interrupted.');
        } else {
          announceProgress(done + ' / ' + j.total + ' processed · ' + enqueued + ' queued for delivery, ' + j.failed + ' could not be queued (' + j.status + ')');
        }
        if (j.status === 'done') {
          $('status').className = 'muted';
          $('status').textContent = 'All recipients were processed.';
          pendingSubmission = null;
          ATTACH = [];
          renderAttach();
          clearPendingOperation();
          reservationConfirmed = false;
          setSubmissionLocked(false);
          return;
        }
        if (j.status === 'failed' || j.status === 'cancelled') {
          $('status').className = 'err';
          $('status').textContent = j.status === 'failed' ? 'The job was not queued.' : 'The job was cancelled.';
          pendingSubmission = null;
          ATTACH = [];
          renderAttach();
          clearPendingOperation();
          reservationConfirmed = false;
          setSubmissionLocked(false);
          return;
        }
      } catch {
        announceProgress('Progress is temporarily unavailable. Retrying without creating another job…');
      }
      await new Promise(res => setTimeout(res, 2000));
    }
  } finally {
    activePollJobId = null;
  }
}

async function reservePendingSubmission() {
  if (!pendingSubmission || confirmInFlight) return;
  confirmInFlight = true;
  reservationConfirmed = false;
  const operationId = pendingSubmission.operationId;
  if (!markReservationRequested(operationId)) {
    $('status').className = 'err';
    $('status').textContent = 'This browser could not preserve the reservation identity.';
    confirmInFlight = false;
    return;
  }
  setConfirmationState('Securing one content-free reservation before anything can be queued…', 'uncertain');
  try {
    let response;
    try {
      response = await fetch(CFG.apiBase + '/operations/' + encodeURIComponent(operationId) + '/reserve', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingSubmission),
      });
    } catch {
      $('status').className = 'err';
      $('status').textContent = 'Reservation outcome unconfirmed. Editing remains locked while recovery checks it.';
      setConfirmationState('The reservation outcome is unconfirmed. Retry safely or let recovery check the same operation.', 'uncertain', true);
      scheduleOperationRecovery();
      return;
    }
    const result = await response.json().catch(() => ({}));
    if (pendingSubmission?.operationId !== operationId || readPendingOperation()?.operationId !== operationId) return;
    if (response.status === 200 && result.state === 'admitted') {
      pendingSubmission = null;
      reservationConfirmed = true;
      clearConfirmation();
      $('status').className = 'muted';
      $('status').textContent = 'Recovered the authoritative bulk job.';
      void poll(result.jobId);
      return;
    }
    if (response.status === 202 && result.state === 'reserved') {
      reservationConfirmed = true;
      $('status').className = 'muted';
      $('status').textContent = 'Reservation secured. Review the final recipient count before queueing.';
      setConfirmationState(confirmationSummary(), 'confirm', true);
      return;
    }
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      $('status').className = 'err';
      $('status').textContent = response.status === 401
        ? 'Your session ended. Reload to sign in again. The operation identity is preserved.'
        : response.status === 403
          ? 'Mailbox access ended. The operation identity is preserved for recovery.'
          : 'Reservation outcome unconfirmed. Editing remains locked while recovery checks it.';
      setConfirmationState(result.error || 'The reservation outcome is unconfirmed. Retry safely using the same operation.', 'uncertain', true);
      if (response.status >= 500) scheduleOperationRecovery();
      return;
    }
    clearPendingOperation(operationId);
    pendingSubmission = null;
    reservationConfirmed = false;
    clearConfirmation();
    setSubmissionLocked(false);
    $('status').className = 'err';
    $('status').textContent = result.error || 'The bulk reservation could not be created. Review the submission and try again.';
  } finally {
    confirmInFlight = false;
    if (!$('submitConfirm').classList.contains('hide')) {
      setConfirmationState(confirmationMessage, confirmationMode);
    }
  }
}

async function cancelPendingReservation(operationId) {
  try {
    const response = await fetch(CFG.apiBase + '/operations/' + encodeURIComponent(operationId) + '/reservation', {
      method: 'DELETE', credentials: 'same-origin',
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.status === 'admitted') {
      pendingSubmission = null;
      reservationConfirmed = true;
      clearConfirmation();
      $('status').className = 'muted';
      $('status').textContent = 'The operation was already admitted. Recovering its authoritative job.';
      void poll(result.jobId);
	  return 'admitted';
    }
	return response.ok || response.status === 404 ? 'cancelled' : 'unknown';
  } catch {
	return 'unknown';
  }
}

async function submitPending() {
  if (!pendingSubmission || confirmInFlight) return;
  if (!reservationConfirmed) {
    await reservePendingSubmission();
    return;
  }
  confirmInFlight = true;
  setConfirmationState('Submitting this exact bulk job…', 'confirm');
  try {
    let response;
    try {
      response = await fetch(CFG.apiBase, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingSubmission),
      });
    } catch {
	  reservationConfirmed = false;
      setConfirmationState('The outcome could not be confirmed. Retry safely to check the same job. Do not rebuild or resubmit it.', 'uncertain', true);
      $('status').className = 'err';
      $('status').textContent = 'Submission outcome unconfirmed.';
	  scheduleOperationRecovery();
      return;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
	  if (response.status === 401 || response.status === 403) {
		reservationConfirmed = false;
		setConfirmationState(result.error || 'Authorization ended before the reserved operation could be confirmed. Retry the same operation after access is restored.', 'uncertain', true);
		$('status').className = 'err';
		$('status').textContent = response.status === 401
		  ? 'Your session ended. The reserved operation identity is preserved.'
		  : 'Mailbox access ended. The reserved operation identity is preserved.';
		return;
	  }
      if (response.status === 429) {
		const retryTime = new Date(result.retryAt || Date.now() + 60000).toLocaleString();
		clearPendingOperation(pendingSubmission.operationId);
		pendingSubmission = null;
		reservationConfirmed = false;
		clearConfirmation();
		setSubmissionLocked(false);
        $('status').className = 'err';
		$('status').textContent = (result.error || 'Mailbox bulk capacity reached.') + ' Start a new submission after ' + retryTime + '.';
        return;
      }
      if (response.status >= 500) {
		reservationConfirmed = false;
        setConfirmationState(result.error || 'The outcome could not be confirmed. Retry this exact submission safely.', 'uncertain', true);
        $('status').className = 'err';
        $('status').textContent = 'Submission outcome unconfirmed.';
		scheduleOperationRecovery();
        return;
      }
      if (response.status === 409 && result.jobId) {
        pendingSubmission = null;
        clearConfirmation();
        $('status').className = 'err';
        $('status').textContent = 'This operation already exists. Recovering its authoritative job.';
        void poll(result.jobId);
        return;
      }
      if (result.code === 'bulk_admission_failed') {
        ATTACH = [];
        renderAttach();
      }
      setConfirmationState(result.error || 'This job could not be queued. Edit the submission and try again.', 'definitive', true);
      $('status').className = 'err';
      $('status').textContent = 'The job was not queued.';
      return;
    }
    clearConfirmation();
	reservationConfirmed = true;
    $('status').className = 'muted';
    $('status').textContent = result.admissionStatus === 'preparing' ? 'Preparing one durable job…' : (result.replayed ? 'Recovered the existing queued job.' : 'Queued safely.');
    if (result.admissionStatus === 'queued') pendingSubmission = null;
    void poll(result.jobId);
  } finally {
    confirmInFlight = false;
    if (!$('submitConfirm').classList.contains('hide')) {
      setConfirmationState(confirmationMessage, confirmationMode);
    }
  }
}

function reportValidation(message, controlId) {
  $('status').className = 'err';
  $('status').textContent = message;
  $(controlId).focus();
}

$('sendBtn').addEventListener('click', () => {
  const subject = $('subject').value.trim();
  const body = $('body').value;
  if (!subject) { reportValidation('Subject is required.', 'subject'); return; }
  if (!body.trim()) { reportValidation('Body is required.', 'body'); return; }
  if (!ROWS.length) { reportValidation('Upload a valid CSV first.', 'csv'); return; }
  if (attachUploading()) { reportValidation('Wait for the attachment to finish uploading.', 'attach'); return; }
  if (attachFailed()) { reportValidation('Retry or remove every failed attachment before sending.', 'attach'); return; }
  const attachmentUploadIds = ATTACH.filter(a => a.status === 'ready' && a.uploadId).map(a => a.uploadId);
  const candidateSubmission = {
    operationId: crypto.randomUUID(),
    subject,
    text: body,
    recipients: ROWS.map(row => ({ ...row })),
    attachmentUploadIds,
  };
  if (new TextEncoder().encode(JSON.stringify(candidateSubmission)).byteLength > CFG.bulkLimits.requestBytes) {
    reportValidation('This submission is over the ' + Math.round(CFG.bulkLimits.requestBytes / 1024) + ' KB request limit. Shorten the CSV or message.', 'csv');
    return;
  }
  if (!storePendingOperation(candidateSubmission.operationId)) {
    reportValidation('This browser cannot preserve a safe retry identity. Enable session storage or use another browser before sending.', 'sendBtn');
    return;
  }
  pendingSubmission = candidateSubmission;
  reservationConfirmed = false;
  setSubmissionLocked(true);
  $('status').className = 'muted';
  $('status').textContent = 'Securing a safe reservation before final confirmation…';
  void reservePendingSubmission();
});

$('cancelSubmitBtn').addEventListener('click', async () => {
  if (confirmInFlight || confirmationMode === 'uncertain') return;
	const operationId = pendingSubmission?.operationId ?? readPendingOperation()?.operationId;
	if (operationId && reservationConfirmed) {
	  confirmInFlight = true;
	  $('status').className = 'muted';
	  $('status').textContent = 'Releasing the unused reservation safely…';
	  const cancellation = await cancelPendingReservation(operationId);
	  confirmInFlight = false;
	  if (cancellation === 'admitted') return;
	  if (cancellation === 'unknown') {
		$('status').className = 'err';
		$('status').textContent = 'The reservation could not be released safely. Editing stays locked while recovery checks it.';
		scheduleOperationRecovery();
		return;
	  }
	}
  clearPendingOperation(operationId);
  pendingSubmission = null;
  reservationConfirmed = false;
  clearConfirmation();
  setSubmissionLocked(false);
  $('status').className = 'muted';
  $('status').textContent = 'Submission unlocked for editing.';
  $('sendBtn').focus();
});

$('confirmSubmitBtn').addEventListener('click', () => { void submitPending(); });
void recoverPendingOperation();
</script>
</div>`,
	);
}

export function bulkPage(c: Ctx) {
	const session = c.get("session");
	if (!session) return c.redirect("/login", 302);
	const mailbox = session.mailbox;
	const apiBase = `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/bulk`;
	const uploadBase = `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/attachment-uploads`;
	return c.html(
		renderBulk(resolveBrand(c.env.BRAND), mailbox, apiBase, uploadBase),
	);
}
