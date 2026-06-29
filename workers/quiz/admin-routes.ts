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

function statusBadge(status: string): string {
	const cls = status === "open" ? "ok" : status === "closed" ? "no" : "";
	return `<span class="tag ${cls}">${escapeHtml(status)}</span>`;
}

// ── GET /admin/quizzes — overview + controls + seed ─────────────────
adminQuizApp.get("/", async (c) => {
	const quizzes = await listQuizzes(c.env);
	const rows = await Promise.all(
		quizzes.map(async (q) => {
			const counts = await attemptCounts(c.env, q.id);
			const statusForm = QUIZ_STATUSES.map(
				(s) =>
					`<button class="sm ${s === q.status ? "" : "secondary"}" name="status" value="${s}" type="submit"${s === q.status ? " disabled" : ""}>${s}</button>`,
			).join(" ");
			return `<div class="qcard">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <h2 style="margin:0">${bi(q.title_en, q.title_ar)} ${statusBadge(q.status)}</h2>
          <span class="muted">${counts.submitted} ${bi("submitted", "متسلّم")} · ${counts.graded} ${bi("graded", "متصحّح")}</span>
        </div>
        <form method="post" action="/admin/quizzes/${q.id}/status" class="row" style="margin-top:10px;gap:8px">
          <div style="flex:0"><label style="margin:0 0 4px">${bi("Set status", "تغيير الحالة")}</label>${statusForm}</div>
        </form>
        <div class="row" style="margin-top:12px;gap:10px">
          <a class="btn secondary sm" href="/admin/quizzes/${q.id}/questions">${bi("Edit questions", "تعديل الأسئلة")}</a>
          <a class="btn secondary sm" href="/admin/quizzes/${q.id}/grade">${bi("Grade short answers", "تصحيح المقالي")}</a>
          <a class="btn secondary sm" href="/admin/quizzes/${q.id}/results">${bi("Results", "النتائج")}</a>
        </div>
      </div>`;
		}),
	);

	const body = `<h1>${bi("Quizzes — admin", "الاختبارات — الأدمن")}</h1>
    ${flash(c)}
    ${rows.join("") || `<div class="qcard">${bi("No quizzes yet. Seed the two defaults to begin.", "مفيش اختبارات. ابدأ بزرع الاختبارين الافتراضيين.")}</div>`}
    <div class="qcard">
      <h2 style="margin-top:0">${bi("Seed default quizzes", "زرع الاختبارات الافتراضية")}</h2>
      <p class="muted">${bi("Inserts the two bundled quizzes if missing. Re-running is safe — existing quizzes are skipped.", "بيضيف الاختبارين المرفقين لو مش موجودين. إعادة التشغيل آمنة — الاختبارات الموجودة بتتخطّى.")}</p>
      <div class="row" style="gap:10px">
        <form method="post" action="/admin/quizzes/seed" style="margin:0"><button type="submit">${bi("Seed default quizzes", "زرع الاختبارات")}</button></form>
        <form method="post" action="/admin/quizzes/seed?force=1" style="margin:0" onsubmit="return confirm('Force reseed DELETES existing questions for these quizzes and recreates them. Only safe before any attempts exist. Continue?')">
          <button type="submit" class="danger sm">${bi("Force reseed", "إعادة زرع إجبارية")}</button>
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

	const body = `<h1>${bi(quiz.title_en, quiz.title_ar)} — ${bi("Questions", "الأسئلة")}</h1>
    ${flash(c)}
    <p class="muted"><a href="/admin/quizzes">← ${bi("All quizzes", "كل الاختبارات")}</a> · ${questions.length} ${bi("questions", "سؤال")}</p>
    ${list}
    <div class="qcard">
      <h2 style="margin-top:0">${bi("Add a question", "إضافة سؤال")}</h2>
      ${questionForm(`/admin/quizzes/${quiz.id}/questions`, null)}
    </div>`;
	return c.html(quizShell("Edit questions", body));
});

/** One question in the admin list: read view + a collapsible (native <details>) edit
 * form + delete + reorder. */
function renderAdminQuestion(quiz: QuizRow, q: QuizQuestionRow, idx: number, total: number): string {
	const options = parseOptions(q);
	const correct = new Set(parseCorrect(q));
	const optsHtml =
		q.type === "short"
			? `<div class="qtitle">${bi("Rubric", "معايير التصحيح")}</div>${biBlock(q.rubric_en, q.rubric_ar, "muted")}`
			: options
					.map(
						(o) =>
							`<div class="opt"><span style="font-weight:700">${escapeHtml(o.id)}${correct.has(o.id) ? " ✓" : ""}</span><span class="otext">${bi(o.en, o.ar)}</span></div>`,
					)
					.join("");

	const move = `<form method="post" action="/admin/quizzes/${quiz.id}/questions/${q.id}/move" class="inline">
    <button class="sm secondary" name="dir" value="up" type="submit"${idx === 0 ? " disabled" : ""}>↑</button>
    <button class="sm secondary" name="dir" value="down" type="submit"${idx === total - 1 ? " disabled" : ""}>↓</button></form>`;

	return `<div class="qcard">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <div class="qnum">#${q.position} · ${escapeHtml(q.type)} · ${q.points} ${bi("pt", "نقطة")}</div>
      <div class="row" style="gap:6px">${move}
        <form method="post" action="/admin/quizzes/${quiz.id}/questions/${q.id}/delete" class="inline" onsubmit="return confirm('Delete this question?')"><button class="sm danger" type="submit">${bi("Delete", "حذف")}</button></form>
      </div>
    </div>
    ${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt">${bi(q.prompt_en, q.prompt_ar)}</div>
    ${optsHtml}
    ${q.type !== "short" && (q.explanation_en || q.explanation_ar) ? `<div class="why"><b>${bi("Why", "ليه")}:</b> ${bi(q.explanation_en, q.explanation_ar)}</div>` : ""}
    <details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">${bi("Edit", "تعديل")}</summary>
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
		return `<div class="row" style="gap:8px;align-items:center">
      <div style="flex:0;min-width:auto"><label style="margin:0">${id}</label></div>
      <div><input name="opt_${id}_en" placeholder="option ${id} (EN)" value="${val(o?.en)}"></div>
      <div><input name="opt_${id}_ar" dir="rtl" placeholder="الخيار ${id} (AR)" value="${val(o?.ar)}"></div>
      <div style="flex:0;min-width:auto"><label class="opt" style="margin:0;padding:6px 10px"><input type="checkbox" name="correct_${id}" value="1"${correct.has(id) ? " checked" : ""}> ${bi("correct", "صح")}</label></div>
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
    <div class="row">
      <div style="flex:0;min-width:160px"><label>Type</label><select name="type">${typeOpts}</select></div>
      <div style="flex:0;min-width:120px"><label>Points</label><input name="points" type="number" min="1" value="${q?.points ?? 1}"></div>
    </div>
    <label style="margin-top:14px">${bi("Options (leave a slot blank to omit; tick the correct one(s); ignored for short answers)", "الخيارات (سيب الخانة فاضية للتجاهل؛ علّم الصح؛ بتتجاهل في المقالي)")}</label>
    ${optionRows}
    <div class="pairgrid" style="margin-top:14px">
      <div><label>Explanation / "Why" (EN)</label><textarea name="explanation_en" style="min-height:60px">${val(q?.explanation_en)}</textarea></div>
      <div><label>الشرح (AR)</label><textarea name="explanation_ar" dir="rtl" style="min-height:60px">${val(q?.explanation_ar)}</textarea></div>
    </div>
    <div class="pairgrid">
      <div><label>Rubric — short answers (EN)</label><textarea name="rubric_en" style="min-height:60px">${val(q?.rubric_en)}</textarea></div>
      <div><label>معايير التصحيح (AR)</label><textarea name="rubric_ar" dir="rtl" style="min-height:60px">${val(q?.rubric_ar)}</textarea></div>
    </div>
    <button type="submit" style="margin-top:14px">${q ? bi("Save changes", "حفظ التعديلات") : bi("Add question", "إضافة السؤال")}</button>
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
            <td><a class="btn secondary sm" href="/admin/quizzes/${quiz.id}/grade/${r.attemptId}">${status === "graded" ? bi("Re-grade", "إعادة تصحيح") : bi("Grade", "صحّح")}</a></td></tr>`,
			)
			.join("");

	const submitted = rowsFor("submitted");
	const graded = rowsFor("graded");

	const body = `<h1>${bi(quiz.title_en, quiz.title_ar)} — ${bi("Grade short answers", "تصحيح المقالي")}</h1>
    ${flash(c)}
    <p class="muted"><a href="/admin/quizzes">← ${bi("All quizzes", "كل الاختبارات")}</a></p>
    <div class="qcard"><h2 style="margin-top:0">${bi("Awaiting grading", "في انتظار التصحيح")}</h2>
      <div class="tablewrap"><table><thead><tr><th>Email</th><th>Mailbox</th><th>MCQ</th><th></th></tr></thead>
      <tbody>${submitted || `<tr><td colspan="4">${bi("None.", "لا يوجد.")}</td></tr>`}</tbody></table></div></div>
    <div class="qcard"><h2 style="margin-top:0">${bi("Already graded", "اتصحّح")}</h2>
      <div class="tablewrap"><table><thead><tr><th>Email</th><th>Mailbox</th><th>MCQ</th><th></th></tr></thead>
      <tbody>${graded || `<tr><td colspan="4">${bi("None.", "لا يوجد.")}</td></tr>`}</tbody></table></div></div>`;
	return c.html(quizShell("Grade", body));
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
        <div class="qtitle">${bi(q.title_en, q.title_ar)} · ${q.points} ${bi("pts", "نقاط")}</div>
        <div class="qprompt">${bi(q.prompt_en, q.prompt_ar)}</div>
        <div class="qtitle">${bi("Rubric", "معايير التصحيح")}</div>${biBlock(q.rubric_en, q.rubric_ar, "muted")}
        <div class="qtitle" style="margin-top:10px">${bi("Rep's answer", "إجابة المندوب")}</div>
        <div class="preview" style="white-space:pre-wrap">${escapeHtml(a?.text_answer ?? "") || `<span class="muted">${bi("(blank)", "(فاضي)")}</span>`}</div>
        <div class="row" style="margin-top:12px;gap:12px">
          <div style="flex:0;min-width:140px"><label>${bi("Award", "الدرجة")} (0–${q.points})</label>
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
			return `<tr><td>#${q.position}</td><td>${escapeHtml(sel) || "—"}</td><td>${escapeHtml(correct)}</td><td>${ok ? "✓" : "✗"}</td></tr>`;
		})
		.join("");

	const body = `<h1>${bi("Grade attempt", "تصحيح المحاولة")}</h1>
    ${flash(c)}
    <p class="muted"><a href="/admin/quizzes/${quiz.id}/grade">← ${bi("Back to grading", "ارجع للتصحيح")}</a> · MCQ ${attempt.mcq_score ?? 0} / ${attempt.mcq_max ?? 0} · ${escapeHtml(attempt.status)}</p>
    <form id="quizform" method="post" action="/admin/quizzes/${quiz.id}/grade/${attempt.id}">
      ${shortBlocks || `<div class="qcard">${bi("This quiz has no short answers.", "الاختبار ده مفيهوش أسئلة مقالية.")}</div>`}
      <div class="qcard" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="muted">${bi("Finalize sets the total and marks the attempt graded.", "الإنهاء بيحسب الإجمالي ويعتبر المحاولة متصحّحة.")}</span>
        <button type="submit">${bi("Finalize grade", "إنهاء التصحيح")}</button>
      </div>
    </form>
    <div class="qcard"><h2 style="margin-top:0">${bi("Multiple-choice (read-only)", "الاختيارات (للعرض فقط)")}</h2>
      <div class="tablewrap"><table><thead><tr><th>#</th><th>${bi("Chose", "اختار")}</th><th>${bi("Correct", "الصح")}</th><th></th></tr></thead>
      <tbody>${mcqRows}</tbody></table></div></div>`;
	return c.html(quizShell("Grade attempt", body));
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
          <td>${r.totalScore ?? "—"} / ${r.totalMax ?? 0}</td>
          <td>${statusBadge(r.status)}</td>
        </tr>`,
		)
		.join("");

	const body = `<h1>${bi(quiz.title_en, quiz.title_ar)} — ${bi("Results", "النتائج")}</h1>
    ${flash(c)}
    <p class="muted"><a href="/admin/quizzes">← ${bi("All quizzes", "كل الاختبارات")}</a> · ${results.length} ${bi("reps", "مندوب")}</p>
    <div class="qcard"><div class="tablewrap"><table>
      <thead><tr><th>Email</th><th>Mailbox</th><th>MCQ</th><th>${bi("Short", "مقالي")}</th><th>${bi("Total", "الإجمالي")}</th><th>${bi("Status", "الحالة")}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">${bi("No attempts yet.", "مفيش محاولات لسه.")}</td></tr>`}</tbody>
    </table></div></div>`;
	return c.html(quizShell("Results", body));
});

export { adminQuizApp };
