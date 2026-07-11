export type SnoozeScope =
	| { kind: "message"; emailId: string }
	| {
			kind: "conversation";
			conversationId: string;
			emailId: string;
			folderId: string;
	  };

export interface SnoozeMutationResponse {
	status: "snoozed" | "unsnoozed";
	affectedCount: number;
}
