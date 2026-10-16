import { publishActiveContext } from "../activeContext";
import type { ActiveAssetContext, ActiveContext, ActiveNoteContext } from "../activeContext";
import { materialNavigationCoordinator } from "./materialNavigationCoordinator";
import {
  beginCurrentKnowledgeContextSession,
  clearCurrentKnowledgeContext,
  ensureActiveKnowledgeUiSource,
  setCurrentKnowledgeContext,
  type KnowledgeContextSession,
  type KnowledgeDocumentRef,
} from "./knowledge";
import { createLatestDrainCoordinator, type LatestDrainSource } from "./knowledgeContextCoordinator";
import { readActiveKnowledgeSource } from "./knowledgeSource";

export const NAV_FOCUS_KEY = "luckyray:nav-focus";

export type NavFocusType = "asset" | "note" | "tag" | "collection";
export type NavFocusAction = "focus" | "focus-only" | "detail";
export type NavFocus = {
  type: NavFocusType;
  id: string;
  action?: NavFocusAction;
  source?: string;
  ts?: number;
};

export type CurrentEditorContext = {
  noteId: string | null;
  documentRef?: KnowledgeDocumentRef | null;
  expectedRevision?: string | null;
  cursorOffset: number | null;
  selection: string | null;
};

export type CurrentNoteContextPublisher = {
  write(context: CurrentEditorContext): Promise<void>;
  dispose(): void;
};

export type ActiveNotePublishInput = Omit<ActiveNoteContext, "cursorOffset" | "selection"> & {
  cursorOffset?: number | null;
  selection?: string | null;
};

export type ActiveAssetPublishInput = ActiveAssetContext;
export type ActiveTagPublishInput = NonNullable<ActiveContext["tag"]>;
export type ActiveGraphPublishInput = NonNullable<ActiveContext["graph"]>;
export type ActiveCanvasPublishInput = NonNullable<ActiveContext["canvas"]> & {
  asset?: ActiveAssetContext | null;
  note?: ActiveNoteContext | null;
};

export function focusEntity(type: NavFocusType, id: string, options?: { action?: NavFocusAction; source?: string }) {
  if (typeof window === "undefined") return;
  if (type === "asset") {
    materialNavigationCoordinator.requestAssetFocus({
      assetId: id,
      action: options?.action,
      source: options?.source || window.location.hash.replace(/^#/, "") || undefined,
    });
    return;
  }
  try {
    const focus: NavFocus = {
      type,
      id,
      action: options?.action,
      source: options?.source || window.location.hash.replace(/^#/, "") || undefined,
      ts: Date.now(),
    };
    sessionStorage.setItem(NAV_FOCUS_KEY, JSON.stringify(focus));
    window.dispatchEvent(new CustomEvent<NavFocus>("luckyray:nav-focus", { detail: focus }));
  } catch {}
}

function isNavFocusType(value: unknown): value is NavFocusType {
  return value === "asset" || value === "note" || value === "tag" || value === "collection";
}

function isNavFocusAction(value: unknown): value is NavFocusAction {
  return value === "focus" || value === "focus-only" || value === "detail";
}

export function readNavFocus(): NavFocus | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(NAV_FOCUS_KEY);
    if (!raw) return null;
    const focus = JSON.parse(raw) as { type?: unknown; id?: unknown; action?: unknown; source?: unknown; ts?: unknown };
    if (!isNavFocusType(focus?.type) || typeof focus.id !== "string" || !focus.id) return null;
    return {
      type: focus.type,
      id: focus.id,
      action: isNavFocusAction(focus.action) ? focus.action : undefined,
      source: typeof focus.source === "string" ? focus.source : undefined,
      ts: typeof focus.ts === "number" ? focus.ts : undefined,
    };
  } catch {
    return null;
  }
}

export function consumeNavFocus(type?: NavFocusType): NavFocus | null {
  const focus = readNavFocus();
  if (!focus || (type && focus.type !== type)) return null;
  try {
    sessionStorage.removeItem(NAV_FOCUS_KEY);
  } catch {}
  return focus;
}

export function clearNavFocus(type?: NavFocusType, id?: string): boolean {
  const focus = readNavFocus();
  if (!focus || (type && focus.type !== type) || (id && focus.id !== id)) return false;
  try {
    sessionStorage.removeItem(NAV_FOCUS_KEY);
    return true;
  } catch {
    return false;
  }
}

const currentContextSessionId = (() => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `webview-${crypto.randomUUID()}`;
  }
  return `webview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
})();
let currentContextSessionState: { sourceEpoch: number; promise: Promise<KnowledgeContextSession> } | null = null;
let currentContextGeneration = 0;

function getCurrentContextSession(sourceEpoch: number) {
  if (!currentContextSessionState || currentContextSessionState.sourceEpoch !== sourceEpoch) {
    const promise = beginCurrentKnowledgeContextSession(currentContextSessionId, sourceEpoch).catch((error) => {
      if (currentContextSessionState?.promise === promise) currentContextSessionState = null;
      throw error;
    });
    currentContextSessionState = { sourceEpoch, promise };
    currentContextGeneration = 0;
  }
  return currentContextSessionState.promise;
}

const currentEditorContextCoordinator = createLatestDrainCoordinator<CurrentEditorContext>(
  async (context) => {
    const source = await ensureActiveKnowledgeUiSource();
    const session = await getCurrentContextSession(source.sourceEpoch);
    currentContextGeneration += 1;
    const order = { ...session, sourceEpoch: source.sourceEpoch, generation: currentContextGeneration };
    if (!context.documentRef) {
      await clearCurrentKnowledgeContext(order);
      return;
    }
    await setCurrentKnowledgeContext({
      ...order,
      documentRef: context.documentRef,
      cursorOffset: context.cursorOffset,
      selection: context.selection,
      expectedRevision: context.expectedRevision,
    });
  },
);

function publisherFromSource(source: LatestDrainSource<CurrentEditorContext>): CurrentNoteContextPublisher {
  return {
    write: (context) => source.submit(context),
    // Releasing the subscription (component unmount / Activity hidden) must not
    // clear the Backend-owned current context. The user's explicitly opened note
    // identity stays valid across Notes→AI navigation; only an explicit close,
    // delete, or Vault switch clears it via clearCurrentNoteContext.
    dispose: () => source.dispose(),
  };
}

const defaultCurrentNoteContextPublisher = publisherFromSource(currentEditorContextCoordinator.createSource());

export function createCurrentNoteContextPublisher(): CurrentNoteContextPublisher {
  return publisherFromSource(currentEditorContextCoordinator.createSource());
}

export function writeCurrentEditorContext(context: CurrentEditorContext): Promise<void> {
  return defaultCurrentNoteContextPublisher.write(context);
}

/** Drains the existing Knowledge current-context authority through its latest queued note. */
export function flushCurrentNoteContextUpdates(): Promise<void> {
  return currentEditorContextCoordinator.flush();
}

export function resolveKnowledgeDocumentRef(note: ActiveNotePublishInput): KnowledgeDocumentRef | null {
  if (note.documentRef?.vaultId && note.documentRef.relativePath) return note.documentRef;
  if (!note.id.startsWith("real-vault:")) return null;
  const source = readActiveKnowledgeSource();
  const relativePath = note.id.slice("real-vault:".length).replace(/\\/g, "/");
  if (source?.mode !== "real-vault" || !source.vaultId || !relativePath) return null;
  return { vaultId: source.vaultId, relativePath };
}

export function publishCurrentNoteContext(
  note: ActiveNotePublishInput,
  publisher: CurrentNoteContextPublisher | null = defaultCurrentNoteContextPublisher,
) {
  const documentRef = resolveKnowledgeDocumentRef(note);
  publishActiveContext({
    page: "notes",
    note: {
      ...note,
      documentRef,
      cursorOffset: note.cursorOffset ?? null,
      selection: note.selection || null,
    },
  });
  void publisher?.write({
    noteId: note.id,
    documentRef,
    expectedRevision: note.revision,
    cursorOffset: note.cursorOffset ?? null,
    selection: note.selection || null,
  });
}

export function clearCurrentNoteContext(
  publisher: CurrentNoteContextPublisher | null = defaultCurrentNoteContextPublisher,
) {
  publishActiveContext({ page: "notes", note: null });
  void publisher?.write({ noteId: null, documentRef: null, cursorOffset: null, selection: null });
}

export function publishPageContext(page: string) {
  publishActiveContext({ page });
}

export function publishCurrentAssetContext(asset: ActiveAssetPublishInput | null, page = "materials") {
  publishActiveContext({ page, asset });
}

export function clearCurrentAssetContext(page = "materials") {
  publishCurrentAssetContext(null, page);
}

export function publishCurrentTagContext(tag: ActiveTagPublishInput | null, page = "tags") {
  publishActiveContext({ page, tag });
}

export function publishCurrentGraphContext(graph: ActiveGraphPublishInput | null, page = "graph") {
  publishActiveContext({ page, graph });
}

export function publishCurrentCanvasContext(canvas: ActiveCanvasPublishInput) {
  const { asset, note, ...canvasContext } = canvas;
  publishActiveContext({
    page: "canvas",
    canvas: canvasContext,
    asset: asset ?? null,
    note: note ?? null,
  });
}
