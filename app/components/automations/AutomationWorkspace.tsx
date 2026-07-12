import { Button, Loader } from "@cloudflare/kumo";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ArrowsClockwiseIcon,
	CheckCircleIcon,
	FlaskIcon,
	LightningIcon,
	PlusIcon,
	WarningCircleIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
	canonicalAutomationRuleDefinition,
	parseAutomationRuleDefinition,
	type AutomationRuleAction,
	type AutomationRuleCondition,
	type AutomationRuleDefinition,
} from "../../../shared/automation-rules.ts";
import type { Folder, Label, Mailbox } from "~/types";
import {
	automationRuleStateLabel,
	automationRunStateLabel,
	automationTabFromParams,
	describeAutomationDefinition,
	paramsWithAutomationRule,
	paramsWithAutomationTab,
	relativeAutomationTime,
} from "~/lib/automation-rules-view";
import {
	useArchiveAutomationRule,
	useAutomationRules,
	useAutomationRun,
	useAutomationRuns,
	useCreateAutomationRule,
	useDryRunAutomationRule,
	useReorderAutomationRules,
	useSetAutomationRuleEnabled,
	useUpdateAutomationRule,
} from "~/queries/automation-rules";
import type {
	AutomationRule,
	AutomationRuleTest,
	AutomationRun,
} from "~/services/automation-rules";

const DEFAULT_DEFINITION: AutomationRuleDefinition = {
	schemaVersion: 1,
	name: "",
	match: "all",
	conditions: [{ kind: "sender_address", operator: "is_any_of", values: [""] }],
	actions: [{ kind: "star" }],
	stopProcessing: false,
};

const inputClass = "min-h-11 w-full rounded-md border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default focus:outline-none focus:ring-2 focus:ring-kumo-ring";

function statusTone(state: AutomationRule["state"]): string {
	if (state === "enabled") return "bg-kumo-success";
	if (state === "needs_attention") return "bg-kumo-danger";
	if (state === "draft") return "bg-kumo-brand";
	return "bg-kumo-subtle";
}

function readableAutomationCode(value: string): string {
	const normalized = value.replaceAll("_", " ");
	return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function AutomationRunDetails({ run }: { run: AutomationRun }) {
	const results = run.results ?? [];
	return (
		<div className="mt-4 rounded-md border border-kumo-line bg-kumo-tint p-4" aria-label="Exact run details">
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-kumo-subtle">
				<span>Ruleset generation {run.rulesetGeneration}</span>
				<span>{run.evaluatedCount} evaluated</span>
				<span>{run.matchedCount} matched</span>
				<span>{run.appliedCount} applied</span>
			</div>
			{run.failureCategory && <p className="mt-3 text-sm text-kumo-danger">Failure: {readableAutomationCode(run.failureCategory)}</p>}
			{results.length === 0 ? (
				<p className="mt-3 text-sm text-kumo-subtle">{run.state === "pending" || run.state === "processing" ? "This run has not finished yet." : "No per-rule results were recorded for this run."}</p>
			) : (
				<ol className="mt-3 space-y-3">
					{results.map((result) => (
						<li key={`${result.ordinal}-${result.ruleId}`} className="rounded-md border border-kumo-line bg-kumo-base p-3">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<p className="text-sm font-medium text-kumo-default">{result.ruleName} · version {result.ruleVersion}</p>
								<span className="text-xs text-kumo-subtle">{readableAutomationCode(result.outcome)}</span>
							</div>
							<p className="mt-2 text-xs text-kumo-subtle">Matched conditions: {result.matchedConditionIndexes.length ? result.matchedConditionIndexes.map((index) => index + 1).join(", ") : "none"}</p>
							{result.plannedActions.length > 0 && <p className="mt-1 text-xs text-kumo-subtle">Planned: {result.plannedActions.map(readableAutomationCode).join(", ")}</p>}
							{result.actionResults.length > 0 && <ul className="mt-2 space-y-1 text-xs text-kumo-subtle">{result.actionResults.map((action, index) => <li key={`${action.action}-${index}`}>{readableAutomationCode(action.action)}: {readableAutomationCode(action.status)}</li>)}</ul>}
							{result.failureCategory && <p className="mt-2 text-xs text-kumo-danger">{readableAutomationCode(result.failureCategory)}</p>}
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

function conditionDefaults(kind: AutomationRuleCondition["kind"]): AutomationRuleCondition {
	switch (kind) {
		case "sender_address": return { kind, operator: "is_any_of", values: [""] };
		case "sender_domain": return { kind, operator: "is_any_of", values: [""] };
		case "subject": return { kind, operator: "contains", value: "" };
		case "attachment_presence": return { kind, operator: "has" };
		case "attachment_filename": return { kind, operator: "contains", value: "" };
		case "every_incoming": return { kind };
	}
}

function actionDefaults(kind: AutomationRuleAction["kind"]): AutomationRuleAction {
	switch (kind) {
		case "apply_labels": return { kind, labelIds: [] };
		case "star": return { kind };
		case "move_to_folder": return { kind, folderId: "archive" };
	}
}

function AutomationRuleEditor({
	mailboxId,
	orderRevision,
	rule,
	labels,
	folders,
	onClose,
	onAccessRevoked,
}: {
	mailboxId: string;
	orderRevision: number;
	rule: AutomationRule | null;
	labels: Label[];
	folders: Folder[];
	onClose(): void;
	onAccessRevoked(mailboxId: string): void;
}) {
	const seed = rule?.draftDefinition ?? rule?.activeDefinition ?? DEFAULT_DEFINITION;
	const [definition, setDefinition] = useState<AutomationRuleDefinition>(() => structuredClone(seed));
	const [error, setError] = useState<string | null>(null);
	const [test, setTest] = useState<AutomationRuleTest | null>(null);
	const [acknowledgedZero, setAcknowledgedZero] = useState(false);
	const create = useCreateAutomationRule(mailboxId, onAccessRevoked);
	const update = useUpdateAutomationRule(mailboxId, onAccessRevoked);
	const dryRun = useDryRunAutomationRule(mailboxId, onAccessRevoked);
	const pending = create.isPending || update.isPending || dryRun.isPending;
	const savedDraftCanonical = useMemo(() => rule?.draftDefinition
		? canonicalAutomationRuleDefinition(rule.draftDefinition)
		: null, [rule?.draftDefinition]);
	const editedCanonical = useMemo(() => {
		try {
			return canonicalAutomationRuleDefinition(definition);
		} catch {
			return null;
		}
	}, [definition]);
	const testReady = Boolean(
		rule &&
		rule.draftVersion !== null &&
		rule.draftDefinition &&
		savedDraftCanonical === editedCanonical,
	);
	const nextActionKind = (["apply_labels", "star", "move_to_folder"] as const).find(
		(kind) => !definition.actions.some((action) => action.kind === kind),
	);

	const setCondition = (index: number, next: AutomationRuleCondition) => {
		setDefinition((current) => ({
			...current,
			conditions: next.kind === "every_incoming"
				? [next]
				: current.conditions.map((condition, at) => at === index ? next : condition),
		}));
		setTest(null);
	};
	const setAction = (index: number, next: AutomationRuleAction) => {
		setDefinition((current) => ({
			...current,
			actions: current.actions.map((action, at) => at === index ? next : action),
		}));
		setTest(null);
	};
	useEffect(() => {
		if (testReady) return;
		setTest(null);
		setAcknowledgedZero(false);
	}, [testReady]);

	const validate = () => {
		try {
			const parsed = parseAutomationRuleDefinition(definition);
			setError(null);
			return parsed;
		} catch {
			setError("Complete every condition and action before saving or testing.");
			return null;
		}
	};

	const save = async () => {
		const parsed = validate();
		if (!parsed) return;
		try {
			if (rule) {
				await update.mutateAsync({ ruleId: rule.id, definition: parsed, expectedRevision: rule.revision });
			} else {
				await create.mutateAsync({
					definition: parsed,
					expectedOrderRevision: orderRevision,
				});
			}
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Rule could not be saved.");
		}
	};

	const runTest = async (acknowledgement = acknowledgedZero) => {
		if (!testReady || !rule?.draftDefinition || rule.draftVersion === null) {
			setError("Save draft before testing.");
			return;
		}
		try {
			const response = await dryRun.mutateAsync({
				definition: rule.draftDefinition,
				ruleId: rule.id,
				ruleVersion: rule.draftVersion,
				acknowledgedZero: acknowledgement,
			});
			setTest(response.test);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Test could not run.");
		}
	};

	return (
		<aside className="flex h-full min-h-0 w-full flex-col border-l border-kumo-line bg-kumo-base lg:w-[560px]" aria-label={rule ? `Edit ${rule.name}` : "Create rule"}>
			<header className="flex items-start justify-between gap-3 border-b border-kumo-line px-5 py-4">
				<div>
					<h2 className="font-semibold text-kumo-default">{rule ? "Edit rule" : "New rule"}</h2>
					<p className="mt-1 text-xs text-kumo-subtle">Changes stay in a draft until you test and enable them.</p>
				</div>
				<Button variant="ghost" shape="square" icon={<XIcon size={18} />} aria-label="Close rule editor" onClick={onClose} className="min-h-11 min-w-11" />
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
				<div className="space-y-6">
					<label className="block">
						<span className="mb-1.5 block text-sm font-medium text-kumo-default">Rule name</span>
						<input className={inputClass} maxLength={80} value={definition.name} onChange={(event) => { setDefinition({ ...definition, name: event.target.value }); setTest(null); }} placeholder="e.g. Vendor invoices" autoFocus />
					</label>

					<fieldset>
						<legend className="text-sm font-medium text-kumo-default">When incoming mail matches</legend>
						<div className="mt-2 flex gap-2">
							{(["all", "any"] as const).map((match) => <button key={match} type="button" onClick={() => setDefinition({ ...definition, match })} className={`min-h-11 rounded-md border px-3 text-sm ${definition.match === match ? "border-kumo-brand bg-kumo-tint font-medium" : "border-kumo-line"}`}>{match === "all" ? "All conditions" : "Any condition"}</button>)}
						</div>
						<div className="mt-3 space-y-3">
							{definition.conditions.map((condition, index) => (
								<div key={`${condition.kind}-${index}`} className="rounded-md border border-kumo-line p-3">
									<div className="flex gap-2">
										<select className={inputClass} value={condition.kind} onChange={(event) => setCondition(index, conditionDefaults(event.target.value as AutomationRuleCondition["kind"]))} aria-label={`Condition ${index + 1} type`}>
											<option value="sender_address">Sender address</option><option value="sender_domain">Sender domain</option><option value="subject">Subject</option><option value="attachment_presence">Attachment presence</option><option value="attachment_filename">Attachment filename</option><option value="every_incoming">Every incoming message</option>
										</select>
										{definition.conditions.length > 1 && <Button variant="ghost" shape="square" icon={<XIcon size={16} />} aria-label={`Remove condition ${index + 1}`} onClick={() => setDefinition({ ...definition, conditions: definition.conditions.filter((_, at) => at !== index) })} className="min-h-11 min-w-11" />}
									</div>
									{condition.kind === "every_incoming" ? <p className="mt-2 rounded-md bg-kumo-warning-tint px-3 py-2 text-xs text-kumo-default"><strong>High impact:</strong> this rule will match every future incoming message.</p> : <ConditionFields condition={condition} onChange={(next) => setCondition(index, next)} />}
								</div>
							))}
							{definition.conditions.length < 10 && definition.conditions[0]?.kind !== "every_incoming" && <Button variant="secondary" icon={<PlusIcon size={16} />} onClick={() => setDefinition({ ...definition, conditions: [...definition.conditions, conditionDefaults("subject")] })} className="min-h-11">Add condition</Button>}
						</div>
					</fieldset>

					<fieldset>
						<legend className="text-sm font-medium text-kumo-default">Then</legend>
						<div className="mt-3 space-y-3">
							{definition.actions.map((action, index) => <ActionFields key={`${action.kind}-${index}`} action={action} labels={labels} folders={folders} onChange={(next) => setAction(index, next)} onRemove={definition.actions.length > 1 ? () => setDefinition({ ...definition, actions: definition.actions.filter((_, at) => at !== index) }) : undefined} index={index} />)}
							{nextActionKind && <Button variant="secondary" icon={<PlusIcon size={16} />} onClick={() => setDefinition({ ...definition, actions: [...definition.actions, actionDefaults(nextActionKind)] })} className="min-h-11">Add action</Button>}
						</div>
					</fieldset>

					<details className="rounded-md border border-kumo-line px-3 py-3">
						<summary className="cursor-pointer text-sm font-medium text-kumo-default">Advanced</summary>
						<label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-kumo-default"><input type="checkbox" checked={definition.stopProcessing} onChange={(event) => setDefinition({ ...definition, stopProcessing: event.target.checked })} /> Stop evaluating later rules after this rule matches</label>
					</details>

					<section className="border-t border-kumo-line pt-5" aria-labelledby="dry-run-title">
						<div className="flex items-start justify-between gap-3">
							<div><h3 id="dry-run-title" className="text-sm font-medium text-kumo-default">Test this rule</h3><p className="mt-1 text-xs leading-5 text-kumo-subtle">Test against recent incoming mail. Nothing will change.<br />Past results do not guarantee what future mail will match.</p></div>
							<Button variant="secondary" icon={<FlaskIcon size={16} />} onClick={() => void runTest()} loading={dryRun.isPending} disabled={!testReady || pending} className="min-h-11">Test</Button>
						</div>
						{!testReady && <p className="mt-2 text-xs font-medium text-kumo-subtle">Save draft before testing.</p>}
						{test && <div className="mt-3 rounded-md bg-kumo-tint p-3" role="status"><div className="flex items-center gap-2 text-sm font-medium text-kumo-default"><CheckCircleIcon size={18} /> {test.matchedCount} of {test.evaluatedCount} messages matched</div><p className="mt-2 text-xs text-kumo-subtle">{test.actionCounts.wouldChange} would change · {test.actionCounts.alreadySatisfied} already satisfied · {test.actionCounts.conflicts} conflicts</p>{(test.evaluatedCount === 0 || test.matchedCount === 0) && (test.acknowledgedZero ? <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-kumo-default"><CheckCircleIcon size={15} aria-hidden="true" /> Zero-result acknowledgment stored. This draft may now be enabled.</p> : <label className="mt-3 flex items-start gap-2 text-xs text-kumo-default"><input type="checkbox" checked={acknowledgedZero} disabled={dryRun.isPending} onChange={(event) => { const checked = event.target.checked; setAcknowledgedZero(checked); if (checked) void runTest(true); }} /> I understand this test had {test.evaluatedCount === 0 ? "no eligible messages" : "no matches"}. Selecting this runs a confirming test and stores my acknowledgment before activation.</label>)}</div>}
					</section>
					{error && <p className="rounded-md bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger" role="alert">{error}</p>}
				</div>
			</div>
			<footer className="flex justify-end gap-2 border-t border-kumo-line px-5 py-4"><Button variant="secondary" onClick={onClose} className="min-h-11">Cancel</Button><Button onClick={save} loading={create.isPending || update.isPending} disabled={pending && !create.isPending && !update.isPending} className="min-h-11">Save draft</Button></footer>
		</aside>
	);
}

function ConditionFields({ condition, onChange }: { condition: Exclude<AutomationRuleCondition, { kind: "every_incoming" }>; onChange(next: AutomationRuleCondition): void }) {
	if (condition.kind === "attachment_presence") return <select className={`${inputClass} mt-2`} value={condition.operator} onChange={(event) => onChange({ ...condition, operator: event.target.value as "has" | "does_not_have" })}><option value="has">Has an attachment</option><option value="does_not_have">Does not have an attachment</option></select>;
	const values = "values" in condition ? condition.values.join(", ") : condition.value;
	return <div className="mt-2 grid gap-2 sm:grid-cols-[180px_1fr]"><select className={inputClass} value={condition.operator} onChange={(event) => { const operator = event.target.value; if (condition.kind === "sender_address") onChange({ ...condition, operator: operator as "is_any_of" | "is_not_any_of" }); else if (condition.kind === "sender_domain") onChange({ ...condition, operator: operator as "is_any_of" | "is_not_any_of" }); else if (condition.kind === "subject") onChange({ ...condition, operator: operator as typeof condition.operator }); else if (operator === "contains") onChange({ kind: "attachment_filename", operator, value: "" }); else onChange({ kind: "attachment_filename", operator: "ends_with_any", values: [""] }); }}><option value={condition.kind.startsWith("sender_") ? "is_any_of" : condition.kind === "subject" ? "contains" : "contains"}>{condition.kind.startsWith("sender_") ? "Is any of" : "Contains"}</option>{condition.kind.startsWith("sender_") && <option value="is_not_any_of">Is not any of</option>}{condition.kind === "subject" && <><option value="equals">Equals</option><option value="starts_with">Starts with</option><option value="does_not_contain">Does not contain</option></>}{condition.kind === "attachment_filename" && <option value="ends_with_any">Ends with any</option>}</select><input className={inputClass} value={values} onChange={(event) => { const value = event.target.value; if ("values" in condition) onChange({ ...condition, values: value.split(",").map((item) => item.trim()) } as AutomationRuleCondition); else onChange({ ...condition, value } as AutomationRuleCondition); }} placeholder={"values" in condition ? "Comma-separated values" : "Value"} /></div>;
}

function ActionFields({ action, labels, folders, onChange, onRemove, index }: { action: AutomationRuleAction; labels: Label[]; folders: Folder[]; onChange(next: AutomationRuleAction): void; onRemove?: () => void; index: number }) {
	return <div className="rounded-md border border-kumo-line p-3"><div className="flex gap-2"><select className={inputClass} value={action.kind} onChange={(event) => onChange(actionDefaults(event.target.value as AutomationRuleAction["kind"]))} aria-label={`Action ${index + 1} type`}><option value="apply_labels">Apply labels</option><option value="star">Star message</option><option value="move_to_folder">Move Inbox conversation</option></select>{onRemove && <Button variant="ghost" shape="square" icon={<XIcon size={16} />} aria-label={`Remove action ${index + 1}`} onClick={onRemove} className="min-h-11 min-w-11" />}</div>{action.kind === "apply_labels" && <div className="mt-2 grid grid-cols-2 gap-2">{labels.map((label) => <label key={label.id} className="flex min-h-11 items-center gap-2 rounded-md border border-kumo-line px-3 text-sm"><input type="checkbox" checked={action.labelIds.includes(label.id)} onChange={(event) => onChange({ ...action, labelIds: event.target.checked ? [...action.labelIds, label.id] : action.labelIds.filter((id) => id !== label.id) })} />{label.name}</label>)}</div>}{action.kind === "move_to_folder" && <select className={`${inputClass} mt-2`} value={action.folderId} onChange={(event) => onChange({ ...action, folderId: event.target.value })}><option value="archive">Archive</option>{folders.filter((folder) => !["inbox", "sent", "draft", "outbox", "snoozed", "trash", "archive"].includes(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}</div>;
}

export default function AutomationWorkspace({ mailboxId, mailbox, labels, folders, onAccessRevoked }: { mailboxId: string; mailbox?: Mailbox; labels: Label[]; folders: Folder[]; onAccessRevoked(mailboxId: string): void }) {
	const [searchParams, setSearchParams] = useSearchParams();
	const tab = automationTabFromParams(searchParams);
	const selectedRuleId = searchParams.get("rule");
	const composing = searchParams.get("compose") === "new";
	const [runState, setRunState] = useState("");
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
	const rulesQuery = useAutomationRules(mailboxId, onAccessRevoked);
	const runsQuery = useAutomationRuns(mailboxId, runState, onAccessRevoked, tab === "runs");
	const selectedRunQuery = useAutomationRun(mailboxId, selectedRunId, onAccessRevoked);
	const reorder = useReorderAutomationRules(mailboxId, onAccessRevoked);
	const toggle = useSetAutomationRuleEnabled(mailboxId, onAccessRevoked);
	const archive = useArchiveAutomationRule(mailboxId, onAccessRevoked);
	const rules = rulesQuery.data?.rules ?? [];
	const orderedRules = rules.filter((rule) => rule.state !== "archived");
	const archivedCount = rules.length - orderedRules.length;
	const runs = runsQuery.data?.pages.flatMap((page) => page.runs) ?? [];
	const canManage = rulesQuery.data?.canManage ?? runsQuery.data?.pages[0]?.canManage ?? false;
	const selectedRule = rules.find((rule) => rule.id === selectedRuleId) ?? null;
	const editorOpen = canManage && Boolean(selectedRule || composing);
	const [actionError, setActionError] = useState<string | null>(null);
	const labelNames = useMemo(() => Object.fromEntries(labels.map((label) => [label.id, label.name])), [labels]);
	const folderNames = useMemo(() => Object.fromEntries(folders.map((folder) => [folder.id, folder.name])), [folders]);
	const closeEditor = () => setSearchParams(paramsWithAutomationRule(searchParams, null), { replace: true });
	useEffect(() => {
		if (rulesQuery.isSuccess && selectedRuleId && !selectedRule) {
			setSearchParams(paramsWithAutomationRule(searchParams, null), { replace: true });
		}
	}, [rulesQuery.isSuccess, searchParams, selectedRule, selectedRuleId, setSearchParams]);
	const reportActionError = (error: unknown) => setActionError(error instanceof Error ? error.message : "The rule could not be changed.");
	const moveRule = (index: number, delta: number) => { const next = [...orderedRules]; const target = index + delta; if (target < 0 || target >= next.length || !rulesQuery.data) return; [next[index], next[target]] = [next[target]!, next[index]!]; setActionError(null); reorder.mutate({ orderedRuleIds: next.map((rule) => rule.id), expectedOrderRevision: rulesQuery.data.orderRevision }, { onError: reportActionError }); };

	return <div className="flex h-full min-h-0 bg-kumo-base"><main className={`flex min-w-0 flex-1 flex-col ${editorOpen ? "hidden lg:flex" : "flex"}`}><header className="border-b border-kumo-line px-4 py-4 sm:px-6"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><LightningIcon size={22} weight="duotone" /><h1 className="text-lg font-semibold text-kumo-default">Automations</h1></div><p className="mt-1 max-w-2xl text-sm leading-6 text-kumo-subtle">Rules organize future incoming mail in this mailbox. They never send messages or contact external services.</p></div>{tab === "rules" && canManage && <Button icon={<PlusIcon size={16} />} onClick={() => setSearchParams(paramsWithAutomationRule(searchParams, null, true))} className="min-h-11 shrink-0">New rule</Button>}</div>{mailbox?.type === "SHARED" && <div className="mt-3 border-l-2 border-kumo-brand pl-3 text-xs leading-5 text-kumo-subtle">These rules are shared by everyone with access to this mailbox. Changes affect future incoming messages for the whole mailbox.{!canManage && <strong className="ml-1 text-kumo-default">You have read-only access.</strong>}</div>}<div className="mt-4 flex gap-1" role="tablist" aria-label="Automation views">{(["rules", "runs"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setSearchParams(paramsWithAutomationTab(searchParams, value))} className={`min-h-11 rounded-md px-4 text-sm font-medium ${tab === value ? "bg-kumo-fill text-kumo-default" : "text-kumo-subtle hover:bg-kumo-tint"}`}>{value === "rules" ? "Rules" : "Run history"}</button>)}</div>{actionError && <p className="mt-3 rounded-md bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger" role="alert">{actionError}</p>}</header>
		{tab === "rules" ? <section className="min-h-0 flex-1 overflow-y-auto" aria-label="Ordered rules">{rulesQuery.isLoading ? <StateMessage><Loader size="sm" /> Loading rules…</StateMessage> : rulesQuery.isError ? <ErrorState title="Rules could not be loaded" onRetry={() => void rulesQuery.refetch()} /> : orderedRules.length === 0 ? <StateMessage><div className="text-center"><LightningIcon className="mx-auto" size={28} /><p className="mt-2 font-medium text-kumo-default">No active rules yet</p><p className="mt-1">Create a draft to begin organizing future incoming mail.</p>{archivedCount > 0 && <p className="mt-1 text-xs">{archivedCount} archived {archivedCount === 1 ? "rule is" : "rules are"} retained in history.</p>}</div></StateMessage> : <ol>{orderedRules.map((rule, index) => { const definition = rule.draftDefinition ?? rule.activeDefinition; return <li key={rule.id} className="border-b border-kumo-line px-4 py-4 sm:px-6"><div className="flex items-start gap-3"><span className={`mt-2 size-2.5 shrink-0 rounded-full ${statusTone(rule.state)}`} aria-hidden="true" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h2 className="font-medium text-kumo-default">{rule.name}</h2><span className="text-xs text-kumo-subtle">{automationRuleStateLabel(rule.state)}</span>{rule.targetHealth === "needs_attention" && <span className="inline-flex items-center gap-1 text-xs text-kumo-danger"><WarningCircleIcon size={14} /> Target needs attention</span>}</div>{definition && <p className="mt-1.5 text-sm leading-6 text-kumo-subtle">{describeAutomationDefinition(definition, { labels: labelNames, folders: { archive: "Archive", ...folderNames } })}</p>}<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-kumo-subtle"><span>Active version {rule.activeVersion ?? "none"}</span><span>Draft version {rule.draftVersion ?? "none"}</span><span>{definition?.stopProcessing ? "Stops later rules" : "Continues to later rules"}</span><span>Last run {relativeAutomationTime(rule.lastRunAt)}</span><span>Last match {relativeAutomationTime(rule.lastMatchedAt)}</span><span>Updated {relativeAutomationTime(rule.updatedAt)}</span></div></div><div className="flex shrink-0 items-center gap-1">{canManage && <><Button variant="ghost" shape="square" icon={<ArrowUpIcon size={16} />} aria-label={`Move ${rule.name} earlier`} disabled={index === 0 || reorder.isPending} onClick={() => moveRule(index, -1)} className="min-h-11 min-w-11"/><Button variant="ghost" shape="square" icon={<ArrowDownIcon size={16} />} aria-label={`Move ${rule.name} later`} disabled={index === orderedRules.length - 1 || reorder.isPending} onClick={() => moveRule(index, 1)} className="min-h-11 min-w-11"/><Button variant="secondary" onClick={() => setSearchParams(paramsWithAutomationRule(searchParams, rule.id))} className="min-h-11">Edit</Button><Button variant="ghost" onClick={() => { setActionError(null); toggle.mutate({ ruleId: rule.id, expectedRevision: rule.revision, enabled: rule.state !== "enabled" }, { onError: reportActionError }); }} className="min-h-11">{rule.state === "enabled" ? "Disable" : "Enable"}</Button><Button variant="ghost" onClick={() => { if (window.confirm(`Archive “${rule.name}”?`)) { setActionError(null); archive.mutate({ ruleId: rule.id, expectedRevision: rule.revision }, { onError: reportActionError }); } }} className="min-h-11">Archive</Button></>}</div></div></li>; })}</ol>}</section> : <section className="min-h-0 flex-1 overflow-y-auto"><div className="flex items-center justify-between gap-3 border-b border-kumo-line px-4 py-3 sm:px-6"><label className="text-sm text-kumo-subtle">Status <select value={runState} onChange={(event) => { setRunState(event.target.value); setSelectedRunId(null); }} className="ml-2 min-h-11 rounded-md border border-kumo-line bg-kumo-base px-3 text-kumo-default"><option value="">All</option><option value="pending">Pending</option><option value="processing">Processing</option><option value="no_match">No match</option><option value="applied">Applied</option><option value="applied_with_skips">Applied with skips</option><option value="failed">Failed</option></select></label><Button variant="secondary" icon={<ArrowsClockwiseIcon size={16} className={runsQuery.isRefetching ? "animate-spin" : ""} />} onClick={() => void runsQuery.refetch()} className="min-h-11">Refresh</Button></div>{runsQuery.isLoading ? <StateMessage><Loader size="sm" /> Loading run history…</StateMessage> : runsQuery.isError ? <ErrorState title="Run history could not be loaded" onRetry={() => void runsQuery.refetch()} /> : runs.length === 0 ? <StateMessage>No automation runs yet. New incoming messages will appear here.</StateMessage> : <><ol>{runs.map((run) => <li key={run.id} className="border-b border-kumo-line px-4 py-4 sm:px-6"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-medium text-kumo-default">{automationRunStateLabel(run.state)}</span>{run.failureCategory && <span className="text-xs text-kumo-danger">{readableAutomationCode(run.failureCategory)}</span>}</div>{run.message.state === "available" ? <Link to={run.message.href} className="mt-1 block truncate text-sm text-kumo-default hover:underline">{run.message.subject || "(No subject)"} · {run.message.sender}</Link> : <p className="mt-1 text-sm text-kumo-subtle">{run.message.label}</p>}<p className="mt-1 text-xs text-kumo-subtle">{run.matchedCount} matched · {run.appliedCount} applied · {run.attemptCount} {run.attemptCount === 1 ? "attempt" : "attempts"}</p></div><div className="flex shrink-0 flex-col items-end gap-2"><time className="text-xs text-kumo-subtle" dateTime={run.createdAt}>{relativeAutomationTime(run.completedAt ?? run.createdAt)}</time><Button variant="ghost" onClick={() => setSelectedRunId((current) => current === run.id ? null : run.id)} aria-expanded={selectedRunId === run.id} className="min-h-11">{selectedRunId === run.id ? "Hide details" : "View details"}</Button></div></div>{selectedRunId === run.id && (selectedRunQuery.isLoading ? <div className="mt-4 flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Loading exact results…</div> : selectedRunQuery.isError ? <div className="mt-4"><ErrorState title="Run details could not be loaded" onRetry={() => void selectedRunQuery.refetch()} /></div> : selectedRunQuery.data ? <AutomationRunDetails run={selectedRunQuery.data.run} /> : null)}</li>)}</ol>{runsQuery.hasNextPage && <div className="flex justify-center border-t border-kumo-line px-4 py-4"><Button variant="secondary" onClick={() => void runsQuery.fetchNextPage()} loading={runsQuery.isFetchingNextPage} className="min-h-11">Load older runs</Button></div>}</>}</section>}</main>{editorOpen && <AutomationRuleEditor key={selectedRule?.id ?? "new"} mailboxId={mailboxId} orderRevision={rulesQuery.data?.orderRevision ?? 0} rule={selectedRule} labels={labels} folders={folders} onClose={closeEditor} onAccessRevoked={onAccessRevoked} />}</div>;
}

function StateMessage({ children }: { children: React.ReactNode }) { return <div className="grid min-h-64 place-items-center px-5 text-sm text-kumo-subtle" role="status"><div className="flex items-center gap-2">{children}</div></div>; }
function ErrorState({ title, onRetry }: { title: string; onRetry(): void }) { return <div className="grid min-h-64 place-items-center px-5 text-center" role="alert"><div><WarningCircleIcon className="mx-auto text-kumo-danger" size={28} /><p className="mt-2 font-medium text-kumo-default">{title}</p><p className="mt-1 text-sm text-kumo-subtle">Your rules were not changed. Retry when you are ready.</p><Button variant="secondary" icon={<ArrowsClockwiseIcon size={16} />} onClick={onRetry} className="mt-4 min-h-11">Retry</Button></div></div>; }
