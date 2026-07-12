import type { ReplyRefinementRequest } from "../../shared/reply-refinement.ts";
import { hasAiAuthoredContent } from "../lib/compose-signature.ts";

export type ReplyRefinementResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			result: { body: string; requiresHumanReview: true };
	  }
	| { state: "budget_paused"; reason?: string }
	| { state: "stale" };

export class ReplyRefinementApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ReplyRefinementApiError";
		this.status = status;
	}
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseReplyRefinementResponse(value: unknown): ReplyRefinementResponse {
	if (!isRecord(value) || typeof value.state !== "string") {
		throw new ReplyRefinementApiError(
			502,
			"The writing assistant returned an invalid reply",
		);
	}
	if (value.state === "stale") return { state: "stale" };
	if (value.state === "budget_paused") {
		return {
			state: "budget_paused",
			...(typeof value.reason === "string" ? { reason: value.reason } : {}),
		};
	}
	if (
		(value.state === "cached" || value.state === "generated") &&
		typeof value.fingerprint === "string" &&
		isRecord(value.result) &&
		typeof value.result.body === "string" &&
		value.result.requiresHumanReview === true &&
		hasAiAuthoredContent(value.result.body)
	) {
		return {
			state: value.state,
			fingerprint: value.fingerprint,
			result: {
				body: value.result.body,
				requiresHumanReview: true,
			},
		};
	}
	throw new ReplyRefinementApiError(
		502,
		"The writing assistant returned an invalid reply",
	);
}

export async function fetchReplyRefinement(
	mailboxId: string,
	sourceEmailId: string,
	request: ReplyRefinementRequest,
	signal: AbortSignal,
	fetcher: FetchLike = fetch,
): Promise<ReplyRefinementResponse> {
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(sourceEmailId)}/reply-refinement`,
		{
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
			signal,
		},
	);

	if (!response.ok) {
		const body: unknown = await response.json().catch(() => null);
		throw new ReplyRefinementApiError(
			response.status,
			isRecord(body) && typeof body.error === "string"
				? body.error
				: "The writing assistant could not update this reply",
		);
	}

	const body: unknown = await response.json();
	return parseReplyRefinementResponse(body);
}
