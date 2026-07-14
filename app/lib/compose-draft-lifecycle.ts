export type ComposeDraftSavePhase =
	| "saved"
	| "pending"
	| "saving"
	| "failed";

export interface ComposeDraftLifecycle {
	localRevision: number;
	savedRevision: number;
	phase: ComposeDraftSavePhase;
	activeSave: { token: number; revision: number } | null;
	error: string | null;
}

export interface ComposeDraftSnapshot {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	body: string;
	attachments: ReadonlyArray<{
		filename: string;
		mimetype: string;
		size: number;
		status: string;
		disposition?: string;
		contentId?: string | null;
	}>;
}

export type ComposeDraftLifecycleEvent =
	| { type: "reset" }
	| { type: "edited" }
	| { type: "save-started"; token: number; revision: number }
	| { type: "save-succeeded"; token: number; revision: number }
	| { type: "save-failed"; token: number; error: string };

export function composeDraftLifecycle(): ComposeDraftLifecycle {
	return {
		localRevision: 0,
		savedRevision: 0,
		phase: "saved",
		activeSave: null,
		error: null,
	};
}

export function composeDraftTransition(
	state: ComposeDraftLifecycle,
	event: ComposeDraftLifecycleEvent,
): ComposeDraftLifecycle {
	if (event.type === "reset") return composeDraftLifecycle();
	if (event.type === "edited") {
		return {
			...state,
			localRevision: state.localRevision + 1,
			phase: state.activeSave ? "saving" : "pending",
			error: null,
		};
	}
	if (event.type === "save-started") {
		return {
			...state,
			phase: "saving",
			activeSave: { token: event.token, revision: event.revision },
			error: null,
		};
	}
	if (state.activeSave?.token !== event.token) return state;
	if (event.type === "save-failed") {
		return {
			...state,
			phase: "failed",
			activeSave: null,
			error: event.error,
		};
	}

	const savedRevision = Math.max(state.savedRevision, event.revision);
	return {
		...state,
		savedRevision,
		phase: state.localRevision === savedRevision ? "saved" : "pending",
		activeSave: null,
		error: null,
	};
}

export function composeDraftIsDirty(state: ComposeDraftLifecycle): boolean {
	return state.localRevision !== state.savedRevision;
}

export function shouldCaptureProgrammaticComposeChange(input: {
	hasDraftIdentity: boolean;
	phase: ComposeDraftSavePhase;
	hasUnobservedUserChange: boolean;
}): boolean {
	return input.hasDraftIdentity ||
		input.phase !== "saved" ||
		input.hasUnobservedUserChange;
}

export function composeDraftFingerprint(snapshot: ComposeDraftSnapshot): string {
	return JSON.stringify({
		to: snapshot.to,
		cc: snapshot.cc,
		bcc: snapshot.bcc,
		subject: snapshot.subject,
		body: snapshot.body,
		attachments: snapshot.attachments.map((attachment) => ({
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			size: attachment.size,
			status: attachment.status,
			disposition: attachment.disposition ?? "attachment",
			contentId: attachment.contentId ?? null,
		})),
	});
}

export async function composeDraftSaveKey(input: {
	composeKey: string;
	draftId?: string;
	draftVersion?: number;
	fingerprint: string;
}): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify([
			input.draftId ? null : input.composeKey,
			input.draftId ?? null,
			input.draftVersion ?? 0,
			input.fingerprint,
		])),
	));
	const bytes = digest.slice(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function composeDraftIsEmpty(snapshot: ComposeDraftSnapshot): boolean {
	const hasVisibleEmbeddedContent =
		/<(?:img|hr|table|iframe|video|audio|svg)\b/i.test(snapshot.body);
	const bodyText = snapshot.body
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;|&#160;/gi, " ")
		.trim();
	return (
		!snapshot.to.trim() &&
		!snapshot.cc.trim() &&
		!snapshot.bcc.trim() &&
		!snapshot.subject.trim() &&
		!bodyText &&
		!hasVisibleEmbeddedContent &&
		snapshot.attachments.length === 0
	);
}

export function planComposeClose(input: {
	isDirty: boolean;
	isSaving: boolean;
	hasPersistedDraft: boolean;
	hasUnpersistedInitialDraft?: boolean;
	isEmpty: boolean;
}): "close-now" | "save-then-close" | "ask" {
	if (!input.isDirty && !input.isSaving) {
		return input.hasUnpersistedInitialDraft
			? "save-then-close"
			: "close-now";
	}
	if (input.hasPersistedDraft) return "ask";
	if (input.isEmpty && !input.isSaving) return "close-now";
	return "save-then-close";
}
