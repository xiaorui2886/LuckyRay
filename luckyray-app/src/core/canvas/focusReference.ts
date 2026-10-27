import { canConnectCanvasNodes, getCanvasNodeCapabilities, type CanvasNodeCapabilityData } from "./nodeCapabilities";
import { resolveCanvasEdgeSemanticData, type CanvasEdgeSemanticData } from "./edgeSemantics";
import { encodeFocusReferenceMention, remapReferenceMentions, ReferenceMentionError } from "./referenceMentions";
import { createCanvasReferencePlan, referenceSourceId, type ReferenceValue } from "./referencePlan";
import { hasInvalidCanvasReference } from "./referenceIdentity";

export type FocusReferenceNode = {
  id: string;
  data: CanvasNodeCapabilityData & {
    label?: string;
    payload?: string;
    refMediaUrl?: string | null;
    refThumbnailUrl?: string | null;
    resultMediaUrl?: string | null;
    resultThumbnailUrl?: string | null;
    resultMediaItems?: Array<{ url: string; thumbnailUrl?: string | null }>;
    generationPrompt?: string;
    generationReferences?: ReferenceValue[];
    generationInputOrder?: string[];
  };
};
export type FocusReferenceEdge = {
  id: string; source: string; target: string;
  sourceHandle?: string | null; targetHandle?: string | null;
  data?: CanvasEdgeSemanticData | null;
};

/** A pin must still belong to the source's live media; never silently retarget it. */
export function resolvePinnedFocusReference<T extends ReferenceValue>(
  source: FocusReferenceNode, baseRef: T, pinnedUrl?: string | null,
): T & ReferenceValue {
  if (!pinnedUrl) return baseRef;
  const data = source.data;
  const item = data.resultMediaItems?.find(candidate => candidate.url === pinnedUrl);
  const belongs = !!pinnedUrl.trim() && (data.refMediaUrl === pinnedUrl || data.resultMediaUrl === pinnedUrl || !!item);
  if (!belongs || baseRef.kind !== "image")
    return { ...baseRef, mediaUrl: undefined, thumbnailUrl: undefined, issue: "missing-media" };
  return {
    ...baseRef,
    mediaUrl: pinnedUrl,
    thumbnailUrl: item ? item.thumbnailUrl || pinnedUrl
      : (data.refMediaUrl === pinnedUrl ? data.refThumbnailUrl : data.resultMediaUrl === pinnedUrl ? data.resultThumbnailUrl : undefined) || pinnedUrl,
    issue: baseRef.issue === "missing-media" ? undefined : baseRef.issue,
  };
}

/** One immutable graph transaction: resolve identity, pin exact media, migrate aliases, append token. */
export function applyFocusReference<TNode extends FocusReferenceNode, TEdge extends FocusReferenceEdge>(input: {
  nodes: readonly TNode[]; edges: readonly TEdge[];
  targetId: string; sourceNodeId: string; sourceMediaUrl: string;
  phrase: string; point: { x: number; y: number }; newEdgeId: string;
}) {
  const { nodes, edges, targetId, sourceNodeId, sourceMediaUrl } = input;
  const source = nodes.find(node => node.id === sourceNodeId);
  const target = nodes.find(node => node.id === targetId);
  if (!source || !target || sourceNodeId === targetId)
    throw new ReferenceMentionError(sourceNodeId, "missing");
  const targetKind = getCanvasNodeCapabilities(target.data).contentKind;
  if (!canConnectCanvasNodes(source.data, target.data) ||
      getCanvasNodeCapabilities(source.data).contentKind !== "image" ||
      (targetKind !== "image" && targetKind !== "video") || hasInvalidCanvasReference(source.data))
    throw new ReferenceMentionError(sourceNodeId, "invalid");
  const pinned = resolvePinnedFocusReference(source, { id: sourceNodeId, kind: "image", label: source.data.label || "", mediaUrl: source.data.refMediaUrl || source.data.resultMediaUrl }, sourceMediaUrl);
  if (!sourceMediaUrl || pinned.issue) throw new ReferenceMentionError(sourceNodeId, "invalid");
  const primaryUrl = source.data.refMediaUrl || source.data.resultMediaUrl || source.data.resultMediaItems?.[0]?.url;
  const existing = edges.find(edge => edge.source === sourceNodeId && edge.target === targetId &&
    edge.data?.relation !== "derivation" && ["reference", "firstFrame", "lastFrame", undefined].includes(edge.data?.role) &&
    (edge.data?.referenceMediaUrl || primaryUrl) === sourceMediaUrl);
  const edgeId = existing?.id || input.newEdgeId;
  if (!edgeId || (!existing && edges.some(edge => edge.id === edgeId))) throw new ReferenceMentionError(edgeId, "ambiguous");
  const token = encodeFocusReferenceMention(edgeId, { label: input.phrase, ...input.point });
  const stored = target.data.generationReferences;
  const connected = edges.filter(edge => edge.target === targetId && edge.data?.relation !== "derivation").map(edge => {
    const node = nodes.find(candidate => candidate.id === edge.source);
    const reference: ReferenceValue = node ? {
      id: node.data.payload || `node:${node.id}`, sourceNodeId: node.id, label: node.data.label || "",
      kind: getCanvasNodeCapabilities(node.data).contentKind,
      mediaUrl: node.data.refMediaUrl || node.data.resultMediaUrl,
    } : { id: `node:${edge.source}`, label: "", kind: "unknown" };
    return { edgeId: edge.id, sourceNodeId: edge.source, role: edge.data?.role || "generic" as const,
      reference: node ? resolvePinnedFocusReference(node, reference, edge.data?.referenceMediaUrl) : reference };
  });
  const storedPlan = createCanvasReferencePlan(targetKind, connected, stored || [])
    .filter(entry => entry.source === "stored");
  const matchingStored = storedPlan.find(entry => referenceSourceId(entry.reference) === sourceNodeId &&
    entry.reference.kind === "image" && entry.reference.mediaUrl === sourceMediaUrl);
  const reserved = storedPlan.map(entry => ({ source: entry.key, target: targetId, data: { role: entry.role } }));
  const semantic = resolveCanvasEdgeSemanticData(source.data, target.data, targetId, [...edges, ...reserved],
    existing?.data || (matchingStored ? { role: matchingStored.role } : undefined));
  const pinnedEdge = {
    ...(existing || { id: edgeId, source: sourceNodeId, target: targetId, sourceHandle: "s-right", targetHandle: "t-left" }),
    data: { ...existing?.data, ...semantic, referenceMediaUrl: sourceMediaUrl },
  };
  const keyMap = new Map<string, string>();
  const occurrences = new Map<string, number>();
  const retained = stored?.filter(ref => {
    const occurrence = occurrences.get(ref.id) || 0;
    occurrences.set(ref.id, occurrence + 1);
    if (referenceSourceId(ref) !== sourceNodeId || ref.kind !== "image" ||
        ref.mediaUrl !== sourceMediaUrl || (ref.role && ref.role !== semantic.role)) return true;
    keyMap.set(ref.mentionKey || `stored:${ref.id}:${occurrence}`, edgeId);
    return false;
  });
  const originalPrompt = remapReferenceMentions(target.data.generationPrompt || "", keyMap);
  const prompt = originalPrompt + (originalPrompt && !/\s$/.test(originalPrompt) ? " " : "") + token;
  const oldKeys = edges.filter(edge => edge.target === targetId && edge.data?.relation !== "derivation")
    .slice().sort((a, b) => (a.data?.order || 0) - (b.data?.order || 0)).map(edge => edge.id);
  const storedOccurrences = new Map<string, number>();
  for (const ref of stored || []) {
    const occurrence = storedOccurrences.get(ref.id) || 0;
    storedOccurrences.set(ref.id, occurrence + 1);
    oldKeys.push(ref.mentionKey || `stored:${ref.id}:${occurrence}`);
  }
  const order = [...new Set([...(target.data.generationInputOrder || []), ...oldKeys].map(key => keyMap.get(key) || key))];
  if (!order.includes(edgeId)) order.push(edgeId);
  return {
    nodes: nodes.map(node => node.id !== targetId ? node : ({ ...node, data: {
      ...node.data, generationPrompt: prompt, generationInputOrder: order,
      ...(stored && retained && retained.length !== stored.length ? { generationReferences: retained } : {}),
    } })),
    edges: existing ? edges.map(edge => edge.id === edgeId ? { ...edge, ...pinnedEdge } : edge) : [...edges, pinnedEdge],
    edgeId, token, createdEdge: !existing,
  };
}
