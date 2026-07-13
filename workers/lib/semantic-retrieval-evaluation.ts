export type FrozenSourceIdentity =
	| {
			mailboxId: string;
			source: "message";
			messageId: string;
	  }
	| {
			mailboxId: string;
			source: "attachment";
			messageId: string;
			attachmentId: string;
	  };

export type FrozenJudgment = {
	source: FrozenSourceIdentity;
	relevance: 1 | 2;
};

export type FrozenRetrievalDocument = {
	source: FrozenSourceIdentity;
	searchableText: string;
};

export type SemanticRankingMetrics = {
	recallAt5: number;
	recallAt10: number;
	reciprocalRankAt10: number;
	ndcgAt10: number;
	attachmentRecallAt10: number;
};

export type FrozenRetrievalSystem = "searchV2" | "fts5" | "vector" | "hybrid";
export const FROZEN_RETRIEVAL_SYSTEMS: readonly FrozenRetrievalSystem[] = [
	"searchV2",
	"fts5",
	"vector",
	"hybrid",
];

export type FrozenRetrievalCase = {
	id: string;
	query: string;
	language: "en" | "ar" | "mixed";
	stratum:
		| "attachment_exact"
		| "attachment_conceptual"
		| "message_exact"
		| "deterministic_filter"
		| "near_duplicate"
		| "negative";
	judgments: readonly FrozenJudgment[];
	observedRankings: {
		searchV2: readonly FrozenSourceIdentity[];
		vector: readonly FrozenSourceIdentity[];
	};
};

export type FrozenRetrievalCorpus = {
	version: string;
	policy: {
		semanticModel: string;
		messagePolicyVersion: number;
		messageChunkVersion: number;
		attachmentExtractionVersion: number;
		attachmentPolicyVersion: number;
		attachmentChunkVersion: number;
		candidatesPerMailbox: number;
		resultLimit: number;
		defaultEnablementEligible: false;
	};
	vectorObservation: {
		kind: "reviewed_fixture";
		model: string;
		controlledProviderRun: false;
		observedAt: null;
	};
	mailboxes: readonly string[];
	documents: readonly FrozenRetrievalDocument[];
	cases: readonly FrozenRetrievalCase[];
	gateSha256: string;
};

export type FrozenRetrievalAggregateMetrics = {
	recallAt5: number;
	recallAt10: number;
	mrrAt10: number;
	ndcgAt10: number;
	zeroResultPrecision: number;
	attachmentRecallAt10: number;
	mailboxMacroRecallAt10: number;
	minimumMailboxRecallAt10: number;
};

export type FrozenRetrievalReport = Record<
	FrozenRetrievalSystem,
	FrozenRetrievalAggregateMetrics
>;

export function semanticEvidenceIdentity(source: FrozenSourceIdentity): string {
	return source.source === "message"
		? `${source.mailboxId}\u0000message\u0000${source.messageId}`
		: `${source.mailboxId}\u0000attachment\u0000${source.messageId}\u0000${source.attachmentId}`;
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function reciprocalRankFusion(
	rankings: readonly (readonly FrozenSourceIdentity[])[],
	limit: number,
): Array<{ source: FrozenSourceIdentity; score: number }> {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new Error("Fusion limit is invalid");
	const candidates = new Map<
		string,
		{ source: FrozenSourceIdentity; score: number }
	>();
	for (const ranking of rankings) {
		const seen = new Set<string>();
		for (let index = 0; index < ranking.length; index += 1) {
			const source = ranking[index]!;
			const identity = semanticEvidenceIdentity(source);
			if (seen.has(identity)) continue;
			seen.add(identity);
			const candidate = candidates.get(identity);
			const score = 1 / (60 + index + 1);
			if (candidate) candidate.score += score;
			else candidates.set(identity, { source, score });
		}
	}
	return [...candidates.values()]
		.sort(
			(left, right) =>
				right.score - left.score ||
				compareCodeUnits(
					semanticEvidenceIdentity(left.source),
					semanticEvidenceIdentity(right.source),
				),
		)
		.slice(0, limit);
}

function recallAt(
	relevant: ReadonlySet<string>,
	ranking: readonly FrozenSourceIdentity[],
	limit: number,
): number {
	if (relevant.size === 0) return 0;
	const found = new Set(
		ranking
			.slice(0, limit)
			.map(semanticEvidenceIdentity)
			.filter((identity) => relevant.has(identity)),
	);
	return found.size / relevant.size;
}

export function evaluateSemanticRanking(input: {
	judgments: readonly FrozenJudgment[];
	ranking: readonly FrozenSourceIdentity[];
}): SemanticRankingMetrics {
	const relevance = new Map(
		input.judgments.map((judgment) => [
			semanticEvidenceIdentity(judgment.source),
			judgment.relevance,
		]),
	);
	if (relevance.size !== input.judgments.length) {
		throw new Error("Semantic judgments contain a duplicate source identity");
	}
	const relevant = new Set(relevance.keys());
	const firstRelevant = input.ranking
		.slice(0, 10)
		.findIndex((source) => relevant.has(semanticEvidenceIdentity(source)));
	let dcg = 0;
	for (let index = 0; index < Math.min(input.ranking.length, 10); index += 1) {
		const grade =
			relevance.get(semanticEvidenceIdentity(input.ranking[index]!)) ?? 0;
		if (grade > 0) dcg += (2 ** grade - 1) / Math.log2(index + 2);
	}
	const idealDcg = [...relevance.values()]
		.sort((left, right) => right - left)
		.slice(0, 10)
		.reduce(
			(total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2),
			0,
		);
	const attachmentRelevant = new Set(
		input.judgments
			.filter((judgment) => judgment.source.source === "attachment")
			.map((judgment) => semanticEvidenceIdentity(judgment.source)),
	);
	return {
		recallAt5: recallAt(relevant, input.ranking, 5),
		recallAt10: recallAt(relevant, input.ranking, 10),
		reciprocalRankAt10: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
		ndcgAt10: idealDcg === 0 ? 0 : dcg / idealDcg,
		attachmentRecallAt10: recallAt(attachmentRelevant, input.ranking, 10),
	};
}

function mean(values: readonly number[]): number {
	return values.length === 0
		? 0
		: values.reduce((total, value) => total + value, 0) / values.length;
}

function systemRanking(
	testCase: FrozenRetrievalCase,
	system: FrozenRetrievalSystem,
	fts5Ranking: readonly FrozenSourceIdentity[],
): readonly FrozenSourceIdentity[] {
	if (system === "hybrid") {
		return reciprocalRankFusion(
			[fts5Ranking, testCase.observedRankings.vector],
			20,
		).map((candidate) => candidate.source);
	}
	if (system === "fts5") return fts5Ranking;
	return testCase.observedRankings[system];
}

function validateFrozenCorpus(corpus: FrozenRetrievalCorpus): void {
	if (
		new Set(corpus.mailboxes).size !== corpus.mailboxes.length ||
		corpus.mailboxes.length < 3
	) {
		throw new Error("Frozen corpus requires three unique Mailboxes");
	}
	const documentIdentities = corpus.documents.map((document) =>
		semanticEvidenceIdentity(document.source),
	);
	if (
		new Set(documentIdentities).size !== documentIdentities.length ||
		corpus.documents.some((document) => !document.searchableText.trim())
	)
		throw new Error("Frozen corpus contains an invalid source document");
	const caseIds = new Set<string>();
	for (const testCase of corpus.cases) {
		if (!testCase.id || caseIds.has(testCase.id) || !testCase.query.trim()) {
			throw new Error("Frozen corpus contains an invalid case identity");
		}
		caseIds.add(testCase.id);
		const judgments = testCase.judgments.map((judgment) =>
			semanticEvidenceIdentity(judgment.source),
		);
		if (new Set(judgments).size !== judgments.length) {
			throw new Error("Frozen corpus contains duplicate judgments");
		}
		if (testCase.stratum === "negative" && testCase.judgments.length > 0) {
			throw new Error("Negative frozen cases cannot carry relevant judgments");
		}
		if (testCase.stratum !== "negative" && testCase.judgments.length === 0) {
			throw new Error("Positive frozen cases require a judgment");
		}
		const rankingSystems: Array<keyof FrozenRetrievalCase["observedRankings"]> =
			["searchV2", "vector"];
		for (const system of rankingSystems) {
			const identities = testCase.observedRankings[system].map(
				semanticEvidenceIdentity,
			);
			if (new Set(identities).size !== identities.length) {
				throw new Error("Frozen ranking contains a duplicate source identity");
			}
		}
	}
}

export function evaluateFrozenRetrievalCorpus(
	corpus: FrozenRetrievalCorpus,
	fts5Rankings: ReadonlyMap<string, readonly FrozenSourceIdentity[]>,
): FrozenRetrievalReport {
	validateFrozenCorpus(corpus);
	if (
		fts5Rankings.size !== corpus.cases.length ||
		corpus.cases.some((testCase) => !fts5Rankings.has(testCase.id))
	)
		throw new Error("FTS5 observations do not cover the frozen corpus");
	const evaluateSystem = (
		system: FrozenRetrievalSystem,
	): FrozenRetrievalAggregateMetrics => {
		const positive = corpus.cases.filter(
			(testCase) => testCase.judgments.length > 0,
		);
		const negative = corpus.cases.filter(
			(testCase) => testCase.stratum === "negative",
		);
		const perCase = positive.map((testCase) =>
			evaluateSemanticRanking({
				judgments: testCase.judgments,
				ranking: systemRanking(
					testCase,
					system,
					fts5Rankings.get(testCase.id)!,
				),
			}),
		);
		let attachmentRelevant = 0;
		let attachmentFound = 0;
		const mailboxRelevant = new Map(
			corpus.mailboxes.map((mailboxId) => [mailboxId, 0]),
		);
		const mailboxFound = new Map(
			corpus.mailboxes.map((mailboxId) => [mailboxId, 0]),
		);
		for (const testCase of positive) {
			const returned = new Set(
				systemRanking(testCase, system, fts5Rankings.get(testCase.id)!)
					.slice(0, 10)
					.map(semanticEvidenceIdentity),
			);
			for (const judgment of testCase.judgments) {
				const identity = semanticEvidenceIdentity(judgment.source);
				mailboxRelevant.set(
					judgment.source.mailboxId,
					(mailboxRelevant.get(judgment.source.mailboxId) ?? 0) + 1,
				);
				if (returned.has(identity)) {
					mailboxFound.set(
						judgment.source.mailboxId,
						(mailboxFound.get(judgment.source.mailboxId) ?? 0) + 1,
					);
				}
				if (judgment.source.source === "attachment") {
					attachmentRelevant += 1;
					if (returned.has(identity)) attachmentFound += 1;
				}
			}
		}
		const mailboxRecall = corpus.mailboxes.map((mailboxId) => {
			const relevant = mailboxRelevant.get(mailboxId) ?? 0;
			return relevant === 0 ? 0 : (mailboxFound.get(mailboxId) ?? 0) / relevant;
		});
		return {
			recallAt5: mean(perCase.map((metric) => metric.recallAt5)),
			recallAt10: mean(perCase.map((metric) => metric.recallAt10)),
			mrrAt10: mean(perCase.map((metric) => metric.reciprocalRankAt10)),
			ndcgAt10: mean(perCase.map((metric) => metric.ndcgAt10)),
			zeroResultPrecision:
				negative.length === 0
					? 0
					: negative.filter(
							(testCase) =>
								systemRanking(testCase, system, fts5Rankings.get(testCase.id)!)
									.length === 0,
						).length / negative.length,
			attachmentRecallAt10:
				attachmentRelevant === 0 ? 0 : attachmentFound / attachmentRelevant,
			mailboxMacroRecallAt10: mean(mailboxRecall),
			minimumMailboxRecallAt10: Math.min(...mailboxRecall),
		};
	};
	return {
		searchV2: evaluateSystem("searchV2"),
		fts5: evaluateSystem("fts5"),
		vector: evaluateSystem("vector"),
		hybrid: evaluateSystem("hybrid"),
	};
}

export function meetsFrozenRetrievalThresholds(
	report: FrozenRetrievalReport,
	thresholds: FrozenRetrievalReport,
): boolean {
	const metrics: Array<keyof FrozenRetrievalAggregateMetrics> = [
		"recallAt5",
		"recallAt10",
		"mrrAt10",
		"ndcgAt10",
		"zeroResultPrecision",
		"attachmentRecallAt10",
		"mailboxMacroRecallAt10",
		"minimumMailboxRecallAt10",
	];
	return FROZEN_RETRIEVAL_SYSTEMS.every((system) =>
		metrics.every(
			(metric) => report[system][metric] >= thresholds[system][metric],
		),
	);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.entries(value)
		.sort(([left], [right]) => compareCodeUnits(left, right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(",")}}`;
}

export async function frozenRetrievalGateDigest(input: {
	corpus: Omit<FrozenRetrievalCorpus, "gateSha256">;
	thresholds: FrozenRetrievalReport;
}): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalJson(input)),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
