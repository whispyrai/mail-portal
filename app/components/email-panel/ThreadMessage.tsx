// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, DropdownMenu, Tooltip } from "@cloudflare/kumo";
import {
	ArrowBendDoubleUpLeftIcon,
	ArrowBendUpLeftIcon,
	ArrowBendUpRightIcon,
	CaretDownIcon,
	CaretUpIcon,
	CodeIcon,
	DotsThreeVerticalIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import { normalizedAddress } from "shared/recipient-addresses";
import {
	formatDetailDate,
	formatShortDate,
	stripHtml,
} from "~/lib/utils";
import type { Email } from "~/types";
import EmailMessageBody, {
	type EmailBodyLoadState,
} from "~/components/email-panel/EmailMessageBody";

interface ThreadMessageProps {
	email: Email;
	mailboxId?: string;
	mailboxEmail?: string;
	isLast: boolean;
	/**
	 * The only message in this conversation. It never collapses (there would be
	 * nothing left to read) and its attachments carry a heading.
	 */
	isSoleMessage?: boolean;
	isDraft?: boolean;
	isSending?: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onSendDraft?: () => void;
	onEditDraft?: () => void;
	onDeleteDraft?: () => void;
	onViewSource?: () => void;
	/** Answer this particular message rather than the newest one. */
	onReply?: () => void;
	/** Absent when nobody but the sender would get the reply. */
	onReplyAll?: () => void;
	onForward?: () => void;
	/** Why Forward is waiting, while this message's complete body loads. */
	forwardUnavailableReason?: string;
	onPreviewImage?: (url: string, filename: string) => void;
	bodyState?: EmailBodyLoadState;
}

function Avatar({ isDraft, isSelf, sender }: { isDraft?: boolean; isSelf: boolean; sender: string }) {
	return (
		<div
			className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
				isDraft
					? "bg-kumo-fill text-kumo-subtle"
					: isSelf
						? "bg-kumo-brand text-kumo-inverse"
						: "bg-kumo-fill text-kumo-default"
			}`}
		>
			{isDraft ? "D" : sender.charAt(0).toUpperCase()}
		</div>
	);
}

export default function ThreadMessage({
	email,
	mailboxId,
	mailboxEmail,
	isLast,
	isSoleMessage,
	isDraft,
	isSending,
	isExpanded,
	onToggleExpand,
	onSendDraft,
	onEditDraft,
	onDeleteDraft,
	onViewSource,
	onReply,
	onReplyAll,
	onForward,
	forwardUnavailableReason,
	onPreviewImage,
	bodyState,
}: ThreadMessageProps) {
	const normalizedMailbox = normalizedAddress(mailboxEmail ?? "");
	const isSelf = normalizedMailbox !== "" &&
		normalizedAddress(email.sender) === normalizedMailbox;
	const containerClassName = `${!isLast ? "border-b border-kumo-line" : ""} ${isDraft ? "border-l-2 border-l-kumo-warning bg-kumo-warning/[0.02]" : ""}`;
	const senderName = email.sender_name?.trim().replace(/^"(.*)"$/, "$1").trim();
	const senderLabel = isDraft
		? "Draft reply"
		: isSelf
			? "You"
			: senderName || email.sender;
	const showsSenderAddress = !isDraft && senderLabel !== email.sender;

	if (!isExpanded && !isSoleMessage) {
		return (
			<div
				className={containerClassName}
				data-intelligence-message-id={email.id}
				tabIndex={-1}
				aria-label={`Message from ${senderLabel}, ${formatDetailDate(email.date)}`}
			>
				<button
					type="button"
					onClick={onToggleExpand}
					className="w-full flex items-center gap-3 px-4 py-3 hover:bg-kumo-tint rounded-lg text-left"
				>
					<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
					<div className="flex-1 min-w-0">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium text-kumo-default truncate">
								{senderLabel}
							</span>
							<span className="text-xs text-kumo-subtle shrink-0">
								{formatDetailDate(email.date)}
							</span>
						</div>
						<p className="text-xs text-kumo-subtle truncate">
							{stripHtml(email.body || "").slice(0, 80)}
						</p>
					</div>
					<CaretDownIcon size={14} className="text-kumo-subtle shrink-0" />
				</button>
			</div>
		);
	}

	return (
		<div
			className={`group/thread-msg ${containerClassName}`}
			data-intelligence-message-id={email.id}
			tabIndex={-1}
			aria-label={`Message from ${senderLabel}, ${formatDetailDate(email.date)}`}
		>
			<div className="px-4 py-4 md:px-6">
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2.5 min-w-0">
						{isSoleMessage ? (
							<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
						) : (
							<button
								type="button"
								onClick={onToggleExpand}
								className="shrink-0"
								aria-label="Collapse message"
							>
								<div className="cursor-pointer hover:ring-2 hover:ring-kumo-brand/30 transition-shadow rounded-full">
									<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
								</div>
							</button>
						)}
						<div className="min-w-0">
							<div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
								<span className="text-sm font-medium text-kumo-default truncate">
									{senderLabel}
								</span>
								{showsSenderAddress && (
									<span className="truncate text-xs text-kumo-subtle">
										{email.sender}
									</span>
								)}
								{isDraft && <Badge variant="outline">Draft</Badge>}
							</div>
						</div>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						<span className="text-xs text-kumo-subtle">
							{formatShortDate(email.date)}
						</span>
						{onReply && (
							<Tooltip content="Reply to this message" side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<ArrowBendUpLeftIcon size={16} />}
									onClick={onReply}
									aria-label="Reply to this message"
								/>
							</Tooltip>
						)}
						{(onReplyAll || onForward) && (
							<DropdownMenu>
								<DropdownMenu.Trigger
									render={
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											icon={<DotsThreeVerticalIcon size={16} weight="bold" />}
											aria-label="More actions for this message"
										/>
									}
								/>
								<DropdownMenu.Content>
									{onReplyAll && (
										<DropdownMenu.Item
											icon={ArrowBendDoubleUpLeftIcon}
											className="min-h-11"
											onClick={onReplyAll}
										>
											Reply all
										</DropdownMenu.Item>
									)}
									{onForward && (
										<DropdownMenu.Item
											icon={ArrowBendUpRightIcon}
											className="min-h-11"
											disabled={Boolean(forwardUnavailableReason)}
											onClick={onForward}
										>
											{forwardUnavailableReason
												? `Forward (${forwardUnavailableReason.toLowerCase()})`
												: "Forward"}
										</DropdownMenu.Item>
									)}
								</DropdownMenu.Content>
							</DropdownMenu>
						)}
						{onViewSource && (
							<Tooltip content="View source" side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<CodeIcon size={14} />}
									onClick={onViewSource}
									aria-label="View source"
									className="transition-opacity !h-6 !w-6"
								/>
							</Tooltip>
						)}
						{!isSoleMessage && (
							<button
								type="button"
								onClick={onToggleExpand}
								className="ml-1"
								aria-label="Collapse message"
							>
								<CaretUpIcon
									size={14}
									className="text-kumo-subtle hover:text-kumo-default transition-colors"
								/>
							</button>
						)}
					</div>
				</div>

				{/* Everyone the message went to, on its own full-width rows so a long
				    Cc list never squeezes against the actions. */}
				<dl className="mt-1 mb-3 grid grid-cols-[auto_1fr] gap-x-1.5 text-xs text-kumo-subtle md:ml-[42px]">
					{email.recipient && (
						<>
							<dt>To:</dt>
							<dd className="min-w-0 break-words">{email.recipient}</dd>
						</>
					)}
					{email.cc && (
						<>
							<dt>Cc:</dt>
							<dd className="min-w-0 break-words">{email.cc}</dd>
						</>
					)}
					{isSelf && email.bcc && (
						<>
							<dt>Bcc:</dt>
							<dd className="min-w-0 break-words">{email.bcc}</dd>
						</>
					)}
				</dl>

				<div className="md:ml-[42px]">
					<EmailMessageBody
						email={email}
						mailboxId={mailboxId}
						bodyState={bodyState}
						senderLabel={senderLabel}
						autoSize
					/>
				</div>

				{isDraft && (onSendDraft || onEditDraft || onDeleteDraft) && (
					<div className="flex gap-2 mt-3 md:ml-[42px]">
						{onSendDraft && (
							<Button
								variant="primary"
								size="sm"
								icon={<PaperPlaneTiltIcon size={14} />}
								onClick={onSendDraft}
								loading={isSending}
								disabled={isSending}
							>
								{isSending ? "Sending…" : "Send"}
							</Button>
						)}
						{onEditDraft && (
							<Button
								variant="secondary"
								size="sm"
								icon={<PencilSimpleIcon size={14} />}
								onClick={onEditDraft}
								disabled={isSending}
							>
								Edit
							</Button>
						)}
						{onDeleteDraft && (
							<Button
								variant="ghost"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={onDeleteDraft}
								disabled={isSending}
							>
								Discard
							</Button>
						)}
					</div>
				)}

				<EmailAttachmentList
					mailboxId={mailboxId}
					emailId={email.id}
					attachments={email.attachments}
					onPreviewImage={onPreviewImage}
					className="mt-3 md:ml-[42px]"
					showHeading={isSoleMessage}
				/>
			</div>
		</div>
	);
}
