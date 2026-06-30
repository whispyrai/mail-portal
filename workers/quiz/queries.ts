// D1 access for the quiz tables (binding `DB`), mirroring the Drizzle pattern in
// lib/users.ts. Pure data layer: it throws on DB failure; route handlers translate
// failures into responses. Grading is delegated to the pure `grading.ts`.

import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import * as quizSchema from "../db/quiz-schema";
import { users } from "../db/users-schema";
import type {
	QuizRow,
	QuizQuestionRow,
	QuizAttemptRow,
	QuizAnswerRow,
	QuizStatus,
	QuestionType,
} from "../db/quiz-schema";
import type { Env } from "../types";
import { SEED_QUIZZES, type SeedOption } from "./seed";
import {
	gradeSubmission,
	clampAward,
	scoreFromAwards,
	type GradableQuestion,
} from "./grading";

const { quizzes, quizQuestions, quizAttempts, quizAnswers } = quizSchema;

function db(env: Env) {
	return drizzle(env.DB, { schema: quizSchema });
}

// ── JSON column helpers ────────────────────────────────────────────

export function parseOptions(row: QuizQuestionRow): SeedOption[] {
	if (!row.options_json) return [];
	try {
		const v = JSON.parse(row.options_json);
		return Array.isArray(v) ? (v as SeedOption[]) : [];
	} catch {
		return [];
	}
}

export function parseCorrect(row: QuizQuestionRow): string[] {
	if (!row.correct_json) return [];
	try {
		const v = JSON.parse(row.correct_json);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

/** Parse a JSON string-array column ('["a","c"]') into ids; [] on null/garbage. */
function jsonIds(json: string | null): string[] {
	if (!json) return [];
	try {
		const v = JSON.parse(json);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

export function parseSelected(row: QuizAnswerRow): string[] {
	return jsonIds(row.selected_json);
}

function gradable(q: QuizQuestionRow): GradableQuestion {
	return {
		id: q.id,
		type: q.type,
		points: q.points,
		correct: q.type === "short" ? null : parseCorrect(q),
	};
}

// ── Quizzes ────────────────────────────────────────────────────────

export async function listQuizzes(env: Env): Promise<QuizRow[]> {
	return db(env).select().from(quizzes).orderBy(asc(quizzes.key)).all();
}

export async function listOpenQuizzes(env: Env): Promise<QuizRow[]> {
	return db(env)
		.select()
		.from(quizzes)
		.where(eq(quizzes.status, "open"))
		.orderBy(asc(quizzes.key))
		.all();
}

export async function getQuizById(env: Env, id: string): Promise<QuizRow | undefined> {
	return db(env).select().from(quizzes).where(eq(quizzes.id, id)).get();
}

export async function getQuizByKey(env: Env, key: string): Promise<QuizRow | undefined> {
	return db(env).select().from(quizzes).where(eq(quizzes.key, key)).get();
}

export async function setQuizStatus(env: Env, id: string, status: QuizStatus): Promise<void> {
	await db(env)
		.update(quizzes)
		.set({ status, updated_at: Date.now() })
		.where(eq(quizzes.id, id))
		.run();
}

// ── Questions ──────────────────────────────────────────────────────

export async function listQuestions(env: Env, quizId: string): Promise<QuizQuestionRow[]> {
	return db(env)
		.select()
		.from(quizQuestions)
		.where(eq(quizQuestions.quiz_id, quizId))
		.orderBy(asc(quizQuestions.position))
		.all();
}

export async function getQuestion(env: Env, id: string): Promise<QuizQuestionRow | undefined> {
	return db(env).select().from(quizQuestions).where(eq(quizQuestions.id, id)).get();
}

export interface QuestionInput {
	type: QuestionType;
	points: number;
	title_en: string;
	title_ar: string;
	prompt_en: string;
	prompt_ar: string;
	options: SeedOption[] | null;
	correct: string[] | null;
	explanation_en: string;
	explanation_ar: string;
	rubric_en: string;
	rubric_ar: string;
}

function questionColumns(input: QuestionInput) {
	const isShort = input.type === "short";
	return {
		type: input.type,
		points: input.points,
		title_en: input.title_en,
		title_ar: input.title_ar,
		prompt_en: input.prompt_en,
		prompt_ar: input.prompt_ar,
		options_json: isShort || !input.options ? null : JSON.stringify(input.options),
		correct_json: isShort || !input.correct ? null : JSON.stringify(input.correct),
		explanation_en: input.explanation_en,
		explanation_ar: input.explanation_ar,
		rubric_en: input.rubric_en,
		rubric_ar: input.rubric_ar,
	};
}

export async function createQuestion(env: Env, quizId: string, input: QuestionInput): Promise<string> {
	// Append to the end of the quiz.
	const existing = await listQuestions(env, quizId);
	const position = existing.length ? existing[existing.length - 1].position + 1 : 1;
	const now = Date.now();
	const id = `qq_${crypto.randomUUID()}`;
	await db(env)
		.insert(quizQuestions)
		.values({
			id,
			quiz_id: quizId,
			position,
			...questionColumns(input),
			created_at: now,
			updated_at: now,
		})
		.run();
	return id;
}

export async function updateQuestion(env: Env, id: string, input: QuestionInput): Promise<void> {
	await db(env)
		.update(quizQuestions)
		.set({ ...questionColumns(input), updated_at: Date.now() })
		.where(eq(quizQuestions.id, id))
		.run();
}

export async function deleteQuestion(env: Env, id: string): Promise<void> {
	await db(env).delete(quizQuestions).where(eq(quizQuestions.id, id)).run();
}

/** Swap a question's position with its neighbour in the given direction. */
export async function moveQuestion(env: Env, quizId: string, id: string, dir: "up" | "down"): Promise<void> {
	const all = await listQuestions(env, quizId);
	const i = all.findIndex((q) => q.id === id);
	if (i < 0) return;
	const j = dir === "up" ? i - 1 : i + 1;
	if (j < 0 || j >= all.length) return;
	const a = all[i];
	const b = all[j];
	const now = Date.now();
	await db(env).update(quizQuestions).set({ position: b.position, updated_at: now }).where(eq(quizQuestions.id, a.id)).run();
	await db(env).update(quizQuestions).set({ position: a.position, updated_at: now }).where(eq(quizQuestions.id, b.id)).run();
}

// ── Attempts (rep side) ────────────────────────────────────────────

export async function getAttempt(env: Env, quizId: string, userId: string): Promise<QuizAttemptRow | undefined> {
	return db(env)
		.select()
		.from(quizAttempts)
		.where(and(eq(quizAttempts.quiz_id, quizId), eq(quizAttempts.user_id, userId)))
		.get();
}

export async function getAttemptById(env: Env, id: string): Promise<QuizAttemptRow | undefined> {
	return db(env).select().from(quizAttempts).where(eq(quizAttempts.id, id)).get();
}

export async function getAnswers(env: Env, attemptId: string): Promise<QuizAnswerRow[]> {
	return db(env).select().from(quizAnswers).where(eq(quizAnswers.attempt_id, attemptId)).all();
}

export async function getAnswerById(env: Env, id: string): Promise<QuizAnswerRow | undefined> {
	return db(env).select().from(quizAnswers).where(eq(quizAnswers.id, id)).get();
}

export type SubmitResult =
	| { ok: true; attemptId: string }
	| { ok: false; reason: "already_submitted" };

/**
 * Create the single attempt for (quiz, user), auto-grade the MCQ, and store every
 * answer. The DB-level UNIQUE(quiz_id,user_id) is the real single-attempt backstop;
 * a pre-check + catch turns a duplicate into a graceful "already submitted".
 * ponytail: last-writer race between two simultaneous submits is acceptable for ~5
 * honor-system internal users; the UNIQUE constraint still prevents a second row.
 */
export async function submitAttempt(
	env: Env,
	quiz: QuizRow,
	userId: string,
	selectedByQuestion: Record<string, string[]>,
	textByQuestion: Record<string, string>,
): Promise<SubmitResult> {
	if (await getAttempt(env, quiz.id, userId)) return { ok: false, reason: "already_submitted" };

	const questions = await listQuestions(env, quiz.id);
	const grade = gradeSubmission(questions.map(gradable), selectedByQuestion);
	const now = Date.now();
	const attemptId = `att_${crypto.randomUUID()}`;

	try {
		await db(env)
			.insert(quizAttempts)
			.values({
				id: attemptId,
				quiz_id: quiz.id,
				user_id: userId,
				status: "submitted",
				started_at: now,
				submitted_at: now,
				mcq_score: grade.mcqScore,
				mcq_max: grade.mcqMax,
				short_max: grade.shortMax,
				total_max: grade.totalMax,
				created_at: now,
				updated_at: now,
			})
			.run();
	} catch (e) {
		if (String((e as Error)?.message || "").includes("UNIQUE")) {
			return { ok: false, reason: "already_submitted" };
		}
		throw e;
	}

	const byQuestion = new Map(grade.answers.map((a) => [a.questionId, a]));
	const rows = questions.map((q) => {
		const graded = byQuestion.get(q.id);
		const isShort = q.type === "short";
		return {
			id: `ans_${crypto.randomUUID()}`,
			attempt_id: attemptId,
			question_id: q.id,
			selected_json: isShort ? null : JSON.stringify(selectedByQuestion[q.id] ?? []),
			text_answer: isShort ? (textByQuestion[q.id] ?? "").trim() || null : null,
			awarded_points: graded?.awarded ?? null,
			is_correct: graded?.isCorrect ?? null,
			grader_note: null,
			created_at: now,
			updated_at: now,
		};
	});
	// D1 caps bound variables per statement (~100); 11 cols/row → ≤8 rows per insert.
	for (let i = 0; i < rows.length; i += 8) {
		await db(env).insert(quizAnswers).values(rows.slice(i, i + 8)).run();
	}

	return { ok: true, attemptId };
}

// ── Grading (admin side) ───────────────────────────────────────────

export async function listAttempts(env: Env, quizId: string): Promise<QuizAttemptRow[]> {
	return db(env).select().from(quizAttempts).where(eq(quizAttempts.quiz_id, quizId)).all();
}

export interface AttemptCounts {
	total: number;
	submitted: number;
	graded: number;
}

export async function attemptCounts(env: Env, quizId: string): Promise<AttemptCounts> {
	const rows = await listAttempts(env, quizId);
	return {
		total: rows.length,
		submitted: rows.filter((r) => r.status === "submitted").length,
		graded: rows.filter((r) => r.status === "graded").length,
	};
}

/**
 * Recompute an attempt's score columns + status from the *current* per-answer awards.
 * This is the single recompute path; every grading action (batch finalize, single
 * answer override via UI or MCP) ends here, so MCQ overrides and short marks always
 * agree with the stored totals. The attempt is 'graded' once every short answer has a
 * non-null award (MCQ are auto-awarded at submit). Maxes are re-summed from the
 * current questions so the math survives question edits.
 */
export async function recomputeAttempt(env: Env, attemptId: string): Promise<void> {
	const attempt = await getAttemptById(env, attemptId);
	if (!attempt) return;
	const questions = await listQuestions(env, attempt.quiz_id);
	const answers = await getAnswers(env, attemptId);
	const awardByQ: Record<string, number | null> = {};
	for (const a of answers) awardByQ[a.question_id] = a.awarded_points;

	const score = scoreFromAwards(
		questions.map((q) => ({ id: q.id, type: q.type, points: q.points })),
		awardByQ,
	);

	await db(env)
		.update(quizAttempts)
		.set({
			mcq_score: score.mcqScore,
			mcq_max: score.mcqMax,
			short_score: score.shortScore,
			short_max: score.shortMax,
			total_score: score.totalScore,
			total_max: score.totalMax,
			status: score.allShortGraded ? "graded" : "submitted",
			updated_at: Date.now(),
		})
		.where(eq(quizAttempts.id, attemptId))
		.run();
}

/**
 * Finalize grading for one attempt: write the award (clamped to each question's max)
 * + note for every question in `marks` — MCQ *and* short, so partial credit and
 * "accept anyway" overrides persist — then recompute the attempt. `marks` maps a
 * question id → { awarded, note }; a question absent from `marks` keeps its stored
 * award.
 */
export async function finalizeGrading(
	env: Env,
	attemptId: string,
	marks: Record<string, { awarded: number; note: string }>,
): Promise<void> {
	const attempt = await getAttemptById(env, attemptId);
	if (!attempt) return;
	const questions = await listQuestions(env, attempt.quiz_id);
	const byId = new Map(questions.map((q) => [q.id, q]));
	const now = Date.now();

	for (const [qid, mark] of Object.entries(marks)) {
		const q = byId.get(qid);
		if (!q) continue;
		await db(env)
			.update(quizAnswers)
			.set({
				awarded_points: clampAward(mark.awarded, q.points),
				grader_note: mark.note?.trim() || null,
				updated_at: now,
			})
			.where(and(eq(quizAnswers.attempt_id, attemptId), eq(quizAnswers.question_id, qid)))
			.run();
	}

	await recomputeAttempt(env, attemptId);
}

export type GradeAnswerResult =
	| { ok: false }
	| { ok: true; question: QuizQuestionRow; attempt: QuizAttemptRow };

/**
 * Grade ONE answer in isolation (the by-question screen and the MCP `quiz_grade_answer`
 * tool): clamp the award to the question's max, write it + the note, recompute the
 * owning attempt, and return the question + refreshed attempt for the redirect / tool
 * response. Returns { ok: false } if the answer or its question is gone.
 */
export async function gradeAnswer(
	env: Env,
	answerId: string,
	rawPoints: number,
	note: string,
): Promise<GradeAnswerResult> {
	const answer = await getAnswerById(env, answerId);
	if (!answer) return { ok: false };
	const question = await getQuestion(env, answer.question_id);
	if (!question) return { ok: false };

	await db(env)
		.update(quizAnswers)
		.set({
			awarded_points: clampAward(rawPoints, question.points),
			grader_note: note.trim() || null,
			updated_at: Date.now(),
		})
		.where(eq(quizAnswers.id, answerId))
		.run();

	await recomputeAttempt(env, answer.attempt_id);
	const attempt = await getAttemptById(env, answer.attempt_id);
	if (!attempt) return { ok: false };
	return { ok: true, question, attempt };
}

// ── Results table (admin) ──────────────────────────────────────────

export interface ResultRow {
	userId: string;
	email: string;
	mailbox: string;
	attemptId: string;
	status: string;
	mcqScore: number | null;
	mcqMax: number | null;
	shortScore: number | null;
	totalScore: number | null;
	totalMax: number | null;
}

export async function listResults(env: Env, quizId: string): Promise<ResultRow[]> {
	const rows = await db(env)
		.select({
			userId: users.id,
			email: users.email,
			mailbox: users.mailbox_address,
			attemptId: quizAttempts.id,
			status: quizAttempts.status,
			mcqScore: quizAttempts.mcq_score,
			mcqMax: quizAttempts.mcq_max,
			shortScore: quizAttempts.short_score,
			totalScore: quizAttempts.total_score,
			totalMax: quizAttempts.total_max,
		})
		.from(quizAttempts)
		.innerJoin(users, eq(quizAttempts.user_id, users.id))
		.where(eq(quizAttempts.quiz_id, quizId))
		.all();
	return rows.sort((a, b) => a.email.localeCompare(b.email));
}

// ── One question across all attempts (admin "by question" view + MCP) ──

export interface QuestionSubmissionRow {
	answerId: string;
	attemptId: string;
	userId: string;
	email: string;
	mailbox: string;
	selected: string[]; // chosen option ids (MCQ); [] for short
	textAnswer: string | null;
	awarded: number | null;
	isCorrect: number | null;
	note: string | null;
	status: string;
	display?: string; // resolved by the route (see getDisplayNames); name or email local part
}

/**
 * Resolve display names for a set of mailbox addresses from the R2 mailbox profiles
 * (`mailboxes/<addr>.json` → `fromName`, set at user creation — see lib/mailbox.ts).
 * Returns addr(lowercased) → name only for profiles that have a non-empty name; the
 * caller falls back to the email's local part. Distinct addrs are read once, in
 * parallel — a handful of cheap R2 gets per page for the ~5-rep team.
 */
export async function getDisplayNames(env: Env, addrs: string[]): Promise<Map<string, string>> {
	const distinct = [...new Set(addrs.map((a) => a.toLowerCase()))];
	const out = new Map<string, string>();
	await Promise.all(
		distinct.map(async (addr) => {
			try {
				const obj = await env.BUCKET.get(`mailboxes/${addr}.json`);
				if (!obj) return;
				const profile = (await obj.json()) as { fromName?: string };
				const name = profile.fromName?.trim();
				if (name) out.set(addr, name);
			} catch {
				// Unreadable/malformed profile → caller uses the email local part.
			}
		}),
	);
	return out;
}

/** Every rep's answer to one question, for grading the same question across the team
 * in a single screen. Sorted by email for a stable order. */
export async function listQuestionSubmissions(
	env: Env,
	questionId: string,
): Promise<QuestionSubmissionRow[]> {
	const rows = await db(env)
		.select({
			answerId: quizAnswers.id,
			attemptId: quizAttempts.id,
			userId: users.id,
			email: users.email,
			mailbox: users.mailbox_address,
			selected_json: quizAnswers.selected_json,
			text_answer: quizAnswers.text_answer,
			awarded: quizAnswers.awarded_points,
			isCorrect: quizAnswers.is_correct,
			note: quizAnswers.grader_note,
			status: quizAttempts.status,
		})
		.from(quizAnswers)
		.innerJoin(quizAttempts, eq(quizAnswers.attempt_id, quizAttempts.id))
		.innerJoin(users, eq(quizAttempts.user_id, users.id))
		.where(eq(quizAnswers.question_id, questionId))
		.all();

	return rows
		.map((r) => ({
			answerId: r.answerId,
			attemptId: r.attemptId,
			userId: r.userId,
			email: r.email,
			mailbox: r.mailbox,
			selected: jsonIds(r.selected_json),
			textAnswer: r.text_answer,
			awarded: r.awarded,
			isCorrect: r.isCorrect,
			note: r.note,
			status: r.status,
		}))
		.sort((a, b) => a.email.localeCompare(b.email));
}

// ── Seed ───────────────────────────────────────────────────────────

export interface SeedReport {
	created: string[];
	skipped: string[];
}

/**
 * Idempotently insert the two bundled quizzes + their questions. A quiz whose `key`
 * already exists is skipped; `force` deletes and re-seeds it (safe only before any
 * attempts exist — wipes questions, which would orphan attempt answers otherwise).
 */
export async function seedQuizzes(env: Env, force: boolean): Promise<SeedReport> {
	const report: SeedReport = { created: [], skipped: [] };

	for (const seed of SEED_QUIZZES) {
		const existing = await getQuizByKey(env, seed.key);
		if (existing && !force) {
			report.skipped.push(seed.key);
			continue;
		}

		const now = Date.now();
		if (existing && force) {
			// Explicit cascade — D1 does not enforce ON DELETE CASCADE by default.
			await db(env).delete(quizQuestions).where(eq(quizQuestions.quiz_id, existing.id)).run();
			await db(env).delete(quizzes).where(eq(quizzes.id, existing.id)).run();
		}

		const quizId = `quiz_${crypto.randomUUID()}`;
		await db(env)
			.insert(quizzes)
			.values({
				id: quizId,
				key: seed.key,
				title_en: seed.title.en,
				title_ar: seed.title.ar,
				description_en: seed.description.en,
				description_ar: seed.description.ar,
				status: "draft",
				created_at: now,
				updated_at: now,
			})
			.run();

		const questionRows = seed.questions.map((q) => ({
			id: `qq_${crypto.randomUUID()}`,
			quiz_id: quizId,
			position: q.position,
			type: q.type,
			points: q.points,
			title_en: q.title?.en ?? "",
			title_ar: q.title?.ar ?? "",
			prompt_en: q.prompt.en,
			prompt_ar: q.prompt.ar,
			options_json: q.options ? JSON.stringify(q.options) : null,
			correct_json: q.correct ? JSON.stringify(q.correct) : null,
			explanation_en: q.explanation?.en ?? "",
			explanation_ar: q.explanation?.ar ?? "",
			rubric_en: q.rubric?.en ?? "",
			rubric_ar: q.rubric?.ar ?? "",
			created_at: now,
			updated_at: now,
		}));
		// D1 caps bound variables per statement (~100); 17 cols/row → ≤5 rows per insert.
		for (let i = 0; i < questionRows.length; i += 5) {
			await db(env).insert(quizQuestions).values(questionRows.slice(i, i + 5)).run();
		}

		report.created.push(seed.key);
	}

	return report;
}
