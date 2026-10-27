import { materialProvenanceFromHistory, normalizeMaterialGenerationProvenance } from "./materialProvenance";
import type { CanvasNodeCapabilityData } from "./nodeCapabilities";
import type { CanvasGenerationTask } from "./generationTasks";
import type {
  CanvasGenerationHistoryEntry,
  CanvasGenerationLibraryCandidate,
} from "./generationHistory";

export type CanvasSavableNodeData = CanvasNodeCapabilityData & {
  gridSlice?: { version: number; batchId: string };
  label?: string;
  result?: string;
  resultMediaUrl?: string | null;
  resultThumbnailUrl?: string | null;
  resultMediaItems?: Array<{ url: string; thumbnailUrl?: string | null }>;
  generationTask?: CanvasGenerationTask;
  sourceGenerationTaskId?: string;
  sourceGenerationHistoryId?: string;
  sourceGenerationMediaUrl?: string;
  refMediaUrl?: string | null;
};
export function canvasNoteBody(data: CanvasSavableNodeData): string | null {
  if (
    data.generationTask &&
    ["queued", "running"].includes(data.generationTask.status)
  )
    return null;
  const body =
    data.kind === "text"
      ? data.label
      : data.kind === "aiResult" &&
          (!data.resultKind || data.resultKind === "text")
        ? data.result || data.label
        : null;
  if (
    !body?.trim() ||
    /^(?:双击开始编辑[.…。]*|Double.click to edit[.…。]*)$/i.test(body.trim())
  )
    return null;
  return body;
}
export function canvasNoteTitle(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.replace(/^\s{0,3}#{1,6}\s+/, "")
      .trim()
      .slice(0, 80) || "画布笔记"
  );
}
export function canvasNodeLibraryCandidates(
  data: CanvasSavableNodeData,
  history: readonly CanvasGenerationHistoryEntry[],
  display: (value: string) => string = (s) => s,
): CanvasGenerationLibraryCandidate[] {
  if (data._emptyMedia) return [];
  if(data.kind === "image" && data.gridSlice?.version === 1 && data.refMediaUrl && !/^(data|blob|https?):/i.test(data.refMediaUrl)) {
    return [{historyId:`grid:${data.gridSlice.batchId}`,taskId:`grid:${data.gridSlice.batchId}`,kind:'image',mediaUrl:data.refMediaUrl,prompt:'',model:'',createdAt:''}];
  }
  const task = data.generationTask;
  if (task && task.status !== "succeeded") return [];
  const entry = history.find((row) =>
    data.sourceGenerationHistoryId
      ? row.id === data.sourceGenerationHistoryId
      : row.taskId === (data.sourceGenerationTaskId || task?.id),
  );
  if (entry && entry.status !== "succeeded") return [];
  const kind =
    task?.request.kind || entry?.kind || data.resultKind || data.kind;
  if (kind !== "image" && kind !== "video") return [];
  if (!task && !data.sourceGenerationTaskId && !data.sourceGenerationHistoryId)
    return [];
  let urls: Array<{ url: string; thumbnailUrl?: string | null }> = [];
  if (task) {
    urls = data.resultMediaItems?.length
      ? data.resultMediaItems
      : data.resultMediaUrl
        ? [{ url: data.resultMediaUrl, thumbnailUrl: data.resultThumbnailUrl }]
        : [];
    // Older restored resource cards may retain a task after replacing their media.
    if (data.kind === "image" || data.kind === "video")
      urls = urls.filter(
        (item) =>
          item.url === data.refMediaUrl ||
          display(item.url) === data.refMediaUrl,
      );
  } else {
    const all = entry?.outputMediaItems?.length
      ? entry.outputMediaItems
      : entry?.outputMediaUrl
        ? [
            {
              url: entry.outputMediaUrl,
              thumbnailUrl: entry.outputThumbnailUrl,
            },
          ]
        : [];
    if (data.kind === "generator") {
      // Restored stacks have no live task. The switcher changes resultMediaUrl,
      // while the resource/provenance URLs intentionally retain their initial value.
      const shown = data.resultMediaUrl;
      const selected = all.find(item => item.url === shown || display(item.url) === shown);
      if (selected) urls = [{ ...selected }];
    } else {
      const raw = data.sourceGenerationMediaUrl;
      const matched =
        raw && (raw === data.refMediaUrl || display(raw) === data.refMediaUrl)
          ? raw
          : all.find(
              (item) =>
                item.url === data.refMediaUrl ||
                display(item.url) === data.refMediaUrl,
            )?.url;
      if (matched) urls = [{ url: matched }];
    }
  }
  return [
    ...new Map(
      urls.filter((item) => !!item.url.trim()).map((item) => [item.url, item]),
    ).values(),
  ].map((item) => {
    // A same-node image stack may contain multiple immutable generation batches.
    const origin = task ? history.find(row => row.status === "succeeded" &&
      (row.sourceNodeId === task.sourceNodeId || row.resultNodeId === task.resultNodeId) &&
      (row.outputMediaUrl === item.url || row.outputMediaItems?.some(image => image.url === item.url))) : entry;
    // A mixed stack must never assign the newest request to an older unknown output.
    const evidence = origin || (entry && (entry.outputMediaUrl === item.url || entry.outputMediaItems?.some(image => image.url === item.url)) ? entry : undefined);
    return {
      provenance: evidence ? materialProvenanceFromHistory(evidence) : task && !entry && !history.some(row => row.taskId === task.id) ? normalizeMaterialGenerationProvenance({version:1,historyId:`history:${task.id}`,taskId:task.id,createdAt:task.createdAt,kind:task.request.kind,request:task.request}) : undefined,
      historyId: origin?.id || entry?.id || data.sourceGenerationHistoryId || `history:${task?.id}`,
      taskId: origin?.taskId || task?.id || entry?.taskId || data.sourceGenerationTaskId!,
      kind,
      mediaUrl: item.url,
      thumbnailUrl: item.thumbnailUrl || undefined,
      prompt: origin?.prompt ?? task?.request.prompt ?? entry?.prompt ?? "",
      model: origin?.model ?? task?.request.model ?? entry?.model ?? "",
      createdAt: origin?.createdAt || task?.createdAt || entry?.createdAt || "",
    };
  });
}
/** Per-session idempotence. A failed write remains retryable. */
export function createCanvasSaveGate() {
  const pending = new Set<string>(),
    saved = new Map<string, string>();
  return {
    async run(
      key: string,
      write: () => Promise<string>,
    ): Promise<{ state: "saved" | "already-saved" | "pending"; id?: string }> {
      if (saved.has(key)) return { state: "already-saved", id: saved.get(key) };
      if (pending.has(key)) return { state: "pending" };
      pending.add(key);
      try {
        const id = await write();
        if (!id) throw Error("save-unconfirmed");
        saved.set(key, id);
        return { state: "saved", id };
      } finally {
        pending.delete(key);
      }
    },
  };
}
