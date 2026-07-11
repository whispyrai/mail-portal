// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Pagination,
	Tooltip,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowCounterClockwiseIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Folders } from "shared/folders";
import { formatListDate } from "shared/dates";
import MailboxSplitView from "~/components/MailboxSplitView";
import BatchTriageToolbar from "~/components/BatchTriageToolbar";
import LabelChip from "~/components/labels/LabelChip";
import LabelPicker from "~/components/labels/LabelPicker";
import { MAIL_COMMAND_EVENT } from "~/components/MailKeyboardController";
import OutboundDeliveryActions from "~/components/OutboundDeliveryActions";
import SaveCurrentViewButton from "~/components/SaveCurrentViewButton";
import {
	resolveVisibleMailTargetId,
	type MailCommand,
} from "~/lib/mail-keyboard";
import { planKeyboardConversationAction } from "~/lib/conversation-actions";
import { indexDeliveryHighlights } from "~/lib/delivery-highlights";
import {
	batchSelectionsEqual,
	batchSelectionContextKey,
	reconcileVisibleSelection,
	selectAllVisible,
	toggleVisibleSelection,
} from "~/lib/batch-selection";
import {
	outboxFolderView,
	shouldLoadOutboundState,
} from "~/lib/outbound-folder-state";
import { getSnippetText } from "~/lib/utils";
import { definitionFromFolderView } from "~/lib/saved-view-navigation";
import {
	useDeleteEmail,
	useArchiveConversation,
	useBatchTriage,
	useDiscardDraft,
	useEmails,
	useMarkThreadRead,
	useMoveEmail,
	useRestoreEmail,
	useOutboundDeliveries,
	useSetConversationRead,
	useTrashConversation,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useLabels, useMutateLabels } from "~/queries/labels";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import type {
	Email,
	Label,
	LabelMutationTarget,
	OutboundDelivery,
} from "~/types";
import {
	isBatchTriageActionAllowed,
	type BatchTriageAction,
} from "../../shared/batch-triage";

const PAGE_SIZE = 25;

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Your inbox is empty",
		description:
			"New emails will appear here when they arrive. Send an email to get the conversation started.",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon
				size={48}
				weight="thin"
				className="text-kumo-subtle"
			/>
		),
		title: "No sent emails",
		description: "Emails you send will show up here.",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "No drafts",
		description: "Emails you're still working on will be saved here.",
		showCompose: true,
	},
	[Folders.OUTBOX]: {
		icon: (
			<PaperPlaneTiltIcon
				size={48}
				weight="thin"
				className="text-kumo-subtle"
			/>
		),
		title: "Outbox is clear",
		description:
			"Queued, scheduled, retrying, and uncertain deliveries appear here.",
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Archive is empty",
		description:
			"Move emails here to keep your inbox clean without deleting them.",
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Trash is empty",
		description:
			"Emails moved to Trash will appear here and remain restorable.",
	},
};

function EmailListSkeleton() {
	return (
		<div
			className="animate-pulse motion-reduce:animate-none space-y-1 p-2"
			aria-label="Loading conversations"
		>
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon
				size={48}
				weight="thin"
				className="text-kumo-subtle"
			/>
		),
		title: "No emails",
		description: "This folder is empty.",
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{config.title}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{config.description}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					Compose
				</Button>
			)}
		</div>
	);
}

function deliveryLabel(delivery: OutboundDelivery) {
	if (delivery.status === "queued" && delivery.scheduledFor) return "Scheduled";
	return {
		queued: "Undo available",
		sending: "Sending",
		retrying: "Retrying",
		sent: "Sent",
		bounced: "Bounced",
		failed: "Failed",
		unknown: "Delivery uncertain",
		cancelled: "Cancelled",
	}[delivery.status];
}

function deliveryBadgeClass(status: OutboundDelivery["status"]) {
	if (status === "failed" || status === "bounced") {
		return "bg-kumo-danger/10 text-kumo-danger";
	}
	if (status === "unknown") return "bg-kumo-warning/10 text-kumo-warning";
	if (status === "sending" || status === "retrying") {
		return "bg-kumo-brand/10 text-kumo-brand";
	}
	return "bg-kumo-fill text-kumo-subtle";
}

export default function EmailListRoute() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const { selectedEmailId, selectEmail, closePanel, startCompose } =
		useUIStore();
	const [page, setPage] = useState(1);
	const [keyboardTargetId, setKeyboardTargetId] = useState<string | null>(null);
	const [batchSelection, setBatchSelection] = useState<Set<string>>(
		() => new Set(),
	);
	const [searchParams, setSearchParams] = useSearchParams();
	const labelId = searchParams.get("label_id") ?? "";
	const toastManager = useKumoToastManager();

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const moveEmail = useMoveEmail();
	const deleteEmail = useDeleteEmail();
	const discardDraft = useDiscardDraft();
	const restoreEmail = useRestoreEmail();
	const setConversationRead = useSetConversationRead();
	const archiveConversation = useArchiveConversation();
	const trashConversation = useTrashConversation();
	const batchTriage = useBatchTriage();
	const mutateLabels = useMutateLabels();
	const isOutbox = folder === Folders.OUTBOX;
	const { data: labels = [] } = useLabels(mailboxId);

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
			...(labelId ? { label_id: labelId } : {}),
		}),
		[folder, labelId, page],
	);

	const { data: emailData, isFetching: isRefreshing } = useEmails(
		mailboxId,
		params,
		{ refetchInterval: 30_000 },
	);

	const rawEmails = emailData?.emails ?? [];
	const { data: outboundDeliveries = [] } = useOutboundDeliveries(
		mailboxId,
		rawEmails,
		shouldLoadOutboundState(folder),
		folder === Folders.SENT,
	);
	const directDeliveryByEmailId = useMemo(
		() =>
			new Map(
				outboundDeliveries.map((delivery) => [delivery.emailId, delivery]),
			),
		[outboundDeliveries],
	);
	const deliveryByEmailId = useMemo(
		() =>
			isOutbox
				? directDeliveryByEmailId
				: indexDeliveryHighlights(rawEmails, outboundDeliveries),
		[directDeliveryByEmailId, isOutbox, outboundDeliveries, rawEmails],
	);
	const folderView = isOutbox
		? outboxFolderView(rawEmails, deliveryByEmailId, emailData?.totalCount ?? 0)
		: { emails: rawEmails, totalCount: emailData?.totalCount ?? 0 };
	const { emails, totalCount } = folderView;
	const visibleEmailIds = useMemo(
		() => emails.map((email) => email.id),
		[emails],
	);
	const selectionContext = batchSelectionContextKey({
		mailboxId: mailboxId ?? "",
		folderId: folder ?? "",
		page,
		searchQuery: labelId,
	});
	const previousSelectionContext = useRef(selectionContext);
	const selectedVisibleIds = useMemo(
		() => reconcileVisibleSelection(batchSelection, visibleEmailIds),
		[batchSelection, visibleEmailIds],
	);
	const selectedEmails = useMemo(
		() => emails.filter((email) => selectedVisibleIds.has(email.id)),
		[emails, selectedVisibleIds],
	);
	const labelMutationTargets = useMemo<LabelMutationTarget[]>(
		() =>
			selectedEmails.flatMap((email) => {
				if (!folder) return [];
				const conversationId =
					(email.thread_count ?? 1) > 1
						? (email.conversation_id ?? email.thread_id ?? undefined)
						: undefined;
				return [
					{
						emailId: email.id,
						folderId: folder,
						...(conversationId ? { conversationId } : {}),
					},
				];
			}),
		[folder, selectedEmails],
	);
	const selectedBatchLabelIds = useMemo(
		() =>
			new Set(
				labels
					.filter(
						(label) =>
							selectedEmails.length > 0 &&
							selectedEmails.every((email) =>
								(email.labels ?? []).some((current) => current.id === label.id),
							),
					)
					.map((label) => label.id),
			),
		[labels, selectedEmails],
	);
	const selectedLabel = labels.find((label) => label.id === labelId);
	const allowedBatchActions = useMemo(() => {
		const actions: BatchTriageAction[] = [
			"mark_read",
			"mark_unread",
			"archive",
			"trash",
		];
		return new Set(
			actions.filter(
				(action) =>
					Boolean(folder) && isBatchTriageActionAllowed(action, folder!),
			),
		);
	}, [folder]);

	const { data: folders = [] } = useFolders(mailboxId);

	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		if (found) return found.name;
		return folder ? folder.charAt(0).toUpperCase() + folder.slice(1) : "Inbox";
	}, [folders, folder]);
	const currentViewDefinition = useMemo(
		() =>
			definitionFromFolderView({
				folder: folder || Folders.INBOX,
				searchParams,
			}),
		[folder, searchParams],
	);

	const isPanelOpen = selectedEmailId !== null;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged =
			prevFolderRef.current !== `${mailboxId}/${folder}/${labelId}`;
		prevFolderRef.current = `${mailboxId}/${folder}/${labelId}`;

		if (folderChanged) {
			closePanel();
			setPage(1);
		}
	}, [mailboxId, folder, labelId, closePanel]);

	useEffect(() => {
		if (previousSelectionContext.current !== selectionContext) {
			previousSelectionContext.current = selectionContext;
			setBatchSelection(new Set());
			return;
		}
		setBatchSelection((current) => {
			const next = reconcileVisibleSelection(current, visibleEmailIds);
			return batchSelectionsEqual(next, current) ? current : next;
		});
	}, [selectionContext, visibleEmailIds]);

	// Deep-link from a push notification tap: `?email=<id>` opens that email,
	// then the param is consumed so closing the panel doesn't reopen it (WISER-240).
	// Runs after the folder-change effect above, so its selection wins on mount.
	useEffect(() => {
		const emailId = searchParams.get("email");
		if (!emailId) return;
		selectEmail(emailId);
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("email");
				return next;
			},
			{ replace: true },
		);
	}, [searchParams, selectEmail, setSearchParams]);

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	const handleDelete = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId) {
			const confirmed = window.confirm("Move this email to Trash?");
			if (!confirmed) return;
			deleteEmail.mutate(
				{ mailboxId, id: emailId },
				{
					onSuccess: () => {
						toastManager.add({ title: "Email moved to Trash" });
						if (selectedEmailId === emailId) closePanel();
					},
					onError: () =>
						toastManager.add({
							title: "Failed to move email to Trash",
							variant: "error",
						}),
				},
			);
		}
	};

	const handleRestore = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (!mailboxId) return;
		restoreEmail.mutate(
			{ mailboxId, id: emailId },
			{
				onSuccess: () => {
					toastManager.add({ title: "Email restored" });
					if (selectedEmailId === emailId) closePanel();
				},
				onError: () =>
					toastManager.add({
						title: "Failed to restore email",
						variant: "error",
					}),
			},
		);
	};

	const handleDiscardDraft = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (!mailboxId || !window.confirm("Discard this draft?")) return;
		discardDraft.mutate(
			{ mailboxId, id: emailId },
			{
				onSuccess: () => {
					toastManager.add({ title: "Draft discarded" });
					if (selectedEmailId === emailId) closePanel();
				},
				onError: () =>
					toastManager.add({
						title: "Failed to discard draft",
						variant: "error",
					}),
			},
		);
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	const handleBatchAction = (action: BatchTriageAction) => {
		if (!mailboxId || !folder || batchTriage.isPending) return;
		if (
			action === "trash" &&
			!window.confirm(
				`Move ${selectedVisibleIds.size} selected conversation${selectedVisibleIds.size === 1 ? "" : "s"} to Trash?`,
			)
		)
			return;
		const targets = emails.flatMap((email) => {
			if (!selectedVisibleIds.has(email.id)) return [];
			const conversationId =
				(email.thread_count ?? 1) > 1
					? (email.conversation_id ?? email.thread_id ?? undefined)
					: undefined;
			return [
				{
					emailId: email.id,
					folderId: folder,
					...(conversationId ? { conversationId } : {}),
				},
			];
		});
		if (targets.length === 0) return;
		batchTriage.mutate(
			{ mailboxId, command: { action, targets } },
			{
				onSuccess: (result) => {
					const failedIds = new Set(
						result.results
							.filter((item) => item.status !== "updated")
							.map((item) => item.emailId),
					);
					setBatchSelection(
						reconcileVisibleSelection(failedIds, visibleEmailIds),
					);
					if (
						selectedEmailId &&
						result.results.some(
							(item) =>
								item.emailId === selectedEmailId && item.status === "updated",
						)
					)
						closePanel();
					toastManager.add({
						title:
							result.failedCount > 0
								? `${result.succeededCount} updated; ${result.failedCount} could not be changed`
								: `${result.succeededCount} conversation${result.succeededCount === 1 ? "" : "s"} updated`,
						variant: result.failedCount > 0 ? "error" : undefined,
					});
				},
				onError: () =>
					toastManager.add({
						title:
							"Bulk action could not be confirmed. Refreshing mailbox state.",
						variant: "error",
					}),
			},
		);
	};

	const handleBatchLabelToggle = (label: Label, selected: boolean) => {
		if (!mailboxId || labelMutationTargets.length === 0) return;
		mutateLabels.mutate(
			{
				mailboxId,
				labelId: label.id,
				action: selected ? "apply" : "remove",
				targets: labelMutationTargets,
			},
			{
				onSuccess: (result) => {
					const failed = result.results.filter(
						(item) => item.status !== "updated",
					).length;
					toastManager.add({
						title:
							failed > 0
								? `Label updated on ${result.results.length - failed}; ${failed} could not be changed`
								: `${selected ? "Applied" : "Removed"} ${label.name}`,
						variant: failed > 0 ? "error" : undefined,
					});
				},
				onError: () =>
					toastManager.add({ title: "Label change failed", variant: "error" }),
			},
		);
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		setKeyboardTargetId(email.id);
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	useEffect(() => {
		const onMailCommand = (event: Event) => {
			const command = (event as CustomEvent<MailCommand>).detail;
			if (!command) return;
			if (command === "refresh") {
				handleRefresh();
				return;
			}
			if (emails.length === 0) return;
			const currentId = keyboardTargetId ?? selectedEmailId;
			const currentIndex = currentId
				? emails.findIndex((email) => email.id === currentId)
				: -1;
			const targetId = resolveVisibleMailTargetId(
				visibleEmailIds,
				currentId,
				command === "next-message" ||
					command === "previous-message" ||
					command === "open-message",
			);
			const target = targetId
				? emails.find((email) => email.id === targetId)
				: undefined;

			if (command === "next-message" || command === "previous-message") {
				const nextIndex =
					command === "next-message"
						? Math.min(
								currentIndex < 0 ? 0 : currentIndex + 1,
								emails.length - 1,
							)
						: Math.max(
								currentIndex < 0 ? emails.length - 1 : currentIndex - 1,
								0,
							);
				const next = emails[nextIndex];
				if (!next) return;
				if (selectedEmailId) handleRowClick(next);
				else setKeyboardTargetId(next.id);
				document
					.querySelector<HTMLElement>(
						`[data-email-id="${CSS.escape(next.id)}"]`,
					)
					?.scrollIntoView({ block: "nearest" });
				return;
			}

			if (!target || !mailboxId || !folder) return;
			switch (command) {
				case "open-message":
					handleRowClick(target);
					return;
				case "reply":
					if (!isOutbox && folder !== Folders.DRAFT) {
						selectEmail(target.id);
						startCompose({ mode: "reply", originalEmail: target });
					}
					return;
				case "archive":
					{
						const action = planKeyboardConversationAction(
							"archive",
							target,
							folder,
						);
						if (!action) return;
						if (action.kind === "conversation-archive") {
							archiveConversation.mutate({ mailboxId, ...action });
						} else if (action.kind === "email-archive") {
							moveEmail.mutate({
								mailboxId,
								id: action.emailId,
								folderId: Folders.ARCHIVE,
							});
						}
						setKeyboardTargetId(null);
						closePanel();
					}
					return;
				case "trash":
					{
						const action = planKeyboardConversationAction(
							"trash",
							target,
							folder,
						);
						if (!action || !window.confirm("Move this conversation to Trash?"))
							return;
						if (action.kind === "conversation-trash") {
							trashConversation.mutate({ mailboxId, ...action });
						} else if (action.kind === "email-trash") {
							deleteEmail.mutate({ mailboxId, id: action.emailId });
						}
						setKeyboardTargetId(null);
						closePanel();
					}
					return;
				case "toggle-unread":
					{
						const action = planKeyboardConversationAction(
							"toggle-unread",
							target,
							folder,
						);
						if (!action) return;
						if (action.kind === "conversation-read") {
							setConversationRead.mutate({ mailboxId, ...action });
						} else if (action.kind === "email-read") {
							updateEmail.mutate({
								mailboxId,
								id: action.emailId,
								data: { read: action.read },
							});
						}
					}
					return;
				case "toggle-star":
					if (!isOutbox) {
						updateEmail.mutate({
							mailboxId,
							id: target.id,
							data: { starred: !target.starred },
						});
					}
					return;
				default:
					return;
			}
		};

		window.addEventListener(MAIL_COMMAND_EVENT, onMailCommand);
		return () => window.removeEventListener(MAIL_COMMAND_EVENT, onMailCommand);
	}, [
		archiveConversation,
		closePanel,
		deleteEmail,
		emails,
		folder,
		handleRefresh,
		isOutbox,
		keyboardTargetId,
		mailboxId,
		moveEmail,
		selectEmail,
		selectedEmailId,
		startCompose,
		setConversationRead,
		trashConversation,
		updateEmail,
		visibleEmailIds,
	]);

	const formatParticipants = (email: Email): string => {
		if (email.participants) {
			const names = email.participants
				.split(",")
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender.split("@")[0];
	};

	return (
		<MailboxSplitView selectedEmailId={selectedEmailId}>
			{/* Folder header */}
			<div className="flex items-center justify-between px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
				<div className="flex min-w-0 items-center gap-2">
					<h1 className="truncate text-lg font-semibold text-kumo-default">
						{folderName}
					</h1>
					{selectedLabel && <LabelChip label={selectedLabel} />}
					{labelId && (
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<XIcon size={14} />}
							onClick={() =>
								setSearchParams((current) => {
									const next = new URLSearchParams(current);
									next.delete("label_id");
									return next;
								})
							}
							aria-label="Clear label filter"
						/>
					)}
				</div>
				<div className="flex items-center gap-1">
					{mailboxId && (
						<SaveCurrentViewButton
							mailboxId={mailboxId}
							definition={currentViewDefinition}
							defaultName={
								selectedLabel
									? `${folderName}: ${selectedLabel.name}`
									: folderName
							}
						/>
					)}
					{totalCount > 0 && (
						<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
							{totalCount} conversation{totalCount !== 1 ? "s" : ""}
						</span>
					)}
					<Tooltip
						content={isRefreshing ? "Refreshing..." : "Refresh"}
						side="bottom"
						asChild
					>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={
								<ArrowsClockwiseIcon
									size={18}
									className={
										isRefreshing
											? "animate-spin motion-reduce:animate-none"
											: ""
									}
								/>
							}
							onClick={handleRefresh}
							disabled={isRefreshing}
							aria-label="Refresh"
						/>
					</Tooltip>
				</div>
			</div>
			{emails.length > 0 && allowedBatchActions.size > 0 && (
				<BatchTriageToolbar
					visibleCount={emails.length}
					selectedCount={selectedVisibleIds.size}
					allowedActions={allowedBatchActions}
					disabled={batchTriage.isPending || mutateLabels.isPending}
					onToggleAll={() =>
						setBatchSelection((current) =>
							selectedVisibleIds.size === visibleEmailIds.length
								? new Set()
								: selectAllVisible(current, visibleEmailIds),
						)
					}
					onClear={() => setBatchSelection(new Set())}
					onAction={handleBatchAction}
					labelControl={
						<LabelPicker
							labels={labels}
							selectedIds={selectedBatchLabelIds}
							onToggle={handleBatchLabelToggle}
							disabled={mutateLabels.isPending}
							buttonLabel="Label selected"
						/>
					}
				/>
			)}

			{/* Email rows */}
			<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
					<div role="list" aria-label={`${folderName} conversations`}>
						{emails.map((email) => {
							const isSelected = selectedEmailId === email.id;
							const isBatchSelected = selectedVisibleIds.has(email.id);
							const isKeyboardTarget = keyboardTargetId === email.id;
							const snippet = getSnippetText(email.snippet);
							const delivery = deliveryByEmailId.get(email.id);
							return (
								<div
									key={email.id}
									data-email-id={email.id}
									role="listitem"
									className={`group flex min-w-0 items-center gap-1.5 sm:gap-2 w-full text-left transition-colors border-b border-kumo-line border-s-2 px-2 py-1.5 sm:px-3 md:px-4 md:py-2 ${
										isPanelOpen ? "md:px-4 md:py-2.5" : ""
									} ${isSelected || isBatchSelected ? "bg-kumo-fill border-s-kumo-brand" : "border-s-transparent hover:bg-kumo-tint"} ${isKeyboardTarget ? "ring-2 ring-inset ring-kumo-brand/50" : ""}`}
								>
									{allowedBatchActions.size > 0 && (
										<label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded focus-within:ring-2 focus-within:ring-kumo-brand">
											<input
												type="checkbox"
												className="h-5 w-5 accent-kumo-brand"
												checked={isBatchSelected}
												onChange={() =>
													setBatchSelection((current) =>
														toggleVisibleSelection(
															current,
															email.id,
															visibleEmailIds,
														),
													)
												}
												aria-label={`Select conversation ${email.subject || "without subject"}`}
											/>
										</label>
									)}

									<button
										type="button"
										className="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-transparent text-kumo-subtle hover:text-kumo-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
										onClick={(e) => toggleStar(e, email)}
										aria-label={
											email.starred
												? `Unstar ${email.subject}`
												: `Star ${email.subject}`
										}
									>
										<StarIcon
											size={18}
											weight={email.starred ? "fill" : "regular"}
											className={
												email.starred ? "text-kumo-warning" : undefined
											}
										/>
									</button>

									<button
										type="button"
										className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
										onClick={() => handleRowClick(email)}
										aria-label={`Open conversation ${email.subject || "without subject"}`}
									>
										{/* Unread dot */}
										<div className="w-2.5 shrink-0 flex justify-center">
											{hasUnread(email) && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-danger font-medium">
														Draft
													</span>
												)}
												{delivery && (
													<span
														className={`max-w-24 shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] font-semibold ${deliveryBadgeClass(delivery.status)}`}
														title={delivery.lastErrorMessage}
													>
														{deliveryLabel(delivery)}
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content="Needs reply" asChild>
														<span className="shrink-0 text-kumo-warning">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
													{formatListDate(email.date)}
												</span>
											</div>
											<div className="truncate text-sm mt-0.5">
												<span
													className={
														hasUnread(email)
															? "font-medium text-kumo-default"
															: "text-kumo-subtle"
													}
												>
													{email.subject}
												</span>
												{(email.labels ?? []).slice(0, 2).map((label) => (
													<LabelChip key={label.id} label={label} />
												))}
												{snippet && (
													<span className="text-kumo-subtle font-normal">
														{" "}
														&mdash; {snippet}
													</span>
												)}
											</div>
										</div>
									</button>

									{isOutbox && mailboxId && delivery && (
										<OutboundDeliveryActions
											mailboxId={mailboxId}
											delivery={delivery}
											compact
										/>
									)}

									{/* Secondary actions remain hover-only on pointer devices. */}
									{!isOutbox && (
										<div className="hidden items-center shrink-0 group-hover:flex group-focus-within:flex">
											<>
												<Tooltip
													content={email.read ? "Mark unread" : "Mark read"}
													asChild
												>
													<Button
														variant="ghost"
														shape="square"
														size="sm"
														className="min-h-11 min-w-11"
														icon={
															email.read ? (
																<EnvelopeSimpleIcon size={14} />
															) : (
																<EnvelopeOpenIcon size={14} />
															)
														}
														onClick={(e) => {
															e.stopPropagation();
															if (mailboxId)
																updateEmail.mutate({
																	mailboxId,
																	id: email.id,
																	data: { read: !email.read },
																});
														}}
														aria-label={
															email.read ? "Mark unread" : "Mark read"
														}
													/>
												</Tooltip>
												<Tooltip
													content={
														folder === Folders.TRASH
															? "Restore"
															: folder === Folders.DRAFT
																? "Discard draft"
																: "Move to Trash"
													}
													asChild
												>
													<Button
														variant="ghost"
														shape="square"
														size="sm"
														className="min-h-11 min-w-11"
														icon={
															folder === Folders.TRASH ? (
																<ArrowCounterClockwiseIcon size={14} />
															) : (
																<TrashIcon size={14} />
															)
														}
														onClick={(e) =>
															folder === Folders.TRASH
																? handleRestore(e, email.id)
																: folder === Folders.DRAFT
																	? handleDiscardDraft(e, email.id)
																	: handleDelete(e, email.id)
														}
														aria-label={
															folder === Folders.TRASH
																? "Restore"
																: folder === Folders.DRAFT
																	? "Discard draft"
																	: "Move to Trash"
														}
													/>
												</Tooltip>
											</>
										</div>
									)}
								</div>
							);
						})}
					</div>
				) : (
					<FolderEmptyState folder={folder} onCompose={() => startCompose()} />
				)}
			</div>

			{/* Pagination */}
			{totalCount > PAGE_SIZE && (
				<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
					<Pagination
						page={page}
						setPage={setPage}
						perPage={PAGE_SIZE}
						totalCount={totalCount}
					/>
				</div>
			)}
		</MailboxSplitView>
	);
}
