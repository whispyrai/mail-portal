#!/usr/bin/env node
// One-time Zoho → portal mail importer driver (WISER-241).
//
// NOT part of the Worker bundle — a local Node script (node >= 18 for global
// fetch). It logs in as ADMIN, walks a Zoho .eml export directory, and POSTs
// each message to the admin import endpoint. Safe to re-run: the endpoint is
// idempotent (derives a stable id per message and skips duplicates).
//
// Usage:
//   node scripts/import-zoho.mjs \
//     --base https://mail.wiserchat.ai \
//     --email admin@wiserchat.ai --password '••••••••••••' \
//     --mailbox hello@wiserchat.ai \
//     --dir ./zoho-export/hello
//
// The export dir is expected to hold one subdirectory per Zoho folder
// (Inbox/, Sent/, Archive/, Trash/, Spam/, …), each containing .eml files. The
// subdirectory name is sent as ?folder= and mapped server-side — Trash/Spam are
// dropped, everything else routes to inbox/sent/archive. Loose .eml files
// directly under --dir default to folder "Inbox".

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.replace(/^--/, "");
		if (key) args[key] = argv[i + 1];
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const required = ["base", "email", "password", "mailbox", "dir"];
const missing = required.filter((k) => !args[k]);
if (missing.length) {
	console.error(`Missing required args: ${missing.map((m) => "--" + m).join(", ")}`);
	process.exit(1);
}
const base = args.base.replace(/\/$/, "");

async function login() {
	const body = new URLSearchParams({ email: args.email, password: args.password });
	const res = await fetch(`${base}/login`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
		redirect: "manual",
	});
	const setCookie = res.headers.get("set-cookie");
	if (!setCookie || res.status >= 400) {
		throw new Error(`Login failed (HTTP ${res.status}). Check credentials / base URL.`);
	}
	return setCookie.split(";")[0]; // name=value session cookie
}

async function* walkEml(dir, folder) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkEml(full, entry.name); // subdir name = the Zoho folder
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".eml")) {
			yield { path: full, folder };
		}
	}
}

async function importOne(cookie, file) {
	const bytes = await readFile(file.path);
	const url = `${base}/admin/import/${encodeURIComponent(args.mailbox)}?folder=${encodeURIComponent(file.folder)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "message/rfc822", cookie },
		body: bytes,
	});
	let json = {};
	try {
		json = await res.json();
	} catch {
		// non-JSON error body; fall through with httpStatus only
	}
	return { httpStatus: res.status, ...json };
}

const cookie = await login();
console.log(`Logged in. Importing ${args.dir} → ${args.mailbox} …`);

const tally = { imported: 0, duplicate: 0, excluded: 0, error: 0 };
for await (const file of walkEml(args.dir, "Inbox")) {
	const r = await importOne(cookie, file);
	if (r.status === "imported") {
		tally.imported++;
	} else if (r.status === "skipped" && r.reason === "duplicate") {
		tally.duplicate++;
	} else if (r.status === "skipped" && r.reason === "excluded-folder") {
		tally.excluded++;
	} else {
		tally.error++;
		console.error(`  ✗ ${file.folder}/${basename(file.path)} → HTTP ${r.httpStatus}: ${r.error || JSON.stringify(r)}`);
	}
}

console.log(
	`Done. imported=${tally.imported} duplicate=${tally.duplicate} excluded=${tally.excluded} error=${tally.error}`,
);
if (tally.error) process.exit(1);
