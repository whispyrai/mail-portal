import type { MailboxSignature } from "../../shared/mailbox-signature-settings.ts";

export type SignatureFormState = MailboxSignature & {
	mailboxId: string;
	confirmed: MailboxSignature;
	revision: number;
	activeSave: { token: number; revision: number } | null;
	dirty: boolean;
	status: "idle" | "saving" | "saved" | "error";
	error: string | null;
};

export type SignatureFormAction =
	| { type: "mailbox_changed"; mailboxId: string }
	| { type: "hydrate"; mailboxId: string; signature: MailboxSignature }
	| { type: "edit_enabled"; mailboxId: string; enabled: boolean }
	| { type: "edit_text"; mailboxId: string; text: string }
	| { type: "save_started"; mailboxId: string; token: number; revision: number }
	| {
			type: "save_succeeded";
			mailboxId: string;
			token: number;
			revision: number;
			signature: MailboxSignature;
	  }
	| {
			type: "save_failed";
			mailboxId: string;
			token: number;
			revision: number;
			error: string;
	  };

const EMPTY_SIGNATURE: MailboxSignature = { enabled: false, text: "" };

export function initialSignatureFormState(mailboxId: string): SignatureFormState {
	return {
		mailboxId,
		...EMPTY_SIGNATURE,
		confirmed: { ...EMPTY_SIGNATURE },
		revision: 0,
		activeSave: null,
		dirty: false,
		status: "idle",
		error: null,
	};
}

function sameSignature(left: MailboxSignature, right: MailboxSignature): boolean {
	return left.enabled === right.enabled && left.text === right.text;
}

function edit(
	state: SignatureFormState,
	mailboxId: string,
	change: Partial<MailboxSignature>,
): SignatureFormState {
	if (mailboxId !== state.mailboxId) return state;
	const signature = { enabled: state.enabled, text: state.text, ...change };
	return {
		...state,
		...signature,
		revision: state.revision + 1,
		dirty: !sameSignature(signature, state.confirmed),
		status: state.activeSave ? "saving" : "idle",
		error: null,
	};
}

export function signatureFormReducer(
	state: SignatureFormState,
	action: SignatureFormAction,
): SignatureFormState {
	switch (action.type) {
		case "mailbox_changed":
			return action.mailboxId === state.mailboxId
				? state
				: initialSignatureFormState(action.mailboxId);
		case "hydrate": {
			if (action.mailboxId !== state.mailboxId) {
				return state;
			}
			return state.dirty || state.activeSave
				? state
				: {
						...state,
						...action.signature,
						confirmed: { ...action.signature },
						status: "idle",
						error: null,
					};
		}
		case "edit_enabled":
			return edit(state, action.mailboxId, { enabled: action.enabled });
		case "edit_text":
			return edit(state, action.mailboxId, { text: action.text });
		case "save_started":
			if (
				action.mailboxId !== state.mailboxId ||
				action.revision !== state.revision
			) return state;
			return {
				...state,
				activeSave: { token: action.token, revision: action.revision },
				status: "saving",
				error: null,
			};
		case "save_succeeded": {
			if (
				action.mailboxId !== state.mailboxId ||
				state.activeSave?.token !== action.token ||
				state.activeSave.revision !== action.revision
			) return state;
			if (state.revision === action.revision) {
				return {
					...state,
					...action.signature,
					confirmed: { ...action.signature },
					activeSave: null,
					dirty: false,
					status: "saved",
					error: null,
				};
			}
			const visible = { enabled: state.enabled, text: state.text };
			return {
				...state,
				confirmed: { ...action.signature },
				activeSave: null,
				dirty: !sameSignature(visible, action.signature),
				status: "idle",
				error: null,
			};
		}
		case "save_failed":
			if (
				action.mailboxId !== state.mailboxId ||
				state.activeSave?.token !== action.token ||
				state.activeSave.revision !== action.revision
			) return state;
			return {
				...state,
				activeSave: null,
				status: "error",
				error: action.error,
			};
	}
}
