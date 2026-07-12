/**
 * Permission-aware global Today API client.
 *
 * The server derives the accessible Mailbox roster from the signed-in actor.
 * The browser supplies only the local IANA timezone.
 */

import type { GlobalTodayResponse } from "../../shared/global-today.ts";
import { parseGlobalTodayResponse } from "../lib/global-today-response.ts";
import { ApiError } from "./api.ts";

// -----------------------------------------------------------------------------
// Get global Today
// Authenticated users may read one deterministic snapshot across current access.
// -----------------------------------------------------------------------------

export type GetGlobalTodayRequest = {
	timeZone: string;
	signal?: AbortSignal;
};

export type GetGlobalTodayResponse = GlobalTodayResponse;

// GET /api/v1/today?timeZone=...
export async function getGlobalToday(
	request: GetGlobalTodayRequest,
): Promise<GetGlobalTodayResponse> {
	const params = new URLSearchParams({ timeZone: request.timeZone });
	const response = await fetch(`/api/v1/today?${params.toString()}`, {
		cache: "no-store",
		credentials: "same-origin",
		signal: request.signal,
	});
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const errorBody = body && typeof body === "object" && !Array.isArray(body)
			? body as Record<string, unknown>
			: { error: "Failed to load Today" };
		throw new ApiError(response.status, errorBody);
	}
	return parseGlobalTodayResponse(body);
}
