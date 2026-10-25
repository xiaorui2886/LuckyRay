import type {
  CanvasImageProtocol,
  CanvasVideoProtocol,
} from "../services/canvasMediaProfiles";
import { isCanvasEdgeRole, type CanvasEdgeRole } from "./edgeSemantics";
import { orderCanvasGenerationReferences } from "./generationInputCompiler";
import type {
  CanvasGenerationKind,
  CanvasGenerationReferenceSnapshot,
} from "./generationTasks";
export type ReferenceIssue =
  | "missing-source"
  | "missing-media"
  | "invalid-source"
  | "duplicate-frame"
  | "unsupported-video"
  | "image-limit"
  | "unsupported-frame";
export type ReferenceValue = Omit<CanvasGenerationReferenceSnapshot, "role"> & {
  role?: CanvasEdgeRole;
  mentionKey?: string;
  issue?: ReferenceIssue;
};
export type ConnectedReference = {
  edgeId: string;
  sourceNodeId: string;
  role: CanvasEdgeRole;
  reference: ReferenceValue;
  issue?: ReferenceIssue;
};
export type ReferenceEntry = {
  key: string;
  source: "connected" | "stored";
  role: CanvasEdgeRole;
  reference: ReferenceValue;
  sourceNodeId?: string;
  edgeId?: string;
  storedIndex?: number;
  issue?: ReferenceIssue;
  usage?: "body" | "media" | "label-only";
  effectiveRole?: CanvasEdgeRole;
};
export function referenceSourceId(ref: ReferenceValue) {
  return ref.sourceNodeId || /^node:([^:]+)/.exec(ref.id)?.[1];
}
export function duplicatesConnectedReference(
  ref: ReferenceValue,
  input: ConnectedReference,
) {
  return (
    (!ref.role || ref.role === input.role) &&
    (!(ref.mediaUrl && input.reference.mediaUrl) || ref.mediaUrl === input.reference.mediaUrl) &&
    (ref.id === input.reference.id ||
      referenceSourceId(ref) === input.sourceNodeId)
  );
}
/** One ordered plan drives both visible chips and immutable generation snapshots. */
export function createCanvasReferencePlan(
  kind: CanvasGenerationKind,
  connected: readonly ConnectedReference[],
  stored: readonly ReferenceValue[],
  protocol?: CanvasImageProtocol | CanvasVideoProtocol,
  inputOrder: readonly string[] = [],
): ReferenceEntry[] {
  const entries: ReferenceEntry[] = connected.map((input) => ({
    key: input.edgeId,
    source: "connected",
    role: input.role,
    reference: input.reference,
    sourceNodeId: input.sourceNodeId,
    edgeId: input.edgeId,
    issue: input.issue || input.reference.issue,
  }));
  const occupied = new Set(connected.map((input) => input.role));
  const occurrences=new Map<string,number>();
  stored.forEach((ref, index) => {
    const occurrence=occurrences.get(ref.id)||0;occurrences.set(ref.id,occurrence+1);
    if (connected.some((input) => duplicatesConnectedReference(ref, input)))
      return;
    let role: CanvasEdgeRole = isCanvasEdgeRole(ref.role)
      ? ref.role
      : "reference";
    if (!isCanvasEdgeRole(ref.role)) {
      if (ref.kind === "text" || ref.kind === "note") role = "promptContext";
      else if (kind === "video" && ref.kind === "video")
        role = "videoReference";
      else if (kind === "video" && !occupied.has("firstFrame"))
        role = "firstFrame";
      else if (kind === "video" && !occupied.has("lastFrame"))
        role = "lastFrame";
    }
    occupied.add(role);
    entries.push({
      key: ref.mentionKey || `stored:${ref.id}:${occurrence}`,
      source: "stored",
      role,
      reference: ref,
      sourceNodeId: referenceSourceId(ref),
      storedIndex: index,
      issue: ref.issue,
    });
  });
  if(inputOrder.length){const ranks=new Map(inputOrder.map((key,index)=>[key,index]));entries.sort((a,b)=>(ranks.get(a.key)??inputOrder.length)-(ranks.get(b.key)??inputOrder.length));}
  const ordered = orderCanvasGenerationReferences(
    entries.map((entry) => ({
      ...entry.reference,
      id: entry.key,
      role: entry.role,
    })),
  );
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const result = ordered.map((ref) => byKey.get(ref.id)!);
  const frames = new Set<string>();
  let imageCount = 0;
  for (const entry of result) {
    const media =
      entry.reference.kind === "image" || entry.reference.kind === "video";
    entry.usage = media ? (kind === "text" ? "label-only" : "media") : "body";
    if (entry.usage === "label-only" && entry.issue === "missing-media")
      entry.issue = undefined;
    if (
      !entry.issue &&
      media &&
      kind !== "text" &&
      !entry.reference.mediaUrl?.trim()
    )
      entry.issue = "missing-media";
    if (!entry.issue && entry.reference.kind === "video" && kind !== "text")
      entry.issue = "unsupported-video";
    if (
      kind === "video" &&
      (entry.role === "firstFrame" || entry.role === "lastFrame")
    ) {
      if (frames.has(entry.role) && !entry.issue)
        entry.issue = "duplicate-frame";
      frames.add(entry.role);
    }
    if (entry.reference.kind === "image") {
      imageCount++;
      if (
        !entry.issue &&
        kind === "video" &&
        ((protocol === "agnes" && imageCount > 2) ||
          (["openai-video", "bigmodel-video"].includes(protocol || "") && imageCount > 1))
      )
        entry.issue = "image-limit";
      if (
        !entry.issue &&
        kind === "video" &&
        ["openai-video", "bigmodel-video"].includes(protocol || "") &&
        entry.role === "lastFrame"
      )
        entry.issue = "unsupported-frame";
      if (kind === "video" && protocol === "agnes" && imageCount <= 2)
        entry.effectiveRole = imageCount === 1 ? "firstFrame" : "lastFrame";
    }
  }
  return result;
}
export function canvasReferenceSnapshots(
  entries: readonly ReferenceEntry[],
): CanvasGenerationReferenceSnapshot[] {
  return entries
    .filter((entry) => !entry.issue)
    .map(({ reference: r, role, sourceNodeId }) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      role,
      sourceNodeId,
      thumbnailUrl: r.thumbnailUrl,
      mediaUrl: r.mediaUrl,
      text: r.text,
    }));
}
export function referenceIssueText(
  issue: ReferenceIssue | undefined,
  english = false,
) {
  if (issue === "unsupported-video")
    return english
      ? "This canvas channel cannot send video references yet"
      : "当前画布通道尚不能传入视频参考";
  if (issue === "image-limit")
    return english
      ? "More images than this channel can send"
      : "超出当前通道实际可传入的图片数量";
  if (issue === "unsupported-frame")
    return english
      ? "Frame role is unsupported by this channel"
      : "当前通道不支持此帧角色，请调整";
  if (issue === "duplicate-frame")
    return english
      ? "Frame role is already occupied"
      : "该帧位置已有引用，请调整角色";
  if (issue === "missing-source")
    return english ? "Source card was removed" : "来源卡片已不存在";
  if (issue === "missing-media")
    return english ? "No usable media yet" : "尚无可用图片或视频";
  if (issue === "invalid-source")
    return english ? "Source reference is invalid" : "来源引用已失效";
  return "";
}
