import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../services/api.ts";
import { shouldRetryGlobalToday } from "./global-today.ts";

test("global Today never retries authorization failures and retries one transient failure", () => {
	assert.equal(shouldRetryGlobalToday(0, new ApiError(401, { error: "Unauthorized" })), false);
	assert.equal(shouldRetryGlobalToday(0, new ApiError(403, { error: "Forbidden" })), false);
	assert.equal(shouldRetryGlobalToday(0, new ApiError(502, { error: "Unavailable" })), true);
	assert.equal(shouldRetryGlobalToday(1, new ApiError(502, { error: "Unavailable" })), false);
});
