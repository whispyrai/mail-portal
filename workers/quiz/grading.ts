// Pure, server-side grading for quiz attempts (design.md section 6). Kept
// dependency-free and side-effect-free so it is trivially testable (see
// grading.test.ts) -- this is the money/correctness path, so it never touches the
// DB or the request.

export type QuestionType = "single" | "multi" | "short";

export interface GradableQuestion {
	id: string;
	type: QuestionType;
	points: number;
	correct: string[] | null; // option ids for MCQ; null for short
}

/** Canonical key for an option-id set: de-duplicated + sorted, so order and
 * accidental duplicates never affect equality. */
function setKey(ids: string[]): string {
	return [...new Set(ids)].sort().join(" ");
}

/**
 * Grade one MCQ answer. Both single- and multi-select award full points ONLY on an
 * exact set match (all correct ids chosen, no incorrect id chosen). Multi-select
 * gets no partial credit. Short answers never reach here.
 */
export function gradeMcqAnswer(
	q: GradableQuestion,
	selected: string[],
): { awarded: number; isCorrect: boolean } {
	const ok = setKey(selected) === setKey(q.correct ?? []);
	return { awarded: ok ? q.points : 0, isCorrect: ok };
}

export interface GradedAnswer {
	questionId: string;
	awarded: number | null; // null for short (admin-graded later)
	isCorrect: number | null; // 1/0 for MCQ, null for short
}

export interface SubmissionGrade {
	answers: GradedAnswer[];
	mcqScore: number; // auto, sum of MCQ awarded
	mcqMax: number; // sum of MCQ points
	shortMax: number; // sum of short points
	totalMax: number; // mcqMax + shortMax
}

/**
 * Grade a whole submission. `selectedByQuestion` maps a question id to the chosen
 * option ids (missing/empty means unanswered means 0). The `*_max` totals are
 * computed from the quiz's current questions, never hardcoded, so editing questions
 * keeps the math correct. Short questions contribute to `shortMax` only; their
 * awarded stays null.
 */
export function gradeSubmission(
	questions: GradableQuestion[],
	selectedByQuestion: Record<string, string[]>,
): SubmissionGrade {
	const answers: GradedAnswer[] = [];
	let mcqScore = 0;
	let mcqMax = 0;
	let shortMax = 0;

	for (const q of questions) {
		if (q.type === "short") {
			shortMax += q.points;
			answers.push({ questionId: q.id, awarded: null, isCorrect: null });
			continue;
		}
		mcqMax += q.points;
		const { awarded, isCorrect } = gradeMcqAnswer(q, selectedByQuestion[q.id] ?? []);
		mcqScore += awarded;
		answers.push({ questionId: q.id, awarded, isCorrect: isCorrect ? 1 : 0 });
	}

	return { answers, mcqScore, mcqMax, shortMax, totalMax: mcqMax + shortMax };
}
