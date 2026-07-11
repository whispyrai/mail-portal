// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";
import EmailPanelToolbar from "~/components/email-panel/EmailPanelToolbar";
import SingleMessageView from "~/components/email-panel/SingleMessageView";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import LabelChip from "~/components/labels/LabelChip";
import LabelPicker from "~/components/labels/LabelPicker";
import OutboundDeliveryActions from "~/components/OutboundDeliveryActions";
import { splitEmailList, toEmailListValue, getNonInlineAttachments } from "~/lib/utils";
import api from "~/services/api";
import { useAiDraftReply, useCancelOutboundDelivery, useDeleteEmail, useDiscardDraft, useEmail, useMoveEmail, useOutboundDeliveries, useReplyToEmail, useRestoreEmail, useSendEmail, useThreadReplies, useUpdateEmail } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useLabels, useMutateLabels } from "~/queries/labels";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email, Folder, Label, Mailbox } from "~/types";
import { LogicalSendIdentity } from "~/lib/compose-send-identity";

function EmailPanelSkeleton() {
	return (
		<div className="animate-pulse p-5 space-y-4">
			<div className="h-5 w-2/3 rounded bg-kumo-fill" />
			<div className="flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-kumo-fill" /><div className="space-y-2 flex-1"><div className="h-3 w-40 rounded bg-kumo-fill" /><div className="h-2.5 w-24 rounded bg-kumo-fill" /></div></div>
			<div className="space-y-2 pt-4"><div className="h-2.5 w-full rounded bg-kumo-fill" /><div className="h-2.5 w-5/6 rounded bg-kumo-fill" /><div className="h-2.5 w-4/6 rounded bg-kumo-fill" /><div className="h-2.5 w-3/4 rounded bg-kumo-fill" /></div>
		</div>
	);
}

export default function EmailPanel({ emailId }: { emailId: string }) {
	const { mailboxId, folder } = useParams<{ mailboxId: string; folder: string }>();
	const { data: email } = useEmail(mailboxId, emailId) as { data?: Email };
	const { data: threadRepliesRaw } = useThreadReplies(mailboxId, email?.thread_id) as {
		data?: Email[];
	};
	const updateEmail = useUpdateEmail();
	const deleteEmailMut = useDeleteEmail();
	const discardDraftMut = useDiscardDraft();
	const restoreEmailMut = useRestoreEmail();
	const moveEmailMut = useMoveEmail();
	const sendEmailMut = useSendEmail();
	const replyMut = useReplyToEmail();
	const cancelOutboundMut = useCancelOutboundDelivery();
	const aiDraftMut = useAiDraftReply();
	const mutateLabels = useMutateLabels();
	const { data: labels = [] } = useLabels(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId) as { data?: Folder[] };
	const { data: currentMailbox } = useMailbox(mailboxId) as {
		data?: Mailbox;
	};
	const { closePanel, startCompose } = useUIStore();
	const toastManager = useKumoToastManager();
	const [isSending, setIsSending] = useState(false);
	const [isDrafting, setIsDrafting] = useState(false);
	const draftSendIdentityRef = useRef(new LogicalSendIdentity());
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	const isDraftFolder = folder === Folders.DRAFT;
	const isOutboxFolder = folder === Folders.OUTBOX || email?.folder_id === Folders.OUTBOX;
	const isTrashFolder = folder === Folders.TRASH || email?.folder_id === Folders.TRASH;
	const { data: outboundDeliveries = [] } = useOutboundDeliveries(
		mailboxId,
		email ? [email] : [],
		isOutboxFolder,
	);
	const outboundDelivery = outboundDeliveries.find(
		(delivery) => delivery.emailId === emailId,
	);

	const threadReplies = useMemo(() => {
		if (!threadRepliesRaw || !email) return [];
		return threadRepliesRaw.filter((e) => e.id !== email.id);
	}, [threadRepliesRaw, email]);

	const allMessages = useMemo(() => {
		if (!email) return [];
		return [email, ...threadReplies].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	}, [email, threadReplies]);

	// Reset expanded state only when the selected email changes, not on every refetch.
	// Using allMessages as a dependency would reset user expand/collapse state on background refetches.
	const currentEmailId = email?.id;
	useEffect(() => { if (allMessages.length > 1) setExpandedMessages(new Set([allMessages[0].id])); }, [currentEmailId]); // eslint-disable-line react-hooks/exhaustive-deps

	const toggleExpand = (msgId: string) => { setExpandedMessages((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; }); };

	const draftMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of allMessages) { if (msg.folder_id === Folders.DRAFT) ids.add(msg.id); else if (isDraftFolder && msg.id === emailId) ids.add(msg.id); }
		return ids;
	}, [allMessages, isDraftFolder, emailId]);

	const lastReceivedMessage = useMemo(() => {
		const ce = currentMailbox?.email;
		const received = allMessages.filter((msg) => !draftMessageIds.has(msg.id) && msg.sender !== ce);
		if (received.length > 0) return received[0];
		const nonDrafts = allMessages.filter((msg) => !draftMessageIds.has(msg.id));
		return nonDrafts.length > 0 ? nonDrafts[0] : email;
	}, [allMessages, draftMessageIds, currentMailbox?.email, email]);

	const moveToFolders = useMemo(() => { const cur = folder || email?.folder_id; return folders.filter((f) => f.id !== cur); }, [folders, folder, email?.folder_id]);
	const selectedLabelIds = useMemo(
		() => new Set((email?.labels ?? []).map((label) => label.id)),
		[email?.labels],
	);

	if (!email) return <EmailPanelSkeleton />;

	const toggleStar = () => { if (mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); };
	const handleMove = (folderId: string) => { if (mailboxId) { moveEmailMut.mutate({ mailboxId, id: email.id, folderId }); closePanel(); } };
	const handleDelete = () => {
		if (!mailboxId) return;
		const confirmed = window.confirm("Move this email to Trash?");
		if (!confirmed) return;
		deleteEmailMut.mutate(
			{ mailboxId, id: email.id },
			{
				onSuccess: () => {
					toastManager.add({ title: "Email moved to Trash" });
					closePanel();
				},
				onError: () =>
					toastManager.add({
						title: "Failed to move email to Trash",
						variant: "error",
					}),
			},
		);
	};
	const handleRestore = () => {
		if (!mailboxId) return;
		restoreEmailMut.mutate(
			{ mailboxId, id: email.id },
			{
				onSuccess: () => {
					toastManager.add({ title: "Email restored" });
					closePanel();
				},
				onError: () =>
					toastManager.add({
						title: "Failed to restore email",
						variant: "error",
					}),
			},
		);
	};

	const handleEditDraft = (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (target.in_reply_to) { startCompose({ mode: "reply", originalEmail: allMessages.find((msg) => msg.id === target.in_reply_to), draftEmail: target }); }
		else { startCompose({ mode: "new", originalEmail: undefined, draftEmail: target }); }
	};

	const handleDeleteDraft = async (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (!mailboxId) return;
		if (!window.confirm("Discard this draft?")) return;
		discardDraftMut.mutate(
			{ mailboxId, id: target.id },
			{
				onSuccess: () => {
					toastManager.add({ title: "Draft discarded" });
					if (target.id === emailId) closePanel();
				},
				onError: () =>
					toastManager.add({
						title: "Failed to discard draft",
						variant: "error",
					}),
			},
		);
	};

	const handleSendDraft = async (draftMsg?: Email) => {
		let target = draftMsg || email;
		if (!mailboxId || !currentMailbox) return;
		setIsSending(true);
		try {
			const fresh = await api.getEmail(mailboxId, target.id) as Email;
			if (fresh) target = fresh;
			if (!target.recipient) { toastManager.add({ title: "Cannot send: no recipient set on this draft.", variant: "error" }); return; }
			if (!target.draft_version) { toastManager.add({ title: "Reload this draft before sending it.", variant: "error" }); return; }
			const toRecipients = splitEmailList(target.recipient);
			if (toRecipients.length === 0) { toastManager.add({ title: "Cannot send: no valid recipient set on this draft.", variant: "error" }); return; }
			const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
			const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
			const originalEmail = target.in_reply_to ? allMessages.find((msg) => msg.id === target.in_reply_to) : undefined;
			// Carry the draft's stored attachments through as existing references.
			const attachmentRefs = getNonInlineAttachments(target.attachments).map(
				(a) => ({ kind: "existing" as const, emailId: target.id, attachmentId: a.id }),
			);
			const sendPayload = {
				source_draft_id: target.id,
				source_draft_version: target.draft_version,
				to: toEmailListValue(toRecipients),
				cc: toEmailListValue(splitEmailList(target.cc)),
				bcc: toEmailListValue(splitEmailList(target.bcc)),
				from,
				subject: target.subject || "(no subject)",
				html: target.body || "",
				text: target.body ? target.body.replace(/<[^>]*>/g, "").trim() : "",
				attachments: attachmentRefs,
			};
			const emailData = {
				...sendPayload,
				idempotency_key: draftSendIdentityRef.current.keyFor(sendPayload),
			};
			const result = originalEmail
				? await replyMut.mutateAsync({ mailboxId, emailId: originalEmail.id, email: emailData })
				: await sendEmailMut.mutateAsync({ mailboxId, email: emailData });
			toastManager.add({
				title: "Email queued. Draft kept until delivery is confirmed.",
				timeout: 10_000,
				actions: [
					{
						children: "Undo",
						variant: "secondary",
						size: "sm",
						onClick: () =>
							cancelOutboundMut.mutate(
								{ mailboxId, deliveryId: result.deliveryId },
								{
									onSuccess: () => toastManager.add({ title: "Send cancelled" }),
									onError: (error) =>
										toastManager.add({
											title: error instanceof Error ? error.message : "Could not cancel send",
											variant: "error",
										}),
								},
							),
					},
				],
			});
			if (isDraftFolder) closePanel();
		} catch (err) {
			const message = (err instanceof Error ? err.message : null) || "Failed to send email.";
			toastManager.add({ title: message, variant: "error" });
		} finally { setIsSending(false); }
	};

	const handleAiDraft = async () => {
		if (!mailboxId) return;
		const target = lastReceivedMessage || email;
		if (!target) return;
		setIsDrafting(true);
		try {
			const draft = await aiDraftMut.mutateAsync({ mailboxId, emailId: target.id });
			const subject =
				draft.subject ||
				(target.subject?.startsWith("Re:")
					? target.subject
					: `Re: ${target.subject || ""}`);
			startCompose({
				mode: "reply",
				originalEmail: target,
				draftEmail: {
					id: "",
					subject,
					sender: currentMailbox?.email || mailboxId,
					recipient: draft.to || target.sender,
					date: new Date().toISOString(),
					read: true,
					starred: false,
					body: draft.body || "",
					in_reply_to: target.id,
					thread_id: target.thread_id ?? null,
				} as Email,
			});
		} catch (err) {
			const message =
				(err instanceof Error ? err.message : null) ||
				"AI couldn't draft a reply. Try again.";
			toastManager.add({ title: message, variant: "error" });
		} finally {
			setIsDrafting(false);
		}
	};

	const handleLabelToggle = (label: Label, selected: boolean) => {
		const folderId = email.folder_id ?? folder;
		if (!mailboxId || !folderId) return;
		mutateLabels.mutate(
			{
				mailboxId,
				labelId: label.id,
				action: selected ? "apply" : "remove",
				targets: [{ emailId: email.id, folderId }],
			},
			{
				onSuccess: (result) => {
					const outcome = result.results[0];
					toastManager.add({
						title: outcome?.status === "updated"
							? `${selected ? "Applied" : "Removed"} ${label.name}`
							: outcome?.status === "outbound_delivery_active"
								? "Labels cannot change while delivery is active"
								: "This message is no longer available in this folder",
						variant: outcome?.status === "updated" ? undefined : "error",
					});
				},
				onError: () => toastManager.add({ title: "Label change failed", variant: "error" }),
			},
		);
	};

	const hasThread = allMessages.length > 1;

	return (
		<div className="flex flex-col h-full">
			<EmailPanelToolbar
				email={email}
				mailboxId={mailboxId}
				isDraftFolder={isDraftFolder}
				isOutboxFolder={isOutboxFolder}
				isSending={isSending}
				isDrafting={isDrafting}
				moveToFolders={moveToFolders}
				onBack={closePanel}
				onSendDraft={() => handleSendDraft()}
				onEditDraft={() => handleEditDraft()}
				onReply={() =>
					startCompose({ mode: "reply", originalEmail: lastReceivedMessage })
				}
				onReplyAll={() =>
					startCompose({
						mode: "reply-all",
						originalEmail: lastReceivedMessage,
					})
				}
				onForward={() => startCompose({ mode: "forward", originalEmail: email })}
				onAiDraft={handleAiDraft}
				onToggleStar={toggleStar}
				onToggleRead={() => {
					if (mailboxId) {
						updateEmail.mutate({
							mailboxId,
							id: email.id,
							data: { read: !email.read },
						});
					}
				}}
				onMove={handleMove}
				onViewSource={() => setSourceViewEmail(email)}
				onDelete={isDraftFolder ? () => handleDeleteDraft() : handleDelete}
				onRestore={handleRestore}
				isTrashFolder={isTrashFolder}
			/>

			{isOutboxFolder && mailboxId && outboundDelivery && (
				<div className="border-b border-kumo-line bg-kumo-tint px-4 py-3 md:px-6">
					<OutboundDeliveryActions
						mailboxId={mailboxId}
						delivery={outboundDelivery}
					/>
				</div>
			)}

			<EmailPanelHeader
				subject={email.subject}
				messageCount={allMessages.length}
				showThreadCount={hasThread}
			/>

			<div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-kumo-line px-4 py-2 md:px-6">
				<span className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Labels</span>
				{(email.labels ?? []).map((label) => <LabelChip key={label.id} label={label} />)}
				{(email.labels ?? []).length === 0 && (
					<span className="text-sm text-kumo-subtle">None</span>
				)}
				<div className="ms-auto">
					<LabelPicker
						labels={labels}
						selectedIds={selectedLabelIds}
						onToggle={handleLabelToggle}
						disabled={mutateLabels.isPending}
						buttonLabel="Edit labels"
					/>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto">
				{hasThread ? (
					allMessages.map((msg, idx) => {
						const isDraft = draftMessageIds.has(msg.id);
						return (
							<ThreadMessage
								key={msg.id}
								email={msg}
								mailboxId={mailboxId}
								mailboxEmail={currentMailbox?.email}
								isLast={idx === allMessages.length - 1}
								isDraft={isDraft}
								isSending={isDraft ? isSending : false}
								isExpanded={expandedMessages.has(msg.id)}
								onToggleExpand={() => toggleExpand(msg.id)}
								onSendDraft={isDraft ? () => handleSendDraft(msg) : undefined}
								onEditDraft={isDraft ? () => handleEditDraft(msg) : undefined}
								onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
								onViewSource={() => setSourceViewEmail(msg)}
								onPreviewImage={(url, filename) =>
									setPreviewImage({ url, filename })
								}
							/>
						);
					})
				) : (
					<SingleMessageView
						email={email}
						mailboxId={mailboxId}
						onPreviewImage={(url, filename) =>
							setPreviewImage({ url, filename })
						}
					/>
				)}
			</div>

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>
		</div>
	);
}
