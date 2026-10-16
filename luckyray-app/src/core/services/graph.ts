import { getLuckyRayBridgeSync, type LuckyRayBridge } from "../bridge/luckyRayBridge";
import { removeMarkdownTagReferencesInText } from "../markdown/inlineTags";
import { isPlainMarkdownProseAt } from "../markdown/proseRanges";
import { createRealVaultLibraryAssetResolver, decodeRealVaultEmbedTarget, isSafeRealVaultAssetRelativePath, realVaultAssetFileName, realVaultEmbedAssetLookupKey, resolveRealVaultEmbedAssetRelativePath } from "../markdown/realVaultEmbeds";
import { createRealVaultWikiTargetResolver, normalizeVaultRelativePath, parseWikiReferenceTarget, realVaultMissingDocumentLocation, stripMarkdownExtension, type RealVaultMissingDocumentLocation } from "../markdown/wikiTargets";
import type { BridgeNotesVaultMarkdownIndex, BridgeNotesVaultMarkdownIndexDocument, BridgeVaultMetadata } from "../bridge/bridgeTypes";
import { knowledgeStore } from "./knowledgeStore";
import {
  knowledgeDocumentNoteId,
  knowledgeMutationSuccessStatus,
  knowledgeTagCanonicalKey,
  knowledgeTagIdentity,
  parseKnowledgeDocumentNoteId,
  parseKnowledgeTagIdentity,
  setActiveKnowledgeDocumentTags,
  type KnowledgeDocumentRef,
  type KnowledgeMutationResult,
} from "./knowledge";
import { materialStore } from "./materialStore";
import { materialLibrarySession } from "./materialLibraryContext";
import { getNote, updateNoteContent } from "./notes";

export type GraphType = "material" | "note" | "tag" | "web";

export type GraphEdge = [number, number];

export type GraphEdgeKind = "relation" | "wiki-link" | "tag" | "embed" | "embed-document" | "embed-asset" | "embed-vault-asset" | "web";
export type GraphEdgeDirection = "forward" | "reverse" | "bidirectional" | "undirected";

export type GraphSeedNode = {
  id: number;
  key: string;
  entityId?: string | null;
  label: string;
  type: GraphType;
  /** Creation/import time used only by the graph time-lapse renderer. */
  timelineAt?: number;
  status?: "missing";
  missingTarget?: RealVaultMissingDocumentLocation & { rawTarget: string; sourceRelativePath: string };
};

export type GraphSeed = {
  nodes: GraphSeedNode[];
  edges: GraphEdge[];
  source: "real" | "empty";
  sourceKind?: "real-vault";
  edgeKinds?: Record<string, GraphEdgeKind>;
  /** Direction is relative to the stored edge tuple: forward=a->b, reverse=b->a. */
  edgeDirections?: Record<string, GraphEdgeDirection>;
};

export type GraphSeedProvenance = { vault: BridgeVaultMetadata; materialLibraryId: string | null; materialLibraryGeneration: number; materialSourceVersion: number | null; documentRevisions: Array<{relativePath:string;revision:string}> };
const graphSeedProvenance = new WeakMap<GraphSeed, GraphSeedProvenance>();
/** Admission provenance comes from the exact stores used by the builder. */
export function readGraphSeedProvenance(seed: GraphSeed): GraphSeedProvenance | null {
  const value = graphSeedProvenance.get(seed);
  return value ? { ...value, vault: { ...value.vault }, documentRevisions: value.documentRevisions.map(document => ({...document})) } : null;
}

export type GraphViewState = {
  /** R2 fits once when entering the expanded world; later camera choices are retained. */
  spatialVersion?: number;
  colorGroups?: {query: string; color: string}[];
  sections?: Record<string, boolean>;
  filters?: Record<GraphType, boolean>;
  showIsolated?: boolean;
  nearbyFilter?: boolean;
  nearbyDepth?: 1 | 2;
  colorMode?: "default" | "type" | "degree";
  showArrows?: boolean;
  showLabels?: boolean;
  labelReveal?: number;
  /** Legacy G2B field. Kept only so older persisted views can load safely. */
  textOpacity?: number;
  nodeSize?: number;
  edgeWidth?: number;
  /** Legacy single multiplier, retained only to migrate saved G2B views. */
  forceStrength?: number;
  centerForce?: number;
  repulsionForce?: number;
  linkAttraction?: number;
  linkLength?: number;
  nodeSpacing?: number;
  scale?: number;
  panX?: number;
  panY?: number;
};

export type GraphRelationResult = {
  changed: boolean;
  message: string;
  mutation?: KnowledgeMutationResult;
};

type BodyRelationKind = "note_link" | "note_asset_embed";

type BodyRelationPair = {
  kind: BodyRelationKind;
  sourceNote: GraphSeedNode;
  target: GraphSeedNode;
};

export const GRAPH_VIEW_KEY = "luckyray-graph-view-v1";

function normalizedGraphVaultRoot(rootPath: string | null | undefined) {
  return (rootPath || "").replace(/\\/g, "/").replace(/\/+$/, "").trim().toLocaleLowerCase();
}

export function graphVaultsMatch(
  expected: Pick<BridgeVaultMetadata, "id" | "rootPath"> | null | undefined,
  actual: Pick<BridgeVaultMetadata, "id" | "rootPath"> | null | undefined,
) {
  const expectedId = expected?.id?.trim();
  const actualId = actual?.id?.trim();
  const expectedRoot = normalizedGraphVaultRoot(expected?.rootPath);
  const actualRoot = normalizedGraphVaultRoot(actual?.rootPath);
  return Boolean(expectedId && actualId && expectedRoot && actualRoot
    && expectedId === actualId
    && expectedRoot === actualRoot);
}

export const TYPE_COLORS: Record<GraphType, string> = {
  material: "#7f9dad",
  note: "#d6dbe1",
  tag: "#77aaa0",
  web: "#b69c74",
};

export const TYPE_LABELS: Record<GraphType, string> = {
  material: "素材",
  note: "笔记",
  tag: "标签",
  web: "网页",
};

export const DEGREE_COLORS = ["#8e99a3", "#96a3ad", "#91aab2", "#8eafb0", "#93b6b0", "#9abdb7", "#a3c2be", "#b1c8c5", "#c1d0ce", "#d5dfdd"];

function getBridge(): LuckyRayBridge | null {
  return getLuckyRayBridgeSync();
}

function requireBridge() {
  const bridge = getBridge();
  if (!bridge) throw new Error("LuckyRay bridge is not ready");
  return bridge;
}

function compactLabel(value: string | null | undefined, fallback: string) {
  const next = String(value || "").trim();
  return next || fallback;
}

function graphTimelineAt(value: string | null | undefined) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}




function graphEdgeKey(a: number, b: number) {
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}

export function mergeGraphEdgeDirection(
  current: GraphEdgeDirection | undefined,
  incoming: Exclude<GraphEdgeDirection, "bidirectional" | "undirected">,
): GraphEdgeDirection {
  if (!current) return incoming;
  if (current === "undirected" || current === "bidirectional" || current === incoming) return current;
  return "bidirectional";
}

function realVaultDocumentLabel(document: BridgeNotesVaultMarkdownIndexDocument) {
  const relativePath = normalizeVaultRelativePath(document.relativePath);
  return compactLabel(document.title, stripMarkdownExtension(document.fileName || relativePath.split("/").pop() || relativePath));
}

function normalizeRealVaultFrontmatterTag(value: string | null | undefined) {
  return (value || "").trim().replace(/^#+/, "").trim();
}

function realVaultDocumentEntityId(vaultId: string, relativePath: string) {
  return knowledgeDocumentNoteId({ vaultId, relativePath: normalizeVaultRelativePath(relativePath) });
}

function realVaultTagEntityId(vaultId: string, tagName: string) {
  return knowledgeTagIdentity(vaultId, tagName);
}

export type RealVaultGraphEmbedResolution =
  | { kind: "document"; relativePath: string }
  | { kind: "library-asset"; assetId: string; assetName: string }
  | { kind: "vault-asset"; relativePath: string; label: string };

type RealVaultGraphEmbedResolutionMap = Map<string, RealVaultGraphEmbedResolution[]>;

function addRealVaultEmbedResolution(
  resolutions: RealVaultGraphEmbedResolutionMap,
  sourceRelativePath: string,
  resolution: RealVaultGraphEmbedResolution,
) {
  const current = resolutions.get(sourceRelativePath) || [];
  if (!current.some((item) => (
    item.kind === "library-asset" && resolution.kind === "library-asset"
      ? item.assetId === resolution.assetId
      : item.kind !== "library-asset" && resolution.kind !== "library-asset" && item.relativePath === resolution.relativePath && item.kind === resolution.kind
  ))) {
    resolutions.set(sourceRelativePath, [...current, resolution]);
  }
}

function realVaultEmbedTarget(rawTarget: string) {
  const parsed = parseWikiReferenceTarget(rawTarget);
  return decodeRealVaultEmbedTarget(parsed.targetTitle || rawTarget);
}

function isMarkdownEmbedTarget(target: string) {
  return /\.md$/i.test(target.trim());
}

async function resolveRealVaultGraphEmbeds(
  index: BridgeNotesVaultMarkdownIndex,
  vault: BridgeVaultMetadata,
): Promise<{ resolutions: RealVaultGraphEmbedResolutionMap; materialLibraryId: string | null; materialLibraryGeneration: number; materialSourceVersion: number | null }> {
  const documents = (index.documents || [])
    .map((document) => ({ ...document, relativePath: normalizeVaultRelativePath(document.relativePath) }))
    .filter((document) => Boolean(document.relativePath));
  const resolutions: RealVaultGraphEmbedResolutionMap = new Map();
  const libraryContext = materialLibrarySession.capture();
  let materialSourceVersion: number | null = null;
  const resolveWikiTarget = createRealVaultWikiTargetResolver(documents);
  const assets = await materialStore.ensureSnapshot({ reason: "graph-real-vault-embed-resolution" })
    .then((snapshot) => { materialSourceVersion = snapshot.sourceVersion; return snapshot.allAssets; })
    .catch(() => []);
  const resolveLibraryAsset = createRealVaultLibraryAssetResolver(assets);
  const vaultCandidateRequests = new Map<string, { sourceRelativePath: string; target: string }>();

  for (const document of documents) {
    const sourceRelativePath = normalizeVaultRelativePath(document.relativePath);
    for (const embed of document.embeds || []) {
      const target = realVaultEmbedTarget(embed.target || embed.raw || "");
      const assetRelativePath = resolveRealVaultEmbedAssetRelativePath(target, sourceRelativePath);
      if (!target || !assetRelativePath) continue;

      const resolvedDocument = resolveWikiTarget(target, sourceRelativePath);
      if (resolvedDocument) {
        addRealVaultEmbedResolution(resolutions, sourceRelativePath, {
          kind: "document",
          relativePath: normalizeVaultRelativePath(resolvedDocument.relativePath),
        });
        continue;
      }
      if (isMarkdownEmbedTarget(target)) continue;

      const libraryAsset = resolveLibraryAsset(target);
      if (libraryAsset) {
        addRealVaultEmbedResolution(resolutions, sourceRelativePath, {
          kind: "library-asset",
          assetId: libraryAsset.id,
          assetName: libraryAsset.name,
        });
        continue;
      }

      const lookupKey = realVaultEmbedAssetLookupKey(sourceRelativePath, target);
      if (!vaultCandidateRequests.has(lookupKey)) {
        vaultCandidateRequests.set(lookupKey, { sourceRelativePath, target });
      }
    }
  }

  const bridge = getBridge();
  if (!bridge?.notesVaultFindAssetCandidates || !vaultCandidateRequests.size) {
    const currentLibrary = materialLibrarySession.capture();
    if (currentLibrary.libraryId !== libraryContext.libraryId || currentLibrary.generation !== libraryContext.generation) throw Error('workspace-graph-material-source-changed');
    return { resolutions, materialLibraryId: libraryContext.libraryId, materialLibraryGeneration: libraryContext.generation, materialSourceVersion };
  }
  const candidateResults = await Promise.all(Array.from(vaultCandidateRequests.values()).map(async (request) => {
    try {
      const matches = await bridge.notesVaultFindAssetCandidates({
        vault,
        target: request.target,
        currentRelativePath: request.sourceRelativePath,
      });
      const match = matches.find((candidate) => candidate.exists && candidate.isFile && isSafeRealVaultAssetRelativePath(candidate.relativePath));
      return { request, match: match || null };
    } catch {
      return { request, match: null };
    }
  }));

  for (const { request, match } of candidateResults) {
    if (!match) continue;
    const relativePath = normalizeVaultRelativePath(match.relativePath);
    addRealVaultEmbedResolution(resolutions, request.sourceRelativePath, {
      kind: "vault-asset",
      relativePath,
      label: realVaultAssetFileName(relativePath),
    });
  }
  const currentLibrary = materialLibrarySession.capture();
  if (currentLibrary.libraryId !== libraryContext.libraryId || currentLibrary.generation !== libraryContext.generation) throw Error('workspace-graph-material-source-changed');
  return { resolutions, materialLibraryId: libraryContext.libraryId, materialLibraryGeneration: libraryContext.generation, materialSourceVersion };
}

export function buildRealVaultGraphSeed(index: BridgeNotesVaultMarkdownIndex, embedResolutions: RealVaultGraphEmbedResolutionMap = new Map()): GraphSeed {
  const documents = (index.documents || [])
    .map((document) => ({ ...document, relativePath: normalizeVaultRelativePath(document.relativePath) }))
    .filter((document) => Boolean(document.relativePath));
  if (!documents.length) return { source: "empty", sourceKind: "real-vault", nodes: [], edges: [], edgeKinds: {}, edgeDirections: {} };

  const nodes: GraphSeedNode[] = [];
  const nodeIds = new Map<string, number>();
  const documentNodeIds = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const edgeKinds: Record<string, GraphEdgeKind> = {};
  const edgeDirections: Record<string, GraphEdgeDirection> = {};
  const edgesByKey = new Map<string, GraphEdge>();

  const addNode = (type: GraphType, entityId: string, label: string, timelineAt?: number, metadata?: Pick<GraphSeedNode, "status" | "missingTarget">) => {
    const key = `${type}:${entityId}`;
    const existing = nodeIds.get(key);
    if (existing !== undefined) {
      const existingNode = nodes[existing];
      if (timelineAt !== undefined && (existingNode.timelineAt === undefined || timelineAt < existingNode.timelineAt)) {
        existingNode.timelineAt = timelineAt;
      }
      return existing;
    }
    const id = nodes.length;
    nodes.push({ id, key, entityId, type, label: compactLabel(label, TYPE_LABELS[type]), timelineAt, ...metadata });
    nodeIds.set(key, id);
    return id;
  };

  const addEdge = (a: number | undefined, b: number | undefined, kind: GraphEdgeKind) => {
    if (a === undefined || b === undefined || a === b) return;
    const key = graphEdgeKey(a, b);
    const existing = edgesByKey.get(key);
    if (existing) {
      const incoming = existing[0] === a && existing[1] === b ? "forward" : "reverse";
      edgeDirections[key] = mergeGraphEdgeDirection(edgeDirections[key], incoming);
      return;
    }
    const edge: GraphEdge = [a, b];
    edgesByKey.set(key, edge);
    edgeKinds[key] = kind;
    edgeDirections[key] = "forward";
    edges.push(edge);
  };

  for (const document of documents) {
    const relativePath = normalizeVaultRelativePath(document.relativePath);
    documentNodeIds.set(
      relativePath,
      addNode("note", realVaultDocumentEntityId(index.vaultId, relativePath), realVaultDocumentLabel(document), graphTimelineAt(document.mtime)),
    );
  }

  const resolveWikiTarget = createRealVaultWikiTargetResolver(documents);
  for (const document of documents) {
    const sourcePath = normalizeVaultRelativePath(document.relativePath);
    const sourceNodeId = documentNodeIds.get(sourcePath);
    const sourceTimelineAt = graphTimelineAt(document.mtime);
    for (const link of document.wikiLinks || []) {
      const rawTarget = link.target || link.raw || "";
      if (!parseWikiReferenceTarget(rawTarget).targetTitle) continue;
      const resolved = resolveWikiTarget(rawTarget, sourcePath);
      if (resolved) {
        addEdge(sourceNodeId, documentNodeIds.get(normalizeVaultRelativePath(resolved.relativePath)), "wiki-link");
        continue;
      }
      const missingTarget = realVaultMissingDocumentLocation(rawTarget, sourcePath, { defaultParent: "root" });
      if (!missingTarget || !missingTarget.title || !normalizeVaultRelativePath(missingTarget.relativePath)) continue;
      const missingNodeId = addNode(
        "note",
        `missing-real-vault:${encodeURIComponent(sourcePath.toLocaleLowerCase())}:${encodeURIComponent(missingTarget.relativePath.toLocaleLowerCase())}`,
        missingTarget.title,
        sourceTimelineAt,
        { status: "missing", missingTarget: { ...missingTarget, rawTarget, sourceRelativePath: sourcePath } },
      );
      addEdge(sourceNodeId, missingNodeId, "wiki-link");
    }

    for (const resolution of embedResolutions.get(sourcePath) || []) {
      if (resolution.kind === "document") {
        addEdge(sourceNodeId, documentNodeIds.get(normalizeVaultRelativePath(resolution.relativePath)), "embed-document");
      } else if (resolution.kind === "library-asset") {
        const assetNodeId = addNode("material", resolution.assetId, resolution.assetName, sourceTimelineAt);
        addEdge(sourceNodeId, assetNodeId, "embed-asset");
      } else {
        const vaultAssetNodeId = addNode(
          "material",
          `real-vault-asset:${normalizeVaultRelativePath(resolution.relativePath)}`,
          resolution.label,
          sourceTimelineAt,
        );
        addEdge(sourceNodeId, vaultAssetNodeId, "embed-vault-asset");
      }
    }

    const seenTags = new Set<string>();
    for (const rawTag of document.frontmatterTags || []) {
      const tagName = normalizeRealVaultFrontmatterTag(rawTag);
      const tagKey = knowledgeTagCanonicalKey(tagName);
      if (!tagKey || seenTags.has(tagKey)) continue;
      seenTags.add(tagKey);
      const tagNodeId = addNode("tag", realVaultTagEntityId(index.vaultId, tagName), tagName, sourceTimelineAt);
      addEdge(sourceNodeId, tagNodeId, "tag");
    }
  }

  return { source: "real", sourceKind: "real-vault", nodes, edges, edgeKinds, edgeDirections };
}

export async function buildGraphSeedForCurrentSource(): Promise<GraphSeed> {
  const bridge = getBridge();
  if (bridge) {
    const snapshot = await knowledgeStore.ensureSnapshot({ reason: "graph-seed" });
    const vault = snapshot.vault;
    const index = snapshot.markdownIndex;
    if (snapshot.mode === "real-vault" && vault && index) {
      const embedResolutions = await resolveRealVaultGraphEmbeds(index, vault);
      const seed = buildRealVaultGraphSeed(index, embedResolutions.resolutions);
      graphSeedProvenance.set(seed, { vault: { ...vault }, materialLibraryId: embedResolutions.materialLibraryId,
        materialLibraryGeneration: embedResolutions.materialLibraryGeneration, materialSourceVersion: embedResolutions.materialSourceVersion, documentRevisions: index.documents.map(document => ({relativePath:document.relativePath,revision:document.revision})) });
      return seed;
    }
  }

  return { source: "empty", sourceKind: "real-vault", nodes: [], edges: [], edgeKinds: {}, edgeDirections: {} };
}

export const graphDataProvider = {
  buildSeed: buildGraphSeedForCurrentSource,
};

export function readGraphViewState(): GraphViewState {
  try {
    const raw = localStorage.getItem(GRAPH_VIEW_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as GraphViewState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeGraphViewState(state: GraphViewState) {
  try {
    localStorage.setItem(GRAPH_VIEW_KEY, JSON.stringify(state));
  } catch {}
}

export function normalizeGraphFilters(filters: GraphViewState["filters"]): Record<GraphType, boolean> {
  if (!filters) return {material: false, note: true, tag: false, web: false};
  return {
    material: filters?.material ?? true,
    note: filters?.note ?? true,
    tag: filters?.tag ?? true,
    web: filters?.web ?? true,
  };
}

export function clampGraphNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function isEditableGraphRelationPair(a: GraphSeedNode | null | undefined, b: GraphSeedNode | null | undefined) {
  if (!a || !b || a.key === b.key) return false;
  if (a.status === "missing" || b.status === "missing") return false;
  if (a.type === "web" || b.type === "web") return false;
  if (a.type === "tag") return b.type === "material" || b.type === "note";
  if (b.type === "tag") return a.type === "material" || a.type === "note";
  return false;
}

export function isEditableGraphBodyRelationPair(a: GraphSeedNode | null | undefined, b: GraphSeedNode | null | undefined) {
  if (!a || !b || a.key === b.key) return false;
  if (a.status === "missing" || b.status === "missing") return false;
  if (!a.entityId || !b.entityId) return false;
  if (a.type === "note" && b.type === "note") return true;
  if (a.type === "note" && b.type === "material") return true;
  if (a.type === "material" && b.type === "note") return true;
  return false;
}

export function graphNodesAreConnected(edges: GraphEdge[], a: GraphSeedNode, b: GraphSeedNode) {
  const low = Math.min(a.id, b.id);
  const high = Math.max(a.id, b.id);
  return edges.some(([edgeA, edgeB]) => Math.min(edgeA, edgeB) === low && Math.max(edgeA, edgeB) === high);
}

function splitTagRelationPair(a: GraphSeedNode, b: GraphSeedNode) {
  if (!isEditableGraphRelationPair(a, b)) return null;
  const tag = a.type === "tag" ? a : b.type === "tag" ? b : null;
  const target = a.type === "tag" ? b : a;
  const tagId = tag?.entityId;
  const targetId = target.entityId;
  if (!tagId || !targetId) return null;
  if (target.type !== "material" && target.type !== "note") return null;
  return { tag, target, tagId, targetId };
}

function splitBodyRelationPair(a: GraphSeedNode, b: GraphSeedNode): BodyRelationPair | null {
  if (!isEditableGraphBodyRelationPair(a, b)) return null;
  if (a.type === "note" && b.type === "note") return { kind: "note_link", sourceNote: a, target: b };
  if (a.type === "note" && b.type === "material") return { kind: "note_asset_embed", sourceNote: a, target: b };
  if (a.type === "material" && b.type === "note") return { kind: "note_asset_embed", sourceNote: b, target: a };
  return null;
}

function assertWikiTarget(label: string) {
  const target = label.trim();
  if (!target) throw new Error("目标名称为空，无法写入正文关系");
  if (/[\]\r\n]/.test(target)) throw new Error("目标名称包含无法安全写入 wiki 引用的字符");
  return target;
}

function appendWikiReference(content: string, reference: string) {
  const current = content.replace(/[ \t]+$/g, "").replace(/\s+$/g, "");
  return current ? `${current}\n\n${reference}` : reference;
}

function normalizeWikiTarget(raw: string) {
  return raw.split("|")[0].split("#")[0].trim();
}

function collectWikiReferenceRanges(content: string, targetLabel: string, kind: BodyRelationKind, matchMode: "any" | "simple" = "any") {
  const ranges: Array<{ start: number; end: number }> = [];
  const target = targetLabel.trim();
  const re = /!?\[\[([^\]\n]+?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (!isPlainMarkdownProseAt(content, match.index)) continue;
    const full = match[0];
    const isEmbed = full.startsWith("!");
    if (kind === "note_link" && isEmbed) continue;
    if (kind === "note_asset_embed" && !isEmbed) continue;
    const rawTarget = match[1].trim();
    if (matchMode === "simple" ? rawTarget !== target : normalizeWikiTarget(rawTarget) !== target) continue;
    ranges.push({ start: match.index, end: match.index + full.length });
  }
  return ranges;
}

function removeRangeAndTidy(content: string, start: number, end: number) {
  const next = `${content.slice(0, start)}${content.slice(end)}`;
  return next
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

async function readNoteContent(noteId: string) {
  const note = await getNote(noteId);
  if (!note) throw new Error("目标笔记不存在");
  return note.contentText || "";
}

async function readBodyRelationTargetLabel(pair: BodyRelationPair) {
  if (pair.kind === "note_link" && pair.target.entityId) {
    const note = await getNote(pair.target.entityId);
    return assertWikiTarget(note?.title || pair.target.label);
  }
  if (pair.kind === "note_asset_embed" && pair.target.entityId) {
    const bridge = getBridge();
    const assets = bridge?.listAssets ? await bridge.listAssets().catch(() => []) : [];
    const asset = Array.isArray(assets) ? assets.find((item) => item.id === pair.target.entityId) : null;
    return assertWikiTarget(asset?.name || pair.target.label);
  }
  return assertWikiTarget(pair.target.label);
}

async function connectBodyRelation(a: GraphSeedNode, b: GraphSeedNode): Promise<GraphRelationResult> {
  const pair = splitBodyRelationPair(a, b);
  if (!pair?.sourceNote.entityId || !pair.target.entityId) throw new Error("当前只支持笔记正文链接与素材嵌入关系编辑");

  const target = await readBodyRelationTargetLabel(pair);
  const content = await readNoteContent(pair.sourceNote.entityId);
  const existing = collectWikiReferenceRanges(content, target, pair.kind);
  if (existing.length > 0) return { changed: false, message: "正文关系已存在" };

  const reference = pair.kind === "note_link" ? `[[${target}]]` : `![[${target}]]`;
  await updateNoteContent(pair.sourceNote.entityId, appendWikiReference(content, reference));
  return {
    changed: true,
    message: pair.kind === "note_link"
      ? `已在 ${pair.sourceNote.label} 正文中连接 ${pair.target.label}`
      : `已在 ${pair.sourceNote.label} 正文中嵌入 ${pair.target.label}`,
  };
}

async function collectBodyRemovalCandidates(a: GraphSeedNode, b: GraphSeedNode) {
  const pairs = [splitBodyRelationPair(a, b)];
  const candidates: Array<{ pair: BodyRelationPair; content: string; start: number; end: number }> = [];

  for (const pair of pairs) {
    if (!pair?.sourceNote.entityId) continue;
    const target = await readBodyRelationTargetLabel(pair);
    const content = await readNoteContent(pair.sourceNote.entityId);
    const matchingRanges = collectWikiReferenceRanges(content, target, pair.kind);
    const simpleRanges = collectWikiReferenceRanges(content, target, pair.kind, "simple");
    if (matchingRanges.length > 1) {
      throw new Error(`未断开：${pair.sourceNote.label} 正文中存在多个 ${pair.target.label} 引用，请在笔记中手动删除`);
    }
    if (matchingRanges.length === 1 && simpleRanges.length === 0) {
      throw new Error(`未断开：${pair.sourceNote.label} 正文中的 ${pair.target.label} 使用了别名或块引用，请在笔记中手动删除`);
    }
    if (simpleRanges.length === 1) candidates.push({ pair, content, start: simpleRanges[0].start, end: simpleRanges[0].end });
  }

  return candidates;
}

async function disconnectBodyRelation(a: GraphSeedNode, b: GraphSeedNode): Promise<GraphRelationResult> {
  if (!isEditableGraphBodyRelationPair(a, b)) throw new Error("当前只支持笔记正文链接与素材嵌入关系编辑");
  const candidates = await collectBodyRemovalCandidates(a, b);
  if (!candidates.length) return { changed: false, message: "未在正文中找到可安全移除的关系" };

  const candidate = candidates[0];
  await updateNoteContent(candidate.pair.sourceNote.entityId!, removeRangeAndTidy(candidate.content, candidate.start, candidate.end));
  return {
    changed: true,
    message: candidate.pair.kind === "note_link"
      ? `已从 ${candidate.pair.sourceNote.label} 正文中移除 ${candidate.pair.target.label} 链接`
      : `已从 ${candidate.pair.sourceNote.label} 正文中移除 ${candidate.pair.target.label} 嵌入`,
  };
}

type RealVaultGraphTagMutationDependencies = {
  readIndex(): Promise<BridgeNotesVaultMarkdownIndex>;
  writeTags(
    documentRef: KnowledgeDocumentRef,
    expectedRevision: string,
    tags: string[],
  ): Promise<KnowledgeMutationResult>;
  refresh(): Promise<unknown>;
};

const realVaultGraphTagMutationDependencies: RealVaultGraphTagMutationDependencies = {
  async readIndex() {
    const snapshot = await knowledgeStore.ensureSnapshot({ reason: "graph-real-vault-tag-edit" });
    if (snapshot.mode !== "real-vault" || !snapshot.markdownIndex) {
      throw new Error("knowledge-vault-required");
    }
    return snapshot.markdownIndex;
  },
  writeTags: setActiveKnowledgeDocumentTags,
  refresh: () => knowledgeStore.revalidate({ reason: "graph-real-vault-tag-edit", force: true }),
};

export async function updateRealVaultGraphTagRelation(
  a: GraphSeedNode,
  b: GraphSeedNode,
  mode: "connect" | "disconnect",
  dependencies: RealVaultGraphTagMutationDependencies = realVaultGraphTagMutationDependencies,
): Promise<GraphRelationResult> {
  const pair = splitTagRelationPair(a, b);
  const documentRef = pair?.target.type === "note" && pair.targetId
    ? parseKnowledgeDocumentNoteId(pair.targetId)
    : null;
  const tagIdentity = pair?.tag.entityId ? parseKnowledgeTagIdentity(pair.tag.entityId) : null;
  if (!pair || !documentRef || !tagIdentity) {
    throw new Error("当前只支持知识库文档与知识库标签之间的关系编辑");
  }
  const index = await dependencies.readIndex();
  if (index.vaultId !== documentRef.vaultId || tagIdentity.vaultId !== documentRef.vaultId) {
    throw new Error("knowledge-vault-not-current");
  }
  const document = index.documents.find((candidate) => (
    candidate.relativePath.toLocaleLowerCase() === documentRef.relativePath.toLocaleLowerCase()
  ));
  if (!document) throw new Error("knowledge-not-found");
  const tagName = pair.tag.label.trim().replace(/^#+/, "").trim();
  if (!tagName) throw new Error("knowledge-invalid-tag");
  const targetKey = knowledgeTagCanonicalKey(tagName);
  if (targetKey !== tagIdentity.key) throw new Error("knowledge-invalid-tag");
  const current = Array.from(new Map(
    (document.frontmatterTags || []).map((tag) => [knowledgeTagCanonicalKey(tag), tag]),
  ).values());
  const existed = current.some((tag) => knowledgeTagCanonicalKey(tag) === targetKey);
  if (mode === "connect" && existed) return { changed: false, message: "关系已存在" };
  if (mode === "disconnect" && !existed) return { changed: false, message: "关系不存在" };
  const next = mode === "connect"
    ? [...current, tagName]
    : current.filter((tag) => knowledgeTagCanonicalKey(tag) !== targetKey);
  const mutation = await dependencies.writeTags(documentRef, document.revision, next);
  if (!mutation.indexWarning && !mutation.indexStale) await dependencies.refresh();
  const successMessage = mode === "connect"
    ? `已连接 ${pair.target.label} 与 ${pair.tag.label}`
    : `已断开 ${pair.target.label} 与 ${pair.tag.label}`;
  return {
    changed: true,
    message: knowledgeMutationSuccessStatus(mutation, successMessage),
    mutation,
  };
}

async function updateTagRelation(a: GraphSeedNode, b: GraphSeedNode, mode: "connect" | "disconnect"): Promise<GraphRelationResult> {
  const pair = splitTagRelationPair(a, b);
  if (!pair) throw new Error("当前只支持素材/笔记与标签之间的关系编辑");

  if (parseKnowledgeDocumentNoteId(pair.targetId)
    || pair.tag.entityId?.startsWith("real-vault-tag:")) {
    return updateRealVaultGraphTagRelation(a, b, mode);
  }

  const bridge = requireBridge();
  const current = pair.target.type === "material"
    ? await bridge.getAssetTags(pair.targetId)
    : await bridge.getNoteTags(pair.targetId);
  const next = new Set(Array.isArray(current) ? current : []);
  const existed = next.has(pair.tagId);
  if (mode === "connect" && existed) return { changed: false, message: "关系已存在" };
  if (mode === "disconnect" && !existed) return { changed: false, message: "关系不存在" };
  if (mode === "connect") next.add(pair.tagId);
  else next.delete(pair.tagId);

  if (pair.target.type === "material") {
    await bridge.setAssetTags(pair.targetId, Array.from(next));
  } else {
    await bridge.setNoteTags(pair.targetId, Array.from(next));
    if (mode === "disconnect") {
      const note = await getNote(pair.targetId).catch(() => null);
      const currentText = note?.contentText || "";
      const nextText = removeMarkdownTagReferencesInText(currentText, pair.tag.label);
      if (nextText !== currentText) await updateNoteContent(pair.targetId, nextText);
    }
  }

  return {
    changed: true,
    message: mode === "connect" ? `已连接 ${pair.target.label} 与 ${pair.tag.label}` : `已断开 ${pair.target.label} 与 ${pair.tag.label}`,
  };
}

export function connectGraphTagRelation(a: GraphSeedNode, b: GraphSeedNode) {
  return updateTagRelation(a, b, "connect");
}

export function disconnectGraphTagRelation(a: GraphSeedNode, b: GraphSeedNode) {
  return updateTagRelation(a, b, "disconnect");
}

export function connectGraphBodyRelation(a: GraphSeedNode, b: GraphSeedNode) {
  return connectBodyRelation(a, b);
}

export function disconnectGraphBodyRelation(a: GraphSeedNode, b: GraphSeedNode) {
  return disconnectBodyRelation(a, b);
}
