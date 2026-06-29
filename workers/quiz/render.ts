// Shared HTML rendering for the quiz pages: the bilingual (EN/AR) primitives, the
// RTL-aware shell, and the language-toggle script. Every readable string is rendered
// in BOTH languages; CSS hides the inactive one and the toggle flips a class + `dir`
// on the #quizroot wrapper. Because the answer inputs live OUTSIDE the language spans
// and never unmount, switching language preserves the rep's selections (design §7).

import { escapeHtml } from "../lib/email-helpers";
import { pageShell, brandLogo } from "../routes/brand";

/** Inline bilingual text: both languages emitted, CSS shows the active one. */
export function bi(en: string, ar: string): string {
	return `<span class="only-en">${escapeHtml(en)}</span><span class="only-ar" dir="rtl">${escapeHtml(ar)}</span>`;
}

/** Block-level bilingual text (own line, preserves newlines). */
export function biBlock(en: string, ar: string, cls = ""): string {
	const c = cls ? ` ${cls}` : "";
	return `<div class="only-en${c}">${escapeHtml(en)}</div><div class="only-ar${c}" dir="rtl">${escapeHtml(ar)}</div>`;
}

export const QUIZ_CSS = `
#quizroot.lang-en .only-ar, #quizroot.lang-ar .only-en { display:none !important; }
#quizroot[dir=rtl] { text-align:right; }
#quizroot .qcard{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:14px 0;box-shadow:0 1px 2px rgba(26,26,26,.04)}
#quizroot .qnum{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
#quizroot .qprompt{font-size:16px;font-weight:600;line-height:1.45;margin:0 0 14px}
#quizroot .qtitle{font-size:12px;color:var(--muted);margin-bottom:2px}
#quizroot .opt{display:flex;align-items:flex-start;gap:10px;padding:11px 13px;border:1px solid var(--line-strong);border-radius:11px;margin:8px 0;cursor:pointer;transition:border-color .12s,background .12s}
#quizroot .opt:hover{background:var(--tint)}
#quizroot .opt input{width:auto;margin:3px 0 0;flex:0 0 auto}
#quizroot .opt .otext{flex:1;font-size:15px;line-height:1.4}
#quizroot .opt:has(input:checked){border-color:var(--charcoal);background:var(--fill)}
#quizroot .qhint{font-size:12px;color:var(--muted);margin:2px 0 10px}
#quizroot textarea{min-height:120px}
#quizroot .langbar{display:inline-flex;border:1px solid var(--line-strong);border-radius:999px;overflow:hidden}
#quizroot .langbar button{background:transparent;color:var(--slate);border:0;border-radius:0;padding:6px 14px;font-size:13px}
#quizroot .langbar button[aria-pressed=true]{background:var(--charcoal);color:#fff}
#quizroot .timer{font-variant-numeric:tabular-nums;font-weight:600;color:var(--slate)}
#quizroot .review-row{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:10px 0}
#quizroot .review-row.correct{border-color:#aacdb8;background:#f3f9f5}
#quizroot .review-row.wrong{border-color:#e7b3ac;background:#fbf2f0}
#quizroot .tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid var(--line-strong);margin-inline-start:8px}
#quizroot .tag.ok{color:var(--success);border-color:#aacdb8;background:#e7f1ea}
#quizroot .tag.no{color:#8a2018;border-color:#e7b3ac;background:#f7ded9}
#quizroot .why{font-size:13px;color:var(--slate);background:var(--tint);border-radius:8px;padding:9px 11px;margin-top:8px}
#quizroot .scorebig{font-size:30px;font-weight:700;letter-spacing:-.02em}
#quizroot .pairgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
#quizroot[dir=rtl] .langbar{direction:ltr}
@media (max-width:640px){ #quizroot .pairgrid{grid-template-columns:1fr} #quizroot .qcard{padding:16px} }
`;

/** Two-button EN/AR switch (the script wires aria-pressed + persistence). */
export function langBar(): string {
	return `<div class="langbar" role="group" aria-label="Language">
  <button type="button" data-lang-btn="en">English</button>
  <button type="button" data-lang-btn="ar">العربية</button>
</div>`;
}

const LANG_SCRIPT = `<script>
(function(){
  var root=document.getElementById('quizroot'); if(!root) return;
  var KEY='whispyrQuizLang';
  function apply(l){
    root.classList.remove('lang-en','lang-ar'); root.classList.add('lang-'+l);
    root.setAttribute('dir', l==='ar'?'rtl':'ltr');
    var btns=document.querySelectorAll('[data-lang-btn]');
    for(var i=0;i<btns.length;i++){ btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-lang-btn')===l?'true':'false'); }
  }
  var saved; try{ saved=localStorage.getItem(KEY); }catch(e){}
  apply(saved==='ar'?'ar':'en');
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-lang-btn]'); if(!b) return;
    var l=b.getAttribute('data-lang-btn'); try{ localStorage.setItem(KEY,l); }catch(e){}
    apply(l);
  });
})();
</script>`;

/** Elapsed-time display: counts up from page load (client-only, no hard timer). */
export const TIMER_SCRIPT = `<script>
(function(){
  var el=document.getElementById('elapsed'); if(!el) return;
  var t0=Date.now();
  function tick(){ var s=Math.floor((Date.now()-t0)/1000); var m=Math.floor(s/60); var ss=String(s%60).padStart(2,'0'); el.textContent=m+':'+ss; }
  tick(); setInterval(tick,1000);
})();
</script>`;

/** Optional client nudge when submitting with blank questions. */
export const BLANK_NUDGE_SCRIPT = `<script>
(function(){
  var form=document.getElementById('quizform'); if(!form) return;
  form.addEventListener('submit',function(e){
    var blanks=0, groups=form.querySelectorAll('[data-qgroup]');
    for(var i=0;i<groups.length;i++){
      var g=groups[i], answered=false;
      var ins=g.querySelectorAll('input,textarea');
      for(var j=0;j<ins.length;j++){
        if((ins[j].type==='radio'||ins[j].type==='checkbox')){ if(ins[j].checked) answered=true; }
        else if(ins[j].value.trim()!=='') answered=true;
      }
      if(!answered) blanks++;
    }
    if(blanks>0 && !confirm(blanks+' question(s) are blank. Submit anyway? You only get one attempt.')){ e.preventDefault(); }
  });
})();
</script>`;

/**
 * Wrap quiz body in the brand shell with the #quizroot language wrapper. `headerExtra`
 * goes on the right of the brand bar (e.g. the timer). Scripts are appended after the
 * body so they run with the DOM in place.
 */
export function quizShell(
	title: string,
	bodyHtml: string,
	opts: { headerExtra?: string; scripts?: string[]; backHref?: string } = {},
): string {
	const back = opts.backHref
		? `<a href="${opts.backHref}">← ${escapeHtml(opts.backHref === "/quizzes" ? "Quizzes" : "Back")}</a>`
		: `<a href="/">← Inbox</a>`;
	const scripts = [LANG_SCRIPT, ...(opts.scripts ?? [])].join("\n");
	const body = `<div class="wrap">
  <div class="brandbar">${brandLogo({ href: "/" })}
    <div class="row" style="gap:12px;align-items:center">${langBar()}
      ${opts.headerExtra ?? ""}
      ${back}
      <form method="post" action="/logout" style="margin:0"><button class="sm secondary" type="submit">Sign out</button></form>
    </div>
  </div>
  <div id="quizroot" class="lang-en" dir="ltr">${bodyHtml}</div>
</div>${scripts}`;
	return pageShell(`${title} · Whispyr Mail`, `<style>${QUIZ_CSS}</style>${body}`);
}
