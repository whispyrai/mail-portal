import { Button, Loader } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import EmailIframe from "~/components/EmailIframe";
import { rewriteInlineImages } from "~/lib/utils";
import type { Email } from "~/types";

export type EmailBodyLoadState = {
	data: string | undefined;
	isError: boolean;
	refetch: () => unknown;
};

type EmailMessageBodyProps = {
	email: Email;
	mailboxId?: string;
	bodyState?: EmailBodyLoadState;
	senderLabel: string;
	autoSize?: boolean;
};

export default function EmailMessageBody({
	email,
	mailboxId,
	bodyState,
	senderLabel,
	autoSize,
}: EmailMessageBodyProps) {
	const authoritativeBody = email.body_external ? bodyState?.data : email.body ?? "";

	if (email.body_external && authoritativeBody === undefined) {
		if (bodyState?.isError) {
			return (
				<div
					className="my-1 flex min-h-28 flex-col justify-center gap-3 rounded-lg border border-kumo-line bg-kumo-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
					role="alert"
				>
					<div className="flex min-w-0 items-start gap-3">
						<WarningCircleIcon
							size={20}
							weight="fill"
							className="mt-0.5 shrink-0 text-kumo-danger"
							aria-hidden="true"
						/>
						<div className="min-w-0">
							<p className="text-sm font-medium text-kumo-default">
								Complete message unavailable
							</p>
							<p className="mt-1 break-words text-sm leading-5 text-kumo-danger">
								The complete message from {senderLabel} could not be loaded.
							</p>
						</div>
					</div>
					<Button
						size="sm"
						variant="secondary"
						onClick={() => void bodyState.refetch()}
						aria-label={`Retry loading complete message from ${senderLabel}`}
						className="min-h-11 shrink-0 self-start sm:self-center"
					>
						Retry
					</Button>
				</div>
			);
		}

		return (
			<div
				className="flex min-h-28 items-center gap-3 py-5 text-sm text-kumo-subtle"
				role="status"
				aria-live="polite"
			>
				<Loader size="sm" />
				<span className="break-words">Loading complete message from {senderLabel}…</span>
			</div>
		);
	}

	return (
		<EmailIframe
			messageId={email.id}
			body={rewriteInlineImages(
				authoritativeBody ?? "",
				mailboxId || "",
				email.id,
				email.attachments,
			)}
			autoSize={autoSize}
		/>
	);
}
