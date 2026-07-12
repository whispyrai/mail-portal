import { Button, Loader } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
	exitRevokedMailbox,
	resolveMailboxChangeFeedStorage,
} from "~/queries/mailbox-change-feed";
import {
	fetchMailboxMessageLocation,
	MailboxMessageLocationApiError,
} from "~/services/mailbox-message-location";

type ResolverState =
	| { kind: "loading" }
	| { kind: "not_found" }
	| { kind: "error"; message: string }
	| { kind: "revoked" };

export default function OpenMessageRoute() {
	const { mailboxId = "", emailId = "" } = useParams<{
		mailboxId: string;
		emailId: string;
	}>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [state, setState] = useState<ResolverState>({ kind: "loading" });
	const [attempt, setAttempt] = useState(0);
	const revokedExitStartedRef = useRef(false);

	const exitForRevokedAccess = useCallback(() => {
		setState({ kind: "revoked" });
		if (revokedExitStartedRef.current) return;
		revokedExitStartedRef.current = true;
		exitRevokedMailbox({
			queryClient,
			mailboxId,
			storage: resolveMailboxChangeFeedStorage(() => window.localStorage),
			onExit: () => navigate("/", { replace: true }),
		});
	}, [mailboxId, navigate, queryClient]);

	useEffect(() => {
		if (!mailboxId || !emailId) {
			setState({ kind: "not_found" });
			return;
		}
		const controller = new AbortController();
		setState({ kind: "loading" });
		void fetchMailboxMessageLocation(mailboxId, emailId, {
			signal: controller.signal,
		}).then((location) => {
			navigate(
				`/mailbox/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(location.folderId)}?email=${encodeURIComponent(location.emailId)}`,
				{ replace: true },
			);
		}).catch((error: unknown) => {
			if (controller.signal.aborted) return;
			if (error instanceof MailboxMessageLocationApiError && error.status === 403) {
				exitForRevokedAccess();
				return;
			}
			if (error instanceof MailboxMessageLocationApiError && error.status === 404) {
				setState({ kind: "not_found" });
				return;
			}
			setState({
				kind: "error",
				message: error instanceof Error ? error.message : "Message location is unavailable",
			});
		});
		return () => controller.abort();
	}, [attempt, emailId, exitForRevokedAccess, mailboxId, navigate]);

	if (state.kind === "loading" || state.kind === "revoked") {
		return (
			<div className="grid h-full place-items-center px-4" role="status" aria-live="assertive">
				<div className="flex items-center gap-2 text-sm text-kumo-subtle">
					<Loader size="sm" />
					<span>{state.kind === "revoked" ? "Mailbox access changed. Returning to Mailboxes…" : "Finding this message…"}</span>
				</div>
			</div>
		);
	}

	return (
		<div className="grid h-full place-items-center px-4">
			<div className="max-w-sm text-center" role={state.kind === "error" ? "alert" : "status"}>
				<h1 className="text-base font-semibold text-kumo-default">
					{state.kind === "not_found" ? "Message no longer available" : "Could not open this message"}
				</h1>
				<p className="mt-2 text-sm leading-6 text-kumo-subtle">
					{state.kind === "not_found"
						? "It may have been removed, or it is no longer available in this mailbox."
						: state.message}
				</p>
				<div className="mt-5 flex flex-wrap justify-center gap-2">
					<Button
						variant="secondary"
						icon={<ArrowLeftIcon size={16} aria-hidden="true" />}
						onClick={() => navigate(`/mailbox/${encodeURIComponent(mailboxId)}/today`, { replace: true })}
						className="min-h-11"
					>
						Back to mailbox
					</Button>
					{state.kind === "error" && (
						<Button
							icon={<ArrowCounterClockwiseIcon size={16} aria-hidden="true" />}
							onClick={() => setAttempt((value) => value + 1)}
							className="min-h-11"
						>
							Retry
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
