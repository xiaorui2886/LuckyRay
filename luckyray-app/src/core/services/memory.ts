export type MemoryViewId = "all" | "global" | "current-vault";

/**
 * Renderer-safe Memory management projection. `entryRef` is an opaque,
 * short-lived Backend capability for the current management snapshot. It is
 * not a database identity and is deliberately distinct from Agent memoryRef.
 */
export type MemoryEntryView = {
  entryRef: string;
  content: string;
  sourceLabel: string;
  pinned: boolean;
  expiryLabel: string;
  scopeLabel: string;
};

export type MemoryEditorState = {
  entryRef: string;
  content: string;
};

export type MemoryManagementSnapshot = {
  view: MemoryViewId;
  requestEpoch: number;
  ready: boolean;
  phase: "idle" | "loading" | "ready" | "error";
  entries: MemoryEntryView[];
};

type MemoryBridge = {
  createMemoryView?: (content: string) => Promise<void>;
  updateMemoryView?: (entryRef: string, patch: { content?: string; pinned?: boolean }) => Promise<void>;
  deleteMemoryView?: (entryRef: string) => Promise<void>;
  listMemoryViews?: (view: MemoryViewId) => Promise<MemoryEntryView[]>;
  searchMemoryViews?: (view: MemoryViewId, query: string) => Promise<MemoryEntryView[]>;
};

export function cleanMemoryContent(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().slice(0, 4000);
}

export function createMemoryManagementSnapshotCoordinator(
  read: (view: MemoryViewId) => Promise<MemoryEntryView[]>,
  publish: (snapshot: MemoryManagementSnapshot) => void,
) {
  let epoch = 0;
  let snapshot: MemoryManagementSnapshot = {
    view: "all",
    requestEpoch: 0,
    ready: false,
    phase: "idle",
    entries: [],
  };
  const setSnapshot = (next: MemoryManagementSnapshot) => {
    snapshot = { ...next, entries: next.entries.map((entry) => ({ ...entry })) };
    publish(snapshot);
  };
  return {
    current: () => snapshot,
    async refresh(view: MemoryViewId): Promise<void> {
      const requestEpoch = ++epoch;
      setSnapshot({ view, requestEpoch, ready: false, phase: "loading", entries: [] });
      try {
        const entries = await read(view);
        if (requestEpoch !== epoch || snapshot.view !== view) return;
        setSnapshot({
          view,
          requestEpoch,
          ready: true,
          phase: "ready",
          entries: Array.isArray(entries) ? entries : [],
        });
      } catch {
        if (requestEpoch !== epoch || snapshot.view !== view) return;
        setSnapshot({ view, requestEpoch, ready: false, phase: "error", entries: [] });
      }
    },
  };
}

export function canMutateMemorySnapshot(
  snapshot: MemoryManagementSnapshot,
  view: MemoryViewId,
): boolean {
  return snapshot.view === view && snapshot.ready && snapshot.phase === "ready";
}

/** Memory creation is a Backend-global operation; current Vault is read-only. */
export function memoryCreateScope(view: MemoryViewId): "global" | null {
  return view === "current-vault" ? null : "global";
}

/**
 * Runs one opaque-ref management mutation and always revalidates the still
 * active view. A failed mutation may already have consumed its one-shot ref,
 * so refresh begins before the original error is returned to the UI.
 */
export async function runMemoryManagementMutation(input: {
  view: MemoryViewId;
  currentView: () => MemoryViewId;
  mutate: () => Promise<void>;
  refresh: (view: MemoryViewId) => Promise<void>;
}): Promise<void> {
  try {
    await input.mutate();
  } catch (reason) {
    if (input.currentView() === input.view) {
      try {
        await input.refresh(input.view);
      } catch {
        // Preserve the mutation error. The production coordinator publishes
        // not-ready before its read and itself converts read failure to error.
      }
    }
    throw reason;
  }
  if (input.currentView() === input.view) await input.refresh(input.view);
}

export function memoryManagementErrorMessage(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : String(error || "");
  if (
    value.includes("memory-management-reference")
    || value.includes("memory-management-source-stale")
    || value.includes("memory-revision-conflict")
  ) {
    return "记忆列表已更新，请刷新后重试";
  }
  return fallback;
}

export async function listMemoryViewEntries(
  bridge: MemoryBridge | null | undefined,
  view: MemoryViewId,
): Promise<MemoryEntryView[]> {
  const fn = bridge?.listMemoryViews;
  if (!fn) return [];
  const rows = await fn(view);
  return Array.isArray(rows) ? rows : [];
}

export async function searchMemoryViewEntries(
  bridge: MemoryBridge | null | undefined,
  view: MemoryViewId,
  query: string,
): Promise<MemoryEntryView[]> {
  const fn = bridge?.searchMemoryViews;
  if (!fn || !query.trim()) return [];
  const hits = await fn(view, query.trim());
  return Array.isArray(hits) ? hits : [];
}

export async function saveMemoryEntry(
  bridge: MemoryBridge | null | undefined,
  content: string,
): Promise<void> {
  const fn = bridge?.createMemoryView;
  if (!fn) throw new Error("当前环境不支持写入记忆");
  await fn(content);
}

export async function updateMemoryEntry(
  bridge: MemoryBridge | null | undefined,
  entryRef: string,
  patch: { content?: string; pinned?: boolean },
): Promise<void> {
  const fn = bridge?.updateMemoryView;
  if (!fn) throw new Error("当前环境不支持编辑记忆");
  await fn(entryRef, patch);
}

export async function deleteMemoryEntry(
  bridge: MemoryBridge | null | undefined,
  entryRef: string,
): Promise<void> {
  const fn = bridge?.deleteMemoryView;
  if (!fn) throw new Error("当前环境不支持删除单条记忆");
  await fn(entryRef);
}

export async function clearMemoryEntries(
  bridge: MemoryBridge | null | undefined,
  memories: MemoryEntryView[],
): Promise<void> {
  if (memories.length === 0) throw new Error("暂无可清空记忆");
  let failed = false;
  let firstFailure: unknown;
  await Promise.all(memories.map(async (memory) => {
    try {
      await deleteMemoryEntry(bridge, memory.entryRef);
    } catch (reason) {
      if (!failed) {
        failed = true;
        firstFailure = reason;
      }
    }
  }));
  if (failed) throw firstFailure;
}
