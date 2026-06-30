// Pure-grading tests. No framework (no new deps): run with
//   node --experimental-strip-types workers/quiz/grading.test.ts
// Exits non-zero on the first failed assertion.

import assert from "node:assert/strict";
import {
	gradeMcqAnswer,
	gradeSubmission,
	clampAward,
	scoreFromAwards,
	type GradableQuestion,
	type ScoreQuestion,
} from "./grading.ts";

const single: GradableQuestion = { id: "q1", type: "single", points: 1, correct: ["b"] };
const multi: GradableQuestion = { id: "q2", type: "multi", points: 1, correct: ["a", "c", "e"] };
const short: GradableQuestion = { id: "q3", type: "short", points: 3, correct: null };

// ── single-select ──
assert.deepEqual(gradeMcqAnswer(single, ["b"]), { awarded: 1, isCorrect: true }, "single exact match");
assert.deepEqual(gradeMcqAnswer(single, ["a"]), { awarded: 0, isCorrect: false }, "single wrong");
assert.deepEqual(gradeMcqAnswer(single, []), { awarded: 0, isCorrect: false }, "single blank");
assert.deepEqual(gradeMcqAnswer(single, ["a", "b"]), { awarded: 0, isCorrect: false }, "single extra pick");

// ── multi-select: points ONLY on exact set match ──
assert.deepEqual(gradeMcqAnswer(multi, ["a", "c", "e"]), { awarded: 1, isCorrect: true }, "multi exact");
assert.deepEqual(gradeMcqAnswer(multi, ["e", "a", "c"]), { awarded: 1, isCorrect: true }, "multi order-insensitive");
assert.deepEqual(gradeMcqAnswer(multi, ["a", "c"]), { awarded: 0, isCorrect: false }, "multi partial → 0");
assert.deepEqual(gradeMcqAnswer(multi, ["a", "c", "e", "d"]), { awarded: 0, isCorrect: false }, "multi superset → 0");
assert.deepEqual(gradeMcqAnswer(multi, ["a", "a", "c", "e"]), { awarded: 1, isCorrect: true }, "multi dup-insensitive");

// ── short answers are never auto-graded ──
const g = gradeSubmission([single, multi, short], { q1: ["b"], q2: ["a"], q3: [] });
const shortRow = g.answers.find((a) => a.questionId === "q3")!;
assert.equal(shortRow.awarded, null, "short awarded is null");
assert.equal(shortRow.isCorrect, null, "short isCorrect is null");

// ── aggregate maxes computed from the quiz, not hardcoded ──
assert.equal(g.mcqScore, 1, "mcqScore = single correct only");
assert.equal(g.mcqMax, 2, "mcqMax = 1 + 1");
assert.equal(g.shortMax, 3, "shortMax = 3");
assert.equal(g.totalMax, 5, "totalMax = mcqMax + shortMax");

// ── a full 25×1 + 5×3 quiz totals 40 / 25 / 15 (today's locked shape) ──
const full: GradableQuestion[] = [
	...Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, type: "single" as const, points: 1, correct: ["b"] })),
	...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, type: "short" as const, points: 3, correct: null })),
];
const gf = gradeSubmission(full, {});
assert.equal(gf.mcqMax, 25, "full mcqMax");
assert.equal(gf.shortMax, 15, "full shortMax");
assert.equal(gf.totalMax, 40, "full totalMax");
assert.equal(gf.mcqScore, 0, "no answers → 0 mcqScore");

// ── clampAward: admin overrides snap to [0, max] in 0.5 steps ──
assert.equal(clampAward(0.5, 1), 0.5, "half point allowed");
assert.equal(clampAward(1, 1), 1, "full point allowed");
assert.equal(clampAward(2, 1), 1, "above max clamps to max");
assert.equal(clampAward(-1, 3), 0, "below zero clamps to 0");
assert.equal(clampAward(0.7, 3), 0.5, "snaps to nearest 0.5 (down)");
assert.equal(clampAward(0.8, 3), 1, "snaps to nearest 0.5 (up)");
assert.equal(clampAward(Number.NaN, 3), 0, "NaN → 0");

// ── scoreFromAwards: MCQ overrides + partial credit flow into the total ──
const sq: ScoreQuestion[] = [
	{ id: "m1", type: "single", points: 1 }, // accepted-anyway: was wrong, awarded 1
	{ id: "m2", type: "multi", points: 1 }, // partial credit: 0.5
	{ id: "s1", type: "short", points: 3 }, // graded 2
	{ id: "s2", type: "short", points: 3 }, // still ungraded
];
const partial = scoreFromAwards(sq, { m1: 1, m2: 0.5, s1: 2, s2: null });
assert.equal(partial.mcqScore, 1.5, "mcqScore = 1 + 0.5 (override + partial)");
assert.equal(partial.mcqMax, 2, "mcqMax = 1 + 1");
assert.equal(partial.shortScore, 2, "shortScore counts only graded short");
assert.equal(partial.shortMax, 6, "shortMax = 3 + 3");
assert.equal(partial.totalScore, 3.5, "totalScore = mcq + short");
assert.equal(partial.allShortGraded, false, "one short ungraded ⇒ not fully graded");

const done = scoreFromAwards(sq, { m1: 0, m2: 1, s1: 3, s2: 1.5 });
assert.equal(done.totalScore, 5.5, "fully graded total = 0 + 1 + 3 + 1.5");
assert.equal(done.allShortGraded, true, "all short graded");

console.log("grading.test.ts: all assertions passed");
