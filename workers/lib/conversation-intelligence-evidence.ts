import { Folders, isInternalFolderId } from "../../shared/folders.ts";

export const CONVERSATION_INTELLIGENCE_EVIDENCE_LIMITS = {
  messages: 30,
  bodyChars: 6_000,
  attachmentsPerMessage: 5,
  attachmentFilenameChars: 255,
  attachmentMimetypeChars: 100,
} as const;

type SqlValue = ArrayBuffer | string | number | null;

export interface ConversationIntelligenceSqlReader {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): Iterable<T>;
}

export type ConversationIntelligenceEvidenceMessage = {
  id: string;
  sender: string;
  recipient: string;
  cc: string;
  bcc: string;
  date: string;
  subject: string;
  body: string;
  attachments: Array<{
    id: string;
    filename: string;
    mimetype: string;
    size: number;
    r2Key: string | null;
  }>;
};

export type ConversationIntelligenceEvidenceProjection =
  | { state: "not_found" }
  | { state: "unsupported"; folderId: "draft" | "outbox" }
  | { state: "ready"; messages: ConversationIntelligenceEvidenceMessage[] };

type SelectedRow = { folderId: string };
type MessageRow = Omit<
  ConversationIntelligenceEvidenceMessage,
  "attachments"
>;
type AttachmentRow = ConversationIntelligenceEvidenceMessage["attachments"][number] & {
  emailId: string;
};

const eligibleConversationWhere = `
  folder_id NOT IN ('draft', 'outbox', '_cancelled_outbound')
  AND (
    (
      thread_id IS NOT NULL
      AND thread_id = (SELECT thread_id FROM emails WHERE id = ?1 LIMIT 1)
    )
    OR (
      id = ?1
      AND (SELECT thread_id FROM emails WHERE id = ?1 LIMIT 1) IS NULL
    )
  )`;

export function readConversationIntelligenceEvidenceProjection(
  sql: ConversationIntelligenceSqlReader,
  emailId: string,
): ConversationIntelligenceEvidenceProjection {
  const selected = [
    ...sql.exec<SelectedRow>(
      `SELECT SUBSTR(folder_id, 1, 100) AS folderId
       FROM emails WHERE id = ?1 LIMIT 1`,
      emailId,
    ),
  ][0];
  if (!selected || isInternalFolderId(selected.folderId)) {
    return { state: "not_found" };
  }
  if (
    selected.folderId === Folders.DRAFT ||
    selected.folderId === Folders.OUTBOX
  ) {
    return {
      state: "unsupported",
      folderId: selected.folderId,
    };
  }

  const messages = [
    ...sql.exec<MessageRow>(
      `SELECT * FROM (
        SELECT
          SUBSTR(id, 1, 200) AS id,
          SUBSTR(COALESCE(sender, ''), 1, 320) AS sender,
          SUBSTR(COALESCE(recipient, ''), 1, 320) AS recipient,
          SUBSTR(COALESCE(cc, ''), 1, 1000) AS cc,
          SUBSTR(COALESCE(bcc, ''), 1, 1000) AS bcc,
          SUBSTR(COALESCE(date, ''), 1, 64) AS date,
          SUBSTR(COALESCE(subject, ''), 1, 500) AS subject,
          SUBSTR(COALESCE(body, ''), 1, ${CONVERSATION_INTELLIGENCE_EVIDENCE_LIMITS.bodyChars}) AS body
        FROM emails
        WHERE ${eligibleConversationWhere}
        ORDER BY date DESC, id DESC
        LIMIT ${CONVERSATION_INTELLIGENCE_EVIDENCE_LIMITS.messages}
      ) AS bounded_messages
      ORDER BY date ASC, id ASC`,
      emailId,
    ),
  ];
  if (messages.length === 0) return { state: "not_found" };

  const attachmentRows = [
    ...sql.exec<AttachmentRow>(
      `WITH eligible_messages AS (
        SELECT id
        FROM emails
        WHERE ${eligibleConversationWhere}
        ORDER BY date DESC, id DESC
        LIMIT ${CONVERSATION_INTELLIGENCE_EVIDENCE_LIMITS.messages}
      ), ranked_attachments AS (
        SELECT
          SUBSTR(a.id, 1, 200) AS id,
          SUBSTR(a.email_id, 1, 200) AS emailId,
          SUBSTR(a.filename, 1, ${CONVERSATION_INTELLIGENCE_EVIDENCE_LIMITS.attachmentFilenameChars}) AS filename,
          SUBSTR(a.mimetype, 1, ${CONVERSATION_INTELLIGENCE_EVIDENCE_LIMITS.attachmentMimetypeChars}) AS mimetype,
          MAX(0, a.size) AS size,
          a.r2_key AS r2Key,
          ROW_NUMBER() OVER (PARTITION BY a.email_id ORDER BY a.id ASC) AS rank
        FROM attachments a
        INNER JOIN eligible_messages e ON e.id = a.email_id
      )
      SELECT id, emailId, filename, mimetype, size, r2Key
      FROM ranked_attachments
      WHERE rank <= ${CONVERSATION_INTELLIGENCE_EVIDENCE_LIMITS.attachmentsPerMessage}
      ORDER BY emailId ASC, id ASC`,
      emailId,
    ),
  ];
  const attachmentsByMessage = new Map<string, AttachmentRow[]>();
  for (const attachment of attachmentRows) {
    const current = attachmentsByMessage.get(attachment.emailId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.emailId, current);
  }
  return {
    state: "ready",
    messages: messages.map((message) => ({
      ...message,
      attachments: (attachmentsByMessage.get(message.id) ?? []).map(
        ({ emailId: _emailId, ...attachment }) => attachment,
      ),
    })),
  };
}
