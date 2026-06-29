// Rep-facing quiz routes, mounted at /quizzes in app.ts AFTER the auth gate (so a
// logged-out request is already bounced to /login) and BEFORE the React catch-all.
// Any logged-in role may take an open quiz. The take page never contains the answer
// key or explanations — grading happens server-side in POST /submit (design §5).

import { Hono, type Context } from "hono";
import type { SessionClaims } from "../lib/auth";
import { escapeHtml } from "../lib/email-helpers";
import type { Env } from "../types";
import type { QuizAnswerRow, QuizQuestionRow, QuizRow } from "../db/quiz-schema";
import {
	bi,
	biBlock,
	quizShell,
	TIMER_SCRIPT,
	BLANK_NUDGE_SCRIPT,
} from "./render";
import {
	getAttempt,
	getAnswers,
	getQuizById,
	listOpenQuizzes,
	listQuestions,
	parseOptions,
	parseCorrect,
	parseSelected,
	submitAttempt,
} from "./queries";

type QuizEnv = { Bindings: Env; Variables: { session?: SessionClaims } };

const quizApp = new Hono<QuizEnv>();

function notAvailable(c: Context<QuizEnv>, quiz?: QuizRow) {
	const t = quiz
		? bi(quiz.title_en, quiz.title_ar)
		: bi("This quiz", "هذا الاختبار");
	return c.html(
		quizShell(
			"Not available",
			`<div class="qcard"><h1>${bi("Not available", "غير متاح")}</h1>
       <p>${t} ${bi("is not open right now.", "مش مفتوح دلوقتي.")}</p>
       <a class="btn secondary" href="/quizzes">${bi("Back to quizzes", "ارجع للاختبارات")}</a></div>`,
			{ backHref: "/quizzes" },
		),
		200,
	);
}

// ── GET /quizzes — open quizzes + this rep's status ─────────────────
quizApp.get("/", async (c) => {
	const session = c.get("session")!;
	const quizzes = await listOpenQuizzes(c.env);

	const cards = await Promise.all(
		quizzes.map(async (q) => {
			const attempt = await getAttempt(c.env, q.id, session.sub);
			const status = attempt?.status; // undefined | submitted | graded
			const statusLabel = !status
				? bi("Not started", "لسه مبدأتش")
				: status === "graded"
					? bi("Graded", "اتصحّح")
					: bi("Submitted", "اتسلّم");
			const action = !status
				? `<a class="btn" href="/quizzes/${q.id}/take">${bi("Take quiz", "ابدأ الاختبار")}</a>`
				: `<a class="btn secondary" href="/quizzes/${q.id}/result">${bi("Review", "مراجعة")}</a>`;
			return `<div class="qcard">
        <div class="qtitle">${statusLabel}</div>
        <h2 style="margin:.1em 0 .3em">${bi(q.title_en, q.title_ar)}</h2>
        ${biBlock(q.description_en, q.description_ar, "muted")}
        <div style="margin-top:14px">${action}</div>
      </div>`;
		}),
	);

	const body = `<h1>${bi("Quizzes", "الاختبارات")}</h1>
    ${cards.join("") || `<div class="qcard">${bi("No open quizzes right now.", "مفيش اختبارات مفتوحة دلوقتي.")}</div>`}`;
	return c.html(quizShell("Quizzes", body));
});

// ── GET /quizzes/:quizId/take — the quiz (NO answer key in payload) ──
quizApp.get("/:quizId/take", async (c) => {
	const session = c.get("session")!;
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return notAvailable(c);
	if (quiz.status !== "open") return notAvailable(c, quiz);

	const existing = await getAttempt(c.env, quiz.id, session.sub);
	if (existing) return c.redirect(`/quizzes/${quiz.id}/result`, 302);

	const questions = await listQuestions(c.env, quiz.id);
	const total = questions.length;
	const cards = questions.map((q, i) => renderTakeQuestion(q, i + 1, total)).join("");

	const body = `<h1>${bi(quiz.title_en, quiz.title_ar)}</h1>
    ${biBlock(quiz.description_en, quiz.description_ar, "muted")}
    <p class="qhint">${bi("One attempt. Multiple-choice is auto-graded; short answers are graded by the admin.", "محاولة واحدة. الاختيارات بتتصحّح تلقائيًا؛ والأسئلة المقالية بيصحّحها الأدمن.")}</p>
    <form id="quizform" method="post" action="/quizzes/${quiz.id}/submit">
      ${cards}
      <div class="qcard" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="muted">${bi("Make sure you answered everything before submitting.", "اتأكد إنك جاوبت على كل حاجة قبل ما تسلّم.")}</span>
        <button type="submit">${bi("Submit quiz", "سلّم الاختبار")}</button>
      </div>
    </form>`;

	const headerExtra = `<span class="muted">${bi("Elapsed", "الوقت")}: <span id="elapsed" class="timer">0:00</span></span>`;
	return c.html(
		quizShell(quiz.title_en, body, {
			headerExtra,
			backHref: "/quizzes",
			scripts: [TIMER_SCRIPT, BLANK_NUDGE_SCRIPT],
		}),
	);
});

/** A single question on the take page. Renders both languages; NEVER the answer key. */
function renderTakeQuestion(q: QuizQuestionRow, n: number, total: number): string {
	const head = `<div class="qnum">${bi(`Question ${n} of ${total}`, `سؤال ${n} من ${total}`)}</div>
    ${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt">${bi(q.prompt_en, q.prompt_ar)}</div>`;

	let inputs = "";
	if (q.type === "short") {
		inputs = `<textarea name="q_${q.id}" placeholder=""></textarea>`;
	} else {
		const inputType = q.type === "multi" ? "checkbox" : "radio";
		const hint =
			q.type === "multi"
				? `<div class="qhint">${bi("Select all that apply.", "اختر كل ما ينطبق.")}</div>`
				: `<div class="qhint">${bi("Select one.", "اختر واحدة.")}</div>`;
		const opts = parseOptions(q)
			.map(
				(o) =>
					`<label class="opt"><input type="${inputType}" name="q_${q.id}" value="${escapeHtml(o.id)}">
            <span class="otext">${bi(o.en, o.ar)}</span></label>`,
			)
			.join("");
		inputs = `${hint}${opts}`;
	}

	return `<div class="qcard" data-qgroup>${head}${inputs}</div>`;
}

// ── POST /quizzes/:quizId/submit — single attempt, auto-grade MCQ ────
quizApp.post("/:quizId/submit", async (c) => {
	const session = c.get("session")!;
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return notAvailable(c);

	const existing = await getAttempt(c.env, quiz.id, session.sub);
	if (existing) return c.redirect(`/quizzes/${quiz.id}/result`, 302);
	if (quiz.status !== "open") return notAvailable(c, quiz);

	const questions = await listQuestions(c.env, quiz.id);
	const form = await c.req.parseBody({ all: true });

	const selectedByQuestion: Record<string, string[]> = {};
	const textByQuestion: Record<string, string> = {};
	for (const q of questions) {
		const raw = form[`q_${q.id}`];
		if (q.type === "short") {
			textByQuestion[q.id] = typeof raw === "string" ? raw : "";
		} else {
			const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
			selectedByQuestion[q.id] = values.filter((v): v is string => typeof v === "string");
		}
	}

	const result = await submitAttempt(c.env, quiz, session.sub, selectedByQuestion, textByQuestion);
	if (!result.ok) return c.redirect(`/quizzes/${quiz.id}/result`, 302);
	return c.redirect(`/quizzes/${quiz.id}/result`, 302);
});

// ── GET /quizzes/:quizId/result — score + per-question review ────────
quizApp.get("/:quizId/result", async (c) => {
	const session = c.get("session")!;
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return notAvailable(c);

	const attempt = await getAttempt(c.env, quiz.id, session.sub);
	if (!attempt) return c.redirect(`/quizzes/${quiz.id}/take`, 302);

	const questions = await listQuestions(c.env, quiz.id);
	const answers = await getAnswers(c.env, attempt.id);
	const ansByQ = new Map(answers.map((a) => [a.question_id, a]));

	const graded = attempt.status === "graded";
	const rows = questions.map((q) => renderReviewRow(q, ansByQ.get(q.id))).join("");

	const totalLine = graded
		? `<div>${bi("Final total", "الإجمالي النهائي")}: <span class="scorebig">${attempt.total_score ?? 0} / ${attempt.total_max ?? 0}</span></div>`
		: `<div class="muted">${bi("Short answers are awaiting admin grading; your final total appears once graded.", "الأسئلة المقالية لسه بتتصحّح من الأدمن؛ إجماليك النهائي هيظهر بعد التصحيح.")}</div>`;

	const body = `<h1>${bi(quiz.title_en, quiz.title_ar)} — ${bi("Results", "النتيجة")}</h1>
    <div class="qcard">
      <div>${bi("Multiple-choice score", "درجة الاختيارات")}: <span class="scorebig">${attempt.mcq_score ?? 0} / ${attempt.mcq_max ?? 0}</span></div>
      <div style="margin-top:8px">${totalLine}</div>
    </div>
    ${rows}
    <div style="margin-top:16px"><a class="btn secondary" href="/quizzes">${bi("Back to quizzes", "ارجع للاختبارات")}</a></div>`;

	return c.html(quizShell(quiz.title_en, body, { backHref: "/quizzes" }));
});

/** A review row: the rep's answer + the correct answer + the "Why" (MCQ), or their
 * short text and (once graded) the awarded 0–3 + admin note. Correct answers ARE
 * shown here — that's the intended post-submission behaviour. */
function renderReviewRow(q: QuizQuestionRow, ans: QuizAnswerRow | undefined): string {
	const head = `${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt">${bi(q.prompt_en, q.prompt_ar)}</div>`;

	if (q.type === "short") {
		const text = ans?.text_answer ?? "";
		const awarded = ans?.awarded_points;
		const note = ans?.grader_note;
		const mark =
			awarded === null || awarded === undefined
				? `<span class="tag">${bi("Awaiting grading", "في انتظار التصحيح")}</span>`
				: `<span class="tag ok">${awarded} / ${q.points}</span>`;
		return `<div class="review-row">${head}
      <div class="qtitle">${bi("Your answer", "إجابتك")} ${mark}</div>
      <div class="preview" style="margin-top:6px;white-space:pre-wrap">${escapeHtml(text) || `<span class="muted">${bi("(blank)", "(فاضي)")}</span>`}</div>
      ${note ? `<div class="why"><b>${bi("Note", "ملاحظة")}:</b> ${escapeHtml(note)}</div>` : ""}
    </div>`;
	}

	const options = parseOptions(q);
	const label = (id: string) => {
		const o = options.find((x) => x.id === id);
		return o ? bi(o.en, o.ar) : escapeHtml(id);
	};
	const selected = ans ? parseSelected(ans) : [];
	const correct = parseCorrect(q);
	const isCorrect = ans?.is_correct === 1;

	const yours = selected.length
		? selected.map(label).join(`<span class="muted">، </span>`)
		: `<span class="muted">${bi("(blank)", "(فاضي)")}</span>`;
	const right = correct.map(label).join(`<span class="muted">، </span>`);

	return `<div class="review-row ${isCorrect ? "correct" : "wrong"}">${head}
    <div class="qtitle">${bi("Your answer", "إجابتك")} ${isCorrect ? `<span class="tag ok">${bi("Correct", "صح")}</span>` : `<span class="tag no">${bi("Incorrect", "غلط")}</span>`}</div>
    <div style="margin:4px 0 8px">${yours}</div>
    <div class="qtitle">${bi("Correct answer", "الإجابة الصحيحة")}</div>
    <div style="margin:4px 0">${right}</div>
    ${q.explanation_en || q.explanation_ar ? `<div class="why"><b>${bi("Why", "ليه")}:</b> ${bi(q.explanation_en, q.explanation_ar)}</div>` : ""}
  </div>`;
}

export { quizApp };
