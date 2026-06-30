// Drizzle schema for the sales quiz tables (D1, binding `DB`). The matching DDL —
// including the UNIQUE constraints and the position index — lives in
// migrations/0002_create_quizzes.sql (applied with `wrangler d1 migrations apply`).
// This file is only the query/type layer, so it declares columns, not constraints.

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const QUIZ_STATUSES = ["draft", "open", "closed"] as const;
export type QuizStatus = (typeof QUIZ_STATUSES)[number];

export const QUESTION_TYPES = ["single", "multi", "short"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const ATTEMPT_STATUSES = ["in_progress", "submitted", "graded"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const quizzes = sqliteTable("quizzes", {
	id: text("id").primaryKey(), // quiz_<uuid>
	key: text("key").notNull().unique(),
	title_en: text("title_en").notNull(),
	title_ar: text("title_ar").notNull(),
	description_en: text("description_en").notNull().default(""),
	description_ar: text("description_ar").notNull().default(""),
	status: text("status", { enum: QUIZ_STATUSES }).notNull().default("draft"),
	created_at: integer("created_at").notNull(),
	updated_at: integer("updated_at").notNull(),
});

export const quizQuestions = sqliteTable("quiz_questions", {
	id: text("id").primaryKey(), // qq_<uuid>
	quiz_id: text("quiz_id").notNull(),
	position: integer("position").notNull(),
	type: text("type", { enum: QUESTION_TYPES }).notNull(),
	points: integer("points").notNull(),
	title_en: text("title_en").notNull().default(""),
	title_ar: text("title_ar").notNull().default(""),
	prompt_en: text("prompt_en").notNull(),
	prompt_ar: text("prompt_ar").notNull(),
	options_json: text("options_json"), // JSON [{id,en,ar}]; null for short
	correct_json: text("correct_json"), // JSON ["b"]; null for short
	explanation_en: text("explanation_en").notNull().default(""),
	explanation_ar: text("explanation_ar").notNull().default(""),
	rubric_en: text("rubric_en").notNull().default(""),
	rubric_ar: text("rubric_ar").notNull().default(""),
	created_at: integer("created_at").notNull(),
	updated_at: integer("updated_at").notNull(),
});

export const quizAttempts = sqliteTable("quiz_attempts", {
	id: text("id").primaryKey(), // att_<uuid>
	quiz_id: text("quiz_id").notNull(),
	user_id: text("user_id").notNull(),
	status: text("status", { enum: ATTEMPT_STATUSES }).notNull().default("in_progress"),
	started_at: integer("started_at"),
	submitted_at: integer("submitted_at"),
	mcq_score: integer("mcq_score"),
	mcq_max: integer("mcq_max"),
	short_score: integer("short_score"),
	short_max: integer("short_max"),
	total_score: integer("total_score"),
	total_max: integer("total_max"),
	created_at: integer("created_at").notNull(),
	updated_at: integer("updated_at").notNull(),
});

// ponytail: the award/score columns are declared INTEGER but hold fractional values
// (0.5 partial credit). SQLite's INTEGER *affinity* stores a non-integer REAL
// losslessly, and Drizzle's integer() column passes numbers through unchanged (no
// Math.round on read or write — verified in drizzle-orm/sqlite-core), so 0.5
// round-trips through D1 without a column-type migration. Clamping/snapping to 0.5
// steps is enforced in code (grading.clampAward), not by the DB.
export const quizAnswers = sqliteTable("quiz_answers", {
	id: text("id").primaryKey(), // ans_<uuid>
	attempt_id: text("attempt_id").notNull(),
	question_id: text("question_id").notNull(),
	selected_json: text("selected_json"), // JSON array of chosen option ids (MCQ)
	text_answer: text("text_answer"), // free text (short)
	awarded_points: integer("awarded_points"), // MCQ auto; admin-overridable; may be fractional
	is_correct: integer("is_correct"), // 0/1 (MCQ convenience)
	grader_note: text("grader_note"),
	created_at: integer("created_at").notNull(),
	updated_at: integer("updated_at").notNull(),
});

export type QuizRow = typeof quizzes.$inferSelect;
export type QuizQuestionRow = typeof quizQuestions.$inferSelect;
export type QuizAttemptRow = typeof quizAttempts.$inferSelect;
export type QuizAnswerRow = typeof quizAnswers.$inferSelect;
