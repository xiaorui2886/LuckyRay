import {
  getCanvasNodeContentKind,
  type CanvasNodeCapabilityData,
} from "./nodeCapabilities";

/** Storyboard metadata lives in the existing canvas graph; it never starts tasks. */
export const SHOT_LIMIT = 64;
export const SHOT_FRAMINGS = [
  "wide",
  "full",
  "medium",
  "close",
  "detail",
] as const;
export type ShotFraming = (typeof SHOT_FRAMINGS)[number];
export type StoryboardTag = { version: 1; sourceScript?: string };
export type StoryboardChosenResult = {
  key: string;
  kind: "image" | "video";
  url: string;
  thumbnailUrl?: string;
  taskId?: string;
  historyId?: string;
  selectedAt?: string;
};
export function validStoryboardChoice(value: unknown): value is StoryboardChosenResult {
  if (!value || typeof value !== "object") return false;
  const c = value as StoryboardChosenResult;
  return typeof c.key === "string" && !!c.key &&
    (c.kind === "image" || c.kind === "video") && typeof c.url === "string" && !!c.url.trim() &&
    [c.thumbnailUrl, c.taskId, c.historyId, c.selectedAt].every(v => v === undefined || typeof v === "string");
}
export type StoryboardShot = {
  version: 1;
  order: number;
  title: string;
  framing: ShotFraming;
  /** Optional for backwards-compatible R7 documents. */
  description?: string;
  /** Optional R8 planning fields; legacy documents remain valid. */
  lighting?: string;
  sound?: string;
  cameraMovement?: string;
  action: string;
  dialogue: string;
  durationSeconds: number;
  chosenResult?: StoryboardChosenResult;
};
export type StoryboardNode = {
  id: string;
  parentId?: string;
  data: CanvasNodeCapabilityData & {
    label?: string;
    generationPrompt?: string;
    generationModel?: string;
    generationTask?: { id?: string; parentTaskId?: string; sourceNodeId?: string; resultNodeId?: string; status: string; error?: unknown };
    sourceGenerationTaskId?: string;
    sourceGenerationHistoryId?: string;
    resultMediaItems?: Array<{ url: string; thumbnailUrl?: string | null }>;
    storyboard?: StoryboardTag;
    storyboardShot?: StoryboardShot;
    refMediaUrl?: string | null;
    refThumbnailUrl?: string | null;
    resultMediaUrl?: string | null;
    resultThumbnailUrl?: string | null;
  };
};
export type ShotPatch = Partial<
  Pick<
    StoryboardShot,
    | "title"
    | "framing"
    | "description"
    | "lighting"
    | "sound"
    | "cameraMovement"
    | "action"
    | "dialogue"
    | "durationSeconds"
  >
>;
export function isStoryboard(node: StoryboardNode): boolean {
  return node.data.kind === "group" && node.data.storyboard?.version === 1;
}
export function canBeShot(node: StoryboardNode): boolean {
  return (
    node.data.kind !== "group" &&
    ["image", "video"].includes(getCanvasNodeContentKind(node.data))
  );
}
export function defaultShot(order: number): StoryboardShot {
  return {
    version: 1,
    order,
    title: "",
    framing: "medium",
    description: "",
    action: "",
    dialogue: "",
    durationSeconds: 5,
  };
}
export function validShot(value: unknown): value is StoryboardShot {
  if (!value || typeof value !== "object") return false;
  const s = value as StoryboardShot;
  return (
    s.version === 1 &&
    Number.isInteger(s.order) &&
    s.order >= 0 &&
    s.order <= 10000 &&
    typeof s.title === "string" &&
    s.title.length <= 100 &&
    SHOT_FRAMINGS.includes(s.framing) &&
    (s.description === undefined ||
      (typeof s.description === "string" && s.description.length <= 4000)) &&
    [s.lighting, s.sound, s.cameraMovement].every(value => value === undefined || (typeof value === "string" && value.length <= 2000)) &&
    typeof s.action === "string" &&
    s.action.length <= 2000 &&
    typeof s.dialogue === "string" &&
    s.dialogue.length <= 2000 &&
    Number.isFinite(s.durationSeconds) &&
    s.durationSeconds >= 0.1 &&
    s.durationSeconds <= 3600 &&
    (s.chosenResult === undefined || validStoryboardChoice(s.chosenResult))
  );
}
export function storyboardShots<T extends StoryboardNode>(
  nodes: readonly T[],
  boardId: string,
): T[] {
  if (!nodes.some((n) => n.id === boardId && isStoryboard(n))) return [];
  return nodes
    .filter(
      (n) =>
        n.parentId === boardId &&
        canBeShot(n) &&
        validShot(n.data.storyboardShot),
    )
    .sort(
      (a, b) => a.data.storyboardShot!.order - b.data.storyboardShot!.order,
    );
}
export function patchStoryboardShot<T extends StoryboardNode>(
  nodes: readonly T[],
  boardId: string,
  id: string,
  patch: ShotPatch,
): T[] {
  const node = storyboardShots(nodes, boardId).find((n) => n.id === id);
  if (
    !node ||
    Object.keys(patch).some(
      (k) =>
        ![
          "title",
          "framing",
          "description",
          "lighting",
          "sound",
          "cameraMovement",
          "action",
          "dialogue",
          "durationSeconds",
        ].includes(k),
    )
  )
    throw Error("invalid-shot");
  const shot = { ...node.data.storyboardShot!, ...patch };
  if (!validShot(shot)) throw Error("invalid-shot");
  return nodes.map((n) =>
    n.id === id ? { ...n, data: { ...n.data, storyboardShot: shot } } : n,
  );
}
export function moveStoryboardShot<T extends StoryboardNode>(
  nodes: readonly T[],
  boardId: string,
  id: string,
  delta: -1 | 1,
): T[] {
  const shots = storyboardShots(nodes, boardId),
    from = shots.findIndex((n) => n.id === id),
    to = from + delta;
  if (from < 0 || to < 0 || to >= shots.length) return [...nodes];
  [shots[from], shots[to]] = [shots[to], shots[from]];
  const order = new Map(shots.map((n, i) => [n.id, i]));
  return nodes.map((n) =>
    order.has(n.id)
      ? {
          ...n,
          data: {
            ...n.data,
            storyboardShot: {
              ...n.data.storyboardShot!,
              order: order.get(n.id)!,
            },
          },
        }
      : n,
  );
}
export function storyboardTimeline(
  nodes: readonly StoryboardNode[],
  boardId: string,
) {
  let total = 0;
  const shots = storyboardShots(nodes, boardId).map((node, index) => {
    const start = total;
    total =
      Math.round((total + node.data.storyboardShot!.durationSeconds) * 10) / 10;
    return { id: node.id, number: index + 1, start, end: total };
  });
  return { shots, total };
}
export function shotPreview(node: StoryboardNode): string {
  const choice = node.data.storyboardShot?.chosenResult;
  if (validStoryboardChoice(choice))
    return choice.kind === "video" ? choice.thumbnailUrl || "" : choice.thumbnailUrl || choice.url;
  // Video posters only: never download or autoplay a movie in the overview.
  if (getCanvasNodeContentKind(node.data) === "video")
    return node.data.resultThumbnailUrl || node.data.refThumbnailUrl || "";
  return (
    node.data.resultThumbnailUrl ||
    node.data.refThumbnailUrl ||
    node.data.resultMediaUrl ||
    node.data.refMediaUrl ||
    ""
  );
}
export function shotTime(seconds: number): string {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

/** Shot titles and speech are script metadata, never an implicit image prompt. */
export function buildStoryboardPrompt(
  node: StoryboardNode,
  english = false,
): string {
  const shot = node.data.storyboardShot;
  if (!validShot(shot)) throw Error("invalid-shot");
  const description = shot.description?.trim() || "";
  const action = shot.action.trim();
  if (!description && !action) return "";
  const framing = (
    english
      ? ["Wide", "Full", "Medium", "Close-up", "Detail"]
      : ["远景", "全景", "中景", "近景", "特写"]
  )[SHOT_FRAMINGS.indexOf(shot.framing)];
  return [
    description,
    `${english ? "Framing" : "景别"}：${framing}`,
    action ? `${english ? "Action / camera" : "动作 / 运镜"}：${action}` : "",
    shot.lighting?.trim() ? `${english ? "Lighting" : "光影氛围"}：${shot.lighting.trim()}` : "",
    shot.cameraMovement?.trim() ? `${english ? "Camera movement" : "运镜"}：${shot.cameraMovement.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
export function patchStoryboardPrompt<T extends StoryboardNode>(
  nodes: readonly T[],
  boardId: string,
  id: string,
  prompt: string,
): T[] {
  const node = storyboardShots(nodes, boardId).find((n) => n.id === id);
  if (
    !node ||
    node.data.kind !== "generator" ||
    typeof prompt !== "string" ||
    prompt.length > 12000
  )
    throw Error("invalid-prompt");
  return nodes.map((n) =>
    n.id === id ? { ...n, data: { ...n.data, generationPrompt: prompt } } : n,
  );
}
export function storyboardOwner(
  nodes: readonly StoryboardNode[],
  nodeId: string,
): string | undefined {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  if (isStoryboard(node)) return node.id;
  return nodes.find((n) => n.id === node.parentId && isStoryboard(n))?.id;
}
/** Reopen an existing board, preferring an explicitly selected card then last view. */
export function resolveStoryboardPosition(
  nodes: readonly StoryboardNode[],
  requestedId?: string,
  previous?: { boardId: string; shotId?: string; mode?: "table" | "board" | "script" },
) {
  const requestedBoard = requestedId
    ? storyboardOwner(nodes, requestedId)
    : undefined;
  const boardId =
    requestedBoard ||
    (nodes.some((n) => n.id === previous?.boardId && isStoryboard(n))
      ? previous!.boardId
      : undefined) ||
    nodes.find(isStoryboard)?.id ||
    "";
  const requestedShot =
    requestedId !== boardId && requestedBoard ? requestedId : undefined;
  const shotId =
    requestedShot ||
    (previous?.boardId === boardId &&
    storyboardShots(nodes, boardId).some((n) => n.id === previous.shotId)
      ? previous.shotId
      : undefined);
  return {
    boardId,
    shotId,
    mode: requestedId
      ? ("table" as const)
      : previous?.mode || ("table" as const),
  };
}
