/**
 * Manual, actor-private Person relationship brief transport. The shared
 * contract is the sole response authority; this module owns only HTTP concerns.
 */
import {
	validateRelationshipBriefResponse,
	type RelationshipBriefRequest,
	type RelationshipBriefResponse,
} from "../../shared/relationship-brief.ts";

export type {
	RelationshipBrief,
	RelationshipBriefCitation,
	RelationshipBriefClaim,
	RelationshipBriefParty,
	RelationshipBriefRequest,
	RelationshipBriefResponse,
} from "../../shared/relationship-brief.ts";

export class RelationshipBriefApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "RelationshipBriefApiError";
		this.status = status;
	}
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function errorMessage(value: unknown): string | null {
	if (!value || typeof value !== "object" || !("error" in value)) return null;
	const error = (value as { error?: unknown }).error;
	return typeof error === "string" && error.trim() ? error.trim() : null;
}

export async function fetchRelationshipBrief(
	mailboxId: string,
	personId: string,
	input: RelationshipBriefRequest,
	fetcher: FetchLike = fetch,
	signal?: AbortSignal,
): Promise<RelationshipBriefResponse> {
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/people/${encodeURIComponent(personId)}/relationship-brief`,
		{
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh: input.refresh }),
			signal,
		},
	);
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => null);
		throw new RelationshipBriefApiError(
			response.status,
			errorMessage(body) ?? "Relationship brief is unavailable",
		);
	}
	return validateRelationshipBriefResponse(await response.json());
}
