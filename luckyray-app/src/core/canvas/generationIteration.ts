import {normalizeGenerationEditorSnapshot} from "./generationEditorSnapshot";
import { materialProvenanceFromHistory } from "./materialProvenance";
import type {
  CanvasGenerationHistoryEntry,
  CanvasGenerationLibraryCandidate,
} from "./generationHistory";
import type { CanvasGenerationReferenceSnapshot } from "./generationTasks";
export function historyHasResult(entry: CanvasGenerationHistoryEntry): boolean {
  return (
    entry.status === "succeeded" &&
    (entry.kind === "text"
      ? !!entry.outputText?.trim()
      : entry.kind === "video"
        ? !!entry.outputMediaUrl?.trim()
        : !!entry.outputMediaUrl?.trim() ||
          !!entry.outputMediaItems?.some((item) => item.url.trim()))
  );
}
/** A new editable card, never a running task or a mutation of the source version. */
export function buildHistoryDraft(
  entry: CanvasGenerationHistoryEntry,
  mode: "result" | "parameters",
  imageIndex = 0,
) {
  if (entry.status === "queued" || entry.status === "running") return null;
  const request = entry.request;
  const editor = normalizeGenerationEditorSnapshot(request.editor, request.references.length);
  const media = entry.outputMediaItems?.length
    ? entry.outputMediaItems
    : entry.outputMediaUrl
      ? [{ url: entry.outputMediaUrl, thumbnailUrl: entry.outputThumbnailUrl }]
      : [];
  let references: Array<CanvasGenerationReferenceSnapshot & {mentionKey?:string}> = request.references
    .map((ref,index)=>({ref,index}))
    .filter(({ref}) => !!editor || (ref.kind !== "text" && ref.kind !== "note"))
    .map(({ref,index}) => ({
      ...ref,
      id: `history:${entry.taskId}:reference:${index}`,
      sourceNodeId: undefined,
      ...(editor?{mentionKey:editor.referenceKeys[index]}:{}),
    }));
  let prompt = editor?.prompt ?? request.prompt,
    label = "";
  if (mode === "result" && entry.kind === "image") {
    const image = media[imageIndex];
    if (!historyHasResult(entry) || !image?.url) return null;
    references = [
      {
        id: `result:${entry.taskId}:${imageIndex}`,
        label: `Image ${imageIndex + 1}`,
        kind: "image",
        role: "reference",
        mediaUrl: image.url,
        thumbnailUrl: image.thumbnailUrl,
      },
    ];
    prompt = "";
  } else if (mode === "result" && entry.kind === "text") {
    if (!historyHasResult(entry)) return null;
    label = entry.outputText || "";
    prompt = "";
    references = [];
  }
  return {
    kind: entry.kind === "text" ? ("text" as const) : ("generator" as const),
    label,
    generationKind: entry.kind === "text" ? undefined : entry.kind,
    generationPrompt: prompt,
    generationReferences: references,
    generationModel: request.model,
    generationAspect: request.aspect,
    generationQuality: request.quality,
    generationResolution: request.resolution,
    generationDuration: request.duration,
    generationSound: request.sound,
    generationCount:
      mode === "result" && entry.kind === "image" ? 1 : request.count,
    generationCameraStrength: request.cameraStrength,
    generationCinematography: mode === "parameters" ? editor?.cinematography : undefined,
    generationCreativeRecipe: mode === "parameters" ? editor?.creativeRecipe : undefined,
    sourceGenerationTaskId: entry.taskId,
    sourceGenerationHistoryId: entry.id,
  };
}
export function historyLibraryCandidates(
  entry: CanvasGenerationHistoryEntry,
): CanvasGenerationLibraryCandidate[] {
  if (!historyHasResult(entry) || entry.kind === "text") return [];
  const media =
    entry.kind === "image" && entry.outputMediaItems?.length
      ? entry.outputMediaItems
      : entry.outputMediaUrl
        ? [
            {
              url: entry.outputMediaUrl,
              thumbnailUrl: entry.outputThumbnailUrl,
            },
          ]
        : [];
  return [
    ...new Map(
      media.filter((item) => item.url.trim()).map((item) => [item.url, item]),
    ).values(),
  ].map((item) => ({
    historyId: entry.id,
    provenance: materialProvenanceFromHistory(entry),
    taskId: entry.taskId,
    kind: entry.kind as "image" | "video",
    mediaUrl: item.url,
    thumbnailUrl: item.thumbnailUrl || undefined,
    prompt: entry.prompt,
    model: entry.model,
    createdAt: entry.createdAt,
  }));
}
export function resultEntryForNode(
  node: {
    id: string;
    data: {
      kind?: string;
      generationTask?: { id: string };
      sourceGenerationHistoryId?: string;
      sourceGenerationMediaUrl?: string;
      refMediaUrl?: string | null;
      resultMediaUrl?: string | null;
    };
  },
  history: readonly CanvasGenerationHistoryEntry[],
  display: (url: string) => string = (url) => url,
) {
  // Same-card iterations can display an older image while the latest task stays intact.
  const displayedResult = node.data.kind === "generator" ? node.data.resultMediaUrl : undefined;
  const displayedEntry = displayedResult ? history.find(item =>
    (item.sourceNodeId === node.id || item.resultNodeId === node.id || (!node.data.generationTask && item.id === node.data.sourceGenerationHistoryId)) && historyHasResult(item) &&
    (item.outputMediaUrl === displayedResult || item.outputMediaItems?.some(image => image.url === displayedResult)),
  ) : undefined;
  const entry = displayedResult ? displayedEntry : (node.data.generationTask
    ? history.find((item) => item.taskId === node.data.generationTask!.id)
    : node.data.kind === "image" || node.data.kind === "video"
      ? history.find((item) => (!node.data.generationTask && item.id === node.data.sourceGenerationHistoryId))
      : undefined);
  if (!entry || !historyHasResult(entry)) return undefined;
  if (node.data.kind !== "image" && node.data.kind !== "video") return entry;
  const shown = node.data.refMediaUrl;
  const matches = (url: string) => url === shown || display(url) === shown;
  const image = entry.outputMediaItems?.find((item) => matches(item.url));
  if (entry.kind === "image" && image)
    return {
      ...entry,
      outputMediaUrl: image.url,
      outputThumbnailUrl: image.thumbnailUrl || undefined,
      outputMediaItems: [{ ...image }],
    };
  return entry.outputMediaUrl && matches(entry.outputMediaUrl)
    ? entry
    : undefined;
}
/** Stale queued snapshots after Undo/cancel are not live jobs. Running workers still own their slot. */
export function hasLiveGenerationTask(
  tasks: Iterable<{
    id: string;
    sourceNodeId: string;
    parentTaskId?: string;
    status: string;
  }>,
  nodes: readonly {
    data: { generationTask?: { id: string; status: string } };
  }[],
  running: ReadonlySet<string>,
  sourceId: string,
  parentId?: string,
) {
  const active = (status: string) =>
    status === "queued" || status === "running";
  return [...tasks].some(
    (task) =>
      (task.sourceNodeId === sourceId ||
        (!!parentId && task.parentTaskId === parentId)) &&
      active(task.status) &&
      (running.has(task.id) ||
        nodes.some(
          (node) =>
            node.data.generationTask?.id === task.id &&
            active(node.data.generationTask.status),
        )),
  );
}
