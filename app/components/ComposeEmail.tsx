// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Dialog, Input } from "@cloudflare/kumo";
import { FloppyDiskIcon, PaperPlaneTiltIcon, XIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import { useUIStore } from "~/hooks/useUIStore";
import RichTextEditor from "./RichTextEditor";

/**
 * The composer. A single roomy centered modal used for new mail, replies,
 * forwards and draft edits. Driven by the shared `isComposing` UI state so the
 * Compose button, the thread toolbar, and the AI-draft flow all open the same
 * surface.
 */
export default function ComposeEmail() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const { isComposing, closeCompose } = useUIStore();

	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		error,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
	} = useComposeForm(mailboxId, folder);

	return (
		<Dialog.Root
			open={isComposing}
			onOpenChange={(open) => !open && !isSending && closeCompose()}
		>
			<Dialog
				size="lg"
				className="w-[min(820px,94vw)] p-0 flex flex-col max-h-[92vh] overflow-hidden"
			>
				{/* Header */}
				<div className="flex items-center justify-between px-6 py-4 border-b border-kumo-line shrink-0">
					<Dialog.Title className="text-lg font-semibold text-kumo-default">
						{formTitle}
					</Dialog.Title>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={() => !isSending && closeCompose()}
						disabled={isSending}
						aria-label="Close compose"
					/>
				</div>

				<form
					onSubmit={(e) => handleSend(e, closeCompose)}
					className="flex flex-col flex-1 min-h-0"
				>
					<div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
						{error && <Banner variant="error" text={error} />}

						{/* Recipients */}
						<div className="flex items-end gap-3">
							<div className="flex-1">
								<Input
									label="To"
									type="text"
									placeholder="recipient@example.com, another@example.com"
									value={to}
									onChange={(e) => setTo(e.target.value)}
									required
								/>
							</div>
							{!showCcBcc && (
								<button
									type="button"
									onClick={() => setShowCcBcc(true)}
									className="shrink-0 pb-2.5 text-sm text-kumo-link hover:text-kumo-link-hover font-medium"
								>
									Cc / Bcc
								</button>
							)}
						</div>

						{showCcBcc && (
							<Input
								label="Cc"
								type="text"
								value={cc}
								onChange={(e) => setCc(e.target.value)}
								placeholder="Separate multiple addresses with commas"
							/>
						)}
						{showCcBcc && (
							<Input
								label="Bcc"
								type="text"
								value={bcc}
								onChange={(e) => setBcc(e.target.value)}
								placeholder="Separate multiple addresses with commas"
							/>
						)}

						<Input
							label="Subject"
							type="text"
							placeholder="What's this about?"
							value={subject}
							onChange={(e) => setSubject(e.target.value)}
							required
						/>

						{/* Body */}
						<div className="h-[42vh] min-h-[280px]">
							<RichTextEditor value={body} onChange={setBody} />
						</div>
					</div>

					{/* Footer actions */}
					<div className="flex items-center justify-between px-6 py-4 border-t border-kumo-line bg-kumo-recessed shrink-0">
						<Button
							type="button"
							variant="ghost"
							onClick={() => !isSending && closeCompose()}
							disabled={isSending}
						>
							Discard
						</Button>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								loading={isSavingDraft}
								disabled={isSending}
								icon={<FloppyDiskIcon size={16} />}
								onClick={handleSaveDraft}
							>
								{isSavingDraft ? "Saving…" : "Save draft"}
							</Button>
							<Button
								type="submit"
								variant="primary"
								loading={isSending}
								disabled={isSavingDraft || isSending}
								icon={<PaperPlaneTiltIcon size={16} />}
							>
								{isSending ? "Sending…" : "Send"}
							</Button>
						</div>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
