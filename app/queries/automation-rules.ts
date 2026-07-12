import {
	useMutation,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import type { AutomationRuleDefinition } from "../../shared/automation-rules.ts";
import { queryKeys } from "./keys.ts";
import {
	archiveAutomationRule,
	createAutomationRule,
	dryRunAutomationRule,
	fetchAutomationRule,
	fetchAutomationRuleTests,
	fetchAutomationRuleVersions,
	fetchAutomationRules,
	fetchAutomationRun,
	fetchAutomationRuns,
	isAutomationAccessRevoked,
	reorderAutomationRules,
	restoreAutomationRuleVersion,
	setAutomationRuleEnabled,
	updateAutomationRule,
} from "../services/automation-rules.ts";

type AccessRevokedHandler = (mailboxId: string) => void;

async function withAccessBoundary<T>(
	mailboxId: string,
	request: () => Promise<T>,
	onAccessRevoked?: AccessRevokedHandler,
): Promise<T> {
	try {
		return await request();
	} catch (error) {
		if (isAutomationAccessRevoked(error)) onAccessRevoked?.(mailboxId);
		throw error;
	}
}

export function buildAutomationRulesQueryOptions(
	mailboxId: string,
	onAccessRevoked?: AccessRevokedHandler,
	request = fetchAutomationRules,
) {
	return {
		queryKey: queryKeys.automations.rules(mailboxId),
		queryFn: ({ signal }: { signal: AbortSignal }) => withAccessBoundary(
			mailboxId,
			() => request(mailboxId, { signal }),
			onAccessRevoked,
		),
		enabled: Boolean(mailboxId),
		staleTime: 5_000,
		refetchOnWindowFocus: true,
		retry: (failureCount: number, error: unknown) =>
			!isAutomationAccessRevoked(error) && failureCount < 2,
	};
}

export function useAutomationRules(mailboxId: string, onAccessRevoked?: AccessRevokedHandler) {
	return useQuery(buildAutomationRulesQueryOptions(mailboxId, onAccessRevoked));
}

export function useAutomationRule(
	mailboxId: string,
	ruleId: string | null,
	onAccessRevoked?: AccessRevokedHandler,
) {
	return useQuery({
		queryKey: ruleId
			? queryKeys.automations.rule(mailboxId, ruleId)
			: ["automations", mailboxId, "rules", "_disabled"],
		queryFn: ({ signal }) => withAccessBoundary(
			mailboxId,
			() => fetchAutomationRule(mailboxId, ruleId!, { signal }),
			onAccessRevoked,
		),
		enabled: Boolean(mailboxId && ruleId),
		retry: (count, error) => !isAutomationAccessRevoked(error) && count < 2,
	});
}

export function useAutomationRuns(
	mailboxId: string,
	state: string,
	onAccessRevoked?: AccessRevokedHandler,
	enabled = true,
) {
	return useInfiniteQuery({
		queryKey: queryKeys.automations.runs(mailboxId, { state }),
		queryFn: ({ signal, pageParam }) => withAccessBoundary(
			mailboxId,
			() => fetchAutomationRuns(mailboxId, {
				cursor: pageParam,
				state: state || undefined,
				signal,
			}),
			onAccessRevoked,
		),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: enabled && Boolean(mailboxId),
		refetchInterval: (query) => query.state.data?.pages.some((page) => page.runs.some(
			(run) => run.state === "pending" || run.state === "processing",
		)) ? 5_000 : false,
		retry: (count, error) => !isAutomationAccessRevoked(error) && count < 2,
	});
}

export function useAutomationRun(
	mailboxId: string,
	runId: string | null,
	onAccessRevoked?: AccessRevokedHandler,
) {
	return useQuery({
		queryKey: runId
			? queryKeys.automations.run(mailboxId, runId)
			: ["automations", mailboxId, "runs", "_disabled"],
		queryFn: ({ signal }) => withAccessBoundary(
			mailboxId,
			() => fetchAutomationRun(mailboxId, runId!, { signal }),
			onAccessRevoked,
		),
		enabled: Boolean(mailboxId && runId),
		retry: (count, error) => !isAutomationAccessRevoked(error) && count < 2,
	});
}

export function useAutomationRuleVersions(
	mailboxId: string,
	ruleId: string | null,
	onAccessRevoked?: AccessRevokedHandler,
) {
	return useQuery({
		queryKey: ruleId
			? queryKeys.automations.versions(mailboxId, ruleId)
			: ["automations", mailboxId, "rules", "_disabled", "versions"],
		queryFn: ({ signal }) => withAccessBoundary(
			mailboxId,
			() => fetchAutomationRuleVersions(mailboxId, ruleId!, signal),
			onAccessRevoked,
		),
		enabled: Boolean(mailboxId && ruleId),
		retry: (count, error) => !isAutomationAccessRevoked(error) && count < 2,
	});
}

export function useAutomationRuleTests(
	mailboxId: string,
	ruleId: string | null,
	onAccessRevoked?: AccessRevokedHandler,
) {
	return useQuery({
		queryKey: ruleId
			? queryKeys.automations.tests(mailboxId, ruleId)
			: ["automations", mailboxId, "tests"],
		queryFn: ({ signal }) => withAccessBoundary(
			mailboxId,
			() => fetchAutomationRuleTests(mailboxId, ruleId ?? undefined, signal),
			onAccessRevoked,
		),
		enabled: Boolean(mailboxId),
		retry: (count, error) => !isAutomationAccessRevoked(error) && count < 2,
	});
}

function invalidateAutomationQueries(queryClient: QueryClient, mailboxId: string) {
	return queryClient.invalidateQueries({
		queryKey: queryKeys.automations.all(mailboxId),
	});
}

export function useCreateAutomationRule(mailboxId: string, onAccessRevoked?: AccessRevokedHandler) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			definition: AutomationRuleDefinition;
			expectedOrderRevision: number;
		}) => withAccessBoundary(
			mailboxId,
			() => createAutomationRule(mailboxId, input),
			onAccessRevoked,
		),
		onSuccess: () => invalidateAutomationQueries(queryClient, mailboxId),
	});
}

export function useUpdateAutomationRule(mailboxId: string, onAccessRevoked?: AccessRevokedHandler) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			ruleId: string;
			definition: AutomationRuleDefinition;
			expectedRevision: number;
		}) => withAccessBoundary(
			mailboxId,
			() => updateAutomationRule(mailboxId, input.ruleId, {
				definition: input.definition,
				expectedRevision: input.expectedRevision,
			}),
			onAccessRevoked,
		),
		onSuccess: () => invalidateAutomationQueries(queryClient, mailboxId),
	});
}

export function useArchiveAutomationRule(mailboxId: string, onAccessRevoked?: AccessRevokedHandler) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { ruleId: string; expectedRevision: number }) => withAccessBoundary(
			mailboxId,
			() => archiveAutomationRule(mailboxId, input.ruleId, input.expectedRevision),
			onAccessRevoked,
		),
		onSuccess: () => invalidateAutomationQueries(queryClient, mailboxId),
	});
}

export function useSetAutomationRuleEnabled(mailboxId: string, onAccessRevoked?: AccessRevokedHandler) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			ruleId: string;
			expectedRevision: number;
			enabled: boolean;
		}) => withAccessBoundary(
			mailboxId,
			() => setAutomationRuleEnabled(mailboxId, input.ruleId, input.enabled, {
				expectedRevision: input.expectedRevision,
			}),
			onAccessRevoked,
		),
		onSuccess: () => invalidateAutomationQueries(queryClient, mailboxId),
	});
}

export function useReorderAutomationRules(mailboxId: string, onAccessRevoked?: AccessRevokedHandler) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { orderedRuleIds: string[]; expectedOrderRevision: number }) =>
			withAccessBoundary(
				mailboxId,
				() => reorderAutomationRules(mailboxId, input.orderedRuleIds, input.expectedOrderRevision),
				onAccessRevoked,
			),
		onSuccess: () => invalidateAutomationQueries(queryClient, mailboxId),
	});
}

export function useDryRunAutomationRule(mailboxId: string, onAccessRevoked?: AccessRevokedHandler) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			definition: AutomationRuleDefinition;
			ruleId?: string;
			ruleVersion?: number;
			acknowledgedZero: boolean;
		}) => withAccessBoundary(
			mailboxId,
			() => dryRunAutomationRule(mailboxId, input),
			onAccessRevoked,
		),
		onSuccess: (_response, input) => queryClient.invalidateQueries({
			queryKey: input.ruleId
				? queryKeys.automations.tests(mailboxId, input.ruleId)
				: ["automations", mailboxId, "tests"],
		}),
	});
}

export function useRestoreAutomationRuleVersion(mailboxId: string, onAccessRevoked?: AccessRevokedHandler) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { ruleId: string; version: number; expectedRevision: number }) =>
			withAccessBoundary(
				mailboxId,
				() => restoreAutomationRuleVersion(mailboxId, input.ruleId, {
					version: input.version,
					expectedRevision: input.expectedRevision,
				}),
				onAccessRevoked,
			),
		onSuccess: () => invalidateAutomationQueries(queryClient, mailboxId),
	});
}
