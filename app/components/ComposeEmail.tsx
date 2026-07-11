// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Dialog, DropdownMenu, Input } from "@cloudflare/kumo";
import {
  CalendarBlankIcon,
  CaretDownIcon,
  ClockIcon,
  FloppyDiskIcon,
  PaperPlaneTiltIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import { useUIStore } from "~/hooks/useUIStore";
import { useBrand } from "~/hooks/useBrand";
import { useAiDraftCompose } from "~/queries/emails";
import { assistantCopyFor } from "~/utils/assistant-copy";
import {
  earliestScheduleTime,
  formatDateTimeLocalValue,
  formatScheduledTime,
  getSendLaterPresets,
  parseAndValidateLocalSchedule,
  scheduleHorizonEnd,
} from "~/lib/send-later";
import RichTextEditor from "./RichTextEditor";
import ComposeAttachments from "./ComposeAttachments";

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

  const { isComposing, closeCompose, composeOptions } = useUIStore();
  const { brand, name } = useBrand();
  const assistantCopy = assistantCopyFor(brand, name);
  const aiComposeMut = useAiDraftCompose();
  const [showAiPrompt, setShowAiPrompt] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [showCustomSchedule, setShowCustomSchedule] = useState(false);
  const [customScheduleValue, setCustomScheduleValue] = useState("");
  const [customScheduleError, setCustomScheduleError] = useState<string | null>(
    null,
  );
  const [customScheduleReference, setCustomScheduleReference] = useState(
    () => new Date(),
  );
  const isNewCompose =
    composeOptions.mode === "new" && !composeOptions.draftEmail;
  const sendLaterPresets = getSendLaterPresets();
  const scheduledLabel = scheduledFor
    ? formatScheduledTime(new Date(scheduledFor))
    : null;

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
    attachments,
    addFiles,
    removeAttachment,
    isUploading,
  } = useComposeForm(mailboxId, folder);
  const sendButtonLabel = isSending
    ? scheduledFor
      ? "Scheduling…"
      : "Sending…"
    : isUploading
      ? "Uploading…"
      : scheduledFor
        ? "Schedule"
        : "Send";

  useEffect(() => {
    if (!isComposing) return;
    setScheduledFor(null);
    setShowCustomSchedule(false);
    setCustomScheduleError(null);
  }, [composeOptions, isComposing]);

  const choosePreset = (date: Date) => {
    setScheduledFor(date.toISOString());
    setCustomScheduleError(null);
  };

  const openCustomSchedule = () => {
    const now = new Date();
    setCustomScheduleReference(now);
    setCustomScheduleValue(
      formatDateTimeLocalValue(
        scheduledFor ? new Date(scheduledFor) : earliestScheduleTime(now),
      ),
    );
    setCustomScheduleError(null);
    setShowCustomSchedule(true);
  };

  const applyCustomSchedule = () => {
    const result = parseAndValidateLocalSchedule(
      customScheduleValue,
      new Date(),
    );
    if (!result.ok) {
      setCustomScheduleError(result.error);
      return;
    }
    setScheduledFor(result.iso);
    setCustomScheduleError(null);
    setShowCustomSchedule(false);
  };

  const handleAiGenerate = async () => {
    if (!mailboxId || !aiPrompt.trim()) return;
    try {
      const draft = await aiComposeMut.mutateAsync({
        mailboxId,
        prompt: aiPrompt.trim(),
      });
      if (draft.subject) setSubject(draft.subject);
      if (draft.body) setBody(draft.body);
      setShowAiPrompt(false);
      setAiPrompt("");
    } catch {
      // error surfaced via mutation.error
    }
  };

  return (
    <>
      <Dialog.Root
        open={isComposing}
        onOpenChange={(open) => !open && !isSending && closeCompose()}
      >
        <Dialog
          size="lg"
          className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:w-[min(820px,94vw)]"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3 sm:px-6 sm:py-4 shrink-0">
            <Dialog.Title className="text-lg font-semibold text-kumo-default">
              {formTitle}
            </Dialog.Title>
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={<XIcon size={18} />}
              className="min-h-11 min-w-11"
              onClick={() => !isSending && closeCompose()}
              disabled={isSending}
              aria-label="Close compose"
            />
          </div>

          <form
            onSubmit={(e) =>
              handleSend(e, closeCompose, scheduledFor ?? undefined)
            }
            className="flex flex-col flex-1 min-h-0"
          >
            <div role="status" aria-live="polite" className="sr-only">
              {isSending
                ? "Sending message"
                : isSavingDraft
                  ? "Saving draft"
                  : isUploading
                    ? "Uploading attachments"
                    : aiComposeMut.isPending
                      ? "Generating draft"
                      : ""}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 sm:px-6 sm:py-5">
              {error && (
                <div role="alert" aria-live="assertive">
                  <Banner variant="error" text={error} />
                </div>
              )}

              {/* Recipients */}
              <div className="flex min-w-0 items-end gap-2 sm:gap-3">
                <div className="flex-1">
                  <Input
                    label="To"
                    type="text"
                    placeholder="recipient@example.com, another@example.com"
                    value={to}
                    autoFocus
                    onChange={(e) => setTo(e.target.value)}
                    required
                  />
                </div>
                {!showCcBcc && (
                  <button
                    type="button"
                    onClick={() => setShowCcBcc(true)}
                    className="min-h-11 shrink-0 rounded px-2 text-sm text-kumo-link hover:underline font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
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

              {/* AI compose, only for brand-new emails */}
              {isNewCompose && (
                <div>
                  {!showAiPrompt ? (
                    <button
                      type="button"
                      onClick={() => setShowAiPrompt(true)}
                      className="flex min-h-11 items-center gap-1.5 rounded px-1 text-sm text-kumo-link hover:text-kumo-link-hover font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
                    >
                      <SparkleIcon size={15} weight="fill" />
                      Generate with AI
                    </button>
                  ) : (
                    <div className="rounded-lg border border-kumo-line bg-kumo-recessed p-3 space-y-2">
                      <label
                        htmlFor="ai-compose-prompt"
                        className="text-xs font-medium text-kumo-subtle"
                      >
                        What should this email be about?
                      </label>
                      <textarea
                        id="ai-compose-prompt"
                        autoFocus
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                            handleAiGenerate();
                          if (e.key === "Escape") setShowAiPrompt(false);
                        }}
                        placeholder={assistantCopy.composePlaceholder}
                        rows={2}
                        className="w-full resize-y rounded border border-kumo-line bg-white px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-placeholder focus:outline-none focus:ring-2 focus:ring-kumo-focus"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          className="min-h-11"
                          loading={aiComposeMut.isPending}
                          disabled={!aiPrompt.trim() || aiComposeMut.isPending}
                          icon={<SparkleIcon size={14} weight="fill" />}
                          onClick={handleAiGenerate}
                        >
                          {aiComposeMut.isPending ? "Generating…" : "Generate"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="min-h-11"
                          disabled={aiComposeMut.isPending}
                          onClick={() => {
                            setShowAiPrompt(false);
                            setAiPrompt("");
                          }}
                        >
                          Cancel
                        </Button>
                        {aiComposeMut.isError && (
                          <span
                            role="alert"
                            className="min-w-0 break-words text-xs text-kumo-danger sm:ml-1"
                          >
                            {(aiComposeMut.error as Error)?.message ||
                              "Generation failed"}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Body */}
              <div className="h-[38dvh] min-h-[220px] sm:h-[42vh] sm:min-h-[280px]">
                <RichTextEditor value={body} onChange={setBody} />
              </div>

              {/* Attachments */}
              <ComposeAttachments
                attachments={attachments}
                onAddFiles={addFiles}
                onRemove={removeAttachment}
                disabled={isSending}
              />
            </div>

            {scheduledLabel && (
              <div
                role="status"
                aria-live="polite"
                className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-kumo-line bg-kumo-brand/5 px-4 py-2.5 text-sm sm:px-6"
              >
                <ClockIcon
                  size={17}
                  className="shrink-0 text-kumo-brand"
                  aria-hidden="true"
                />
                <span className="text-kumo-subtle">Scheduled for</span>
                <strong className="text-kumo-default">{scheduledLabel}</strong>
                <button
                  type="button"
                  className="min-h-11 rounded px-2 font-semibold text-kumo-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand sm:ms-auto"
                  onClick={() => setScheduledFor(null)}
                >
                  Send now instead
                </button>
              </div>
            )}

            {/* Footer actions */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-recessed px-4 py-3 sm:px-6 sm:py-4 shrink-0">
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                onClick={() => !isSending && closeCompose()}
                disabled={isSending}
              >
                Discard
              </Button>
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11 min-w-0 flex-1 sm:flex-none"
                  loading={isSavingDraft}
                  disabled={isSending || isUploading}
                  icon={<FloppyDiskIcon size={16} />}
                  onClick={handleSaveDraft}
                >
                  {isSavingDraft ? "Saving…" : "Save draft"}
                </Button>
                <div className="flex min-w-0 flex-1 sm:flex-none">
                  <Button
                    type="submit"
                    variant="primary"
                    className="min-h-11 min-w-0 flex-1 rounded-r-none sm:min-w-24"
                    loading={isSending}
                    disabled={isSavingDraft || isSending || isUploading}
                    icon={<PaperPlaneTiltIcon size={16} />}
                  >
                    {sendButtonLabel}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      render={
                        <Button
                          type="button"
                          variant="primary"
                          shape="square"
                          className="min-h-11 min-w-11 rounded-l-none border-l border-kumo-line/30"
                          icon={<CaretDownIcon size={16} />}
                          aria-label="Send options"
                          disabled={isSavingDraft || isSending || isUploading}
                        />
                      }
                    />
                    <DropdownMenu.Content>
                      <DropdownMenu.Label>Send later</DropdownMenu.Label>
                      {sendLaterPresets.map((preset) => (
                        <DropdownMenu.Item
                          key={preset.id}
                          icon={ClockIcon}
                          className="min-h-11"
                          onSelect={() => choosePreset(preset.date)}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="font-medium">{preset.title}</span>
                            <span className="text-xs text-kumo-subtle">
                              {formatScheduledTime(preset.date)}
                            </span>
                          </span>
                        </DropdownMenu.Item>
                      ))}
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        className="min-h-11"
                        icon={CalendarBlankIcon}
                        onSelect={openCustomSchedule}
                      >
                        Custom date and time…
                      </DropdownMenu.Item>
                      {scheduledFor && (
                        <DropdownMenu.Item
                          className="min-h-11"
                          icon={PaperPlaneTiltIcon}
                          onSelect={() => setScheduledFor(null)}
                        >
                          Send now
                        </DropdownMenu.Item>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={showCustomSchedule}
        onOpenChange={setShowCustomSchedule}
      >
        <Dialog size="sm" className="w-[calc(100vw-1rem)] p-0 sm:w-[420px]">
          <div className="border-b border-kumo-line px-4 py-4 sm:px-5">
            <Dialog.Title className="text-base font-semibold text-kumo-default">
              Choose a local send time
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
              The timezone shown by your device will be used.
            </Dialog.Description>
          </div>
          <div className="space-y-3 px-4 py-4 sm:px-5">
            <label
              htmlFor="custom-send-time"
              className="block text-sm font-semibold text-kumo-default"
            >
              Local date and time
            </label>
            <input
              id="custom-send-time"
              type="datetime-local"
              value={customScheduleValue}
              min={formatDateTimeLocalValue(
                earliestScheduleTime(customScheduleReference),
              )}
              max={formatDateTimeLocalValue(
                scheduleHorizonEnd(customScheduleReference),
              )}
              onChange={(event) => {
                setCustomScheduleValue(event.target.value);
                setCustomScheduleError(null);
              }}
              aria-describedby="custom-send-time-help"
              aria-invalid={Boolean(customScheduleError)}
              className="min-h-11 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-base text-kumo-default outline-none focus:ring-2 focus:ring-kumo-brand"
            />
            <p id="custom-send-time-help" className="text-xs text-kumo-subtle">
              Choose any valid future time within the next year.
            </p>
            {customScheduleError && (
              <p role="alert" className="text-sm font-medium text-kumo-danger">
                {customScheduleError}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-5">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => setShowCustomSchedule(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              className="min-h-11"
              onClick={applyCustomSchedule}
            >
              Use this time
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}
