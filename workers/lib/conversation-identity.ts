export const CONVERSATION_ID_SQL = `CASE
	WHEN thread_id IS NOT NULL THEN raw_thread_id
	ELSE raw_thread_id
END`;

export function resolveConversationIdentity(input: {
	rawThreadId: string;
	threadId: string | null | undefined;
	normalizedSubject: string | null | undefined;
	minimumRawThreadIdForSubject: string;
}): string {
	return input.rawThreadId;
}
