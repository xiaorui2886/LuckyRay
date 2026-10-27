import type { CanvasGenerationHistoryEntry } from "./generationHistory";
import { getCanvasNodeContentKind } from "./nodeCapabilities";
import {
  SHOT_LIMIT, isStoryboard, storyboardShots, validStoryboardChoice,
  type StoryboardNode, type StoryboardChosenResult,
} from "./storyboard";

export type StoryboardCandidate = StoryboardChosenResult & {
  source: "current" | "history" | "chosen";
  selectable: boolean;
};
export type StoryboardCandidateState = {
  candidates: StoryboardCandidate[];
  activeTaskIds: string[];
};
const active = (status: string) => status === "queued" || status === "running";
const keyFor = (shotId: string, kind: string, url: string) => JSON.stringify([shotId, kind, url]);

/** Descendants only, never ancestors/siblings, labels, positions, or reference URLs. */
export function storyboardCandidates(
  nodes: readonly StoryboardNode[],
  history: readonly CanvasGenerationHistoryEntry[],
  boardId: string,
  shotId: string,
): StoryboardCandidateState {
  const shots = storyboardShots(nodes, boardId);
  const shot = shots.find(node => node.id === shotId);
  if (!shot || shots.length > SHOT_LIMIT) return { candidates: [], activeTaskIds: [] };
  const boards = new Set(nodes.filter(isStoryboard).map(n => n.id));
  const foreign = new Set(nodes.filter(n => n.id !== shotId &&
    (!!n.parentId && boards.has(n.parentId)))
    .map(n => n.id));
  const tasks = new Map<string, { id: string; parentTaskId?: string; sourceNodeId?: string; resultNodeId?: string; status: string }>();
  for (const entry of history) tasks.set(entry.taskId, { ...entry, id: entry.taskId });
  // The current node task takes precedence over stale history status.
  for (const node of nodes) {
    const task = node.data.generationTask;
    if (task?.id) tasks.set(task.id, { ...task, id: task.id, resultNodeId: task.resultNodeId || node.id });
  }
  const blocked = (task: { sourceNodeId?: string; resultNodeId?: string }) =>
    (!!task.sourceNodeId && foreign.has(task.sourceNodeId)) || (!!task.resultNodeId && foreign.has(task.resultNodeId));
  const ids = new Set<string>();
  const ownHistory = history.find(e => e.id === shot.data.sourceGenerationHistoryId);
  for (const id of [shot.data.generationTask?.id, shot.data.sourceGenerationTaskId, ownHistory?.taskId, shot.data.storyboardShot?.chosenResult?.taskId]) {
    if (id && (!tasks.has(id) || !blocked(tasks.get(id)!))) ids.add(id);
  }
  for (const task of tasks.values()) {
    if (!blocked(task) && (task.sourceNodeId === shotId || task.resultNodeId === shotId)) ids.add(task.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks.values()) {
      if (!ids.has(task.id) && task.parentTaskId && ids.has(task.parentTaskId) && !blocked(task)) {
        ids.add(task.id); changed = true;
      }
    }
  }
  const candidates: StoryboardCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: "image" | "video", url: string | null | undefined,
    thumbnailUrl: string | null | undefined, extra: Pick<StoryboardCandidate, "source" | "selectable"> & Partial<StoryboardChosenResult>) => {
    if (!url?.trim() || seen.has(url)) return;
    seen.add(url);
    candidates.push({ ...extra, key: keyFor(shotId, kind, url), kind, url, thumbnailUrl: thumbnailUrl || undefined });
  };
  for (const entry of history) {
    if (!ids.has(entry.taskId) || entry.status !== "succeeded" || entry.kind === "text" ||
      (tasks.has(entry.taskId) && tasks.get(entry.taskId)!.status !== "succeeded")) continue;
    const extra = { source: "history" as const, selectable: true, taskId: entry.taskId, historyId: entry.id };
    for (const item of entry.outputMediaItems || []) add(entry.kind, item.url, item.thumbnailUrl, extra);
    add(entry.kind, entry.outputMediaUrl, entry.outputThumbnailUrl, extra);
  }
  for (const node of nodes) {
    if (node.id !== shotId && (!node.data.generationTask?.id || !ids.has(node.data.generationTask.id) || foreign.has(node.id))) continue;
    const kind = getCanvasNodeContentKind(node.data);
    if (kind !== "image" && kind !== "video") continue;
    const task = node.data.generationTask;
    const extra = { source: "current" as const, selectable: true, taskId: task?.id };
    if (!task || task.status === "succeeded") {
      for (const item of node.data.resultMediaItems || []) add(kind, item.url, item.thumbnailUrl, extra);
      add(kind, node.data.resultMediaUrl, node.data.resultThumbnailUrl, extra);
    }
    if (node.id === shotId) add(kind, node.data.refMediaUrl, node.data.refThumbnailUrl, { source: "current", selectable: true });
  }
  const chosen = shot.data.storyboardShot?.chosenResult;
  if (validStoryboardChoice(chosen)) add(chosen.kind, chosen.url, chosen.thumbnailUrl, { ...chosen, source: "chosen", selectable: false });
  return { candidates, activeTaskIds: [...ids].filter(id => active(tasks.get(id)?.status || "")) };
}

/** Re-derive from trusted state; a client supplies only a key, never a replacement URL. */
export function adoptStoryboardCandidate<T extends StoryboardNode>(
  nodes: readonly T[], history: readonly CanvasGenerationHistoryEntry[], boardId: string,
  shotId: string, candidateKey: string, selectedAt = new Date().toISOString(),
): T[] {
  const candidate = storyboardCandidates(nodes, history, boardId, shotId).candidates
    .find(c => c.key === candidateKey && c.selectable);
  if (!candidate) throw Error("invalid-storyboard-candidate");
  const { source: _source, selectable: _selectable, ...snapshot } = candidate;
  return nodes.map(node => node.id === shotId ? {
    ...node, data: { ...node.data, storyboardShot: { ...node.data.storyboardShot!, chosenResult: { ...snapshot, selectedAt } } },
  } : node);
}
export function clearStoryboardChoice<T extends StoryboardNode>(nodes: readonly T[], boardId: string, shotId: string): T[] {
  if (!storyboardShots(nodes, boardId).some(n => n.id === shotId)) throw Error("invalid-shot");
  return nodes.map(node => {
    if (node.id !== shotId) return node;
    const { chosenResult: _choice, ...shot } = node.data.storyboardShot!;
    return { ...node, data: { ...node.data, storyboardShot: shot } };
  });
}
