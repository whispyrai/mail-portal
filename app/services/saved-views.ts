import type {
  SavedView,
  SavedViewDefinition,
} from "../../shared/saved-views.ts";

export class SavedViewApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly resourceId?: string;
  readonly currentRevision?: number;
  constructor(
    status: number,
    message: string,
    details: {
      code?: string;
      resourceId?: string;
      currentRevision?: number;
    } = {},
  ) {
    super(message);
    this.name = "SavedViewApiError";
    this.status = status;
    this.code = details.code;
    this.resourceId = details.resourceId;
    this.currentRevision = details.currentRevision;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      resourceId?: string;
      currentRevision?: number;
    };
    throw new SavedViewApiError(
      response.status,
      body.error ?? "Saved view request failed",
      body,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function base(mailboxId: string): string {
  return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/saved-views`;
}

export const savedViewsApi = {
  async list(mailboxId: string) {
    return request<{ views: SavedView[] }>(base(mailboxId));
  },
  async create(
    mailboxId: string,
    definition: SavedViewDefinition,
    operationId: string,
  ) {
    return request<SavedView & { replayed: boolean }>(base(mailboxId), {
      method: "POST",
      body: JSON.stringify({ ...definition, operationId }),
    });
  },
  async update(
    mailboxId: string,
    viewId: string,
    definition: SavedViewDefinition,
  ) {
    return request<SavedView>(
      `${base(mailboxId)}/${encodeURIComponent(viewId)}`,
      {
        method: "PUT",
        body: JSON.stringify(definition),
      },
    );
  },
  async delete(mailboxId: string, viewId: string) {
    return request<void>(`${base(mailboxId)}/${encodeURIComponent(viewId)}`, {
      method: "DELETE",
    });
  },
  async use(mailboxId: string, viewId: string) {
    return request<{ view: SavedView; searchParams: Record<string, string> }>(
      `${base(mailboxId)}/${encodeURIComponent(viewId)}/use`,
      { method: "POST" },
    );
  },
};
