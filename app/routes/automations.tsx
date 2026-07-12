import { Button, Loader } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import AutomationWorkspace from "~/components/automations/AutomationWorkspace";
import { useFolders } from "~/queries/folders";
import { useLabels } from "~/queries/labels";
import {
	exitRevokedMailbox,
	resolveMailboxChangeFeedStorage,
} from "~/queries/mailbox-change-feed";
import { useMailbox } from "~/queries/mailboxes";
import { ApiError } from "~/services/api";

function isSupportingAccessRevoked(error: unknown): boolean {
	return error instanceof ApiError && error.status === 403;
}

export default function AutomationsRoute() {
	const { mailboxId = "" } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const mailboxQuery = useMailbox(mailboxId);
	const labelsQuery = useLabels(mailboxId);
	const foldersQuery = useFolders(mailboxId);
	const labels = labelsQuery.data ?? [];
	const folders = foldersQuery.data ?? [];
	const [revoked, setRevoked] = useState(false);
	const exitStarted = useRef(false);
	useEffect(() => { exitStarted.current = false; setRevoked(false); }, [mailboxId]);
	const onAccessRevoked = useCallback((revokedMailboxId: string) => {
		if (revokedMailboxId !== mailboxId) return;
		setRevoked(true);
		if (exitStarted.current) return;
		exitStarted.current = true;
		exitRevokedMailbox({ queryClient, mailboxId, storage: resolveMailboxChangeFeedStorage(() => window.localStorage), onExit: () => navigate("/", { replace: true }) });
	}, [mailboxId, navigate, queryClient]);
	const supportingAccessRevoked = [
		mailboxQuery.error,
		mailboxQuery.failureReason,
		labelsQuery.error,
		labelsQuery.failureReason,
		foldersQuery.error,
		foldersQuery.failureReason,
	].some(isSupportingAccessRevoked);
	useEffect(() => {
		if (supportingAccessRevoked) onAccessRevoked(mailboxId);
	}, [mailboxId, onAccessRevoked, supportingAccessRevoked]);
	if (revoked) return <div className="grid h-full place-items-center px-4 text-sm text-kumo-subtle" role="status" aria-live="assertive"><span className="flex items-center gap-2"><Loader size="sm" />Mailbox access changed. Returning to Mailboxes…</span></div>;
	if (supportingAccessRevoked) return <div className="grid h-full place-items-center px-4 text-sm text-kumo-subtle" role="status" aria-live="assertive"><span className="flex items-center gap-2"><Loader size="sm" />Mailbox access changed. Returning to Mailboxes…</span></div>;
	if (mailboxQuery.isLoading || labelsQuery.isLoading || foldersQuery.isLoading) return <div className="grid h-full place-items-center px-4 text-sm text-kumo-subtle" role="status"><span className="flex items-center gap-2"><Loader size="sm" />Loading Automations…</span></div>;
	if (mailboxQuery.isError || labelsQuery.isError || foldersQuery.isError) return <div className="grid h-full place-items-center px-4 text-center" role="alert"><div><h1 className="font-semibold text-kumo-default">Automations could not open</h1><p className="mt-2 text-sm text-kumo-subtle">Mailbox folders and labels are needed to show rule targets safely.</p><Button variant="secondary" className="mt-4 min-h-11" onClick={() => { void mailboxQuery.refetch(); void labelsQuery.refetch(); void foldersQuery.refetch(); }}>Retry</Button></div></div>;
	return <AutomationWorkspace mailboxId={mailboxId} mailbox={mailboxQuery.data} labels={labels} folders={folders} onAccessRevoked={onAccessRevoked} />;
}
