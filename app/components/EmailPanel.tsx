// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowBendDoubleUpLeftIcon,
	ArrowBendUpLeftIcon,
	ArrowBendUpRightIcon,
} from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";
import EmailPanelToolbar from "~/components/email-panel/EmailPanelToolbar";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import LabelChip from "~/components/labels/LabelChip";
import LabelPicker from "~/components/labels/LabelPicker";
import OutboundDeliveryActions from "~/components/OutboundDeliveryActions";
import ConversationIntelligenceCard from "~/components/ConversationIntelligenceCard";
import ConversationActivity from "~/components/ConversationActivity";
import SnoozeDialog from "~/components/SnoozeDialog";
import { FollowUpReminderControl } from "~/components/FollowUpReminderDialog";
import { htmlToPlainText, toEmailListValue } from "~/lib/utils";
import { recipientProblem, replyRecipientFields } from "~/lib/recipient-input";
import { normalizedAddress, sendableRecipients } from "shared/recipient-addresses";
import { composeSurface, INLINE_COMPOSE_HOST_ID } from "~/lib/compose-surface";
import { prefixedSubject } from "~/lib/compose-initialization";
import { evaluateStoredDraftAttachments } from "~/lib/compose-attachment-policy";
import { planComposeEnqueueResult } from "~/lib/outbound-enqueue-outcome";
import api, { ApiError } from "~/services/api";
import { useAiDraftReply, useDeleteEmail, useDiscardDraft, useEmail, useMoveEmail, useOutboundDeliveries, useReplyToEmail, useRestoreEmail, useSaveDraft, useSendEmail, useThreadReplies, useUpdateEmail } from "~/queries/emails";
import { buildEmailBodyQueryOptions } from "~/queries/email-body";
import { useFolders } from "~/queries/folders";
import { useMailbox, useMailboxes } from "~/queries/mailboxes";
import { useLabels, useMutateLabels } from "~/queries/labels";
import { useUnsnooze } from "~/queries/snooze";
import { useFollowUpReminders } from "~/queries/follow-up-reminders";
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
	const { data: threadRepliesRaw, isFetched: threadRepliesFetched } = useThreadReplies(mailboxId, email?.thread_id) as {
		data?: Email[];
		isFetched: boolean;
	};
	const updateEmail = useUpdateEmail();
	const deleteEmailMut = useDeleteEmail();
	const discardDraftMut = useDiscardDraft();
	const restoreEmailMut = useRestoreEmail();
	const moveEmailMut = useMoveEmail();
	const sendEmailMut = useSendEmail();
	const replyMut = useReplyToEmail();
	const saveDraftMut = useSaveDraft();
	const aiDraftMut = useAiDraftReply();
	const mutateLabels = useMutateLabels();
	const unsnooze = useUnsnooze();
	const { data: labels = [] } = useLabels(mailboxId);
	const { data: followUpReminders = [] } = useFollowUpReminders(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId) as { data?: Folder[] };
	const { data: currentMailbox } = useMailbox(mailboxId) as {
		data?: Mailbox;
	};
	const { data: mailboxes = [] } = useMailboxes();
	const activityMailboxType = mailboxId
		? mailboxes.find((mailbox) =>
			mailbox.id.toLowerCase() === mailboxId.toLowerCase() ||
			mailbox.email.toLowerCase() === mailboxId.toLowerCase()
		)?.type
		: undefined;
	const hasAuthoritativeActivityMailbox =
		activityMailboxType === "PERSONAL" || activityMailboxType === "SHARED";
	const {
		closePanel,
		startCompose,
		isComposing,
		composeOptions,
		selectedEmailId,
		trackSend,
		pendingThreadAction,
		clearThreadAction,
	} = useUIStore();
	const isInlineComposing = isComposing &&
		composeSurface(composeOptions, selectedEmailId) === "inline";
	const toastManager = useKumoToastManager();
	const [isSending, setIsSending] = useState(false);
	const [isDrafting, setIsDrafting] = useState(false);
	const draftSendIdentityRef = useRef(new LogicalSendIdentity());
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
	const conversationScrollRef = useRef<HTMLDivElement>(null);
	const pendingMessageFocusRef = useRef<string | null>(null);
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	const [isSnoozeOpen, setIsSnoozeOpen] = useState(false);
	const isDraftFolder = folder === Folders.DRAFT;
	const isOutboxFolder = folder === Folders.OUTBOX || email?.folder_id === Folders.OUTBOX;
	const isIntelligenceUnsupported =
		isDraftFolder || email?.folder_id === Folders.DRAFT || isOutboxFolder;
	const isTrashFolder = folder === Folders.TRASH || email?.folder_id === Folders.TRASH;
	const isSnoozedFolder = folder === Folders.SNOOZED || email?.folder_id === Folders.SNOOZED;
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

	// A thread reads like a chat: oldest at the top, newest at the bottom.
	const allMessages = useMemo(() => {
		if (!email) return [];
		return [email, ...threadReplies].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
	}, [email, threadReplies]);
	const draftMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of allMessages) { if (msg.folder_id === Folders.DRAFT) ids.add(msg.id); else if (isDraftFolder && msg.id === emailId) ids.add(msg.id); }
		return ids;
	}, [allMessages, isDraftFolder, emailId]);

	// Route-level mailboxId is often the address itself, so it is a truthful
	// fallback while the mailbox record loads. Unresolved means nothing is self.
	const selfAddress = normalizedAddress(currentMailbox?.email ?? mailboxId ?? "");
	const lastReceivedMessage = useMemo(() => {
		const received = allMessages.filter(
			(msg) => !draftMessageIds.has(msg.id) &&
				normalizedAddress(msg.sender) !== selfAddress,
		);
		if (received.length > 0) return received.at(-1);
		const nonDrafts = allMessages.filter((msg) => !draftMessageIds.has(msg.id));
		return nonDrafts.at(-1) ?? email;
	}, [allMessages, draftMessageIds, selfAddress, email]);

	// What Reply, Reply all and Forward answer by default: the newest message in
	// the conversation, whoever sent it. Drafts and mail still in the Outbox are
	// not part of the conversation yet.
	const latestMessage = useMemo(() => {
		const settled = allMessages.filter(
			(msg) => !draftMessageIds.has(msg.id) && msg.folder_id !== Folders.OUTBOX,
		);
		return settled.at(-1) ?? email;
	}, [allMessages, draftMessageIds, email]);

	// Forward quotes the newest message, so its body is fetched even while
	// collapsed. Depended on by id, not by message, to keep the query set stable.
	const latestBodyId = latestMessage?.body_external
		? latestMessage.id
		: undefined;
	const activeExternalBodyIds = useMemo(() => {
		if (!email) return [];
		const ids = new Set<string>();
		if (email.body_external) ids.add(email.id);
		if (latestBodyId) ids.add(latestBodyId);
		for (const message of allMessages) {
			if (
				message.id !== email.id &&
				message.body_external &&
				expandedMessages.has(message.id)
			) {
				ids.add(message.id);
			}
		}
		return [...ids];
	}, [allMessages, email, expandedMessages, latestBodyId]);
	const externalBodyQueries = useQueries({
		queries: mailboxId
			? activeExternalBodyIds.map((messageId) =>
					buildEmailBodyQueryOptions(mailboxId, messageId)
				)
			: [],
	});
	const externalBodyQueriesById = useMemo(
		() => new Map(
			activeExternalBodyIds.map((messageId, index) => [
				messageId,
				externalBodyQueries[index],
			]),
		),
		[activeExternalBodyIds, externalBodyQueries],
	);

	/** The message with its complete body, or null while that body is loading. */
	const withCompleteBody = (message: Email): Email | null => {
		if (!message.body_external) return message;
		const body = externalBodyQueriesById.get(message.id)?.data;
		return body === undefined ? null : { ...message, body };
	};

	// A keyboard Reply, Reply all or Forward from the list lands here and runs
	// against the same newest message the buttons use, once it has loaded. It
	// checks after every render and does nothing until a request is waiting.
	useEffect(() => {
		if (!pendingThreadAction || pendingThreadAction.emailId !== emailId) return;
		if (!email || !latestMessage || (email.thread_id && !threadRepliesFetched)) return;
		const { action } = pendingThreadAction;
		if (action !== "forward") {
			clearThreadAction();
			startCompose({ mode: action, originalEmail: latestMessage });
			return;
		}
		const complete = withCompleteBody(latestMessage);
		if (complete) {
			clearThreadAction();
			startCompose({ mode: "forward", originalEmail: complete });
		} else if (externalBodyQueriesById.get(latestMessage.id)?.isError) {
			clearThreadAction();
			toastManager.add({ title: "This message could not be loaded to forward", variant: "error" });
		}
	});

	const currentEmailId = email?.id;
	const newestMessageId = allMessages.at(-1)?.id;
	const seededSelectionRef = useRef<string | null>(null);
	useEffect(() => {
		if (!currentEmailId) return;
		pendingMessageFocusRef.current = currentEmailId;
		seededSelectionRef.current = null;
		setExpandedMessages(new Set([currentEmailId]));
	}, [currentEmailId]);
	// The newest message joins the opened one exactly once per selection, so a
	// reply arriving later never re-collapses what the reader has opened.
	useEffect(() => {
		if (!currentEmailId || !newestMessageId) return;
		if (seededSelectionRef.current === currentEmailId) return;
		seededSelectionRef.current = currentEmailId;
		setExpandedMessages((current) => new Set(current).add(newestMessageId));
	}, [currentEmailId, newestMessageId]);
	// Closing the inline composer hands focus back to the message it answered, so
	// the keyboard never lands on nothing. Queued before the focus effect below,
	// which is what actually moves focus on this same commit.
	const wasInlineComposingRef = useRef(false);
	useEffect(() => {
		if (wasInlineComposingRef.current && !isInlineComposing && newestMessageId) {
			pendingMessageFocusRef.current = newestMessageId;
		}
		wasInlineComposingRef.current = isInlineComposing;
	}, [isInlineComposing, newestMessageId]);

	useEffect(() => {
		const pendingId = pendingMessageFocusRef.current;
		const container = conversationScrollRef.current;
		if (!pendingId || !container) return;
		if (email?.thread_id && !threadRepliesFetched) return;
		const target = Array.from(
			container.querySelectorAll<HTMLElement>("[data-intelligence-message-id]"),
		).find((element) => element.dataset.intelligenceMessageId === pendingId);
		if (!target) return;
		target.scrollIntoView({ block: "start" });
		target.focus({ preventScroll: true });
		pendingMessageFocusRef.current = null;
	}, [currentEmailId, allMessages.length, expandedMessages, email?.thread_id, threadRepliesFetched, isInlineComposing]);

	const focusMessage = (messageId: string) => {
		pendingMessageFocusRef.current = messageId;
		setExpandedMessages((current) => new Set(current).add(messageId));
	};

	const toggleExpand = (msgId: string) => { setExpandedMessages((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; }); };

	const moveToFolders = useMemo(() => {
		const cur = folder || email?.folder_id;
		return folders.filter((candidate) =>
			candidate.id !== cur && candidate.id !== Folders.SNOOZED
		);
	}, [folders, folder, email?.folder_id]);
	const selectedLabelIds = useMemo(
		() => new Set((email?.labels ?? []).map((label) => label.id)),
		[email?.labels],
	);

	if (!email) return <EmailPanelSkeleton />;

	const bodyUnavailableReason = (message: Email) =>
		externalBodyQueriesById.get(message.id)?.isError
			? "Complete message unavailable"
			: "Loading complete message";
	const replyAddressesDiffer = (message: Email) => {
		const mailboxAddress = currentMailbox?.email ?? mailboxId ?? "";
		const reply = replyRecipientFields({ original: message, mailboxAddress, all: false });
		const everyone = replyRecipientFields({ original: message, mailboxAddress, all: true });
		return everyone.to !== reply.to || everyone.cc !== "";
	};
	const replyTo = (message: Email, all: boolean) =>
		startCompose({ mode: all ? "reply-all" : "reply", originalEmail: message });
	const forward = (message: Email) => {
		const complete = withCompleteBody(message);
		if (complete) startCompose({ mode: "forward", originalEmail: complete });
	};
	// Until the whole conversation is here, the newest message is unknown, so
	// Reply, Reply all and Forward wait rather than answer the wrong one.
	const conversationLoaded = !email.thread_id || threadRepliesFetched;
	const latest = latestMessage ?? email;
	const latestHasOthers = replyAddressesDiffer(latest);
	const canForwardLatest = conversationLoaded && withCompleteBody(latest) !== null;
	const latestUnavailableReason = conversationLoaded
		? bodyUnavailableReason(latest)
		: "Loading conversation";
	const showsReplyActions = !isDraftFolder && !isOutboxFolder;
	const canAnswer = (message: Email, isDraft: boolean) =>
		showsReplyActions && !isDraft && message.folder_id !== Folders.OUTBOX;

	const snoozeFolderId = email.folder_id ?? folder ?? Folders.INBOX;
	const reminderConversationKey = email.thread_id?.trim() || email.id;
	const activeFollowUpReminder = followUpReminders.find(
		(reminder) => reminder.conversationKey === reminderConversationKey,
	);
	const canSetFollowUpReminder = new Set<string>([
		Folders.INBOX,
		Folders.SENT,
		Folders.ARCHIVE,
		Folders.SNOOZED,
	]).has(snoozeFolderId);
	const snoozeConversationId = email.conversation_id ?? email.thread_id;
	const canSnooze = !isSnoozedFolder && !isDraftFolder && !isOutboxFolder &&
		!isTrashFolder && !new Set<string>([Folders.SENT, Folders.SPAM]).has(snoozeFolderId) &&
		!snoozeFolderId.startsWith("_");
	const snoozeScope = snoozeConversationId && allMessages.length > 1
		? {
				kind: "conversation" as const,
				conversationId: snoozeConversationId,
				emailId: email.id,
				folderId: snoozeFolderId,
			}
		: { kind: "message" as const, emailId: email.id };

	const toggleStar = () => { if (mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); };
	const handleMove = (folderId: string) => { if (mailboxId) { moveEmailMut.mutate({ mailboxId, id: email.id, folderId }); closePanel(); } };
	const handleDelete = () => {
		if (!mailboxId) return;
		const confirmed = window.confirm("Move this conversation to Trash?");
		if (!confirmed) return;
		deleteEmailMut.mutate(
			{ mailboxId, id: email.id },
			{
				onSuccess: () => {
					toastManager.add({ title: "Conversation moved to Trash" });
					closePanel();
				},
				onError: () =>
					toastManager.add({
						title: "Failed to move the conversation to Trash",
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
					toastManager.add({ title: "Conversation restored" });
					closePanel();
				},
				onError: () =>
					toastManager.add({
						title: "Failed to restore the conversation",
						variant: "error",
					}),
			},
		);
	};
	const handleUnsnooze = () => {
		if (!mailboxId || unsnooze.isPending) return;
		unsnooze.mutate(
			{ mailboxId, scope: snoozeScope },
			{
				onSuccess: () => {
					toastManager.add({ title: "Conversation returned" });
					closePanel();
				},
				onError: () =>
					toastManager.add({
						title: "Could not return the conversation",
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
			{ mailboxId, id: target.id, version: target.draft_version ?? 1 },
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
			const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
			const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
			const enqueueDraft = async (draft: Email) => {
				if (!draft.recipient) {
					throw new Error("Cannot send: no recipient set on this draft.");
				}
				if (!draft.draft_version) {
					throw new Error("Reload this draft before sending it.");
				}
				const draftRecipients = {
					to: draft.recipient,
					cc: draft.cc ?? "",
					bcc: draft.bcc ?? "",
				};
				const recipientError = recipientProblem(draftRecipients);
				if (recipientError) throw new Error(recipientError);
				const recipients = sendableRecipients(draftRecipients);
				const attachmentPolicy = evaluateStoredDraftAttachments(
					draft.id,
					draft.attachments,
					draft.body ?? "",
				);
				if (!attachmentPolicy.ok) throw new Error(attachmentPolicy.error);
				const sendPayload = {
					source_draft_id: draft.id,
					source_draft_version: draft.draft_version,
					to: toEmailListValue(recipients.to),
					cc: toEmailListValue(recipients.cc),
					bcc: toEmailListValue(recipients.bcc),
					from,
					subject: draft.subject || "(no subject)",
					html: draft.body || "",
					text: draft.body ? htmlToPlainText(draft.body) : "",
					attachments: attachmentPolicy.refs,
				};
				const emailData = {
					...sendPayload,
					idempotency_key: draftSendIdentityRef.current.keyFor(sendPayload),
				};
				// A reply draft goes through the reply route whether or not its thread
				// has loaded here; the server resolves the original. Only an original
				// that no longer exists sends it as a new message.
				const sendAsNew = () =>
					sendEmailMut.mutateAsync({ mailboxId, email: emailData });
				const result = draft.in_reply_to
					? await replyMut
							.mutateAsync({ mailboxId, emailId: draft.in_reply_to, email: emailData })
							.catch((error: unknown) => {
								if (error instanceof ApiError && error.status === 404) return sendAsNew();
								throw error;
							})
					: await sendAsNew();
				return { result, attachmentPolicy };
			};

			let { result, attachmentPolicy } = await enqueueDraft(target);
			let enqueuePlan = planComposeEnqueueResult(result);
			if (enqueuePlan.action === "renew_revision_and_resend") {
				target = await saveDraftMut.mutateAsync({
					mailboxId,
					draft: {
						to: target.recipient,
						cc: target.cc,
						bcc: target.bcc,
						subject: target.subject,
						body: target.body || "",
						in_reply_to: target.in_reply_to || undefined,
						thread_id: target.thread_id || undefined,
						draft_id: target.id,
						draft_version: target.draft_version,
						attachments: attachmentPolicy.refs,
					},
				});
				draftSendIdentityRef.current.reset();
				({ result, attachmentPolicy } = await enqueueDraft(target));
				enqueuePlan = planComposeEnqueueResult(result);
			}
			if (enqueuePlan.action !== "finish") {
				const message = enqueuePlan.action === "block"
					? enqueuePlan.message
					: "A prior delivery still owns this draft revision. Review it before sending again.";
				toastManager.add({ title: message, variant: "error" });
				return;
			}
			// Handed to the mailbox-level watcher: this panel closes on the next line
			// when sending from Drafts, so it cannot see the delivery settle.
			trackSend({
				deliveryId: result.deliveryId,
				emailId: result.id,
				mailboxId,
				scheduledFor: result.scheduledFor ?? undefined,
				title: enqueuePlan.title,
				canUndo: enqueuePlan.canUndo,
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
				draft.subject || prefixedSubject(target.subject || "", "Re");
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
				"AI couldn’t draft a reply. Try again.";
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
				isDraftFolder={isDraftFolder}
				isOutboxFolder={isOutboxFolder}
				isSnoozedFolder={isSnoozedFolder}
				canSnooze={canSnooze}
				isUnsnoozing={unsnooze.isPending}
				isSending={isSending}
				isDrafting={isDrafting}
				moveToFolders={moveToFolders}
				onBack={closePanel}
				onSendDraft={() => handleSendDraft()}
				onEditDraft={() => handleEditDraft()}
				onReply={() => replyTo(latest, false)}
				onReplyAll={latestHasOthers ? () => replyTo(latest, true) : undefined}
				onForward={() => forward(latest)}
				canReply={conversationLoaded}
				canForward={canForwardLatest}
				forwardUnavailableReason={latestUnavailableReason}
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
				onSnooze={() => setIsSnoozeOpen(true)}
				onUnsnooze={handleUnsnooze}
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
				<div className="ms-auto flex flex-wrap items-center justify-end gap-1">
					{mailboxId && canSetFollowUpReminder && (
						<FollowUpReminderControl
							mailboxId={mailboxId}
							emailId={email.id}
							reminder={activeFollowUpReminder}
						/>
					)}
					<LabelPicker
						labels={labels}
						selectedIds={selectedLabelIds}
						onToggle={handleLabelToggle}
						disabled={mutateLabels.isPending}
						buttonLabel="Edit labels"
					/>
				</div>
			</div>

			<div ref={conversationScrollRef} className="flex-1 overflow-y-auto">
				{allMessages.map((msg, idx) => {
						const isDraft = draftMessageIds.has(msg.id);
						return (
							<ThreadMessage
								key={msg.id}
								email={msg}
								mailboxId={mailboxId}
								mailboxEmail={currentMailbox?.email}
								isLast={idx === allMessages.length - 1}
								isSoleMessage={!hasThread}
								isDraft={isDraft}
								isSending={isDraft ? isSending : false}
								isExpanded={expandedMessages.has(msg.id)}
								onToggleExpand={() => toggleExpand(msg.id)}
								onSendDraft={isDraft ? () => handleSendDraft(msg) : undefined}
								onEditDraft={isDraft ? () => handleEditDraft(msg) : undefined}
								onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
								onViewSource={() => setSourceViewEmail(msg)}
								onReply={canAnswer(msg, isDraft) ? () => replyTo(msg, false) : undefined}
								onReplyAll={canAnswer(msg, isDraft) && replyAddressesDiffer(msg)
									? () => replyTo(msg, true)
									: undefined}
								onForward={canAnswer(msg, isDraft) ? () => forward(msg) : undefined}
								forwardUnavailableReason={withCompleteBody(msg) ? undefined : bodyUnavailableReason(msg)}
								onPreviewImage={(url, filename) =>
									setPreviewImage({ url, filename })
								}
								bodyState={externalBodyQueriesById.get(msg.id)}
							/>
						);
					})}
				{showsReplyActions && conversationLoaded && !isInlineComposing && (
					<div className="flex flex-wrap gap-2 border-t border-kumo-line px-4 py-4 md:px-6">
						<Button
							variant="secondary"
							icon={<ArrowBendUpLeftIcon size={16} />}
							className="min-h-11"
							onClick={() => replyTo(latest, false)}
						>
							Reply
						</Button>
						{latestHasOthers && (
							<Button
								variant="secondary"
								icon={<ArrowBendDoubleUpLeftIcon size={16} />}
								className="min-h-11"
								onClick={() => replyTo(latest, true)}
							>
								Reply all
							</Button>
						)}
						<Button
							variant="secondary"
							icon={<ArrowBendUpRightIcon size={16} />}
							className="min-h-11"
							onClick={() => forward(latest)}
							disabled={!canForwardLatest}
							title={canForwardLatest ? undefined : latestUnavailableReason}
						>
							Forward
						</Button>
					</div>
				)}
				{/* The one composer instance renders itself in here when it is answering
				    this thread. Kept unconditional so it exists before compose opens. */}
				<div id={INLINE_COMPOSE_HOST_ID} />
				{!isIntelligenceUnsupported && mailboxId && (
					<ConversationIntelligenceCard
						mailboxId={mailboxId}
						emailId={email.id}
						onFocusMessage={focusMessage}
					/>
				)}
				{mailboxId && hasAuthoritativeActivityMailbox && (
					<ConversationActivity
						key={`${mailboxId}:${email.id}`}
						mailboxId={mailboxId}
						emailId={email.id}
						isSharedMailbox={activityMailboxType === "SHARED"}
					/>
				)}
			</div>

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>

			{mailboxId && isSnoozeOpen && (
				<SnoozeDialog
					mailboxId={mailboxId}
					target={{
						emailId: email.id,
						folderId: snoozeFolderId,
						conversationId: snoozeConversationId,
						conversationCount: allMessages.length,
					}}
					open
					onOpenChange={setIsSnoozeOpen}
				/>
			)}
		</div>
	);
}
