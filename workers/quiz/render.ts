// Shared HTML rendering for the quiz pages: the bilingual (EN/AR) primitives, the
// RTL-aware shell, the language toggle, and the client enhancements (progress rail,
// elapsed timer, and localStorage draft autosave). Every readable string is rendered
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

export interface ReadoutOption {
	id: string;
	en: string;
	ar: string;
}

/**
 * Read-only option list for review/grading: every option on its OWN row, with the
 * correct answer(s) marked (✓ + green) and the picked option(s) marked (charcoal ring
 * + a label). Shared by the rep's post-submit review and the admin grade screens.
 * Replaces comma-joining the chosen option *texts* into a single line — fine for short
 * labels, an unreadable wall once options are full sentences. `pickedLabel` adapts the
 * voice ("your pick" for the rep, "chose" for an admin reading someone else's answer).
 */
export function optionReadout(
	options: ReadoutOption[],
	correctIds: string[],
	selectedIds: string[],
	pickedLabel: { en: string; ar: string } = { en: "chose", ar: "اختار" },
): string {
	const correct = new Set(correctIds);
	const chosen = new Set(selectedIds);
	return options
		.map((o) => {
			const isC = correct.has(o.id);
			const isPick = chosen.has(o.id);
			return `<div class="opt-read${isC ? " correct" : ""}${isPick ? " chosen" : ""}">
      <span class="slot">${escapeHtml(o.id)}</span>
      <span class="otext">${bi(o.en, o.ar)}</span>
      ${isPick ? `<span class="picked">${bi(pickedLabel.en, pickedLabel.ar)}</span>` : ""}
      ${isC ? `<span class="mark">✓</span>` : ""}
    </div>`;
		})
		.join("");
}

// The quiz visual system. Built on the brand tokens in brand.ts (--bg/--surface/
// --charcoal/--tint/--fill/--line/--success/--danger …). Editorial-calm: generous
// rhythm, one tactile interaction (the option rows), a quiet score moment. No new
// colours invented — the portal is charcoal/cream with green/red semantics only.
export const QUIZ_CSS = `
#quizroot{--q-gap:clamp(14px,2.2vw,20px);--q-accent:#0f0f0f}
#quizroot.lang-en .only-ar, #quizroot.lang-ar .only-en{display:none !important}
#quizroot[dir=rtl]{text-align:right}

/* Header: brand bar holds the language switch + utilities */
.qtopbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.qtools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.qtools a{font-size:13px;color:var(--muted)}
.qtools a:hover{color:var(--charcoal)}

/* Segmented control — language switch + admin status. Pill track, raised thumb. */
.seg{display:inline-flex;gap:2px;padding:3px;background:var(--fill);border:1px solid var(--line);border-radius:999px}
.seg button,.seg .segopt{appearance:none;border:0;margin:0;background:transparent;color:var(--muted);font-family:inherit;font-weight:600;font-size:12.5px;letter-spacing:0;padding:6px 14px;border-radius:999px;cursor:pointer;line-height:1.1;transition:color .15s,background .15s,box-shadow .15s}
.seg button:hover:not([aria-pressed=true]):not(:disabled){color:var(--charcoal)}
.seg button[aria-pressed=true],.seg button:disabled.is-current{background:var(--surface);color:var(--charcoal);box-shadow:0 1px 2px rgba(26,26,26,.10);cursor:default;opacity:1}
#quizroot[dir=rtl] .seg{direction:ltr}

/* Page intro */
.qhead{margin:0 0 4px}
.qlede{color:var(--muted);font-size:14.5px;line-height:1.55;max-width:62ch;margin:0 0 4px}
.qback{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);margin-bottom:14px}
.qback:hover{color:var(--charcoal)}

/* Cards */
.qcard{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:clamp(18px,2.4vw,24px);margin:var(--q-gap) 0;box-shadow:0 1px 2px rgba(26,26,26,.04)}
.qcard--flush{padding-top:18px}
.qrow-split{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}

/* Question internals */
.qindex{display:inline-flex;align-items:baseline;gap:6px;font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.qindex b{font-size:14px;color:var(--charcoal);letter-spacing:-.01em}
.qtitle{font-size:12px;color:var(--muted);margin-bottom:3px}
.qprompt{font-size:clamp(15.5px,1.7vw,17px);font-weight:600;line-height:1.5;margin:0 0 14px;color:var(--charcoal)}
.qhint{font-size:12.5px;color:var(--muted);margin:0 0 12px}

/* Options — the one tactile surface. Native input kept for a11y, row styled via :has */
.optset{display:flex;flex-direction:column;gap:8px}
.opt{display:flex;align-items:flex-start;gap:12px;padding:13px 15px;border:1px solid var(--line-strong);border-radius:12px;cursor:pointer;background:var(--surface);transition:border-color .14s,background .14s,box-shadow .14s,transform .06s}
.opt:hover{background:var(--tint);border-color:var(--ring)}
.opt:active{transform:translateY(.5px)}
.opt input{appearance:none;-webkit-appearance:none;width:19px;height:19px;margin:1px 0 0;flex:0 0 auto;border:1.5px solid var(--ring);background:var(--surface);display:grid;place-content:center;cursor:pointer;transition:border-color .14s,background .14s}
.opt input[type=radio]{border-radius:50%}
.opt input[type=checkbox]{border-radius:6px}
.opt input::after{content:"";opacity:0;transition:opacity .12s,transform .12s;transform:scale(.5)}
.opt input[type=radio]::after{width:9px;height:9px;border-radius:50%;background:#fff}
.opt input[type=checkbox]::after{width:11px;height:11px;clip-path:polygon(14% 48%,0 62%,40% 100%,100% 22%,86% 8%,38% 70%);background:#fff}
.opt input:checked{background:var(--q-accent);border-color:var(--q-accent)}
.opt input:checked::after{opacity:1;transform:scale(1)}
.opt input:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(26,26,26,.18)}
.opt .otext{flex:1;font-size:15px;line-height:1.45;padding-top:0}
.opt:has(input:checked){border-color:var(--q-accent);background:var(--fill);box-shadow:inset 0 0 0 1px var(--q-accent)}
#quizroot textarea{min-height:128px;line-height:1.6}

/* Sticky progress rail (take page) */
.qprog{position:sticky;top:0;z-index:20;margin:0 0 var(--q-gap);padding:12px 16px;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:saturate(1.2) blur(8px);-webkit-backdrop-filter:saturate(1.2) blur(8px);border:1px solid var(--line);border-radius:14px}
.qprog-top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:9px}
.qprog-label{font-size:12.5px;color:var(--muted);display:inline-flex;align-items:center;gap:8px}
.qprog-count{font-variant-numeric:tabular-nums;font-weight:700;color:var(--charcoal)}
.qprog-meta{display:inline-flex;align-items:center;gap:14px;font-size:12.5px;color:var(--muted)}
.timer{font-variant-numeric:tabular-nums;font-weight:600;color:var(--slate)}
.qprog-track{height:7px;border-radius:999px;background:var(--fill);overflow:hidden;display:flex}
.qprog-fill{height:100%;width:0;background:var(--q-accent);border-radius:999px;transition:width .35s cubic-bezier(.2,.7,.2,1)}
.savechip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--success);opacity:0;transform:translateY(-2px);transition:opacity .2s,transform .2s}
.savechip.on{opacity:1;transform:none}
.savechip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}

/* Submit / footer bar */
.qfooter{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.qfooter .muted{max-width:46ch}

/* Quiz list cards */
.qlist{display:grid;gap:var(--q-gap);grid-template-columns:repeat(auto-fill,minmax(280px,1fr));margin-top:var(--q-gap)}
.qlist .qcard{margin:0;display:flex;flex-direction:column}
.qlist .qcard h2{margin:2px 0 6px;font-size:18px;letter-spacing:-.01em}
.qlist .qcard .grow{flex:1}
.qlist .qcard .acts{margin-top:16px}

/* Status pills / tags */
.tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;border:1px solid var(--line-strong);color:var(--slate);letter-spacing:.01em;white-space:nowrap;text-transform:capitalize}
.tag::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85}
.tag.ok{color:var(--success);border-color:#aacdb8;background:#eef5f0}
.tag.no{color:#8a2018;border-color:#e7b3ac;background:#f9eeec}
.tag.wait{color:#7a5b18;border-color:#e3cf9e;background:#f7f1e3}
.tag.plain::before{display:none}

/* Score hero (result page) */
.qhero{display:flex;align-items:center;gap:clamp(18px,4vw,40px);flex-wrap:wrap}
.qhero .ring{--p:0;flex:0 0 auto;width:128px;height:128px;border-radius:50%;display:grid;place-content:center;background:conic-gradient(var(--q-accent) calc(var(--p)*1%),var(--fill) 0)}
.qhero .ring .inner{width:104px;height:104px;border-radius:50%;background:var(--surface);display:grid;place-content:center;text-align:center;box-shadow:inset 0 0 0 1px var(--line)}
.qhero .ring .pct{font-size:26px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1}
.qhero .ring .of{font-size:11px;color:var(--muted);margin-top:3px}
.qhero .breakdown{flex:1;min-width:200px;display:flex;flex-direction:column;gap:12px}
.scoreline{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:11px;border-bottom:1px solid var(--line)}
.scoreline:last-child{border-bottom:0;padding-bottom:0}
.scoreline .lbl{font-size:13.5px;color:var(--slate)}
.scorebig{font-size:21px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}

/* Review rows */
.review-row{border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:12px 0}
.review-row.correct{border-color:#cfe2d6;background:#f4f9f6}
.review-row.wrong{border-color:#eccfca;background:#fcf4f2}
.ans-line{margin:5px 0 0;font-size:14.5px;line-height:1.5}
.ans-lbl{font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-top:11px}
.why{font-size:13.5px;color:var(--slate);background:var(--tint);border:1px solid var(--line);border-radius:10px;padding:11px 13px;margin-top:11px;line-height:1.55}
.why b{color:var(--charcoal)}

/* Admin editor */
.pairgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.opt-edit{display:grid;grid-template-columns:28px 1fr 1fr auto;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}
.opt-edit:first-of-type{border-top:0}
.opt-edit .slot{font-weight:700;color:var(--muted);text-align:center;font-size:13px}
.opt-edit .ck{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--slate);white-space:nowrap}
.opt-edit .ck input{width:auto;margin:0}
.editbtns{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* Outline-danger: a cautious destructive action (Delete / Force reseed) */
.danger.secondary{background:transparent;color:var(--danger);border-color:#e7b3ac}
.danger.secondary:hover{background:#f9eeec;border-color:var(--danger)}
details.qedit{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
details.qedit>summary{cursor:pointer;font-weight:600;font-size:13.5px;color:var(--slate);list-style:none;display:inline-flex;align-items:center;gap:7px}
details.qedit>summary::-webkit-details-marker{display:none}
details.qedit>summary::before{content:"+";font-weight:700;color:var(--muted)}
details.qedit[open]>summary::before{content:"–"}

/* Read view of an admin option */
.opt-read{display:flex;gap:10px;align-items:flex-start;padding:8px 12px;border:1px solid var(--line);border-radius:10px;margin:6px 0;background:var(--tint)}
.opt-read .slot{font-weight:700;color:var(--slate);min-width:18px}
.opt-read .otext{flex:1}
.opt-read.correct{border-color:#cfe2d6;background:#f4f9f6}
.opt-read .mark{color:var(--success);font-weight:700}
/* The rep's chosen option in an admin read-out: a charcoal inset ring (works on top
 * of the green "correct" background, so right-and-chosen reads as both). */
.opt-read.chosen{border-color:var(--ring);box-shadow:inset 0 0 0 1px var(--ring)}
.opt-read .picked{color:var(--slate);font-weight:700;font-size:11px;white-space:nowrap}

/* Admin grading bar: award (0–points) + note, optionally a per-row action (Accept /
 * Save). One shared 3-col grid; the action column collapses to 0 when empty. */
.gradebar{display:grid;gap:12px;align-items:end;margin-top:14px;grid-template-columns:120px minmax(0,1fr) auto}
.gradebar label{margin-top:0}
.awarded-chip{font-variant-numeric:tabular-nums}
@media (max-width:640px){.gradebar{grid-template-columns:1fr}}

/* The question card above its stacked submissions: a leading accent (logical prop, so
 * it flips to the right edge in RTL) marks where each question group starts. */
.qcard.qpanel{border-inline-start:3px solid var(--q-accent)}
/* Sticky "jump to question" strip on the all-submissions scroll page. */
.qjump{position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 var(--q-gap);padding:10px 14px;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:saturate(1.2) blur(8px);-webkit-backdrop-filter:saturate(1.2) blur(8px);border:1px solid var(--line);border-radius:14px;font-size:12.5px;color:var(--muted)}
.qjump a{display:inline-grid;place-content:center;min-width:26px;height:26px;padding:0 6px;border:1px solid var(--line-strong);border-radius:8px;color:var(--slate);font-weight:600;font-variant-numeric:tabular-nums}
.qjump a:hover{background:var(--tint);border-color:var(--ring);text-decoration:none}

/* Empty states */
.qempty{text-align:center;padding:38px 24px}
.qempty h2{font-size:17px;margin:0 0 6px}
.qempty p{color:var(--muted);font-size:14px;max-width:42ch;margin:0 auto}

/* Entrance motion — subtle, reduced-motion-safe */
@keyframes qfade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
#quizroot.anim .qcard,#quizroot.anim .qhero-card,#quizroot.anim .review-row{animation:qfade .5s cubic-bezier(.2,.7,.2,1) both}
#quizroot.anim.stagger .qcard:nth-child(1){animation-delay:.02s}
#quizroot.anim.stagger .qcard:nth-child(2){animation-delay:.06s}
#quizroot.anim.stagger .qcard:nth-child(3){animation-delay:.10s}
#quizroot.anim.stagger .qcard:nth-child(4){animation-delay:.14s}
#quizroot.anim.stagger .qcard:nth-child(5){animation-delay:.18s}
@media (prefers-reduced-motion:reduce){
  #quizroot.anim .qcard,#quizroot.anim .review-row,#quizroot.anim .qhero-card{animation:none}
  .qprog-fill,.opt,.savechip,.seg button{transition:none}
}
@media (max-width:640px){
  .pairgrid{grid-template-columns:1fr}
  .opt-edit{grid-template-columns:24px 1fr auto;gap:8px}
  .opt-edit .ar{grid-column:1 / -1}
  .qhero{gap:18px}
}
`;

/** Two-button EN/AR segmented switch (script wires aria-pressed + persistence). */
export function langBar(): string {
	return `<div class="seg" role="group" aria-label="Language">
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
  // Defer entrance animation one frame so it never blocks first paint.
  requestAnimationFrame(function(){ root.classList.add('anim'); });
})();
</script>`;

/** Elapsed-time display: counts up from first open; survives reload via localStorage. */
export const TIMER_SCRIPT = `<script>
(function(){
  var el=document.getElementById('elapsed'); if(!el) return;
  var K='whispyrQuizStart:'+(el.getAttribute('data-quiz')||'');
  var t0=Date.now();
  try{ var s=parseInt(localStorage.getItem(K),10);
    if(s && Date.now()-s < 6*3600*1000){ t0=s; } else { localStorage.setItem(K,String(t0)); }
  }catch(e){}
  function tick(){ var s=Math.floor((Date.now()-t0)/1000); var m=Math.floor(s/60); var ss=String(s%60).padStart(2,'0'); el.textContent=m+':'+ss; }
  tick(); setInterval(tick,1000);
})();
</script>`;

/**
 * Take-page enhancements on #quizform[data-autosave]: live progress, localStorage
 * draft autosave + restore (survives reload / leaving and coming back), a "saved" /
 * "draft restored" chip, and a blank-question confirm on submit. Draft is keyed by
 * quiz + user and cleared on submit. ponytail: localStorage only — no in_progress row,
 * no server round-trip; honor-system quiz, the draft is a convenience not a record.
 */
export const TAKE_SCRIPT = `<script>
(function(){
  var form=document.getElementById('quizform');
  if(!form || !form.getAttribute('data-autosave')) return;
  var key='whispyrQuizDraft:'+(form.getAttribute('data-quiz')||'')+':'+(form.getAttribute('data-user')||'');
  var groups=[].slice.call(form.querySelectorAll('[data-qgroup]'));
  var total=groups.length;
  var fill=document.getElementById('qprogfill');
  var count=document.getElementById('qprogcount');
  var chip=document.getElementById('qsave');

  function answered(){
    var n=0;
    for(var i=0;i<groups.length;i++){
      var ins=groups[i].querySelectorAll('input,textarea'), done=false;
      for(var j=0;j<ins.length;j++){
        var el=ins[j];
        if(el.type==='radio'||el.type==='checkbox'){ if(el.checked) done=true; }
        else if(el.value.trim()!=='') done=true;
      }
      if(done) n++;
    }
    return n;
  }
  function progress(){
    var n=answered();
    if(count) count.textContent=n+' / '+total;
    if(fill) fill.style.width=(total?(n/total*100):0)+'%';
  }
  function serialize(){
    var data={}, els=form.querySelectorAll('input,textarea');
    for(var i=0;i<els.length;i++){ var el=els[i]; if(!el.name) continue;
      if(el.type==='radio'||el.type==='checkbox'){ if(el.checked){ (data[el.name]=data[el.name]||[]).push(el.value); } }
      else { data[el.name]=el.value; }
    }
    return data;
  }
  var st;
  function lang(){ var r=document.getElementById('quizroot'); return (r&&r.classList.contains('lang-ar'))?'ar':'en'; }
  function chipText(name){ if(!chip) return ''; return chip.getAttribute('data-'+name+'-'+lang()) || chip.getAttribute('data-'+name+'-en') || ''; }
  function showChip(text,ms){ if(!chip||!text) return; chip.textContent=text; chip.classList.add('on');
    clearTimeout(chip._t); chip._t=setTimeout(function(){ chip.classList.remove('on'); }, ms||1300); }
  function save(){ try{ localStorage.setItem(key, JSON.stringify({t:Date.now(), d:serialize()})); }catch(e){}
    showChip(chipText('saved'),1300); }
  function restore(){
    var raw; try{ raw=localStorage.getItem(key); }catch(e){} if(!raw) return false;
    var obj; try{ obj=JSON.parse(raw); }catch(e){ return false; }
    var data=(obj&&obj.d)||{}, els=form.querySelectorAll('input,textarea'), any=false;
    for(var i=0;i<els.length;i++){ var el=els[i]; if(!el.name || !(el.name in data)) continue; var v=data[el.name];
      if(el.type==='radio'||el.type==='checkbox'){ if(Object.prototype.toString.call(v)==='[object Array]' && v.indexOf(el.value)>-1){ el.checked=true; any=true; } }
      else if(typeof v==='string'){ el.value=v; if(v.trim()!=='') any=true; }
    }
    return any;
  }

  var didRestore=restore();
  progress();
  if(didRestore){ showChip(chipText('restored'), 2800); }

  form.addEventListener('input', function(){ progress(); clearTimeout(st); st=setTimeout(save,450); });
  form.addEventListener('change', function(){ progress(); clearTimeout(st); st=setTimeout(save,200); });
  form.addEventListener('submit', function(e){
    var blanks=total-answered();
    if(blanks>0 && !confirm(blanks+' question(s) are blank. Submit anyway? You only get one attempt.')){ e.preventDefault(); return; }
    try{ localStorage.removeItem(key); localStorage.removeItem('whispyrQuizStart:'+(form.getAttribute('data-quiz')||'')); }catch(e2){}
  });
})();
</script>`;

/**
 * Wrap quiz body in the brand shell with the #quizroot language wrapper. `headerExtra`
 * sits in the brand bar (e.g. a Back link). Scripts run after the body so the DOM is in
 * place. `stagger` enables the small per-card entrance cascade (use only on short lists).
 */
export function quizShell(
	title: string,
	bodyHtml: string,
	opts: { scripts?: string[]; backHref?: string; backLabelEn?: string; backLabelAr?: string; stagger?: boolean } = {},
): string {
	const back = opts.backHref
		? `<a class="qback" href="${opts.backHref}">← ${bi(opts.backLabelEn ?? "Back", opts.backLabelAr ?? "رجوع")}</a>`
		: "";
	const scripts = [LANG_SCRIPT, ...(opts.scripts ?? [])].join("\n");
	const rootClass = `lang-en${opts.stagger ? " stagger" : ""}`;
	// The whole page (header + back + body) lives inside #quizroot so the language
	// toggle's only-en/only-ar CSS and dir flip reach the header too, not just the body.
	const body = `<div class="wrap">
  <div id="quizroot" class="${rootClass}" dir="ltr">
    <div class="qtopbar">${brandLogo({ href: "/" })}
      <div class="qtools">${langBar()}
        <a href="/">${bi("Inbox", "البريد")}</a>
        <form method="post" action="/logout" style="margin:0"><button class="sm secondary" type="submit">${bi("Sign out", "خروج")}</button></form>
      </div>
    </div>
    ${back}
    ${bodyHtml}
  </div>
</div>${scripts}`;
	return pageShell(`${title} · Whispyr Mail`, `<style>${QUIZ_CSS}</style>${body}`);
}
