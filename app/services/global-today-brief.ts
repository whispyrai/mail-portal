import type { GlobalTodayBriefResponse } from "../../shared/global-today-brief.ts";
import { parseGlobalTodayBriefResponse } from "../lib/global-today-brief-response.ts";
import { ApiError } from "./api.ts";

export async function getGlobalTodayBrief(input: {
	timeZone: string;
	refresh?: boolean;
	signal?: AbortSignal;
}): Promise<GlobalTodayBriefResponse> {
	const response = await fetch("/api/v1/today/brief", {
		method: "POST",
		cache: "no-store",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			timeZone: input.timeZone,
			...(input.refresh ? { refresh: true } : {}),
		}),
		signal: input.signal,
	});
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const errorBody = body && typeof body === "object" && !Array.isArray(body)
			? body as Record<string, unknown>
			: { error: "AI guidance is unavailable" };
		throw new ApiError(response.status, errorBody);
	}
	return parseGlobalTodayBriefResponse(body);
}
