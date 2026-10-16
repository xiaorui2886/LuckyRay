export type ActiveNoteContext = {
  id: string;
  title: string;
  documentRef?: {
    vaultId: string;
    relativePath: string;
  } | null;
  revision?: string | null;
  contentText?: string;
  folderId?: string | null;
  tagIds?: string[];
  tags?: string[];
  cursorOffset?: number | null;
  selection?: string | null;
  updatedAt?: string | null;
};

export type ActiveAssetContext = {
  id: string;
  name: string;
  kind?: string | null;
  mimeType?: string | null;
  libraryPath?: string | null;
  folderId?: string | null;
  description?: string | null;
  updatedAt?: string | null;
};

export type ActiveContext = {
  page?: string;
  note?: ActiveNoteContext | null;
  asset?: ActiveAssetContext | null;
  tag?: { id: string; name: string } | null;
  graph?: { nodeId?: string | null; nodeType?: string | null; label?: string | null } | null;
  canvas?: { id?: string | null; title?: string | null; selectionId?: string | null } | null;
  updatedAt?: number;
};

export const ACTIVE_CONTEXT_KEY = "luckyray:active-context-v1";
export const ACTIVE_CONTEXT_EVENT = "luckyray:active-context";

function parseContext(raw: string | null): ActiveContext {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readActiveContext(): ActiveContext {
  if (typeof window === "undefined") return {};
  const raw = sessionStorage.getItem(ACTIVE_CONTEXT_KEY) || localStorage.getItem(ACTIVE_CONTEXT_KEY);
  return parseContext(raw);
}

export function publishActiveContext(patch: Partial<ActiveContext>, options?: { replace?: boolean }) {
  if (typeof window === "undefined") return;
  const base = options?.replace ? {} : readActiveContext();
  const next: ActiveContext = {
    ...base,
    ...patch,
    updatedAt: Date.now(),
  };
  try {
    const serialized = JSON.stringify(next);
    sessionStorage.setItem(ACTIVE_CONTEXT_KEY, serialized);
    localStorage.setItem(ACTIVE_CONTEXT_KEY, serialized);
  } catch {}
  window.dispatchEvent(new CustomEvent<ActiveContext>(ACTIVE_CONTEXT_EVENT, { detail: next }));
}

export function subscribeActiveContext(handler: (context: ActiveContext) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    handler((event as CustomEvent<ActiveContext>).detail || readActiveContext());
  };
  window.addEventListener(ACTIVE_CONTEXT_EVENT, listener);
  return () => window.removeEventListener(ACTIVE_CONTEXT_EVENT, listener);
}
