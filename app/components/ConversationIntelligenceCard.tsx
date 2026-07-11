import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  CaretDownIcon,
  CaretUpIcon,
  SparkleIcon,
  ArrowsClockwiseIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useConversationIntelligence } from "~/queries/conversation-intelligence";
import type {
  ConversationIntelligenceResult,
  IntelligenceEvidence,
} from "~/services/conversation-intelligence";

function label(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dueLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return `Due ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}

function EvidenceLinks({
  messageIds,
  onFocusMessage,
}: {
  messageIds: string[];
  onFocusMessage: (messageId: string) => void;
}) {
  const focusEvidence = (messageId: string) => {
    onFocusMessage(messageId);
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-intelligence-message-id="${CSS.escape(messageId)}"]`,
      );
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {messageIds.map((messageId, index) => (
        <button
          key={messageId}
          type="button"
          onClick={() => focusEvidence(messageId)}
          className="min-h-8 rounded px-1.5 text-xs font-semibold text-kumo-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
          aria-label={`Focus cited message ${index + 1}`}
        >
          Evidence {index + 1}
        </button>
      ))}
    </span>
  );
}

function EvidenceItem({
  item,
  meta,
  onFocusMessage,
}: {
  item: IntelligenceEvidence;
  meta?: string;
  onFocusMessage: (messageId: string) => void;
}) {
  return (
    <li className="space-y-1 text-sm text-kumo-strong">
      <p>{item.text}</p>
      {meta && <p className="text-xs font-medium text-kumo-subtle">{meta}</p>}
      <EvidenceLinks
        messageIds={item.messageIds}
        onFocusMessage={onFocusMessage}
      />
    </li>
  );
}

function IntelligenceResult({
  result,
  onFocusMessage,
}: {
  result: ConversationIntelligenceResult;
  onFocusMessage: (messageId: string) => void;
}) {
  return (
    <div className="space-y-5 px-4 pb-5 sm:px-5">
      <section aria-labelledby="intelligence-summary-heading">
        <h3
          id="intelligence-summary-heading"
          className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle"
        >
          Summary
        </h3>
        <p className="mt-1 text-sm leading-6 text-kumo-default">
          {result.summary.text}
        </p>
        <EvidenceLinks
          messageIds={result.summary.messageIds}
          onFocusMessage={onFocusMessage}
        />
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-lg bg-kumo-recessed p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-kumo-subtle">
              Priority
            </span>
            <Badge variant="outline">{label(result.priority.level)}</Badge>
          </div>
          <p className="mt-1 text-sm text-kumo-strong">
            {result.priority.rationale}
          </p>
          <EvidenceLinks
            messageIds={result.priority.messageIds}
            onFocusMessage={onFocusMessage}
          />
        </section>
        <section className="rounded-lg bg-kumo-recessed p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-kumo-subtle">
              Category
            </span>
            <Badge variant="outline">{label(result.category.value)}</Badge>
          </div>
          <p className="mt-1 text-sm text-kumo-strong">
            {result.category.rationale}
          </p>
          <EvidenceLinks
            messageIds={result.category.messageIds}
            onFocusMessage={onFocusMessage}
          />
        </section>
      </div>

      {result.keyPoints.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
            Key points
          </h3>
          <ul className="mt-2 list-disc space-y-3 ps-5">
            {result.keyPoints.map((item, index) => (
              <EvidenceItem
                key={`${item.messageIds.join("-")}-${index}`}
                item={item}
                onFocusMessage={onFocusMessage}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-kumo-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
            Suggested next action
          </h3>
          <Badge variant="outline">Human review required</Badge>
        </div>
        <p className="mt-2 text-sm font-medium text-kumo-default">
          {result.suggestedNextAction.text}
        </p>
        <EvidenceLinks
          messageIds={result.suggestedNextAction.messageIds}
          onFocusMessage={onFocusMessage}
        />
      </section>

      {result.signals.followUps.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
            Follow-ups
          </h3>
          <ul className="mt-2 list-disc space-y-3 ps-5">
            {result.signals.followUps.map((item, index) => (
              <EvidenceItem
                key={`${item.messageIds.join("-")}-${index}`}
                item={item}
                meta={dueLabel(item.dueAt)}
                onFocusMessage={onFocusMessage}
              />
            ))}
          </ul>
        </section>
      )}
      {result.signals.commitments.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
            Commitments
          </h3>
          <ul className="mt-2 list-disc space-y-3 ps-5">
            {result.signals.commitments.map((item, index) => (
              <EvidenceItem
                key={`${item.messageIds.join("-")}-${index}`}
                item={{ text: item.text, messageIds: item.messageIds }}
                meta={[item.actor, dueLabel(item.dueAt)]
                  .filter(Boolean)
                  .join(" · ")}
                onFocusMessage={onFocusMessage}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function ConversationIntelligenceCard({
  mailboxId,
  emailId,
  onFocusMessage,
}: {
  mailboxId: string;
  emailId: string;
  onFocusMessage: (messageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const intelligence = useConversationIntelligence(
    mailboxId,
    emailId,
    expanded,
  );
  const error = intelligence.refreshError ?? intelligence.error;
  return (
    <section
      className="border-b border-kumo-line bg-kumo-base"
      aria-labelledby="conversation-intelligence-heading"
    >
      <div className="flex min-h-14 items-center gap-2 px-4 sm:px-5">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls="conversation-intelligence-content"
        >
          <SparkleIcon
            size={18}
            className="shrink-0 text-kumo-brand"
            aria-hidden="true"
          />
          <span
            id="conversation-intelligence-heading"
            className="font-semibold text-kumo-default"
          >
            Intelligence
          </span>
          {intelligence.data?.state === "cached" && (
            <Badge variant="outline">Cached</Badge>
          )}
          {intelligence.data?.state === "generated" && (
            <Badge variant="outline">Generated</Badge>
          )}
          {expanded ? (
            <CaretUpIcon size={15} className="ms-auto shrink-0" />
          ) : (
            <CaretDownIcon size={15} className="ms-auto shrink-0" />
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          shape="square"
          size="sm"
          className="min-h-11 min-w-11"
          icon={
            <ArrowsClockwiseIcon
              size={17}
              className={
                intelligence.isRefreshing
                  ? "animate-spin motion-reduce:animate-none"
                  : ""
              }
            />
          }
          onClick={() => intelligence.refresh()}
          disabled={intelligence.isLoading || intelligence.isRefreshing}
          aria-label="Refresh intelligence"
        />
      </div>
      {expanded && (
        <div id="conversation-intelligence-content">
          {intelligence.isLoading ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-kumo-subtle"
            >
              <Loader size="sm" />
              Analyzing this conversation…
            </div>
          ) : error ? (
            <div role="alert" className="px-4 pb-5 text-sm text-kumo-danger">
              Conversation intelligence is unavailable. Try refreshing.
            </div>
          ) : intelligence.data?.state === "budget_paused" ? (
            <div role="status" className="px-4 pb-5 text-sm text-kumo-subtle">
              Intelligence is paused by the team’s AI budget controls. Mail
              remains fully available.
            </div>
          ) : intelligence.data?.result ? (
            <IntelligenceResult
              result={intelligence.data.result}
              onFocusMessage={onFocusMessage}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
