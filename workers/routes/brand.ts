// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Shared Whispyr brand shell for the Worker-rendered pages (login, admin, bulk,
// landing fallback). Matches the whispyrcrm.com landing: Kamerik 105 type,
// cream/charcoal palette, purple accent used sparingly, the Whispyr mark.
// Brand assets are served statically from public/ (fonts/, whispyr-mark.svg).

export const BRAND_CSS = `
@font-face { font-family:"Kamerik 105"; src:url("/fonts/Kamerik105-Light.woff2") format("woff2"); font-weight:300; font-display:swap; }
@font-face { font-family:"Kamerik 105"; src:url("/fonts/Kamerik105-Book.woff2") format("woff2"); font-weight:400; font-display:swap; }
@font-face { font-family:"Kamerik 105"; src:url("/fonts/Kamerik105-Bold.woff2") format("woff2"); font-weight:700; font-display:swap; }
:root{
  --bg:#fbfaf8; --surface:#ffffff; --charcoal:#1a1a1a; --slate:#3a352f; --muted:#6b6b6b;
  --tint:#f7f3ec; --fill:#f1ebe1;
  --line:rgba(26,26,26,.12); --line-strong:rgba(26,26,26,.20); --ring:rgba(26,26,26,.30);
  --success:#1e6b43; --danger:#b42318;
  --font:"Kamerik 105", ui-sans-serif, system-ui, -apple-system, sans-serif;
  color-scheme:light;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--charcoal);font-family:var(--font);font-weight:400;line-height:1.5;letter-spacing:-.005em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
a{color:var(--charcoal);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:26px 24px 64px}
.wrap--center{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.brandbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--charcoal)}
.brand:hover{text-decoration:none}
.brand img{display:block;height:30px;width:auto}
.brand b{font-weight:700;font-size:19px;letter-spacing:-.01em}
.brand b span{color:var(--muted);font-weight:400}
h1{font-size:24px;font-weight:700;letter-spacing:-.02em;margin:0 0 4px}
h2{font-size:16px;font-weight:700;margin:0 0 14px}
.sub{color:var(--muted);font-size:14px;margin:0 0 22px}
.note{color:var(--muted);font-size:12px;margin-top:18px;text-align:center}
.muted{color:var(--muted);font-size:13px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:26px;margin:16px 0;box-shadow:0 1px 2px rgba(26,26,26,.04)}
.card--auth{width:100%;max-width:412px;margin:0}
label{display:block;font-size:13px;font-weight:500;color:var(--slate);margin:14px 0 6px}
input,select,textarea{width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--line-strong);background:var(--surface);color:var(--charcoal);font-size:15px;font-family:inherit;transition:border-color .12s,box-shadow .12s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--charcoal);box-shadow:0 0 0 3px rgba(26,26,26,.12)}
textarea{min-height:170px;resize:vertical;line-height:1.5}
input[type=file]{padding:9px 0;border:0;background:transparent;font-size:13px;color:var(--slate)}
button,.btn{appearance:none;cursor:pointer;font-family:inherit;font-weight:600;font-size:15px;border:1px solid var(--charcoal);background:var(--charcoal);color:#fff;padding:11px 18px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;transition:background .12s,border-color .12s}
button:hover,.btn:hover{background:#000;border-color:#000;text-decoration:none}
a.btn{color:#fff}
a.btn.secondary{color:var(--charcoal)}
button.block{width:100%;margin-top:22px}
.btn.secondary,button.secondary{background:transparent;color:var(--charcoal);border-color:var(--line-strong)}
.btn.secondary:hover,button.secondary:hover{background:var(--tint);border-color:var(--ring)}
button.sm{padding:7px 11px;font-size:12px;border-radius:10px}
button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
button.danger:hover{background:#9a1d14;border-color:#9a1d14}
button:disabled{opacity:.45;cursor:not-allowed}
.err{background:#f7ded9;border:1px solid #e7b3ac;color:#8a2018;padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:10px}
.flash{padding:11px 14px;border-radius:10px;margin-bottom:12px;font-size:13px}
.flash.ok{background:#d9ece0;border:1px solid #aacdb8;color:#1e6b43}
.flash.err{background:#f7ded9;border:1px solid #e7b3ac;color:#8a2018}
.pill{color:#1e6b43;font-weight:700}
.tablewrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.badge{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--line-strong);color:var(--slate);white-space:nowrap}
.badge.admin{color:var(--charcoal);border-color:var(--line);background:var(--fill)}
.badge.off{color:#8a2018;border-color:#e7b3ac;background:#f7ded9}
code{background:var(--tint);border:1px solid var(--line);padding:3px 7px;border-radius:7px;font-size:13px;word-break:break-all;font-family:ui-monospace,Menlo,monospace}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.row>div{flex:1;min-width:200px}
form.inline{display:inline;margin:0}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px;flex-wrap:wrap}
.preview{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;white-space:pre-wrap;font-size:13px}
.bar{height:8px;background:var(--tint);border-radius:999px;overflow:hidden;border:1px solid var(--line)}
.bar>span{display:block;height:100%;background:var(--charcoal);width:0%;transition:width .3s}
.hide{display:none}
@media (max-width:640px){
  .wrap{padding:18px 16px 48px}
  .card{padding:18px;border-radius:14px}
  h1{font-size:21px}
  h2{font-size:15px}
  .row{gap:10px}
  .row>div{min-width:100%}
  button,.btn{font-size:14px;padding:11px 16px}
  button.sm{width:auto}
}
`;

/** The Whispyr mark + wordmark. `href` defaults to the inbox; `sub` is the suffix word. */
export function brandLogo(opts: { href?: string; sub?: string } = {}): string {
	const href = opts.href ?? "/";
	const sub = opts.sub ?? "Mail";
	return `<a class="brand" href="${href}" aria-label="Whispyr ${sub}">
  <img src="/whispyr-mark.svg" alt="" width="22" height="36">
  <b>Whispyr${sub ? ` <span>${sub}</span>` : ""}</b>
</a>`;
}

/** Full HTML document with the Whispyr brand styles applied. */
export function pageShell(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#faf8f5">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/Kamerik105-Book.woff2" as="font" type="font/woff2" crossorigin>
<title>${title}</title><style>${BRAND_CSS}</style></head><body>${body}</body></html>`;
}
