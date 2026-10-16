/** UI-only note pane operations. Document identities and draft owners never change. */
export type NotesOpenTab = { id: string; kind?: "note" | "empty" };
export type NotesSplitDirection = "left" | "right" | "up" | "down";
export type NotesDockZone = "center" | NotesSplitDirection;
export type NotesPaneLayout =
  | { kind: "pane"; id: string }
  | { kind: "split"; id: string; orientation: "row" | "column"; ratio: number; first: NotesPaneLayout; second: NotesPaneLayout };
export type NotesPaneTabs = Record<string, NotesOpenTab[]>;
export type NotesPaneActiveTabs = Record<string, string>;
export type NotesDockTabRequest = {
  sourcePaneId: string;
  tabId: string;
  targetPaneId: string;
  zone: NotesDockZone;
  /** Insertion slot in the target strip BEFORE removing the source tab. */
  targetIndex?: number;
};
export type NotesPaneState = {
  layout: NotesPaneLayout;
  tabs: NotesPaneTabs;
  activeTabs: NotesPaneActiveTabs;
  activePaneId: string;
};

export function notesPaneIds(layout: NotesPaneLayout): string[] {
  return layout.kind === "pane" ? [layout.id] : [...notesPaneIds(layout.first), ...notesPaneIds(layout.second)];
}

export function replaceNotesPane(layout: NotesPaneLayout, paneId: string, replacement: NotesPaneLayout): NotesPaneLayout {
  if (layout.kind === "pane") return layout.id === paneId ? replacement : layout;
  return { ...layout, first: replaceNotesPane(layout.first, paneId, replacement), second: replaceNotesPane(layout.second, paneId, replacement) };
}

export function removeNotesPane(layout: NotesPaneLayout, paneId: string): NotesPaneLayout | null {
  if (layout.kind === "pane") return layout.id === paneId ? null : layout;
  const first = removeNotesPane(layout.first, paneId);
  const second = removeNotesPane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

/** Invalid/stale gestures are no-ops, including gestures from a previous vault. */
export function dockNotesTab(
  state: NotesPaneState,
  request: NotesDockTabRequest,
  ids: { paneId: string; splitId: string; emptyTab: NotesOpenTab },
): NotesPaneState {
  if (!request || !["center", "left", "right", "up", "down"].includes(request.zone)) return state;
  const { sourcePaneId, targetPaneId, tabId, zone } = request;
  const paneIds = notesPaneIds(state.layout);
  if (!paneIds.includes(sourcePaneId) || !paneIds.includes(targetPaneId)) return state;
  const source = state.tabs[sourcePaneId] || [];
  const target = state.tabs[targetPaneId] || [];
  const sourceIndex = source.findIndex((tab) => tab.id === tabId);
  if (sourceIndex < 0) return state;
  const moving = source[sourceIndex];
  const samePane = sourcePaneId === targetPaneId;
  if (zone !== "center" && (paneIds.includes(ids.paneId) || !ids.paneId || !ids.splitId)) return state;
  const tabs = { ...state.tabs };
  const activeTabs = { ...state.activeTabs };
  let layout = state.layout;
  let activePaneId = targetPaneId;
  const remaining = source.filter((tab) => tab.id !== tabId);

  if (zone === "center") {
    const slot = Number.isFinite(request.targetIndex)
      ? Math.min(target.length, Math.max(0, Math.trunc(request.targetIndex!)))
      : target.length;
    const existingTargetIndex = target.findIndex(tab => tab.id === tabId);
    const insertionIndex = existingTargetIndex >= 0 && existingTargetIndex < slot ? slot - 1 : slot;
    const destination = (samePane ? remaining : target).filter((tab) => tab.id !== tabId);
    destination.splice(Math.min(insertionIndex, destination.length), 0, moving);
    tabs[targetPaneId] = destination;
    activeTabs[targetPaneId] = moving.id;
    if (samePane) return { ...state, tabs, activeTabs, activePaneId };
  } else {
    activePaneId = ids.paneId;
    tabs[ids.paneId] = [moving];
    activeTabs[ids.paneId] = moving.id;
    const newPane: NotesPaneLayout = { kind: "pane", id: ids.paneId };
    const oldPane: NotesPaneLayout = { kind: "pane", id: targetPaneId };
    const before = zone === "left" || zone === "up";
    layout = replaceNotesPane(layout, targetPaneId, {
      kind: "split", id: ids.splitId, orientation: zone === "left" || zone === "right" ? "row" : "column", ratio: .5,
      first: before ? newPane : oldPane, second: before ? oldPane : newPane,
    });
  }

  if (remaining.length) {
    tabs[sourcePaneId] = remaining;
    if (activeTabs[sourcePaneId] === moving.id) activeTabs[sourcePaneId] = remaining[Math.min(sourceIndex, remaining.length - 1)].id;
  } else if (samePane) {
    // Splitting the only document leaves a usable empty source pane, not a
    // duplicate document or a split that immediately collapses on itself.
    tabs[sourcePaneId] = [ids.emptyTab];
    activeTabs[sourcePaneId] = ids.emptyTab.id;
  } else {
    layout = removeNotesPane(layout, sourcePaneId) || layout;
    delete tabs[sourcePaneId];
    delete activeTabs[sourcePaneId];
  }
  return { layout, tabs, activeTabs, activePaneId };
}

export function notesDockZoneAt(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): NotesDockZone | null {
  if (rect.width <= 0 || rect.height <= 0 || x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) return null;
  const distances = [
    { zone: "left" as const, value: (x - rect.left) / rect.width },
    { zone: "right" as const, value: (rect.left + rect.width - x) / rect.width },
    { zone: "up" as const, value: (y - rect.top) / rect.height },
    { zone: "down" as const, value: (rect.top + rect.height - y) / rect.height },
  ].sort((a, b) => a.value - b.value);
  return distances[0].value < .25 ? distances[0].zone : "center";
}

/** Saved presentation only. Never serialize Markdown, revisions, or drafts. */
export type NotesLayoutSnapshot = {
  version: 1;
  vaultId: string;
  state: NotesPaneState;
  modes: Record<string, "live" | "source" | "preview">;
  indexOpen: boolean;
  indexWidth: number;
};

export function validateNotesLayoutSnapshot(value: unknown, vaultId: string, current: NotesPaneState, canReopen?: (tab: NotesOpenTab) => boolean): value is NotesLayoutSnapshot {
  if (!value || typeof value !== "object") return false;
  const saved = value as NotesLayoutSnapshot;
  if (saved.version !== 1 || saved.vaultId !== vaultId || !saved.state || typeof saved.indexOpen !== "boolean"
    || !Number.isFinite(saved.indexWidth) || saved.indexWidth < 0 || saved.indexWidth > 1600) return false;
  const seen = new Set<string>();
  const leaves: string[] = [];
  const validTree = (node: NotesPaneLayout, depth: number): boolean => {
    if (!node || typeof node !== "object" || depth > 16 || seen.size > 64 || typeof node.id !== "string" || !node.id || seen.has(node.id)) return false;
    seen.add(node.id);
    if (node.kind === "pane") { leaves.push(node.id); return true; }
    return node.kind === "split" && ["row", "column"].includes(node.orientation) && Number.isFinite(node.ratio)
      && node.ratio >= .08 && node.ratio <= .92 && validTree(node.first, depth + 1) && validTree(node.second, depth + 1);
  };
  if (!validTree(saved.state.layout, 0) || !leaves.includes(saved.state.activePaneId) || !saved.state.tabs || !saved.state.activeTabs || !saved.modes) return false;
  // Existing callers retain strict in-memory validation. Production restoration
  // can explicitly permit validated closed identities, then preload them before commit.
  const currentTabs = new Map(Object.values(current.tabs).flat().map(tab => [tab.id, tab.kind || "note"]));
  let totalTabs=0;
  for (const paneId of leaves) {
    const tabs = saved.state.tabs[paneId];
    if (!Array.isArray(tabs) || !tabs.length || tabs.length > 500 || new Set(tabs.map(tab => tab?.id)).size !== tabs.length) return false;
    if((totalTabs+=tabs.length)>500)return false;
    if (!tabs.every(tab => tab && typeof tab.id === "string" && tab.id.length<=2100 && [undefined,"note","empty"].includes(tab.kind) && (currentTabs.get(tab.id) === (tab.kind || "note") || Boolean(canReopen?.(tab))))) return false;
    if (!tabs.some(tab => tab.id === saved.state.activeTabs[paneId])) return false;
    if (saved.modes[paneId] !== undefined && !["live", "source", "preview"].includes(saved.modes[paneId])) return false;
  }
  return Object.keys(saved.state.tabs).every(id => leaves.includes(id));
}

export function restoreNotesLayoutState(current: NotesPaneState, saved: NotesLayoutSnapshot): NotesPaneState {
  const tabs: NotesPaneTabs = Object.fromEntries(Object.entries(saved.state.tabs).map(([id, entries]) => [id, entries.map(tab => ({ id: tab.id, kind: tab.kind }))]));
  const restoredIds = new Set(Object.values(tabs).flat().map(tab => tab.id));
  for (const paneId of notesPaneIds(current.layout)) {
    for (const tab of current.tabs[paneId] || []) {
      if (restoredIds.has(tab.id)) continue;
      tabs[saved.state.activePaneId].push(tab);
      restoredIds.add(tab.id);
    }
  }
  return { ...saved.state, tabs, activeTabs: { ...saved.state.activeTabs } };
}
