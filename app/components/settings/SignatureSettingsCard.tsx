import { Button, Loader } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useReducer, useRef } from "react";
import { MAILBOX_SIGNATURE_LIMITS } from "../../../shared/mailbox-signature-settings.ts";
import {
	initialSignatureFormState,
	signatureFormReducer,
} from "../../lib/signature-settings-form.ts";
import {
	useMailboxSignatureSettings,
	useUpdateMailboxSignature,
} from "../../queries/mailbox-signature-settings.ts";

export function SignatureSettingsCard({ mailboxId }: { mailboxId: string }) {
	const query = useMailboxSignatureSettings(mailboxId);
	const update = useUpdateMailboxSignature();
	const [state, dispatch] = useReducer(
		signatureFormReducer,
		mailboxId,
		initialSignatureFormState,
	);
	const nextSaveTokenRef = useRef(0);

	useEffect(() => {
		dispatch({ type: "mailbox_changed", mailboxId });
	}, [mailboxId]);
	useEffect(() => {
		if (query.data) {
			dispatch({ type: "hydrate", mailboxId, signature: query.data.signature });
		}
	}, [mailboxId, query.data]);

	const scoped = state.mailboxId === mailboxId
		? state
		: initialSignatureFormState(mailboxId);
	const canManage = query.data?.canManage === true;

	async function save() {
		const saveMailboxId = mailboxId;
		const saveRevision = scoped.revision;
		const token = ++nextSaveTokenRef.current;
		const signature = { enabled: scoped.enabled, text: scoped.text };
		dispatch({
			type: "save_started",
			mailboxId: saveMailboxId,
			token,
			revision: saveRevision,
		});
		try {
			const response = await update.mutateAsync({
				mailboxId: saveMailboxId,
				signature,
			});
			dispatch({
				type: "save_succeeded",
				mailboxId: saveMailboxId,
				token,
				revision: saveRevision,
				signature: response.signature,
			});
		} catch (error) {
			dispatch({
				type: "save_failed",
				mailboxId: saveMailboxId,
				token,
				revision: saveRevision,
				error: error instanceof Error ? error.message : "Signature could not be saved",
			});
		}
	}

	return (
		<section className="rounded-lg border border-kumo-line bg-kumo-base p-5" aria-labelledby="signature-settings-title">
			<div className="flex items-start gap-3">
				<EnvelopeSimpleIcon size={18} weight="duotone" className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<h2 id="signature-settings-title" className="text-sm font-semibold text-kumo-default">Email signature</h2>
					<p className="mt-1 text-xs text-kumo-subtle">Added to new messages and replies from this mailbox.</p>
				</div>
			</div>

			{query.isLoading ? (
				<div className="flex justify-center py-8"><Loader size="sm" /></div>
			) : query.isError ? (
				<div role="alert" className="mt-4 space-y-3 rounded-md bg-kumo-danger-tint p-3 text-sm text-kumo-danger">
					<p>Signature settings could not be loaded.</p>
					<Button variant="secondary" size="sm" onClick={() => query.refetch()} loading={query.isFetching}>Retry</Button>
				</div>
			) : (
				<div className="mt-5 space-y-4">
					{!canManage && (
						<p className="rounded-md bg-kumo-recessed px-3 py-2 text-xs text-kumo-subtle">
							This signature is managed for this shared mailbox. You can preview it, but only an administrator can change it.
						</p>
					)}
					<label className="flex min-h-11 items-center gap-3 text-sm font-medium text-kumo-default">
						<input
							type="checkbox"
							aria-label="Enable email signature"
							checked={scoped.enabled}
							disabled={!canManage}
							onChange={(event) => dispatch({
								type: "edit_enabled",
								mailboxId,
								enabled: event.target.checked,
							})}
							className="h-5 w-5 accent-kumo-brand"
						/>
						Enable signature
					</label>
					<div>
						<label htmlFor="mailbox-signature-text" className="mb-1.5 block text-xs font-medium text-kumo-default">Signature text</label>
						<textarea
							id="mailbox-signature-text"
							value={scoped.text}
							readOnly={!canManage}
							maxLength={MAILBOX_SIGNATURE_LIMITS.textCharacters}
							rows={6}
							onChange={(event) => dispatch({
								type: "edit_text",
								mailboxId,
								text: event.target.value,
							})}
							className="min-h-32 w-full resize-y rounded-md border border-kumo-line bg-kumo-control px-3 py-2 text-sm leading-relaxed text-kumo-default outline-none placeholder:text-kumo-subtle focus-visible:ring-2 focus-visible:ring-kumo-ring read-only:bg-kumo-recessed"
							placeholder="Your name\nTeam or company"
						/>
						<p className="mt-1 text-right text-xs text-kumo-subtle">{scoped.text.length} / {MAILBOX_SIGNATURE_LIMITS.textCharacters}</p>
					</div>
					<div>
						<p className="mb-1.5 text-xs font-medium text-kumo-default">Preview</p>
						<div className="min-h-20 whitespace-pre-wrap rounded-md border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm leading-relaxed text-kumo-default">
							{scoped.text || "Your signature preview will appear here."}
						</div>
					</div>
					{scoped.error && <p role="alert" className="text-sm text-kumo-danger">{scoped.error}</p>}
					{scoped.status === "saved" && <p role="status" className="text-sm text-kumo-success">Signature saved</p>}
					{canManage && (
						<div className="flex justify-end">
							<Button variant="primary" size="sm" onClick={save} loading={scoped.status === "saving"} disabled={!scoped.dirty}>
								Save signature
							</Button>
						</div>
					)}
				</div>
			)}
		</section>
	);
}
