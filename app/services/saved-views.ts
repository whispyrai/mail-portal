import type {
  SavedView,
  SavedViewDefinition,
} from "../../shared/saved-views.ts";

export class SavedViewApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SavedViewApiError";
    this.status = status;
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
    };
    throw new SavedViewApiError(
      response.status,
      body.error ?? "Saved view request failed",
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
  async create(mailboxId: string, definition: SavedViewDefinition) {
    return request<SavedView>(base(mailboxId), {
      method: "POST",
      body: JSON.stringify(definition),
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
