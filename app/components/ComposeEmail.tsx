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
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useBlocker, useParams } from "react-router";
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
import {
  planComposeShortcut,
  type ComposeShortcutOrigin,
} from "~/lib/compose-shortcuts";
import {
  consumeComposeFileTransfer,
  transferContainsFiles,
} from "~/lib/compose-file-transfer";
import {
  extractAiAuthoredContent,
  hasAiAuthoredContent,
  hasComposeSignature,
} from "~/lib/compose-signature";
import RichTextEditor from "./RichTextEditor";
import ComposeAttachments from "./ComposeAttachments";
import RecipientCombobox from "./RecipientCombobox";
import {
  AI_DRAFTING_LIMITS,
  validateAiComposeDraftRequest,
} from "../../shared/ai-drafting";

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

  const { isComposing, composeOptions } = useUIStore();
  const { brand, name } = useBrand();
  const assistantCopy = assistantCopyFor(brand, name);
  const aiComposeMut = useAiDraftCompose();
  const [showAiPrompt, setShowAiPrompt] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiPanelError, setAiPanelError] = useState<string | null>(null);
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
    handleBodyChange,
    applyAiBody,
    canInsertSignature,
    insertSignature,
    error,
    isSavingDraft,
    isSending,
    formTitle,
    handleSaveDraft,
    handleSend,
    isMissingAttachmentWarningOpen,
    confirmMissingAttachment,
    cancelMissingAttachment,
    requestClose,
    requestDiscard,
    closePrompt,
    keepEditing,
    saveAndClose,
    discardAndClose,
    discardLocalAndClose,
    isResolvingClose,
    draftStatusLabel,
    hasPersistedDraft,
    hasUnconfirmedWork,
    mailboxChanged,
    originMailboxId,
    attachments,
    addFiles,
		addInlineImages,
		inlineImagePreviews,
    removeAttachment,
    retryAttachment,
    isUploading,
    hasAttachmentIssue,
  } = useComposeForm(mailboxId, folder);
  const recipientValues = { to, cc, bcc };
  const navigationBlocker = useBlocker(isComposing && hasUnconfirmedWork);
  const handledBlockedNavigationRef = useRef(false);
  const composeFormRef = useRef<HTMLFormElement>(null);
  const fileDragDepthRef = useRef(0);
  const aiRequestPendingRef = useRef(false);
  const aiEditableSnapshotRef = useRef({ subject, body });
  aiEditableSnapshotRef.current = { subject, body };
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const sendButtonLabel = isSending
    ? scheduledFor
      ? "Scheduling…"
      : "Sending…"
    : isUploading
      ? "Uploading…"
      : hasAttachmentIssue
        ? "Fix attachments"
        : scheduledFor
          ? "Schedule"
          : "Send";
  const aiAuthoredBody = extractAiAuthoredContent(body);
  const hasAiDraftContext =
    subject.trim().length > 0 || hasAiAuthoredContent(body);
  const aiActionLabel = hasAiDraftContext ? "Refine" : "Generate";

  useEffect(() => {
    if (!isComposing) return;
    setScheduledFor(null);
    setShowCustomSchedule(false);
    setCustomScheduleError(null);
  }, [composeOptions, isComposing]);

  useEffect(() => {
    if (navigationBlocker.state === "unblocked") {
      handledBlockedNavigationRef.current = false;
      return;
    }
    if (
      navigationBlocker.state === "blocked" &&
      !handledBlockedNavigationRef.current
    ) {
      handledBlockedNavigationRef.current = true;
      void requestClose(() => navigationBlocker.proceed());
    }
  }, [navigationBlocker, requestClose]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      let origin: ComposeShortcutOrigin = "outside";
      if (target && composeFormRef.current?.contains(target)) {
        if (target.closest('[data-compose-shortcut-surface="ai-panel"]')) {
          origin = "ai-panel";
        } else if (
          target.closest(
            '[data-compose-shortcut-surface="nested-overlay"], [role="menu"], [role="listbox"]',
          )
        ) {
          origin = "nested-overlay";
        } else {
          origin = "primary";
        }
      }
      const action = planComposeShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isImeComposing: event.isComposing,
        composeActive: isComposing,
        defaultPrevented: event.defaultPrevented,
        origin,
        hasBlockingState: Boolean(
          closePrompt ||
          showCustomSchedule ||
          isMissingAttachmentWarningOpen ||
          isResolvingClose
        ),
      });
      if (action === "ignore" || action === "ai-generate") return;
      event.preventDefault();
      if (action === "submit") {
        composeFormRef.current?.requestSubmit();
      } else if (action === "save") {
        void handleSaveDraft();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    closePrompt,
    handleSaveDraft,
    isComposing,
    isMissingAttachmentWarningOpen,
    isResolvingClose,
    showCustomSchedule,
  ]);

  const handleKeepEditing = () => {
    keepEditing();
    if (navigationBlocker.state === "blocked") navigationBlocker.reset();
  };

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

  const handleAiGenerate = async (instruction = aiPrompt) => {
    const prompt = instruction.trim();
    if (!originMailboxId || !prompt || aiRequestPendingRef.current) return;
    if (/<img\b/i.test(aiAuthoredBody)) {
      setAiPanelError(
        "Remove inline images before refining this draft so their placement cannot be lost.",
      );
      return;
    }
    const request = {
      prompt,
      currentSubject: subject.trim().length > 0 ? subject : undefined,
      currentBody: hasAiAuthoredContent(body) ? aiAuthoredBody : undefined,
      preserveSignature: hasComposeSignature(body) || undefined,
    };
    const validation = validateAiComposeDraftRequest(request);
    if (!validation.ok) {
      setAiPanelError(
        validation.code === "invalid_fields"
          ? "This instruction or draft is too long to refine safely."
          : "This draft is too large to refine safely. Shorten it before trying again.",
      );
      return;
    }
    const requestedSnapshot = { subject, body };
    setAiPanelError(null);
    aiRequestPendingRef.current = true;
    try {
      const draft = await aiComposeMut.mutateAsync({
        mailboxId: originMailboxId,
        ...request,
      });
      if (
        aiEditableSnapshotRef.current.subject !== requestedSnapshot.subject ||
        aiEditableSnapshotRef.current.body !== requestedSnapshot.body
      ) {
        setAiPanelError(
          "Your draft changed while the writing assistant was working. Nothing was replaced. Run it again when you are ready.",
        );
        return;
      }
      if (typeof draft.subject === "string") setSubject(draft.subject);
      if (typeof draft.body === "string") applyAiBody(draft.body);
      setAiPrompt("");
    } catch {
      // error surfaced via mutation.error
    } finally {
      aiRequestPendingRef.current = false;
    }
  };

  const acceptTransferredFiles = (files: File[]) => {
    fileDragDepthRef.current = 0;
    setIsDraggingFiles(false);
    addFiles(files);
  };

  const handleOuterPaste = (event: ReactClipboardEvent<HTMLFormElement>) => {
    consumeComposeFileTransfer(event, acceptTransferredFiles);
  };

  const handleOuterDragEnter = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!transferContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setIsDraggingFiles(true);
  };

  const handleOuterDragOver = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!transferContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleOuterDragLeave = () => {
    if (fileDragDepthRef.current === 0) return;
    fileDragDepthRef.current -= 1;
    if (fileDragDepthRef.current === 0) setIsDraggingFiles(false);
  };

  const handleOuterDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    fileDragDepthRef.current = 0;
    setIsDraggingFiles(false);
    consumeComposeFileTransfer(event, acceptTransferredFiles);
  };

  return (
    <>
      <Dialog.Root
        open={isComposing}
        onOpenChange={(open) => {
          if (!open && !isSending) void requestClose();
        }}
      >
        <Dialog
          size="lg"
          className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:w-[min(820px,94vw)]"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3 sm:px-6 sm:py-4 shrink-0">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-kumo-default">
                {formTitle}
              </Dialog.Title>
              <div
                role="status"
                aria-live="polite"
                className={`mt-0.5 text-xs ${
                  draftStatusLabel === "Save failed"
                    ? "font-semibold text-kumo-danger"
                    : "text-kumo-subtle"
                }`}
              >
                {draftStatusLabel}
              </div>
            </div>
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={<XIcon size={18} />}
              className="min-h-11 min-w-11"
              onClick={() => void requestClose()}
              disabled={isSending || isResolvingClose}
              aria-label="Close compose"
            />
          </div>

          <form
            ref={composeFormRef}
            data-compose-shortcut-surface="primary"
            onSubmit={(e) => handleSend(e, scheduledFor ?? undefined)}
            onPaste={handleOuterPaste}
            onDragEnter={handleOuterDragEnter}
            onDragOver={handleOuterDragOver}
            onDragLeave={handleOuterDragLeave}
            onDrop={handleOuterDrop}
            className="relative flex flex-col flex-1 min-h-0"
          >
            {isDraggingFiles && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-kumo-brand/50 bg-white/90 px-6 text-center text-sm font-semibold text-kumo-brand shadow-sm"
              >
                Drop files to attach
              </div>
            )}
            <div role="status" aria-live="polite" className="sr-only">
              {isSending
                ? "Sending message"
                : isSavingDraft
                  ? "Saving draft"
                  : isUploading
                    ? "Uploading attachments"
                    : hasAttachmentIssue
                      ? "Attachments need attention"
                    : aiComposeMut.isPending
                      ? hasAiDraftContext
                        ? "Refining draft"
                        : "Generating draft"
                      : ""}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 sm:px-6 sm:py-5">
              {error && (
                <div role="alert" aria-live="assertive">
                  <Banner variant="error" text={error} />
                </div>
              )}

              {mailboxChanged && (
                <Banner
                  variant="alert"
                  text="You changed mailboxes. This draft is still saving to the mailbox where you started it."
                />
              )}

              {/* Recipients */}
              <div className="flex min-w-0 items-end gap-2 sm:gap-3">
                <div className="flex-1">
                  <RecipientCombobox
                    id="compose-to"
                    label="To"
                    field="to"
                    mailboxId={originMailboxId ?? ""}
                    recipients={recipientValues}
                    placeholder="recipient@example.com, another@example.com"
                    value={to}
                    autoFocus
                    onChange={setTo}
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
                <RecipientCombobox
                  id="compose-cc"
                  label="Cc"
                  field="cc"
                  mailboxId={originMailboxId ?? ""}
                  recipients={recipientValues}
                  value={cc}
                  onChange={setCc}
                  placeholder="Separate multiple addresses with commas"
                />
              )}
              {showCcBcc && (
                <RecipientCombobox
                  id="compose-bcc"
                  label="Bcc"
                  field="bcc"
                  mailboxId={originMailboxId ?? ""}
                  recipients={recipientValues}
                  value={bcc}
                  onChange={setBcc}
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
                      onClick={() => {
                        aiComposeMut.reset();
                        setAiPanelError(null);
                        setShowAiPrompt(true);
                      }}
                      className="flex min-h-11 items-center gap-1.5 rounded px-1 text-sm text-kumo-link hover:text-kumo-link-hover font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
                    >
                      <SparkleIcon size={15} weight="fill" />
                      Write with AI
                    </button>
                  ) : (
                    <div
                      data-compose-shortcut-surface="ai-panel"
                      aria-busy={aiComposeMut.isPending}
                      className="space-y-3 rounded-lg border border-kumo-line bg-kumo-recessed p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-kumo-default">
                            Writing assistant
                          </div>
                          <label
                            htmlFor="ai-compose-prompt"
                            className="mt-0.5 block text-xs text-kumo-subtle"
                          >
                            {hasAiDraftContext
                              ? "Tell it what to improve in your current draft."
                              : "Describe the email you want to write."}
                          </label>
                        </div>
                        <button
                          type="button"
                          aria-label="Close writing assistant"
                          disabled={aiComposeMut.isPending}
                          onClick={() => {
                            aiComposeMut.reset();
                            setAiPanelError(null);
                            setShowAiPrompt(false);
                            setAiPrompt("");
                          }}
                          className="flex min-h-9 min-w-9 items-center justify-center rounded text-kumo-subtle hover:bg-white hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:opacity-50"
                        >
                          <XIcon size={15} />
                        </button>
                      </div>
                      {hasAiDraftContext && (
                        <div
                          className="flex flex-wrap gap-1.5"
                          aria-label="Quick refinements"
                        >
                          {[
                            ["Polish", "Polish this draft while preserving its meaning."],
                            ["Shorter", "Make this draft shorter and more concise."],
                            ["More formal", "Make this draft more formal."],
                            ["Friendlier", "Make this draft friendlier and warmer."],
                          ].map(([label, instruction]) => (
                            <Button
                              key={label}
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={aiComposeMut.isPending}
                              onClick={() => void handleAiGenerate(instruction)}
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                      )}
                      <textarea
                        id="ai-compose-prompt"
                        autoFocus
                        value={aiPrompt}
                        disabled={aiComposeMut.isPending}
                        maxLength={AI_DRAFTING_LIMITS.promptChars}
                        onChange={(e) => setAiPrompt(e.target.value)}
                        onKeyDown={(e) => {
                          const action = planComposeShortcut({
                            key: e.key,
                            metaKey: e.metaKey,
                            ctrlKey: e.ctrlKey,
                            altKey: e.altKey,
                            shiftKey: e.shiftKey,
                            repeat: e.repeat,
                            isImeComposing: e.nativeEvent.isComposing,
                            composeActive: isComposing,
                            hasBlockingState: false,
                            defaultPrevented: e.defaultPrevented,
                            origin: "ai-prompt",
                          });
                          if (action === "ai-generate") {
                            e.preventDefault();
                            e.stopPropagation();
                            void handleAiGenerate();
                          }
                          if (e.key === "Escape" && !aiComposeMut.isPending) {
                            aiComposeMut.reset();
                            setAiPanelError(null);
                            setShowAiPrompt(false);
                            setAiPrompt("");
                          }
                        }}
                        placeholder={
                          hasAiDraftContext
                            ? "For example: emphasize the next steps and keep it concise"
                            : assistantCopy.composePlaceholder
                        }
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
                          onClick={() => void handleAiGenerate()}
                        >
                          {aiComposeMut.isPending
                            ? `${aiActionLabel}…`
                            : aiActionLabel}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="min-h-11"
                          disabled={aiComposeMut.isPending}
                          onClick={() => setAiPrompt("")}
                        >
                          Clear
                        </Button>
                        {(aiPanelError || aiComposeMut.isError) && (
                          <span
                            role="alert"
                            className="min-w-0 break-words text-xs text-kumo-danger sm:ml-1"
                          >
                            {aiPanelError ||
                              (aiComposeMut.error as Error)?.message ||
                              "The writing assistant could not update this draft. Your content is unchanged."}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Body */}
              {canInsertSignature && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-h-11"
                    aria-label="Insert signature"
                    onClick={insertSignature}
                  >
                    Insert signature
                  </Button>
                </div>
              )}
              <div className="h-[38dvh] min-h-[220px] sm:h-[42vh] sm:min-h-[280px]">
                <RichTextEditor
                  value={body}
                  onChange={handleBodyChange}
                  onFiles={acceptTransferredFiles}
					onInlineImages={addInlineImages}
					inlineImagePreviews={inlineImagePreviews}
                />
              </div>

              {/* Attachments */}
              <ComposeAttachments
                attachments={attachments}
                bodyHtml={body}
                onAddFiles={addFiles}
                onRemove={removeAttachment}
                onRetry={retryAttachment}
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
                onClick={requestDiscard}
                disabled={isSending || isResolvingClose}
              >
                Discard
              </Button>
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11 min-w-0 flex-1 sm:flex-none"
                  loading={isSavingDraft}
                  disabled={
                    isSending ||
                    isResolvingClose ||
                    isUploading ||
                    hasAttachmentIssue
                  }
                  icon={<FloppyDiskIcon size={16} />}
                  onClick={handleSaveDraft}
                  aria-keyshortcuts="Meta+S Control+S"
                  title="Save draft (⌘/Ctrl+S)"
                >
                  {isSavingDraft ? "Saving…" : "Save draft"}
                </Button>
                <div className="flex min-w-0 flex-1 sm:flex-none">
                  <Button
                    type="submit"
                    variant="primary"
                    className="min-h-11 min-w-0 flex-1 rounded-r-none sm:min-w-24"
                    loading={isSending}
                    disabled={
                      isSavingDraft ||
                      isSending ||
                      isResolvingClose ||
                      isUploading ||
                      hasAttachmentIssue
                    }
                    icon={<PaperPlaneTiltIcon size={16} />}
                    aria-keyshortcuts="Meta+Enter Control+Enter"
                    title="Send (⌘/Ctrl+Enter)"
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
                          disabled={
                            isSavingDraft ||
                            isSending ||
                            isResolvingClose ||
                            isUploading ||
                            hasAttachmentIssue
                          }
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
        open={isMissingAttachmentWarningOpen}
        onOpenChange={(open) => {
          if (!open && !isSending) cancelMissingAttachment();
        }}
      >
        <Dialog size="sm" className="w-[calc(100vw-1rem)] p-0 sm:w-[440px]">
          <div className="border-b border-kumo-line px-4 py-4 sm:px-5">
            <Dialog.Title className="text-base font-semibold text-kumo-default">
              Send without an attachment?
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
              Your message says an attachment is included, but no ready file is attached.
            </Dialog.Description>
          </div>
          <div className="flex flex-wrap justify-end gap-2 px-4 py-4 sm:px-5">
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={isSending}
              onClick={cancelMissingAttachment}
            >
              Back
            </Button>
            <Button
              type="button"
              variant="primary"
              className="min-h-11"
              loading={isSending}
              disabled={isSending}
              onClick={confirmMissingAttachment}
            >
              Send anyway
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(closePrompt)}
        onOpenChange={(open) => {
          if (!open && !isResolvingClose) handleKeepEditing();
        }}
      >
        <Dialog size="sm" className="w-[calc(100vw-1rem)] p-0 sm:w-[440px]">
          <div className="border-b border-kumo-line px-4 py-4 sm:px-5">
            <Dialog.Title className="text-base font-semibold text-kumo-default">
              {closePrompt?.reason === "save-failed"
                ? "Draft is not safely saved"
                : closePrompt?.reason === "access-revoked"
                  ? "Mailbox access was removed"
                : closePrompt?.reason === "discard"
                  ? hasPersistedDraft
                    ? "Discard this draft?"
                    : "Discard these changes?"
                  : "Save before closing?"}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
              {closePrompt?.message ||
                (closePrompt?.reason === "discard"
                  ? hasPersistedDraft
                    ? "Discard permanently removes the saved draft and its attachments. This cannot be undone."
                    : "These unsaved changes will be removed. This cannot be undone."
                  : "Save the latest changes, keep editing, or deliberately discard the draft.")}
            </Dialog.Description>
          </div>
          <div className="flex flex-wrap justify-end gap-2 px-4 py-4 sm:px-5">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={isResolvingClose}
              onClick={handleKeepEditing}
            >
              Keep editing
            </Button>
            {closePrompt?.reason !== "access-revoked" && (
              <Button
                type="button"
                variant="secondary"
                className="min-h-11"
                loading={isResolvingClose && isSavingDraft}
                disabled={isResolvingClose}
                onClick={() => void saveAndClose()}
              >
                Save and close
              </Button>
            )}
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              loading={isResolvingClose && !isSavingDraft}
              disabled={isResolvingClose}
              onClick={() =>
                closePrompt?.reason === "access-revoked"
                  ? discardLocalAndClose()
                  : void discardAndClose()
              }
            >
              {closePrompt?.reason === "access-revoked"
                ? "Discard local changes and close"
                : hasPersistedDraft
                  ? "Discard draft"
                  : "Discard changes"}
            </Button>
          </div>
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
