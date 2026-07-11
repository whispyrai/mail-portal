// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  escapeHtml,
  formatComposeDate,
  getSignatureBlock,
  htmlToPlainText,
  splitEmailList,
  stripHtml,
  toEmailListValue,
} from "~/lib/utils";
import {
  useCancelOutboundDelivery,
  useForwardEmail,
  useReplyToEmail,
  useSaveDraft,
  useSendEmail,
} from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import { useAttachments, attachmentsToRefs } from "~/hooks/useAttachments";
import type { OutboundEnqueueResponse } from "~/types";
import { LogicalSendIdentity } from "~/lib/compose-send-identity";
import { validateScheduledDate } from "~/lib/send-later";

function appendUniqueAddress(
  addresses: string[],
  seen: Set<string>,
  address: string,
  exclude?: string,
) {
  const trimmed = address.trim();
  if (!trimmed) return;

  const normalized = trimmed.toLowerCase();
  if (normalized === exclude || seen.has(normalized)) return;

  seen.add(normalized);
  addresses.push(trimmed);
}

interface ComposeFormFields {
  to: string;
  cc: string;
  bcc: string;
  showCcBcc: boolean;
  subject: string;
  body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
  to: "",
  cc: "",
  bcc: "",
  showCcBcc: false,
  subject: "",
  body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
  const expectedPrefix = `${prefix}: `;
  return subject.startsWith(expectedPrefix)
    ? subject
    : `${expectedPrefix}${subject}`;
}

function buildForwardBody(
  original: NonNullable<
    ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]
  >,
  sigBlock: string,
) {
  const safeSender = escapeHtml(original.sender);
  const safeSubject = escapeHtml(original.subject);
  const safeBody = escapeHtml(stripHtml(original.body || "")).replace(
    /\n/g,
    "<br>",
  );

  return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
  original: NonNullable<
    ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]
  >,
  selfAddress?: string,
) {
  const toRecipients: string[] = [];
  const toSeen = new Set<string>();
  appendUniqueAddress(toRecipients, toSeen, original.sender, selfAddress);

  for (const recipient of splitEmailList(original.recipient)) {
    appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
  }

  const ccRecipients: string[] = [];
  const ccSeen = new Set<string>();
  for (const recipient of splitEmailList(original.cc)) {
    const normalized = recipient.toLowerCase();
    if (
      normalized === selfAddress ||
      toSeen.has(normalized) ||
      ccSeen.has(normalized)
    ) {
      continue;
    }
    ccSeen.add(normalized);
    ccRecipients.push(recipient);
  }

  return {
    to: toRecipients.join(", "),
    cc: ccRecipients.join(", "),
    showCcBcc: ccRecipients.length > 0,
  };
}

function buildInitialComposeFields(
  composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
  mailboxEmail: string | undefined,
  sigBlock: string,
): ComposeFormFields {
  const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

  if (draft) {
    return {
      to: draft.recipient || "",
      cc: draft.cc || "",
      bcc: draft.bcc || "",
      showCcBcc: Boolean(draft.cc || draft.bcc),
      subject: draft.subject || "",
      body: draft.body || "",
    };
  }

  if (!original) {
    return {
      ...EMPTY_FIELDS,
      body: sigBlock ? `<p><br></p>${sigBlock}` : "",
    };
  }

  // Replies open with a clean body (signature only). The original message stays
  // visible in the thread view behind the composer; it is deliberately NOT
  // quoted into the reply body.
  if (mode === "reply") {
    return {
      ...EMPTY_FIELDS,
      to: original.sender,
      subject: getPrefixedSubject(original.subject, "Re"),
      body: sigBlock ? `<p><br></p>${sigBlock}` : "",
    };
  }

  if (mode === "reply-all") {
    const recipients = buildReplyAllFields(
      original,
      mailboxEmail?.toLowerCase(),
    );
    return {
      ...EMPTY_FIELDS,
      ...recipients,
      subject: getPrefixedSubject(original.subject, "Re"),
      body: sigBlock ? `<p><br></p>${sigBlock}` : "",
    };
  }

  if (mode === "forward") {
    return {
      ...EMPTY_FIELDS,
      subject: getPrefixedSubject(original.subject, "Fwd"),
      body: buildForwardBody(original, sigBlock),
    };
  }

  return {
    ...EMPTY_FIELDS,
    body: sigBlock ? `<p><br></p>${sigBlock}` : "",
  };
}

export function useComposeForm(mailboxId?: string, _folder?: string) {
  const toastManager = useKumoToastManager();
  const { composeOptions, closePanel, closeCompose } = useUIStore();
  const { data: currentMailbox } = useMailbox(mailboxId);
  const sendEmailMutation = useSendEmail();
  const saveDraftMutation = useSaveDraft();
  const replyMutation = useReplyToEmail();
  const forwardMutation = useForwardEmail();
  const cancelOutboundMutation = useCancelOutboundDelivery();
  const {
    attachments,
    addFiles,
    removeAttachment,
    hydrateFromDraft,
    reset: resetAttachments,
    isUploading,
    hasError: hasAttachmentError,
  } = useAttachments(mailboxId);

  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [draftIdentity, setDraftIdentity] = useState<{
    id: string;
    version: number;
  } | null>(null);
  const sendIdentityRef = useRef(new LogicalSendIdentity());
  const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
  const isDraftEdit = !!composeOptions.draftEmail;

  const formTitle = useMemo(() => {
    if (isDraftEdit) return "Edit Draft";
    switch (composeOptions.mode) {
      case "reply":
        return "Reply";
      case "reply-all":
        return "Reply All";
      case "forward":
        return "Forward";
      default:
        return "New Message";
    }
  }, [composeOptions.mode, isDraftEdit]);

  const sigBlock = useMemo(
    () => getSignatureBlock(currentMailbox?.settings),
    [currentMailbox],
  );

  useEffect(() => {
    if (lastInitializedOptionsRef.current === composeOptions) return;
    lastInitializedOptionsRef.current = composeOptions;

    const initialFields = buildInitialComposeFields(
      composeOptions,
      currentMailbox?.email,
      sigBlock,
    );
    setError(null);
    setTo(initialFields.to);
    setCc(initialFields.cc);
    setBcc(initialFields.bcc);
    setShowCcBcc(initialFields.showCcBcc);
    setSubject(initialFields.subject);
    setBody(initialFields.body);
    setDraftIdentity(
      composeOptions.draftEmail?.id
        ? {
            id: composeOptions.draftEmail.id,
            version: composeOptions.draftEmail.draft_version ?? 1,
          }
        : null,
    );
    sendIdentityRef.current.reset();

    // Seed attachment chips from a real draft (id-bearing); clear otherwise.
    const draftToHydrate = composeOptions.draftEmail;
    if (draftToHydrate?.id)
      hydrateFromDraft(draftToHydrate.id, draftToHydrate.attachments);
    else resetAttachments();
  }, [
    composeOptions,
    currentMailbox?.email,
    sigBlock,
    hydrateFromDraft,
    resetAttachments,
  ]);

  const handleSaveDraft = async () => {
    if (!mailboxId || isSending) return;
    setIsSavingDraft(true);
    setError(null);
    try {
      const saved = await saveDraftMutation.mutateAsync({
        mailboxId,
        draft: {
          to,
          cc: cc || undefined,
          bcc: bcc || undefined,
          subject,
          body,
          in_reply_to:
            composeOptions.originalEmail?.id ||
            composeOptions.draftEmail?.in_reply_to ||
            undefined,
          thread_id:
            composeOptions.originalEmail?.thread_id ||
            composeOptions.draftEmail?.thread_id ||
            undefined,
          draft_id: draftIdentity?.id,
          draft_version: draftIdentity?.version,
          attachments: attachmentsToRefs(attachments),
        },
      });
      setDraftIdentity({ id: saved.id, version: saved.draft_version ?? 1 });
      hydrateFromDraft(saved.id, saved.attachments);
      sendIdentityRef.current.reset();
      toastManager.add({ title: "Draft saved!" });
    } catch (err: unknown) {
      const message =
        (err instanceof Error ? err.message : null) || "Failed to save draft.";
      setError(message);
      toastManager.add({ title: message, variant: "error" });
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleSend = async (
    e: FormEvent,
    onClose: () => void,
    scheduledFor?: string,
  ) => {
    e.preventDefault();
    if (isSending) return;
    setError(null);
    if (!currentMailbox || !mailboxId) {
      setError("No mailbox selected.");
      return;
    }
    if (scheduledFor) {
      const scheduleValidation = validateScheduledDate(new Date(scheduledFor));
      if (!scheduleValidation.ok) {
        setError(scheduleValidation.error);
        return;
      }
    }
    const toRecipients = splitEmailList(to);
    if (toRecipients.length === 0) {
      setError("Add at least one recipient.");
      return;
    }
    if (isUploading) {
      setError("Wait for attachments to finish uploading.");
      return;
    }
    const ccRecipients = splitEmailList(cc);
    const bccRecipients = splitEmailList(bcc);
    const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
    const from =
      fromName && fromName !== currentMailbox.email
        ? { email: currentMailbox.email, name: fromName }
        : currentMailbox.email;
    const sendPayload = {
      source_draft_id: draftIdentity?.id,
      source_draft_version: draftIdentity?.version,
      to: toEmailListValue(toRecipients),
      cc: toEmailListValue(ccRecipients),
      bcc: toEmailListValue(bccRecipients),
      from,
      subject,
      html: body,
      text: htmlToPlainText(body),
      attachments: attachmentsToRefs(attachments),
      ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
    };
    const emailData = {
      ...sendPayload,
      idempotency_key: sendIdentityRef.current.keyFor(sendPayload),
    };
    const mode = composeOptions.mode;
    const originalId =
      composeOptions.originalEmail?.id ||
      composeOptions.draftEmail?.in_reply_to;
    setIsSending(true);
    toastManager.add({
      title: scheduledFor ? "Scheduling email..." : "Queueing email...",
    });
    try {
      let result: OutboundEnqueueResponse;
      if ((mode === "reply" || mode === "reply-all") && originalId)
        result = await replyMutation.mutateAsync({
          mailboxId,
          emailId: originalId,
          email: emailData,
        });
      else if (mode === "forward" && originalId)
        result = await forwardMutation.mutateAsync({
          mailboxId,
          emailId: originalId,
          email: emailData,
        });
      else
        result = await sendEmailMutation.mutateAsync({
          mailboxId,
          email: emailData,
        });
      toastManager.add({
        title: result.scheduledFor ? "Email scheduled" : "Email queued",
        description:
          "It will move to Sent only after the provider confirms acceptance.",
        timeout: result.scheduledFor ? 15_000 : 10_000,
        actions: [
          {
            children: "Undo",
            variant: "secondary",
            size: "sm",
            onClick: () =>
              cancelOutboundMutation.mutate(
                { mailboxId, deliveryId: result.deliveryId },
                {
                  onSuccess: () =>
                    toastManager.add({ title: "Send cancelled" }),
                  onError: (error) =>
                    toastManager.add({
                      title:
                        error instanceof Error
                          ? error.message
                          : "Could not cancel send",
                      variant: "error",
                    }),
                },
              ),
          },
        ],
      });
      onClose();
    } catch (err: unknown) {
      const message =
        (err instanceof Error ? err.message : null) || "Failed to send email.";
      setError(message);
      toastManager.add({ title: message, variant: "error" });
    } finally {
      setIsSending(false);
    }
  };

  return {
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
    setError,
    isSavingDraft,
    isSending,
    formTitle,
    handleSaveDraft,
    handleSend,
    closeCompose,
    closePanel,
    attachments,
    addFiles,
    removeAttachment,
    isUploading,
    hasAttachmentError,
  };
}
