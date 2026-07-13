import { SEMANTIC_SEARCH_LIMITS } from "../../shared/semantic-search.ts";
import {
	SEMANTIC_ATTACHMENT_CHUNK_VERSION,
	SEMANTIC_ATTACHMENT_EXTRACTION_VERSION,
	SEMANTIC_ATTACHMENT_POLICY_VERSION,
} from "./semantic-attachment.ts";
import { SEMANTIC_CANDIDATES_PER_MAILBOX } from "./global-semantic-search.ts";
import {
	SEMANTIC_EMBEDDING_MODEL,
	SEMANTIC_MESSAGE_CHUNK_VERSION,
	SEMANTIC_MESSAGE_POLICY_VERSION,
} from "./semantic-search.ts";
import type {
	FrozenRetrievalCorpus,
	FrozenRetrievalReport,
	FrozenSourceIdentity,
} from "./semantic-retrieval-evaluation.ts";

const legalMessage = {
	mailboxId: "legal@portal.test",
	source: "message",
	messageId: "message-renewal",
} satisfies FrozenSourceIdentity;
const legalPdf = {
	mailboxId: "legal@portal.test",
	source: "attachment",
	messageId: "message-renewal",
	attachmentId: "attachment-renewal-pdf",
} satisfies FrozenSourceIdentity;
const financeMessage = {
	mailboxId: "finance@portal.test",
	source: "message",
	messageId: "message-q3-forecast",
} satisfies FrozenSourceIdentity;
const financeXlsx = {
	mailboxId: "finance@portal.test",
	source: "attachment",
	messageId: "message-q3-forecast",
	attachmentId: "attachment-q3-xlsx",
} satisfies FrozenSourceIdentity;
const financeNumbers = {
	mailboxId: "finance@portal.test",
	source: "attachment",
	messageId: "message-q3-forecast",
	attachmentId: "attachment-q3-numbers",
} satisfies FrozenSourceIdentity;
const operationsMessage = {
	mailboxId: "ops@portal.test",
	source: "message",
	messageId: "message-loading-window",
} satisfies FrozenSourceIdentity;
const operationsOdt = {
	mailboxId: "ops@portal.test",
	source: "attachment",
	messageId: "message-arabic-delivery",
	attachmentId: "attachment-delivery-odt",
} satisfies FrozenSourceIdentity;

export const FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1 = {
	version: "semantic-attachment-gate-b-v1",
	policy: {
		semanticModel: SEMANTIC_EMBEDDING_MODEL,
		messagePolicyVersion: SEMANTIC_MESSAGE_POLICY_VERSION,
		messageChunkVersion: SEMANTIC_MESSAGE_CHUNK_VERSION,
		attachmentExtractionVersion: SEMANTIC_ATTACHMENT_EXTRACTION_VERSION,
		attachmentPolicyVersion: SEMANTIC_ATTACHMENT_POLICY_VERSION,
		attachmentChunkVersion: SEMANTIC_ATTACHMENT_CHUNK_VERSION,
		candidatesPerMailbox: SEMANTIC_CANDIDATES_PER_MAILBOX,
		resultLimit: SEMANTIC_SEARCH_LIMITS.resultLimit,
		defaultEnablementEligible: false,
	},
	vectorObservation: {
		kind: "reviewed_fixture",
		model: SEMANTIC_EMBEDDING_MODEL,
		controlledProviderRun: false,
		observedAt: null,
	},
	mailboxes: ["legal@portal.test", "finance@portal.test", "ops@portal.test"],
	documents: [
		{
			source: legalMessage,
			searchableText: "Renewal documents and attached agreement",
		},
		{
			source: legalPdf,
			searchableText:
				"45 calendar days written cancellation notice. How far ahead must we terminate the renewal.",
		},
		{
			source: financeMessage,
			searchableText: "Regional forecast workbook attachment",
		},
		{
			source: financeXlsx,
			searchableText:
				"Cairo East Q3 1842500 EGP. Expected third quarter revenue for the eastern Cairo region. filename q3-cairo-east.xlsx.",
		},
		{
			source: financeNumbers,
			searchableText: "Third quarter revenue eastern Cairo region draft.",
		},
		{
			source: operationsMessage,
			searchableText: "The loading window closes at 14:30.",
		},
		{
			source: operationsOdt,
			searchableText: "التسليم يوم الخميس الساعة التاسعة",
		},
	],
	cases: [
		{
			id: "legal-attachment-exact",
			query: "45 calendar days written cancellation notice",
			language: "en",
			stratum: "attachment_exact",
			judgments: [{ source: legalPdf, relevance: 2 }],
			observedRankings: {
				searchV2: [],
				vector: [legalPdf, legalMessage],
			},
		},
		{
			id: "legal-attachment-conceptual",
			query: "how far ahead must we terminate the renewal",
			language: "en",
			stratum: "attachment_conceptual",
			judgments: [{ source: legalPdf, relevance: 2 }],
			observedRankings: {
				searchV2: [],
				vector: [legalPdf],
			},
		},
		{
			id: "legal-stale-prior-version",
			query: "30 day cancellation notice",
			language: "en",
			stratum: "negative",
			judgments: [],
			observedRankings: { searchV2: [], vector: [] },
		},
		{
			id: "finance-spreadsheet-exact",
			query: "Cairo East Q3 1842500 EGP",
			language: "mixed",
			stratum: "attachment_exact",
			judgments: [{ source: financeXlsx, relevance: 2 }],
			observedRankings: {
				searchV2: [],
				vector: [financeXlsx, financeNumbers],
			},
		},
		{
			id: "finance-spreadsheet-near-duplicate",
			query: "expected third quarter revenue for the eastern Cairo region",
			language: "en",
			stratum: "near_duplicate",
			judgments: [{ source: financeXlsx, relevance: 2 }],
			observedRankings: {
				searchV2: [],
				vector: [financeXlsx, financeNumbers],
			},
		},
		{
			id: "operations-arabic-exact",
			query: "التسليم يوم الخميس الساعة التاسعة",
			language: "ar",
			stratum: "attachment_exact",
			judgments: [{ source: operationsOdt, relevance: 2 }],
			observedRankings: {
				searchV2: [],
				vector: [operationsOdt],
			},
		},
		{
			id: "operations-arabic-conceptual",
			query: "متى موعد وصول الشحنة",
			language: "ar",
			stratum: "attachment_conceptual",
			judgments: [{ source: operationsOdt, relevance: 2 }],
			observedRankings: {
				searchV2: [],
				vector: [operationsOdt],
			},
		},
		{
			id: "operations-message-exact",
			query: "loading window closes at 14:30",
			language: "en",
			stratum: "message_exact",
			judgments: [{ source: operationsMessage, relevance: 2 }],
			observedRankings: {
				searchV2: [operationsMessage],
				vector: [operationsMessage],
			},
		},
		{
			id: "finance-deterministic-filename",
			query: "filename:q3-cairo-east.xlsx",
			language: "en",
			stratum: "deterministic_filter",
			judgments: [{ source: financeMessage, relevance: 2 }],
			observedRankings: {
				searchV2: [financeMessage],
				vector: [financeXlsx],
			},
		},
		{
			id: "unsupported-negative",
			query: "Antarctic laboratory permit ZX-991",
			language: "en",
			stratum: "negative",
			judgments: [],
			observedRankings: { searchV2: [], vector: [] },
		},
	],
	gateSha256:
		"8037c6237645e054fb030f4eca1d2a6d3b9182f5b2aa442a1b5e2a36f897e529",
} satisfies FrozenRetrievalCorpus;

export const FROZEN_RETRIEVAL_THRESHOLDS_V1: FrozenRetrievalReport = {
	searchV2: {
		recallAt5: 0.25,
		recallAt10: 0.25,
		mrrAt10: 0.25,
		ndcgAt10: 0.25,
		zeroResultPrecision: 1,
		attachmentRecallAt10: 0,
		mailboxMacroRecallAt10: 0.2,
		minimumMailboxRecallAt10: 0,
	},
	fts5: {
		recallAt5: 0.75,
		recallAt10: 0.75,
		mrrAt10: 0.75,
		ndcgAt10: 0.75,
		zeroResultPrecision: 1,
		attachmentRecallAt10: 0.8,
		mailboxMacroRecallAt10: 0.7,
		minimumMailboxRecallAt10: 0.65,
	},
	vector: {
		recallAt5: 0.85,
		recallAt10: 0.85,
		mrrAt10: 0.85,
		ndcgAt10: 0.85,
		zeroResultPrecision: 1,
		attachmentRecallAt10: 1,
		mailboxMacroRecallAt10: 0.85,
		minimumMailboxRecallAt10: 0.65,
	},
	hybrid: {
		recallAt5: 0.85,
		recallAt10: 0.85,
		mrrAt10: 0.85,
		ndcgAt10: 0.85,
		zeroResultPrecision: 1,
		attachmentRecallAt10: 1,
		mailboxMacroRecallAt10: 0.85,
		minimumMailboxRecallAt10: 0.65,
	},
};
