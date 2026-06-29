// Admin-facing quiz routes, mounted inside adminApp at /admin/quizzes (so they
// inherit adminApp's ADMIN-only guard). Hesham opens/closes quizzes, edits every
// question (paired EN/AR fields, so any string — incl. Arabic — is fixable without a
// code change), grades short answers, and reads the results table (design §5).

import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth";
import { escapeHtml } from "../lib/email-helpers";
import type { Env } from "../types";
import { QUESTION_TYPES, QUIZ_STATUSES } from "../db/quiz-schema";
import type { QuizQuestionRow, QuizRow } from "../db/quiz-schema";
import type { SeedOption } from "./seed";
import { bi, biBlock, quizShell } from "./render";
import {
	attemptCounts,
	createQuestion,
	deleteQuestion,
	finalizeGrading,
	getAnswers,
	getAttemptById,
	getQuestion,
	getQuizById,
	listQuestions,
	listQuizzes,
	listResults,
	moveQuestion,
	parseCorrect,
	parseOptions,
	parseSelected,
	seedQuizzes,
	setQuizStatus,
	updateQuestion,
	type QuestionInput,
} from "./queries";

type AdminEnv = { Bindings: Env; Variables: { session?: SessionClaims } };

const OPTION_SLOTS = ["a", "b", "c", "d", "e", "f"] as const;

const adminQuizApp = new Hono<AdminEnv>();

function flash(c: { req: { query: (k: string) => string | undefined } }): string {
	const ok = c.req.query("ok");
	const err = c.req.query("err");
	if (ok) return `<div class="flash ok">${escapeHtml(ok)}</div>`;
	if (err) return `<div class="flash err">${escapeHtml(err)}</div>`;
	return "";
}

const STATUS_LABEL: Record<string, string> = { draft: "مسودة", open: "مفتوح", closed: "مقفول" };
function statusLabel(s: string): string {
	return bi(s, STATUS_LABEL[s] ?? s);
}

function statusBadge(status: string): string {
	const cls =
		status === "open" || status === "graded"
			? "ok"
			: status === "submitted"
				? "wait"
				: status === "closed"
					? "no"
					: "plain";
	return `<span class="tag ${cls}">${statusLabel(status)}</span>`;
}

// ── GET /admin/quizzes — overview + controls + seed ─────────────────
adminQuizApp.get("/", async (c) => {
	const quizzes = await listQuizzes(c.env);
	const rows = await Promise.all(
		quizzes.map(async (q) => {
			const counts = await attemptCounts(c.env, q.id);
			const segButtons = QUIZ_STATUSES.map(
				(s) =>
					`<button type="submit" name="status" value="${s}"${s === q.status ? ' class="is-current" disabled' : ""}>${statusLabel(s)}</button>`,
			).join("");
			return `<div class="qcard">
        <div class="qrow-split">
          <h2 style="margin:0">${bi(q.title_en, q.title_ar)} ${statusBadge(q.status)}</h2>
          <span class="muted">${counts.submitted} ${bi("submitted", "متسلّم")} · ${counts.graded} ${bi("graded", "متصحّح")}</span>
        </div>
        <div class="qrow-split" style="margin-top:14px;align-items:flex-end">
          <div>
            <div class="qtitle" style="margin-bottom:7px">${bi("Visibility to reps", "الظهور للمناديب")}</div>
            <form method="post" action="/admin/quizzes/${q.id}/status" class="seg" aria-label="${escapeHtml("Set status")}">${segButtons}</form>
          </div>
          <div class="editbtns">
            <a class="btn secondary sm" href="/admin/quizzes/${q.id}/questions">${bi("Edit questions", "تعديل الأسئلة")}</a>
            <a class="btn secondary sm" href="/admin/quizzes/${q.id}/grade">${bi("Grade", "تصحيح")}</a>
            <a class="btn secondary sm" href="/admin/quizzes/${q.id}/results">${bi("Results", "النتائج")}</a>
          </div>
        </div>
      </div>`;
		}),
	);

	const body = `<h1 class="qhead">${bi("Quizzes", "الاختبارات")}</h1>
    <p class="qlede">${bi("Open or close each quiz, edit its questions, grade short answers, and read results. Only quizzes set to “open” are visible to reps.", "افتح أو اقفل كل اختبار، عدّل أسئلته، صحّح المقالي، واقرا النتائج. الاختبارات اللي حالتها «مفتوح» بس هي اللي بتظهر للمناديب.")}</p>
    ${flash(c)}
    ${
			rows.length
				? rows.join("")
				: `<div class="qcard qempty"><h2>${bi("No quizzes yet", "مفيش اختبارات")}</h2><p>${bi("Seed the two default quizzes below to get started.", "ازرع الاختبارين الافتراضيين تحت عشان تبدأ.")}</p></div>`
		}
    <div class="qcard">
      <h2 style="margin-top:0">${bi("Seed default quizzes", "زرع الاختبارات الافتراضية")}</h2>
      <p class="qlede">${bi("Inserts the two bundled quizzes if they're missing. Re-running is safe — existing quizzes are skipped.", "بيضيف الاختبارين المرفقين لو مش موجودين. إعادة التشغيل آمنة — الاختبارات الموجودة بتتخطّى.")}</p>
      <div class="editbtns" style="margin-top:6px">
        <form method="post" action="/admin/quizzes/seed" style="margin:0"><button type="submit">${bi("Seed default quizzes", "زرع الاختبارات")}</button></form>
        <form method="post" action="/admin/quizzes/seed?force=1" style="margin:0" onsubmit="return confirm('Force reseed DELETES existing questions for these quizzes and recreates them. Only safe before any attempts exist. Continue?')">
          <button type="submit" class="danger sm secondary">${bi("Force reseed", "إعادة زرع إجبارية")}</button>
        </form>
      </div>
    </div>`;
	return c.html(quizShell("Quizzes admin", body));
});

// ── POST /admin/quizzes/:quizId/status ──────────────────────────────
adminQuizApp.post("/:quizId/status", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const form = await c.req.parseBody();
	const status = String(form.status || "");
	if (!(QUIZ_STATUSES as readonly string[]).includes(status)) {
		return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Invalid status.")}`, 302);
	}
	await setQuizStatus(c.env, quiz.id, status as (typeof QUIZ_STATUSES)[number]);
	return c.redirect(`/admin/quizzes?ok=${encodeURIComponent(`${quiz.title_en} → ${status}.`)}`, 302);
});

// ── POST /admin/quizzes/seed ────────────────────────────────────────
adminQuizApp.post("/seed", async (c) => {
	const force = c.req.query("force") === "1";
	const report = await seedQuizzes(c.env, force);
	const msg =
		(report.created.length ? `Seeded: ${report.created.join(", ")}. ` : "") +
		(report.skipped.length ? `Skipped (already exist): ${report.skipped.join(", ")}.` : "");
	return c.redirect(`/admin/quizzes?ok=${encodeURIComponent(msg || "Nothing to seed.")}`, 302);
});

// ── GET /admin/quizzes/:quizId/questions — list + add/edit/reorder ───
adminQuizApp.get("/:quizId/questions", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const questions = await listQuestions(c.env, quiz.id);

	const list = questions.map((q, i) => renderAdminQuestion(quiz, q, i, questions.length)).join("");

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    <p class="qlede">${questions.length} ${bi("questions", "سؤال")} · ${bi("edit any field in both languages; reorder or remove; add new ones below.", "عدّل أي خانة باللغتين؛ رتّب أو احذف؛ وضيف جداد تحت.")}</p>
    ${flash(c)}
    ${list || `<div class="qcard qempty"><h2>${bi("No questions yet", "مفيش أسئلة")}</h2><p>${bi("Add the first question below.", "ضيف أول سؤال تحت.")}</p></div>`}
    <div class="qcard">
      <h2 style="margin-top:0">${bi("Add a question", "إضافة سؤال")}</h2>
      ${questionForm(`/admin/quizzes/${quiz.id}/questions`, null)}
    </div>`;
	return c.html(quizShell("Edit questions", body, { backHref: "/admin/quizzes", backLabelEn: "All quizzes", backLabelAr: "كل الاختبارات" }));
});

/** One question in the admin list: read view + a collapsible (native <details>) edit
 * form + delete + reorder. */
function renderAdminQuestion(quiz: QuizRow, q: QuizQuestionRow, idx: number, total: number): string {
	const options = parseOptions(q);
	const correct = new Set(parseCorrect(q));
	const optsHtml =
		q.type === "short"
			? `<div class="ans-lbl">${bi("Rubric", "معايير التصحيح")}</div>${biBlock(q.rubric_en, q.rubric_ar, "qlede")}`
			: options
					.map(
						(o) =>
							`<div class="opt-read${correct.has(o.id) ? " correct" : ""}"><span class="slot">${escapeHtml(o.id)}</span><span class="otext">${bi(o.en, o.ar)}</span>${correct.has(o.id) ? `<span class="mark">✓</span>` : ""}</div>`,
					)
					.join("");

	const move = `<form method="post" action="/admin/quizzes/${quiz.id}/questions/${q.id}/move" class="inline editbtns">
    <button class="sm secondary" name="dir" value="up" type="submit"${idx === 0 ? " disabled" : ""} aria-label="Move up">↑</button>
    <button class="sm secondary" name="dir" value="down" type="submit"${idx === total - 1 ? " disabled" : ""} aria-label="Move down">↓</button></form>`;

	return `<div class="qcard">
    <div class="qrow-split">
      <div class="qindex">#${q.position} · ${escapeHtml(q.type)} · ${q.points} ${bi("pt", "نقطة")}</div>
      <div class="editbtns">${move}
        <form method="post" action="/admin/quizzes/${quiz.id}/questions/${q.id}/delete" class="inline" onsubmit="return confirm('Delete this question?')"><button class="sm danger secondary" type="submit">${bi("Delete", "حذف")}</button></form>
      </div>
    </div>
    ${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt" style="margin-bottom:10px">${bi(q.prompt_en, q.prompt_ar)}</div>
    ${optsHtml}
    ${q.type !== "short" && (q.explanation_en || q.explanation_ar) ? `<div class="why"><b>${bi("Why", "ليه")}:</b> ${bi(q.explanation_en, q.explanation_ar)}</div>` : ""}
    <details class="qedit"><summary>${bi("Edit this question", "تعديل السؤال")}</summary>
      ${questionForm(`/admin/quizzes/${quiz.id}/questions/${q.id}`, q)}
    </details>
  </div>`;
}

/** The add/edit form with paired EN/AR fields for every string + 6 option slots. */
function questionForm(action: string, q: QuizQuestionRow | null): string {
	const options = q ? parseOptions(q) : [];
	const correct = new Set(q ? parseCorrect(q) : []);
	const byId = new Map(options.map((o) => [o.id, o]));
	const val = (s: string | null | undefined) => escapeHtml(s ?? "");

	const typeOpts = QUESTION_TYPES.map(
		(t) => `<option value="${t}"${q?.type === t ? " selected" : ""}>${t}</option>`,
	).join("");

	const optionRows = OPTION_SLOTS.map((id) => {
		const o = byId.get(id) as SeedOption | undefined;
		return `<div class="opt-edit">
      <span class="slot">${id}</span>
      <input name="opt_${id}_en" placeholder="option ${id} (EN)" value="${val(o?.en)}">
      <input class="ar" name="opt_${id}_ar" dir="rtl" placeholder="الخيار ${id} (AR)" value="${val(o?.ar)}">
      <label class="ck"><input type="checkbox" name="correct_${id}" value="1"${correct.has(id) ? " checked" : ""}> ${bi("correct", "صح")}</label>
    </div>`;
	}).join("");

	return `<form method="post" action="${action}">
    <div class="pairgrid">
      <div><label>Title (EN)</label><input name="title_en" value="${val(q?.title_en)}"></div>
      <div><label>العنوان (AR)</label><input name="title_ar" dir="rtl" value="${val(q?.title_ar)}"></div>
    </div>
    <div class="pairgrid">
      <div><label>Prompt (EN)</label><textarea name="prompt_en" style="min-height:80px">${val(q?.prompt_en)}</textarea></div>
      <div><label>السؤال (AR)</label><textarea name="prompt_ar" dir="rtl" style="min-height:80px">${val(q?.prompt_ar)}</textarea></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 140px;gap:12px">
      <div><label>Type</label><select name="type">${typeOpts}</select></div>
      <div><label>Points</label><input name="points" type="number" min="1" value="${q?.points ?? 1}"></div>
    </div>
    <label style="margin-top:16px">${bi("Options — leave a slot blank to omit, tick the correct one(s). Ignored for short answers.", "الخيارات — سيب الخانة فاضية للتجاهل، علّم الصح. بتتجاهل في المقالي.")}</label>
    <div class="qcard" style="margin:6px 0;padding:6px 16px">${optionRows}</div>
    <div class="pairgrid">
      <div><label>Explanation / “Why” (EN)</label><textarea name="explanation_en" style="min-height:60px">${val(q?.explanation_en)}</textarea></div>
      <div><label>الشرح (AR)</label><textarea name="explanation_ar" dir="rtl" style="min-height:60px">${val(q?.explanation_ar)}</textarea></div>
    </div>
    <div class="pairgrid">
      <div><label>Rubric — short answers (EN)</label><textarea name="rubric_en" style="min-height:60px">${val(q?.rubric_en)}</textarea></div>
      <div><label>معايير التصحيح (AR)</label><textarea name="rubric_ar" dir="rtl" style="min-height:60px">${val(q?.rubric_ar)}</textarea></div>
    </div>
    <button type="submit" style="margin-top:16px">${q ? bi("Save changes", "حفظ التعديلات") : bi("Add question", "إضافة السؤال")}</button>
  </form>`;
}

/** Parse the question form into a QuestionInput. */
function parseQuestionForm(form: Record<string, string | File>): QuestionInput {
	const s = (k: string) => {
		const v = form[k];
		return typeof v === "string" ? v.trim() : "";
	};
	const typeRaw = s("type");
	const type = (QUESTION_TYPES as readonly string[]).includes(typeRaw)
		? (typeRaw as QuestionInput["type"])
		: "single";
	const points = Math.max(1, parseInt(s("points"), 10) || 1);

	const options: SeedOption[] = [];
	const correct: string[] = [];
	for (const id of OPTION_SLOTS) {
		const en = s(`opt_${id}_en`);
		const ar = s(`opt_${id}_ar`);
		if (!en && !ar) continue;
		options.push({ id, en, ar });
		if (form[`correct_${id}`]) correct.push(id);
	}

	return {
		type,
		points,
		title_en: s("title_en"),
		title_ar: s("title_ar"),
		prompt_en: s("prompt_en"),
		prompt_ar: s("prompt_ar"),
		options: type === "short" ? null : options,
		correct: type === "short" ? null : correct,
		explanation_en: s("explanation_en"),
		explanation_ar: s("explanation_ar"),
		rubric_en: s("rubric_en"),
		rubric_ar: s("rubric_ar"),
	};
}

// ── POST create / update / delete / move question ───────────────────
adminQuizApp.post("/:quizId/questions", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const input = parseQuestionForm(await c.req.parseBody());
	if (!input.prompt_en && !input.prompt_ar) {
		return c.redirect(`/admin/quizzes/${quiz.id}/questions?err=${encodeURIComponent("A prompt is required.")}`, 302);
	}
	await createQuestion(c.env, quiz.id, input);
	return c.redirect(`/admin/quizzes/${quiz.id}/questions?ok=${encodeURIComponent("Question added.")}`, 302);
});

adminQuizApp.post("/:quizId/questions/:questionId/delete", async (c) => {
	const quizId = c.req.param("quizId");
	await deleteQuestion(c.env, c.req.param("questionId"));
	return c.redirect(`/admin/quizzes/${quizId}/questions?ok=${encodeURIComponent("Question deleted.")}`, 302);
});

adminQuizApp.post("/:quizId/questions/:questionId/move", async (c) => {
	const quizId = c.req.param("quizId");
	const form = await c.req.parseBody();
	const dir = String(form.dir || "") === "up" ? "up" : "down";
	await moveQuestion(c.env, quizId, c.req.param("questionId"), dir);
	return c.redirect(`/admin/quizzes/${quizId}/questions?ok=${encodeURIComponent("Reordered.")}`, 302);
});

adminQuizApp.post("/:quizId/questions/:questionId", async (c) => {
	const quizId = c.req.param("quizId");
	const question = await getQuestion(c.env, c.req.param("questionId"));
	if (!question) return c.redirect(`/admin/quizzes/${quizId}/questions?err=${encodeURIComponent("Question not found.")}`, 302);
	const input = parseQuestionForm(await c.req.parseBody());
	if (!input.prompt_en && !input.prompt_ar) {
		return c.redirect(`/admin/quizzes/${quizId}/questions?err=${encodeURIComponent("A prompt is required.")}`, 302);
	}
	await updateQuestion(c.env, question.id, input);
	return c.redirect(`/admin/quizzes/${quizId}/questions?ok=${encodeURIComponent("Question saved.")}`, 302);
});

// ── GET /admin/quizzes/:quizId/grade — attempts awaiting grading ────
adminQuizApp.get("/:quizId/grade", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const results = await listResults(c.env, quiz.id);

	const rowsFor = (status: string) =>
		results
			.filter((r) => r.status === status)
			.map(
				(r) =>
					`<tr><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.mailbox)}</td><td>${r.mcqScore ?? 0} / ${r.mcqMax ?? 0}</td>
            <td style="text-align:right"><a class="btn secondary sm" href="/admin/quizzes/${quiz.id}/grade/${r.attemptId}">${status === "graded" ? bi("Re-grade", "إعادة تصحيح") : bi("Grade", "صحّح")}</a></td></tr>`,
			)
			.join("");

	const submitted = rowsFor("submitted");
	const graded = rowsFor("graded");
	const tableHead = `<thead><tr><th>${bi("Email", "الإيميل")}</th><th>${bi("Mailbox", "الصندوق")}</th><th>MCQ</th><th></th></tr></thead>`;

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    <p class="qlede">${bi("Score each rep's short answers (0–3 + a note), then finalize.", "صحّح إجابات كل مندوب المقالية (٠–٣ وملاحظة)، وبعدين أنهِ.")}</p>
    ${flash(c)}
    <div class="qcard"><h2 style="margin-top:0">${bi("Awaiting grading", "في انتظار التصحيح")} <span class="tag wait plain">${(submitted.match(/<tr>/g) || []).length}</span></h2>
      <div class="tablewrap"><table>${tableHead}
      <tbody>${submitted || `<tr><td colspan="4"><span class="muted">${bi("Nobody waiting.", "مفيش حد مستني.")}</span></td></tr>`}</tbody></table></div></div>
    <div class="qcard"><h2 style="margin-top:0">${bi("Already graded", "اتصحّح")}</h2>
      <div class="tablewrap"><table>${tableHead}
      <tbody>${graded || `<tr><td colspan="4"><span class="muted">${bi("None yet.", "لسه ولا واحد.")}</span></td></tr>`}</tbody></table></div></div>`;
	return c.html(quizShell("Grade", body, { backHref: "/admin/quizzes", backLabelEn: "All quizzes", backLabelAr: "كل الاختبارات" }));
});

// ── GET /admin/quizzes/:quizId/grade/:attemptId — grade one attempt ─
adminQuizApp.get("/:quizId/grade/:attemptId", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const attempt = await getAttemptById(c.env, c.req.param("attemptId"));
	if (!attempt) return c.redirect(`/admin/quizzes/${quiz.id}/grade?err=${encodeURIComponent("Attempt not found.")}`, 302);

	const questions = await listQuestions(c.env, quiz.id);
	const answers = await getAnswers(c.env, attempt.id);
	const ansByQ = new Map(answers.map((a) => [a.question_id, a]));

	const shortQs = questions.filter((q) => q.type === "short");
	const shortBlocks = shortQs
		.map((q) => {
			const a = ansByQ.get(q.id);
			const awarded = a?.awarded_points;
			return `<div class="qcard" data-qgroup>
        <div class="qindex">${bi(q.title_en, q.title_ar)} · ${q.points} ${bi("pts", "نقاط")}</div>
        <div class="qprompt">${bi(q.prompt_en, q.prompt_ar)}</div>
        <div class="ans-lbl">${bi("Rubric", "معايير التصحيح")}</div>${biBlock(q.rubric_en, q.rubric_ar, "qlede")}
        <div class="ans-lbl">${bi("Rep's answer", "إجابة المندوب")}</div>
        <div class="preview" style="margin-top:6px">${escapeHtml(a?.text_answer ?? "") || `<span class="muted">${bi("(blank)", "(فاضي)")}</span>`}</div>
        <div style="display:grid;grid-template-columns:150px 1fr;gap:12px;margin-top:14px">
          <div><label>${bi("Award", "الدرجة")} (0–${q.points})</label>
            <input type="number" name="mark_${q.id}" min="0" max="${q.points}" value="${awarded ?? ""}" placeholder="0–${q.points}"></div>
          <div><label>${bi("Note to rep", "ملاحظة للمندوب")}</label><input name="note_${q.id}" value="${escapeHtml(a?.grader_note ?? "")}"></div>
        </div>
      </div>`;
		})
		.join("");

	// MCQ breakdown, read-only for context.
	const mcqRows = questions
		.filter((q) => q.type !== "short")
		.map((q) => {
			const a = ansByQ.get(q.id);
			const sel = a ? parseSelected(a).join(", ") : "";
			const correct = parseCorrect(q).join(", ");
			const ok = a?.is_correct === 1;
			return `<tr><td>#${q.position}</td><td>${escapeHtml(sel) || "—"}</td><td>${escapeHtml(correct)}</td><td>${ok ? `<span class="tag ok plain">✓</span>` : `<span class="tag no plain">✗</span>`}</td></tr>`;
		})
		.join("");

	const body = `<h1 class="qhead">${bi("Grade attempt", "تصحيح المحاولة")}</h1>
    <p class="qlede">${escapeHtml(attempt.status)} · MCQ ${attempt.mcq_score ?? 0} / ${attempt.mcq_max ?? 0}</p>
    ${flash(c)}
    <form id="quizform" method="post" action="/admin/quizzes/${quiz.id}/grade/${attempt.id}">
      ${shortBlocks || `<div class="qcard qempty"><p>${bi("This quiz has no short answers.", "الاختبار ده مفيهوش أسئلة مقالية.")}</p></div>`}
      <div class="qcard qfooter">
        <span class="muted">${bi("Finalize sets the total and marks the attempt graded.", "الإنهاء بيحسب الإجمالي ويعتبر المحاولة متصحّحة.")}</span>
        <button type="submit">${bi("Finalize grade", "إنهاء التصحيح")}</button>
      </div>
    </form>
    <div class="qcard"><h2 style="margin-top:0">${bi("Multiple-choice (read-only)", "الاختيارات (للعرض فقط)")}</h2>
      <div class="tablewrap"><table><thead><tr><th>#</th><th>${bi("Chose", "اختار")}</th><th>${bi("Correct", "الصح")}</th><th></th></tr></thead>
      <tbody>${mcqRows}</tbody></table></div></div>`;
	return c.html(quizShell("Grade attempt", body, { backHref: `/admin/quizzes/${quiz.id}/grade`, backLabelEn: "Back to grading", backLabelAr: "ارجع للتصحيح" }));
});

// ── POST /admin/quizzes/:quizId/grade/:attemptId — finalize ─────────
adminQuizApp.post("/:quizId/grade/:attemptId", async (c) => {
	const quizId = c.req.param("quizId");
	const attempt = await getAttemptById(c.env, c.req.param("attemptId"));
	if (!attempt) return c.redirect(`/admin/quizzes/${quizId}/grade?err=${encodeURIComponent("Attempt not found.")}`, 302);

	const questions = await listQuestions(c.env, attempt.quiz_id);
	const form = await c.req.parseBody();
	const marks: Record<string, { awarded: number; note: string }> = {};
	for (const q of questions) {
		if (q.type !== "short") continue;
		const raw = parseInt(String(form[`mark_${q.id}`] ?? ""), 10);
		const awarded = Number.isFinite(raw) ? Math.min(q.points, Math.max(0, raw)) : 0;
		marks[q.id] = { awarded, note: String(form[`note_${q.id}`] ?? "") };
	}
	await finalizeGrading(c.env, attempt.id, marks);
	return c.redirect(`/admin/quizzes/${quizId}/results?ok=${encodeURIComponent("Attempt graded.")}`, 302);
});

// ── GET /admin/quizzes/:quizId/results — reps × scores ──────────────
adminQuizApp.get("/:quizId/results", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const results = await listResults(c.env, quiz.id);

	const rows = results
		.map(
			(r) =>
				`<tr>
          <td>${escapeHtml(r.email)}</td>
          <td>${escapeHtml(r.mailbox)}</td>
          <td>${r.mcqScore ?? 0} / ${r.mcqMax ?? 0}</td>
          <td>${r.shortScore ?? "—"} / ${(r.totalMax ?? 0) - (r.mcqMax ?? 0)}</td>
          <td><b>${r.totalScore ?? "—"} / ${r.totalMax ?? 0}</b></td>
          <td>${statusBadge(r.status)}</td>
        </tr>`,
		)
		.join("");

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    <p class="qlede">${results.length} ${bi("reps have attempted this quiz.", "مندوب جرّبوا الاختبار ده.")}</p>
    ${flash(c)}
    <div class="qcard"><div class="tablewrap"><table>
      <thead><tr><th>${bi("Email", "الإيميل")}</th><th>${bi("Mailbox", "الصندوق")}</th><th>MCQ</th><th>${bi("Short", "مقالي")}</th><th>${bi("Total", "الإجمالي")}</th><th>${bi("Status", "الحالة")}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6"><span class="muted">${bi("No attempts yet.", "مفيش محاولات لسه.")}</span></td></tr>`}</tbody>
    </table></div></div>`;
	return c.html(quizShell("Results", body, { backHref: "/admin/quizzes", backLabelEn: "All quizzes", backLabelAr: "كل الاختبارات" }));
});

export { adminQuizApp };
