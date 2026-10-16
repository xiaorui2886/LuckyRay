// D85/D119: 图谱 React 化主组件。视觉和交互以 public/luckyray-ui.html 的图谱页为准。

import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { resolveScopedShortcut } from "../../app/shortcuts";
import { useI18n, useMessages, type I18nContextValue } from "../../core/i18n/index";
import { readActiveContext } from "../../core/activeContext";
import { getLuckyRayBridgeSync } from "../../core/bridge/luckyRayBridge";
import { normalizeVaultRelativePath, realVaultMissingDocumentLocation } from "../../core/markdown/wikiTargets";
import { focusEntity, publishCurrentGraphContext as publishMainGraphContext } from "../../core/services/context";
import { knowledgeDocumentNoteId, parseKnowledgeDocumentNoteId } from "../../core/services/knowledge";
import { KNOWLEDGE_SOURCE_CHANGED_EVENT } from "../../core/services/knowledgeSource";
import { knowledgeStore } from "../../core/services/knowledgeStore";
import { materialStore } from "../../core/services/materialStore";
import { openInLightSeek } from "../../core/services/openInLightSeek";
import {
  graphDataProvider,
  readGraphSeedProvenance,
  type GraphSeedProvenance,
  clampGraphNumber,
  connectGraphBodyRelation,
  connectGraphTagRelation,
  DEGREE_COLORS,
  disconnectGraphBodyRelation,
  disconnectGraphTagRelation,
  graphVaultsMatch,
  graphNodesAreConnected,
  isEditableGraphBodyRelationPair,
  isEditableGraphRelationPair,
  normalizeGraphFilters,
  readGraphViewState,
  TYPE_COLORS,
  type GraphEdge,
  type GraphEdgeDirection,
  type GraphEdgeKind,
  type GraphSeed,
  type GraphSeedNode,
  type GraphType,
  type GraphViewState,
  writeGraphViewState,
} from "../../core/services/graph";
import {
  buildGraphPlaybackPlan,
  graphPlaybackEdgeKey,
  graphPlaybackEdgeProgress,
  graphPlaybackNodeVisual,
  type GraphPlaybackPlan,
} from "../../core/services/graphPlayback";
import {
  GRAPH_PHYSICS_STATE_STRIDE,
  packGraphPhysicsState,
  stepGraphPhysics,
  type GraphPhysicsInput,
  type GraphPhysicsOutput,
  type GraphPhysicsStepRequest,
  type GraphPhysicsStepParameters,
  type GraphPhysicsStepResponse,
  type GraphPhysicsTopologyPayload,
} from "./graphPhysics";
import { updateGraphLabels, graphLabelDetail, graphLabelFocusAlpha, type GraphLabelState, normalizeGraphColorGroups, normalizeGraphSections, graphGroupMatches, type GraphLabelCandidate } from './graphPresentation';
import { GRAPH_MIN_SCALE, GRAPH_MAX_SCALE, wheelCamera, wheelZoomPoint, stepCamera, fitGraphCamera } from './graphCamera';
import { graphSeedPositions, graphScreenRadius, graphEdgeDetail } from './graphSpatial';
import {graphMessages} from './graphMessages';
import { GraphColorGroups } from './GraphColorGroups';
import { graphSessionStore, sameGraphSessionSnapshot, validateGraphSessionSnapshot, type GraphSessionSnapshot } from './graphSessionStore';
import { captureGraphPlayback, createGraphPlaybackClock, graphPlaybackActivationNodes, restoreGraphPlayback, type GraphPlaybackSnapshot } from './graphPlaybackSession';
import { graphSessionRects, type GraphSplitRect } from './graphSessionLayout';
import { beginGraphTabPointerDrag } from './graphTabPointerDrag';
import { registerIntegratedLayout } from '../../workspace/integratedLayoutRegistry';
import { graphNativeViews, graphNativeIdentity, sameNativeGraphSeed, isNativeGraphAdmission, type GraphNativeViewBinding } from "./graphNativeViewRegistry";
import { validateGraphViewPresentation, sameGraphViewIdentity, assertGraphPresentationSceneState, type GraphViewApplyAck } from "../../workspace/graphViewPresentation";
import type { ScopedGraphSnapshot } from "../../workspace/scopedGraphRuntime";
import { isCurrentGraphDataProof, type GraphDataProof, type GraphRuntime, type GraphNodeAction } from "./GraphRuntime";
import type { GraphViewPresentationController } from "../../workspace/graphViewPresentation";
import "./graph.css";

type GraphNode = GraphSeedNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  links: number;
  hidden: boolean;
  dimmed: boolean;
  labelShort: string;
};

const GRAPH_NODE_MENU_VIEWPORT_MARGIN = 8;

function clampGraphNodeMenuPosition(x: number, y: number, width: number, height: number, containerWidth: number, containerHeight: number) {
  const maxLeft = Math.max(GRAPH_NODE_MENU_VIEWPORT_MARGIN, containerWidth - width - GRAPH_NODE_MENU_VIEWPORT_MARGIN);
  const maxTop = Math.max(GRAPH_NODE_MENU_VIEWPORT_MARGIN, containerHeight - height - GRAPH_NODE_MENU_VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(x, GRAPH_NODE_MENU_VIEWPORT_MARGIN), maxLeft),
    top: Math.min(Math.max(y, GRAPH_NODE_MENU_VIEWPORT_MARGIN), maxTop),
  };
}

function isMissingGraphNode(node: Pick<GraphSeedNode, "entityId" | "status" | "missingTarget">) {
  return node.status === "missing"
    || Boolean(node.missingTarget)
    || Boolean(node.entityId?.startsWith("missing-real-vault:") || node.entityId?.startsWith("real-vault-missing:"));
}

function graphMissingDocumentTarget(node: Pick<GraphSeedNode, "entityId" | "missingTarget">) {
  if (node.missingTarget) return node.missingTarget;
  const prefix = node.entityId?.startsWith("missing-real-vault:")
    ? "missing-real-vault:"
    : node.entityId?.startsWith("real-vault-missing:")
      ? "real-vault-missing:"
      : null;
  if (!prefix || !node.entityId) return null;
  const encoded = node.entityId.slice(prefix.length);
  const separator = encoded.indexOf(":");
  if (separator < 0) return null;
  try {
    const relativePath = normalizeVaultRelativePath(decodeURIComponent(encoded.slice(separator + 1)));
    if (!relativePath) return null;
    const slash = relativePath.lastIndexOf("/");
    const parentPath = slash >= 0 ? relativePath.slice(0, slash) : "";
    const fileName = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
    const title = fileName.replace(/\.md$/i, "").trim();
    if (!title || !fileName) return null;
    return { parentPath, fileName, title, relativePath };
  } catch {
    return null;
  }
}

type TrustedGraphMissingDocumentTarget = NonNullable<GraphSeedNode["missingTarget"]>;

function hasTrustedGraphMissingDocumentMetadata(
  target: NonNullable<ReturnType<typeof graphMissingDocumentTarget>>,
): target is TrustedGraphMissingDocumentTarget {
  return "rawTarget" in target
    && typeof target.rawTarget === "string"
    && Boolean(target.rawTarget.trim())
    && "sourceRelativePath" in target
    && typeof target.sourceRelativePath === "string"
    && Boolean(normalizeVaultRelativePath(target.sourceRelativePath));
}

function isSafeGraphMissingDocumentTarget(target: NonNullable<ReturnType<typeof graphMissingDocumentTarget>>) {
  if (!hasTrustedGraphMissingDocumentMetadata(target)) return false;
  const relativePath = normalizeVaultRelativePath(target.relativePath);
  const segments = relativePath.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === ".." || segment.toLocaleLowerCase() === ".luckyray")) return false;
  if (!/\.md$/i.test(target.fileName) || segments[segments.length - 1] !== target.fileName) return false;
  if (normalizeVaultRelativePath(target.parentPath) !== segments.slice(0, -1).join("/")) return false;
  if (!target.title.trim()) return false;
  const resolved = realVaultMissingDocumentLocation(target.rawTarget, target.sourceRelativePath, { defaultParent: "root" });
  return Boolean(resolved && normalizeVaultRelativePath(resolved.relativePath) === relativePath);
}

type GraphRenderEdge = {
  a: GraphNode;
  b: GraphNode;
  kind: GraphEdgeKind;
  direction: GraphEdgeDirection;
  relatedToFocus: boolean;
  dimmed: boolean;
};

type GraphPhysicsTopologyCache = {
  revision: number;
  nodeIds: number[];
  radii: number[];
  edgePairs: number[];
};

function graphPhysicsNumberArraysEqual(current: number[], next: number[]) {
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index++) {
    if (current[index] !== next[index]) return false;
  }
  return true;
}

function updateGraphPhysicsTopology(
  current: GraphPhysicsTopologyCache,
  nodes: ReadonlyArray<Pick<GraphNode, "id" | "r">>,
  edges: ReadonlyArray<Pick<GraphRenderEdge, "a" | "b">>,
) {
  const nodeIds = nodes.map((node) => node.id);
  const radii = nodes.map((node) => node.r);
  const edgePairs = edges.flatMap((edge) => [edge.a.id, edge.b.id]);
  if (
    graphPhysicsNumberArraysEqual(current.nodeIds, nodeIds)
    && graphPhysicsNumberArraysEqual(current.radii, radii)
    && graphPhysicsNumberArraysEqual(current.edgePairs, edgePairs)
  ) {
    return current;
  }
  return {
    revision: current.revision + 1,
    nodeIds,
    radii,
    edgePairs,
  };
}

type GraphSearchResult =
  | { kind: "folder"; key: string; label: string; secondary: string; nodeKeys: string[] }
  | { kind: "document"; key: string; label: string; secondary: string; node: GraphNode };

type GraphSearchScope = {
  kind: "folder" | "document";
  label: string;
  nodeKeys: string[];
};

type GraphParams = {
  alpha: number;
  scale: number;
  panX: number;
  panY: number;
  showLabels: boolean;
  colorMode: "default" | "type" | "degree";
  showArrows: boolean;
  nodeSizeMultiplier: number;
  edgeWidthBase: number;
  labelReveal: number;
  centerForce: number;
  repulsionForce: number;
  linkAttraction: number;
  linkLength: number;
  nodeSpacing: number;
  showIsolated: boolean;
  nearbyFilter: boolean;
  nearbyDepth: 1 | 2;
  animPhase: number;
};

type GraphViewport = {
  width: number;
  height: number;
  left: number;
  top: number;
  dpr: number;
};

type GraphPaneCamera = Pick<GraphParams, "scale" | "panX" | "panY">;

type GraphPaneNodePosition = Pick<GraphNode, "key" | "x" | "y" | "vx" | "vy">;

export type GraphPaneSnapshot = GraphSessionSnapshot;

export type GraphViewportProps = {
  runtime?: GraphRuntime;
  presentation?: GraphViewPresentationController;
  /** Scoped proof, delivered only after a completed canvas draw is presented. */
  onRevisionReady?: (proof: GraphDataProof) => void;
  onRevisionInvalidated?: () => void;
  paneId: string;
  sessionId?: string;
  layoutRevision?: string;
  initialSnapshot?: GraphSessionSnapshot;
  onDuplicate?: () => void;
  visible?: boolean;
  scopeVaultId?: string;
  initialCamera?: GraphPaneCamera;
  initialView?: GraphViewState;
  initialPositions?: GraphPaneNodePosition[];
  active: boolean;
  primary: boolean;
  headerInTitlebar: boolean;
  persistView: boolean;
  canClose: boolean;
  onActivate: (paneId: string) => void;
  onSplit?: (paneId: string, orientation: "row" | "column", snapshot: GraphPaneSnapshot) => void;
  onClose: (paneId: string) => boolean;
};

let sharedGraphSeed: GraphSeed | null = null;
let sharedGraphSeedRequest: Promise<GraphSeed> | null = null;
let sharedGraphSeedRevision = "";
let sharedGraphSeedRequestRevision = "";

function readGraphDataRevision() {
  const knowledge = knowledgeStore.getSnapshot();
  const materials = materialStore.getSnapshot();
  if (knowledge.mode === "real-vault") {
    return [
      "real-vault",
      knowledge.vault?.id || knowledge.vault?.rootPath || "none",
      knowledge.markdownIndex?.version || 0,
      materials.sourceVersion ?? materials.version,
    ].join(":");
  }
  return ["db", knowledge.version, materials.sourceVersion ?? materials.version].join(":");
}

async function readSharedGraphSeed(refresh = false) {
  const revision = readGraphDataRevision();
  if (refresh || sharedGraphSeedRevision !== revision) sharedGraphSeed = null;
  if (sharedGraphSeed && sharedGraphSeedRevision === revision) return sharedGraphSeed;
  if (!sharedGraphSeedRequest || sharedGraphSeedRequestRevision !== revision) {
    const request = graphDataProvider.buildSeed()
      .then((seed) => {
        if (readGraphDataRevision() === revision) {
          sharedGraphSeed = seed;
          sharedGraphSeedRevision = revision;
        }
        return seed;
      })
      .finally(() => {
        if (sharedGraphSeedRequest === request) {
          sharedGraphSeedRequest = null;
          sharedGraphSeedRequestRevision = "";
        }
      });
    sharedGraphSeedRequest = request;
    sharedGraphSeedRequestRevision = revision;
  }
  return sharedGraphSeedRequest;
}

function invalidateSharedGraphSeed() {
  sharedGraphSeed = null;
  sharedGraphSeedRevision = "";
}

type GraphSceneCache = {
  visibleNodes: GraphNode[];
  visibleEdges: GraphRenderEdge[];
  adjacency: Map<number, Set<number>>;
  connectedIds: Set<number>;
  nearbyFocusId: number | null;
  hoverId: number | null;
  activeFocusId: number | null;
};

type GraphDirtyReason = "scene" | "viewport" | "hover" | "layout";

type PendingPointer = {
  clientX: number;
  clientY: number;
};

type PendingWheel = {
  x: number;
  y: number;
  delta: number;
};

type GraphCamera = Pick<GraphParams, "scale" | "panX" | "panY">;

type GraphCameraVelocity = Pick<GraphParams, "panX" | "panY">;

type PanGesture = {
  pointerType: string;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  lastX: number;
  lastY: number;
  lastAt: number;
  velocityX: number;
  velocityY: number;
  moved: boolean;
};

type SimulationState = {
  active: boolean;
  stepped: boolean;
  delay: number;
};

const INITIAL_PARAMS: GraphParams = {
  alpha: 1,
  scale: 1,
  panX: 0,
  panY: 0,
  showLabels: true,
  colorMode: "type",
  showArrows: false,
  nodeSizeMultiplier: 1,
  edgeWidthBase: 1,
  labelReveal: 0.25,
  centerForce: 50,
  repulsionForce: 50,
  linkAttraction: 50,
  linkLength: 132,
  nodeSpacing: 50,
  showIsolated: true,
  nearbyFilter: false,
  nearbyDepth: 1,
  animPhase: 0,
};

const EMPTY_SCENE: GraphSceneCache = {
  visibleNodes: [],
  visibleEdges: [],
  adjacency: new Map(),
  connectedIds: new Set(),
  nearbyFocusId: null,
  hoverId: null,
  activeFocusId: null,
};

const EMPTY_VIEWPORT: GraphViewport = { width: 0, height: 0, left: 0, top: 0, dpr: 1 };
const VIEW_PERSIST_DELAY_MS = 280;
const SIMULATION_FRAME_BUDGET_MS = 7;
const SIMULATION_MAX_CADENCE_MS = 66;
const SIMULATION_BACKGROUND_MIN_CADENCE_MS = 34;
const SIMULATION_WORK_TIME_EWMA_WEIGHT = 0.28;

function graphSimulationCadence(
  activeNodeCount: number,
  workTimeEwma: number,
  activePane: boolean,
  interactionPriority: boolean,
  smoothDragMotion = false,
) {
  // One in-flight worker plus one rAF already bounds interactive work. A second
  // timer (including a multiplier of worker cost) makes neighbours pause between
  // replies. The synchronous fallback continues to use the normal CPU budget.
  if (smoothDragMotion) return 0;
  const nodeCadence = activeNodeCount >= 260 ? 34 : activeNodeCount >= 140 ? 24 : 16;
  const costCadence = workTimeEwma > SIMULATION_FRAME_BUDGET_MS
    ? Math.ceil(workTimeEwma * (activePane || interactionPriority ? 1.7 : 2.2))
    : 0;
  const paneCadence = activePane || interactionPriority
    ? nodeCadence
    : Math.max(nodeCadence, SIMULATION_BACKGROUND_MIN_CADENCE_MS);
  return Math.min(SIMULATION_MAX_CADENCE_MS, Math.max(paneCadence, costCadence));
}
const CAMERA_INERTIA_FRICTION = 0.012;
const CAMERA_INERTIA_STOP_SPEED = 0.018;
const CAMERA_INERTIA_MAX_SPEED = 1.35;
const CAMERA_FRAME_DELAY_MS = 16;
const GRAPH_NODE_BASE_RADIUS = 3.6;
const GRAPH_NODE_DEGREE_STEP = 0.85;
const GRAPH_NODE_DEGREE_MAX = 3.4;
const GRAPH_REPULSION = 100;
const GRAPH_REST_LENGTH = 180;
const GRAPH_LINK_ATTRACTION = 1;
const GRAPH_COLLISION_GAP = 14;
const GRAPH_CENTER_PULL = 0.02;
const GRAPH_FORCE_CONTROL_DEFAULT = 50;
const GRAPH_FORCE_CONTROL_MIN = 0;
const GRAPH_FORCE_CONTROL_MAX = 100;
const GRAPH_LINK_LENGTH_MIN = 64;
const GRAPH_LINK_LENGTH_MAX = 360;
const GRAPH_NODE_SPACING_MIN = 2;
const GRAPH_NODE_SPACING_MAX = 104;
const GRAPH_LABEL_REVEAL_DEFAULT = 0.45;
const GRAPH_LABEL_REVEAL_MAX = 1.6;

function graphNodeRadiusForLinks(links: number) {
  return GRAPH_NODE_BASE_RADIUS + Math.min(
    GRAPH_NODE_DEGREE_MAX,
    links <= 1 ? 0 : Math.sqrt(Math.max(0, links - 1)) * GRAPH_NODE_DEGREE_STEP,
  );
}

function realVaultDocumentPath(node: GraphNode) {
  if (node.type !== "note" || !node.entityId) return null;
  return parseKnowledgeDocumentNoteId(node.entityId)?.relativePath || null;
}

function buildGraphSearchResults(nodes: GraphNode[], normalizedQuery: string, t: I18nContextValue["t"]): GraphSearchResult[] {
  if (!normalizedQuery) return [];
  const folders = new Map<string, Set<string>>();
  for (const node of nodes) {
    const relativePath = realVaultDocumentPath(node);
    if (!relativePath) continue;
    const parts = relativePath.split("/").filter(Boolean);
    parts.pop();
    for (let index = 1; index <= parts.length; index++) {
      const folderPath = parts.slice(0, index).join("/");
      let nodeKeys = folders.get(folderPath);
      if (!nodeKeys) folders.set(folderPath, nodeKeys = new Set());
      nodeKeys.add(node.key);
    }
  }

  const folderResults = [...folders.entries()]
    .filter(([folderPath]) => folderPath.toLocaleLowerCase().includes(normalizedQuery))
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
    .map(([folderPath, nodeKeys]) => ({
      kind: "folder" as const,
      key: `folder:${folderPath}`,
      label: folderPath.split("/").pop() || folderPath,
      secondary: t("editor.graph.search.folderDocuments", { path: folderPath, count: nodeKeys.size }),
      nodeKeys: [...nodeKeys],
    }));
  const documentResults = nodes
    .filter((node) => node.type === "note" && (
      node.label.toLocaleLowerCase().includes(normalizedQuery)
      || realVaultDocumentPath(node)?.toLocaleLowerCase().includes(normalizedQuery)
    ))
    .map((node) => ({
      kind: "document" as const,
      key: node.key,
      label: node.label,
      secondary: realVaultDocumentPath(node) || t("editor.graph.search.knowledgeDocument"),
      node,
    }));
  return [...folderResults, ...documentResults].slice(0, 12);
}
const GRAPH_REVEAL_FRAME_DELAY_MS = 16;

type GraphEdgeVisual = {
  width: number;
};

const GRAPH_EDGE_VISUALS: Record<GraphEdgeKind, GraphEdgeVisual> = {
  relation: { width: 0.86 },
  "wiki-link": { width: 1 },
  tag: { width: 0.76 },
  embed: { width: 0.9 },
  "embed-document": { width: 0.94 },
  "embed-asset": { width: 0.94 },
  "embed-vault-asset": { width: 0.82 },
  web: { width: 0.78 },
};

const GRAPH_THEME_ACCENT_FALLBACK = "#7c8aff";
const REAL_VAULT_ASSET_PREFIX = "real-vault-asset:";
const GRAPH_NODE_BACKGROUND = "#0a0a0c";
const GRAPH_EDGE_BASE_STROKE = "#646871";
const GRAPH_EDGE_DIMMED_STROKE = "#33363c";
const GRAPH_NODE_TYPE_TONES: Record<GraphType, string> = {
  note: "#f2f3f5",
  material: "#c5cad1",
  tag: "#9198a2",
  web: "#707780",
};

function graphEdgeKey(a: number, b: number) {
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}

function safeRealVaultAssetRelativePath(entityId: string | null | undefined) {
  if (!entityId?.startsWith(REAL_VAULT_ASSET_PREFIX)) return null;
  const relativePath = entityId.slice(REAL_VAULT_ASSET_PREFIX.length).replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = relativePath.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === ".." || part.toLocaleLowerCase() === ".luckyray")) return null;
  return parts.join("/");
}

function safeRealVaultDocumentRelativePath(entityId: string | null | undefined) {
  const relativePath = entityId ? parseKnowledgeDocumentNoteId(entityId)?.relativePath || "" : "";
  const parts = relativePath.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === ".." || part.toLocaleLowerCase() === ".luckyray")) return null;
  const normalized = parts.join("/");
  return /\.(?:md|markdown)$/i.test(normalized) ? normalized : null;
}

function collectGraphNeighborhood(adjacency: Map<number, Set<number>>, rootId: number, depth: 1 | 2) {
  const neighborhood = new Set<number>([rootId]);
  let frontier = new Set<number>([rootId]);
  for (let level = 0; level < depth && frontier.size; level += 1) {
    const next = new Set<number>();
    for (const nodeId of frontier) {
      for (const neighborId of adjacency.get(nodeId) || []) {
        if (neighborhood.has(neighborId)) continue;
        neighborhood.add(neighborId);
        next.add(neighborId);
      }
    }
    frontier = next;
  }
  return neighborhood;
}

function mixGraphHexColors(foreground: string, background: string, foregroundWeight: number) {
  const readHex = (value: string) => value.trim().replace(/^#/, "");
  const source = readHex(foreground);
  const base = readHex(background);
  if (!/^[0-9a-f]{6}$/i.test(source) || !/^[0-9a-f]{6}$/i.test(base)) return foreground;
  const weight = Math.max(0, Math.min(1, foregroundWeight));
  const channel = (offset: number) => Math.round(
    Number.parseInt(source.slice(offset, offset + 2), 16) * weight
      + Number.parseInt(base.slice(offset, offset + 2), 16) * (1 - weight),
  ).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

function graphThemeNodeTone(type: GraphType, accent: string) {
  if (type === "note") return GRAPH_NODE_TYPE_TONES.note;
  const base = GRAPH_NODE_TYPE_TONES[type];
  const accentWeight = type === "material" ? 0.16 : type === "tag" ? 0.32 : 0.1;
  return mixGraphHexColors(accent, base, accentWeight);
}

function truncateGraphLabel(value: string, maxLength: number) {
  const text = value.trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}

function smoothstep(min: number, max: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return t * t * (3 - 2 * t);
}

function readSavedLabelReveal(view: GraphViewState) {
  if (typeof view.labelReveal === "number") {
    return clampGraphNumber(view.labelReveal, GRAPH_LABEL_REVEAL_DEFAULT, 0, GRAPH_LABEL_REVEAL_MAX);
  }
  // G2B stored a maximum alpha. It has no equivalent threshold meaning, so use
  // the readable default instead of preserving a permanently dim label state.
  return GRAPH_LABEL_REVEAL_DEFAULT;
}

function readLegacyForceControl(view: GraphViewState) {
  const legacy = clampGraphNumber(view.forceStrength, 1, 0, 3);
  // The former single multiplier covered three unrelated forces. Keep its
  // default at the new midpoint instead of restoring an extreme layout.
  return clampGraphNumber(50 + (legacy - 1) * 25, GRAPH_FORCE_CONTROL_DEFAULT, GRAPH_FORCE_CONTROL_MIN, GRAPH_FORCE_CONTROL_MAX);
}

function readSavedForceControl(
  view: GraphViewState,
  key: "centerForce" | "repulsionForce" | "linkAttraction",
) {
  return clampGraphNumber(
    view[key],
    readLegacyForceControl(view),
    GRAPH_FORCE_CONTROL_MIN,
    GRAPH_FORCE_CONTROL_MAX,
  );
}

function graphAnchoredControlValue(value: number, minimum: number, maximum: number, defaultValue: number) {
  const normalized = clampGraphNumber(value, GRAPH_FORCE_CONTROL_DEFAULT, GRAPH_FORCE_CONTROL_MIN, GRAPH_FORCE_CONTROL_MAX) / 100;
  const defaultRatio = (defaultValue - minimum) / (maximum - minimum);
  const exponent = Math.log(defaultRatio) / Math.log(0.5);
  return minimum + (maximum - minimum) * Math.pow(normalized, exponent);
}

function graphForceScale(value: number, minimum: number, maximum: number) {
  // Keep the 50% setting at the historical baseline while reserving the upper
  // segment for deliberately stronger, still bounded layout changes.
  return graphAnchoredControlValue(value, minimum, maximum, 1);
}

function graphNodeSpacingGap(value: number) {
  return graphAnchoredControlValue(value, GRAPH_NODE_SPACING_MIN, GRAPH_NODE_SPACING_MAX, GRAPH_COLLISION_GAP);
}

function graphForceLevel(value: number) {
  if (value <= 33) return "weak";
  if (value >= 67) return "strong";
  return "moderate";
}

function graphLinkLengthLevel(value: number) {
  if (value <= 108) return "near";
  if (value >= 224) return "far";
  return "moderate";
}

function graphNodeSpacingLevel(value: number) {
  if (value <= 33) return "tight";
  if (value >= 67) return "loose";
  return "moderate";
}

function normalizeWheelDelta(event: WheelEvent, pageHeight: number) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(pageHeight, 1) : 1;
  return Math.max(-240, Math.min(240, event.deltaY * unit));
}

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function rangeFillStyle(value: number, min: number, max: number): CSSProperties {
  const pct = ((value - min) / (max - min)) * 100;
  return { "--range-fill": `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties;
}

function iconClose() {
  return (
    <svg viewBox="0 0 16 16">
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

function playIcon() {
  return <svg viewBox="0 0 16 16"><polygon points="5,3 13,8 5,13" /></svg>;
}

export function GraphViewport({ runtime, presentation, onRevisionReady, onRevisionInvalidated, paneId, sessionId, layoutRevision, initialSnapshot, onDuplicate, visible = true, scopeVaultId, initialCamera = initialSnapshot?.camera, initialView = initialSnapshot?.view, initialPositions = initialSnapshot?.positions, active, primary, headerInTitlebar, persistView, canClose, onActivate, onSplit, onClose }: GraphViewportProps) {
  const publishCurrentGraphContext = useCallback((context: Parameters<typeof publishMainGraphContext>[0]) => {
    if (runtime) runtime.publishContext(context?.nodeId && context.nodeType ? { nodeId: context.nodeId, nodeType: context.nodeType, label: context.label || "" } : null);
    else publishMainGraphContext(context);
  }, [runtime]);
  const runtimeActionUnavailable = (action: GraphNodeAction, node: GraphSeedNode) => runtime ? !runtime.capability(action, node).available : false;
  const mainGraphSourceRef = useRef<GraphSeedProvenance & { generation: number; seed: GraphSeed; verified: ScopedGraphSnapshot | null } | null>(null);
  const mainGraphCaptureSequenceRef = useRef(0);
  const graphMutationPendingRef = useRef(0);
  const mainGraphApplyRef = useRef<{ seed: GraphSeed; generation: number; state: GraphSessionSnapshot; acknowledgment: GraphViewApplyAck; resolve: (ack: GraphViewApplyAck) => void; reject: (error: Error) => void } | null>(null);
  const mainGraphPaintedSeedRef = useRef<GraphSeed | null>(null);
  const presentationRef = useRef(presentation); presentationRef.current = presentation;
  const presentationFrozenRef = useRef(Boolean(sessionId && graphNativeViews.isIncoming(sessionId)));
  const [presentationFrozen, setPresentationFrozen] = useState(Boolean(sessionId && graphNativeViews.isIncoming(sessionId)));
  const [presentationPaintVersion, setPresentationPaintVersion] = useState(0);
  const [, setRuntimeCapabilityVersion] = useState(0);
  const presentationCommitRef = useRef(true);
  const workspaceVisibleRef=useRef(visible);workspaceVisibleRef.current=visible;
  const {t: graphText} = useMessages(graphMessages);
  const { t } = useI18n();
  const savedViewRef = useRef<GraphViewState>(initialView || (runtime ? {} : readGraphViewState()));
  const savedView = savedViewRef.current;
  const initialFilters = normalizeGraphFilters(savedView.filters);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeMenuRef = useRef<HTMLDivElement>(null);
  const graphSeedRef = useRef<GraphSeed>({ source: "empty", nodes: [], edges: [] });
  const sceneSeedRef = useRef<GraphSeed | null>(null);
  const loadedGraphProofRef = useRef<{ runtime: GraphRuntime; proof: GraphDataProof; seed: GraphSeed; requestId: number } | null>(null);
  const currentRuntimeRef = useRef(runtime); currentRuntimeRef.current = runtime;
  const persistViewRef = useRef(persistView); persistViewRef.current = persistView;
  const revisionReadyRef = useRef(onRevisionReady); revisionReadyRef.current = onRevisionReady;
  const revisionInvalidatedRef = useRef(onRevisionInvalidated); revisionInvalidatedRef.current = onRevisionInvalidated;
  const currentLayoutRevisionRef = useRef(layoutRevision); currentLayoutRevisionRef.current = layoutRevision;
  const paintReadinessEpochRef = useRef(0);
  const pendingPaintReadyRef = useRef<number | null>(null);
  const lastPaintReadyRef = useRef<string | null>(null);
  const invalidatePaintReadiness = useCallback(() => {
    paintReadinessEpochRef.current += 1;
    if (pendingPaintReadyRef.current !== null) window.cancelAnimationFrame(pendingPaintReadyRef.current);
    pendingPaintReadyRef.current = null;
    lastPaintReadyRef.current = null;
    if (currentRuntimeRef.current) revisionInvalidatedRef.current?.();
    presentationRef.current?.invalidate();
    mainGraphPaintedSeedRef.current = null;
    if (mainGraphApplyRef.current) { mainGraphApplyRef.current.reject(Error('workspace-graph-main-presentation-invalidated')); mainGraphApplyRef.current = null; }
  }, []);
  const nodesRef = useRef<GraphNode[]>([]);
  const initialPositionsRef = useRef(new Map((savedView.spatialVersion === 3 ? initialPositions || [] : []).map((node) => [node.key, node])));
  const edgesRef = useRef<GraphEdge[]>([]);
  const sceneCacheRef = useRef<GraphSceneCache>(EMPTY_SCENE);
  const viewportRef = useRef<GraphViewport>(EMPTY_VIEWPORT);
  const canvasContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const graphThemeAccentRef = useRef(GRAPH_THEME_ACCENT_FALLBACK);
  const graphPaletteRef = useRef({background: GRAPH_NODE_BACKGROUND, text: '#d6d9de', node: '#c3c6cc', edge: GRAPH_EDGE_BASE_STROKE, dimmed: GRAPH_EDGE_DIMMED_STROKE});
  const labelMeasurementsRef = useRef(new Map<string, number>());
  const labelMemoryRef = useRef(new Map<number, GraphLabelState>());
  const labelsAnimatingRef = useRef(false);
  const colorGroupsRef = useRef(normalizeGraphColorGroups(savedView.colorGroups));
  const sectionsRef = useRef(normalizeGraphSections(savedView.sections));
  const nodeTagsRef = useRef(new Map<number, string[]>());
  const paramsRef = useRef<GraphParams>({
    ...INITIAL_PARAMS,
    scale: initialCamera?.scale ?? clampGraphNumber(savedView.scale, INITIAL_PARAMS.scale, GRAPH_MIN_SCALE, GRAPH_MAX_SCALE),
    panX: initialCamera?.panX ?? clampGraphNumber(savedView.panX, INITIAL_PARAMS.panX, -1000000, 1000000),
    panY: initialCamera?.panY ?? clampGraphNumber(savedView.panY, INITIAL_PARAMS.panY, -1000000, 1000000),
    showLabels: savedView.showLabels ?? INITIAL_PARAMS.showLabels,
    colorMode: savedView.colorMode || INITIAL_PARAMS.colorMode,
    showArrows: savedView.showArrows ?? INITIAL_PARAMS.showArrows,
    labelReveal: readSavedLabelReveal(savedView),
    nodeSizeMultiplier: clampGraphNumber(savedView.nodeSize, 6, 3, 12) / 6,
    edgeWidthBase: clampGraphNumber(savedView.edgeWidth, INITIAL_PARAMS.edgeWidthBase, 0.5, 4),
    centerForce: readSavedForceControl(savedView, "centerForce"),
    repulsionForce: readSavedForceControl(savedView, "repulsionForce"),
    linkAttraction: readSavedForceControl(savedView, "linkAttraction"),
    linkLength: clampGraphNumber(savedView.linkLength, GRAPH_REST_LENGTH, GRAPH_LINK_LENGTH_MIN, GRAPH_LINK_LENGTH_MAX),
    nodeSpacing: clampGraphNumber(savedView.nodeSpacing, INITIAL_PARAMS.nodeSpacing, GRAPH_FORCE_CONTROL_MIN, GRAPH_FORCE_CONTROL_MAX),
    showIsolated: savedView.showIsolated ?? INITIAL_PARAMS.showIsolated,
    nearbyFilter: savedView.nearbyFilter ?? INITIAL_PARAMS.nearbyFilter,
    nearbyDepth: savedView.nearbyDepth === 2 ? 2 : 1,
  });
  const cameraTargetRef = useRef<GraphCamera>({
    scale: paramsRef.current.scale,
    panX: paramsRef.current.panX,
    panY: paramsRef.current.panY,
  });
  const cameraVelocityRef = useRef<GraphCameraVelocity>({ panX: 0, panY: 0 });
  const cameraZoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const needsInitialFitRef = useRef(savedView.spatialVersion !== 3);
  const settledFitRef = useRef(savedView.spatialVersion !== 3);
  const lastCameraFrameAtRef = useRef(0);
  const cameraNeedsPersistRef = useRef(false);
  const filtersRef = useRef<Record<GraphType, boolean>>(initialFilters);
  const searchScopeNodeKeysRef = useRef<Set<string> | null>(initialSnapshot?.searchScope ? new Set(initialSnapshot.searchScope.nodeKeys) : null);
  const pendingSelectionRef = useRef(initialSnapshot?.focusedKey || null);
  const pendingRelationRef = useRef(initialSnapshot?.relationSourceKey || null);
  const revealTimelineRef = useRef<GraphPlaybackPlan | null>(null);
  const revealActiveRef = useRef(false);
  const revealActivatedNodeIdsRef = useRef<Set<number>>(new Set());
  const playbackCameraFollowRef = useRef(false);
  const playbackClockRef = useRef(createGraphPlaybackClock());
  const playbackActivationRef = useRef<{ timeline: GraphPlaybackPlan; ids: Map<number, number>; order: Map<number, number> } | null>(null);
  const pendingPlaybackSnapshotRef = useRef(initialSnapshot?.playback);
  const hoveredRef = useRef<GraphNode | null>(null);
  const focusedNodeRef = useRef<GraphNode | null>(null);
  const lastPublishedHoverKeyRef = useRef<string | null>(null);
  const draggingNodeRef = useRef<GraphNode | null>(null);
  const mouseDownNodeRef = useRef<GraphNode | null>(null);
  const mouseDownPointRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);
  const panningRef = useRef<PanGesture | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<PendingPointer | null>(null);
  const hoverPointerRef = useRef<PendingPointer | null>(null);
  const pendingWheelRef = useRef<PendingWheel | null>(null);
  const engineFrameRef = useRef<number>(0);
  const engineTimerRef = useRef<number | null>(null);
  const graphLoadSequenceRef = useRef(0);
  const missingDocumentCreationRef = useRef(new Set<string>());
  const graphSeedRefreshTimerRef = useRef<number | null>(null);
  const graphMaterialVersionRef = useRef(runtime ? 0 : materialStore.getSnapshot().lastChange?.version || 0);
  const runGraphFrameRef = useRef<((timestamp: number) => void) | null>(null);
  const dirtyRef = useRef<Record<GraphDirtyReason, boolean>>({ scene: true, viewport: true, hover: true, layout: true });
  const lastSimulationAtRef = useRef(0);
  const dragRelaxationRef = useRef(false);
  const physicsWorkerRef = useRef<Worker | null>(null);
  const physicsWorkerUnavailableRef = useRef(false);
  const physicsRequestSequenceRef = useRef(0);
  const physicsGenerationRef = useRef(0);
  const physicsMutationRevisionRef = useRef(0);
  const physicsWorkTimeEwmaRef = useRef(0);
  const physicsTopologyRef = useRef<GraphPhysicsTopologyCache>({
    revision: 0,
    nodeIds: [],
    radii: [],
    edgePairs: [],
  });
  const physicsWorkerTopologyRevisionRef = useRef(-1);
  const physicsStateBufferRef = useRef<Float64Array | null>(null);
  const activePaneRef = useRef(active);
  const physicsInFlightRef = useRef<{
    requestId: number;
    generation: number;
    mutationRevision: number;
    topologyRevision: number;
  } | null>(null);
  const viewPersistTimerRef = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const tooltipPositionRef = useRef({ x: 0, y: 0 });
  const tooltipKeyRef = useRef<string | null>(null);
  const canvasCursorRef = useRef("default");
  const [sideOpen, setSideOpen] = useState(initialSnapshot?.sideOpen ?? false);
  const [colorGroups, setColorGroups] = useState(colorGroupsRef.current);
  const [moreOpen, setMoreOpen] = useState(false);
  const [nodeQuery, setNodeQuery] = useState(initialSnapshot?.searchQuery || "");
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const [graphSearchScope, setGraphSearchScope] = useState<GraphSearchScope | null>(initialSnapshot?.searchScope || null);
  const [playing, setPlaying] = useState(false);
  const [filters, setFilters] = useState<Record<GraphType, boolean>>(initialFilters);
  const [showIsolated, setShowIsolated] = useState(savedView.showIsolated ?? true);
  const [nearbyFilter, setNearbyFilter] = useState(savedView.nearbyFilter ?? false);
  const [nearbyDepth, setNearbyDepth] = useState<1 | 2>(savedView.nearbyDepth === 2 ? 2 : 1);
  const [colorMode, setColorModeState] = useState<GraphParams["colorMode"]>(savedView.colorMode || "type");
  const [showArrows, setShowArrows] = useState(savedView.showArrows ?? false);
  const [showLabels, setShowLabels] = useState(savedView.showLabels ?? true);
  const [labelReveal, setLabelReveal] = useState(readSavedLabelReveal(savedView));
  const [nodeSize, setNodeSize] = useState(clampGraphNumber(savedView.nodeSize, 6, 3, 12));
  const [edgeWidth, setEdgeWidth] = useState(clampGraphNumber(savedView.edgeWidth, 1, 0.5, 4));
  const [centerForce, setCenterForce] = useState(readSavedForceControl(savedView, "centerForce"));
  const [repulsionForce, setRepulsionForce] = useState(readSavedForceControl(savedView, "repulsionForce"));
  const [linkAttraction, setLinkAttraction] = useState(readSavedForceControl(savedView, "linkAttraction"));
  const [linkLength, setLinkLength] = useState(clampGraphNumber(savedView.linkLength, GRAPH_REST_LENGTH, GRAPH_LINK_LENGTH_MIN, GRAPH_LINK_LENGTH_MAX));
  const [nodeSpacing, setNodeSpacing] = useState(clampGraphNumber(savedView.nodeSpacing, INITIAL_PARAMS.nodeSpacing, GRAPH_FORCE_CONTROL_MIN, GRAPH_FORCE_CONTROL_MAX));
  const [tooltip, setTooltip] = useState<{ key: string; title: string; meta: string } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; node: GraphNode } | null>(null);
  const [nodeMenuPosition, setNodeMenuPosition] = useState({ left: 0, top: 0 });
  const [relationSource, setRelationSource] = useState<GraphNode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [graphStatus, setGraphStatus] = useState<"loading" | "real" | "empty" | "error">("loading");

  activePaneRef.current = active;

  const normalizedNodeQuery = nodeQuery.trim().toLocaleLowerCase();
  const nodeSearchResults = buildGraphSearchResults(nodesRef.current, normalizedNodeQuery, t);

  const updateParam = useCallback(<K extends keyof GraphParams>(key: K, value: GraphParams[K]) => {
    paramsRef.current[key] = value;
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? null : current), 1600);
  }, []);

  const currentGraphView = useCallback((): GraphViewState => {
    const params = paramsRef.current;
    return {
      spatialVersion: settledFitRef.current ? savedViewRef.current.spatialVersion : 3,
      filters: filtersRef.current,
      colorGroups: colorGroupsRef.current,
      sections: sectionsRef.current,
      showIsolated: params.showIsolated,
      nearbyFilter: params.nearbyFilter,
      nearbyDepth: params.nearbyDepth,
      colorMode: params.colorMode,
      showArrows: params.showArrows,
      showLabels: params.showLabels,
      labelReveal: Number(params.labelReveal.toFixed(2)),
      nodeSize: Number((params.nodeSizeMultiplier * 6).toFixed(2)),
      edgeWidth: params.edgeWidthBase,
      centerForce: Number(params.centerForce.toFixed(1)),
      repulsionForce: Number(params.repulsionForce.toFixed(1)),
      linkAttraction: Number(params.linkAttraction.toFixed(1)),
      linkLength: Number(params.linkLength.toFixed(1)),
      nodeSpacing: Number(params.nodeSpacing.toFixed(1)),
      scale: Number(params.scale.toFixed(4)),
      panX: Number(params.panX.toFixed(2)),
      panY: Number(params.panY.toFixed(2)),
    };
  }, []);

  const persistGraphView = useCallback(() => {
    // Changing one retained view into two changes persistence policy, not the
    // canvas/animation lifetime. Keep the engine effect's callbacks stable.
    if (!persistViewRef.current || currentRuntimeRef.current) return;
    writeGraphViewState(currentGraphView());
  }, [currentGraphView]);

  const saveGraphView = useCallback((delay = VIEW_PERSIST_DELAY_MS) => {
    if (viewPersistTimerRef.current !== null) window.clearTimeout(viewPersistTimerRef.current);
    viewPersistTimerRef.current = window.setTimeout(() => {
      viewPersistTimerRef.current = null;
      persistGraphView();
    }, delay);
  }, [persistGraphView]);

  const flushGraphView = useCallback(() => {
    if (viewPersistTimerRef.current !== null) {
      window.clearTimeout(viewPersistTimerRef.current);
      viewPersistTimerRef.current = null;
    }
    persistGraphView();
  }, [persistGraphView]);

  const cancelCameraInertia = useCallback(() => {
    cameraVelocityRef.current.panX = 0;
    cameraVelocityRef.current.panY = 0;
  }, []);

  const takeCameraControl = useCallback(() => {
    needsInitialFitRef.current = false;
    const params = paramsRef.current;
    playbackCameraFollowRef.current = false;
    cameraTargetRef.current = {
      scale: params.scale,
      panX: params.panX,
      panY: params.panY,
    };
    cameraZoomAnchorRef.current = null;
    lastCameraFrameAtRef.current = 0;
    cancelCameraInertia();
  }, [cancelCameraInertia]);

  const setCameraImmediately = useCallback((camera: GraphCamera) => {
    const next = {
      scale: clampGraphNumber(camera.scale, paramsRef.current.scale, GRAPH_MIN_SCALE, GRAPH_MAX_SCALE),
      panX: camera.panX,
      panY: camera.panY,
    };
    paramsRef.current.scale = next.scale;
    paramsRef.current.panX = next.panX;
    paramsRef.current.panY = next.panY;
    cameraTargetRef.current = next;
    cameraZoomAnchorRef.current = null;
    lastCameraFrameAtRef.current = 0;
    cameraNeedsPersistRef.current = true;
    cancelCameraInertia();
    dirtyRef.current.viewport = true;
  }, [cancelCameraInertia]);

  const requestGraphFrame = useCallback((...reasons: GraphDirtyReason[]) => {
    for (const reason of reasons) dirtyRef.current[reason] = true;
    if(!workspaceVisibleRef.current)return;
    if (engineTimerRef.current !== null) {
      window.clearTimeout(engineTimerRef.current);
      engineTimerRef.current = null;
    }
    if (engineFrameRef.current !== 0) return;
    engineFrameRef.current = window.requestAnimationFrame((timestamp) => {
      engineFrameRef.current = 0;
      runGraphFrameRef.current?.(timestamp);
    });
  }, []);

  const markGraphDirty = useCallback((...reasons: GraphDirtyReason[]) => {
    requestGraphFrame(...reasons);
  }, [requestGraphFrame]);

  const applyGraphPhysicsOutput = useCallback((output: GraphPhysicsOutput) => {
    const outputById = new Map(output.nodes.map((node) => [node.id, node]));
    for (const node of sceneCacheRef.current.visibleNodes) {
      const next = outputById.get(node.id);
      if (!next || node.id === draggingNodeRef.current?.id) continue;
      node.x = next.x;
      node.y = next.y;
      node.vx = next.vx;
      node.vy = next.vy;
    }
    paramsRef.current.alpha = draggingNodeRef.current ? Math.max(0.3, output.alpha) : output.alpha;
    lastSimulationAtRef.current = performance.now();
  }, []);

  const applyPackedGraphPhysicsOutput = useCallback((
    state: Float64Array,
    topologyRevision: number,
    alpha: number,
  ) => {
    const topology = physicsTopologyRef.current;
    if (
      topology.revision !== topologyRevision
      || state.length !== topology.nodeIds.length * GRAPH_PHYSICS_STATE_STRIDE
    ) {
      return false;
    }
    const visibleNodes = sceneCacheRef.current.visibleNodes;
    let nodesById: Map<number, GraphNode> | null = null;
    for (let index = 0; index < topology.nodeIds.length; index++) {
      const id = topology.nodeIds[index];
      let node = visibleNodes[index];
      if (!node || node.id !== id) {
        nodesById ||= new Map(visibleNodes.map((candidate) => [candidate.id, candidate]));
        node = nodesById.get(id) as GraphNode;
      }
      if (!node || node.id === draggingNodeRef.current?.id) continue;
      const offset = index * GRAPH_PHYSICS_STATE_STRIDE;
      node.x = state[offset];
      node.y = state[offset + 1];
      node.vx = state[offset + 2];
      node.vy = state[offset + 3];
    }
    paramsRef.current.alpha = draggingNodeRef.current ? Math.max(0.3, alpha) : alpha;
    lastSimulationAtRef.current = performance.now();
    physicsStateBufferRef.current = state;
    return true;
  }, []);

  const recordGraphPhysicsWorkTime = useCallback((workTime: number) => {
    const sample = Number.isFinite(workTime) ? Math.max(0, workTime) : 0;
    const previous = physicsWorkTimeEwmaRef.current;
    physicsWorkTimeEwmaRef.current = previous > 0
      ? previous + (sample - previous) * SIMULATION_WORK_TIME_EWMA_WEIGHT
      : sample;
  }, []);

  useEffect(() => {
    if (runtime && !runtime.allowWorker) {
      physicsWorkerRef.current = null;
      physicsWorkerUnavailableRef.current = true;
      physicsWorkerTopologyRevisionRef.current = -1;
      physicsInFlightRef.current = null;
      return;
    }
    let worker: Worker | null = null;
    physicsWorkerUnavailableRef.current = false;
    physicsWorkerTopologyRevisionRef.current = -1;
    try {
      worker = new Worker(new URL("./graphPhysics.worker.ts", import.meta.url), { type: "module" });
      physicsWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<GraphPhysicsStepResponse>) => {
        const response = event.data;
        const pending = physicsInFlightRef.current;
        if (response.type !== "step-result" || !pending || response.requestId !== pending.requestId) return;
        physicsInFlightRef.current = null;
        if (
          response.generation !== physicsGenerationRef.current
          || response.mutationRevision !== physicsMutationRevisionRef.current
          || response.topologyRevision !== pending.topologyRevision
          || response.topologyRevision !== physicsTopologyRef.current.revision
        ) {
          requestGraphFrame("layout");
          return;
        }
        recordGraphPhysicsWorkTime(response.workTime);
        if (!applyPackedGraphPhysicsOutput(response.state, response.topologyRevision, response.alpha)) {
          requestGraphFrame("scene", "layout");
          return;
        }
        dirtyRef.current.layout = true;
        requestGraphFrame("layout");
      };
      worker.onerror = () => {
        if (physicsWorkerRef.current !== worker) return;
        physicsWorkerRef.current = null;
        physicsWorkerUnavailableRef.current = true;
        physicsWorkerTopologyRevisionRef.current = -1;
        physicsInFlightRef.current = null;
        worker?.terminate();
        requestGraphFrame("layout");
      };
    } catch {
      physicsWorkerUnavailableRef.current = true;
      physicsWorkerRef.current = null;
      physicsWorkerTopologyRevisionRef.current = -1;
    }
    return () => {
      physicsGenerationRef.current += 1;
      physicsInFlightRef.current = null;
      physicsWorkTimeEwmaRef.current = 0;
      physicsWorkerTopologyRevisionRef.current = -1;
      physicsStateBufferRef.current = null;
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      }
      if (physicsWorkerRef.current === worker) physicsWorkerRef.current = null;
    };
  }, [applyPackedGraphPhysicsOutput, recordGraphPhysicsWorkTime, requestGraphFrame, runtime]);

  useEffect(() => {
    const updateThemeAccent = () => {
      const style = getComputedStyle(document.documentElement);
      const accent = style.getPropertyValue("--accent").trim();
      // Resolve CSS colors once per theme change, never inside the frame loop.
      const color = (name: string, fallback: string) => {
        const context = document.createElement('canvas').getContext('2d');
        if (!context) return fallback;
        context.fillStyle = fallback;
        context.fillStyle = style.getPropertyValue(name).trim() || fallback;
        return context.fillStyle;
      };
      graphPaletteRef.current = {
        background: color('--bg-base', GRAPH_NODE_BACKGROUND),
        text: color('--text-primary', '#d6d9de'),
        node: color('--text-primary', '#c3c6cc'),
        edge: color('--text-tertiary', GRAPH_EDGE_BASE_STROKE),
        dimmed: color('--border', GRAPH_EDGE_DIMMED_STROKE),
      };
      graphThemeAccentRef.current = accent || GRAPH_THEME_ACCENT_FALLBACK;
      markGraphDirty("scene");
    };
    updateThemeAccent();
    const observer = new MutationObserver(updateThemeAccent);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => observer.disconnect();
  }, [markGraphDirty]);

  const reheatGraphLayout = useCallback((alpha = 0.36, dampVelocity = false) => {
    physicsMutationRevisionRef.current += 1;
    if (dampVelocity) {
      for (const node of nodesRef.current) {
        node.vx *= 0.32;
        node.vy *= 0.32;
      }
    }
    paramsRef.current.alpha = Math.max(paramsRef.current.alpha, alpha);
    saveGraphView();
    markGraphDirty("layout");
  }, [markGraphDirty, saveGraphView]);

  const cancelGraphReveal = useCallback(() => {
    revealTimelineRef.current = null;
    revealActivatedNodeIdsRef.current.clear();
    playbackCameraFollowRef.current = false;
    if (!revealActiveRef.current) return;
    revealActiveRef.current = false;
    setPlaying(false);
  }, []);

  const installPlaybackSession = useCallback((snapshot: GraphPlaybackSnapshot, restored: ReturnType<typeof restoreGraphPlayback>) => {
    revealTimelineRef.current = restored.timeline;
    revealActiveRef.current = true;
    revealActivatedNodeIdsRef.current = restored.activatedIds;
    playbackActivationRef.current = { timeline: restored.timeline, ids: restored.activationIds, order: restored.activationOrder };
    playbackClockRef.current.restored(restored.timeline, snapshot.elapsedMs, performance.now());
    playbackCameraFollowRef.current = snapshot.cameraFollow;
    cameraTargetRef.current = { ...snapshot.cameraTarget };
    cameraVelocityRef.current = { ...snapshot.cameraVelocity };
    cameraZoomAnchorRef.current = snapshot.cameraZoomAnchor ? { ...snapshot.cameraZoomAnchor } : null;
    paramsRef.current.alpha = snapshot.alpha;
    lastSimulationAtRef.current = 0;
    lastCameraFrameAtRef.current = 0;
    setPlaying(true);
  }, []);

  const setGraphPresentationFrozen = useCallback((frozen: boolean) => {
    const now = performance.now();
    playbackClockRef.current.hold('presentation', frozen, now, revealTimelineRef.current);
    presentationFrozenRef.current = frozen;
    setPresentationFrozen(frozen);
    physicsGenerationRef.current += 1;
    physicsInFlightRef.current = null;
    pendingPointerRef.current = null; pendingWheelRef.current = null;
    hoveredRef.current = null; hoverPointerRef.current = null;
    panningRef.current = null; draggingNodeRef.current = null;
    mouseDownNodeRef.current = null; mouseDownPointRef.current = null;
    activePointerIdRef.current = null;
    // Keep the current plan, activated set, camera target and velocities. A
    // failed transfer resumes this same state with no elapsed-time catch-up.
    lastCameraFrameAtRef.current = 0;
    lastSimulationAtRef.current = now;
    if (!frozen) requestGraphFrame('scene', 'layout', 'viewport');
  }, [requestGraphFrame]);

  const advanceGraphReveal = useCallback((timestamp: number) => {
    const timeline = revealTimelineRef.current;
    if (!timeline || !revealActiveRef.current) return false;
    if (timestamp - timeline.startedAt < timeline.totalDuration) return true;
    revealTimelineRef.current = null;
    revealActiveRef.current = false;
    revealActivatedNodeIdsRef.current.clear();
    playbackCameraFollowRef.current = false;
    setPlaying(false);
    return true;
  }, []);

  const activateGraphRevealNodes = useCallback((timestamp: number) => {
    const timeline = revealTimelineRef.current;
    if (!timeline || !revealActiveRef.current) return null;
    const elapsed = Math.max(0, timestamp - timeline.startedAt);
    const activeNodeIds = revealActivatedNodeIdsRef.current;
    let activated = false;

    for (const node of graphPlaybackActivationNodes(sceneCacheRef.current.visibleNodes,
      playbackActivationRef.current?.timeline === timeline ? playbackActivationRef.current.order : undefined)) {
      if (node.hidden || activeNodeIds.has(node.id)) continue;
      const plan = timeline.nodes.get(node.id);
      if (!plan || elapsed < plan.startAt) continue;

      let spawnX = plan.spawnX;
      let spawnY = plan.spawnY;
      if (plan.parentId !== null) {
        const parent = nodesRef.current.find((candidate) => candidate.id === plan.parentId);
        if (parent && activeNodeIds.has(parent.id)) {
          const activationId = playbackActivationRef.current?.timeline === timeline ? playbackActivationRef.current.ids.get(node.id) ?? node.id : node.id;
          const angle = (activationId * 2.399963229728653) % (Math.PI * 2);
          const separation = Math.min(4.2, 1.8 + node.links * 0.12);
          spawnX = parent.x + Math.cos(angle) * separation;
          spawnY = parent.y + Math.sin(angle) * separation;
        }
      }

      plan.spawnX = spawnX;
      plan.spawnY = spawnY;
      node.x = spawnX;
      node.y = spawnY;
      const targetX = plan.targetX - spawnX;
      const targetY = plan.targetY - spawnY;
      const targetDistance = Math.max(1, Math.hypot(targetX, targetY));
      node.vx = (targetX / targetDistance) * 1.45;
      node.vy = (targetY / targetDistance) * 1.45;
      activeNodeIds.add(node.id);
      activated = true;
    }

    if (activated) {
      physicsMutationRevisionRef.current += 1;
      paramsRef.current.alpha = Math.max(paramsRef.current.alpha, 0.68);
    }
    return activeNodeIds;
  }, []);

  const measureViewport = useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;
    const rect = container.getBoundingClientRect();
    const next: GraphViewport = {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      dpr: window.devicePixelRatio || 1,
    };
    const current = viewportRef.current;
    const changed = current.width !== next.width
      || current.height !== next.height
      || current.left !== next.left
      || current.top !== next.top
      || current.dpr !== next.dpr;
    if (changed) { invalidatePaintReadiness(); viewportRef.current = next; }
    return changed;
  }, [invalidatePaintReadiness]);

  useLayoutEffect(() => {
    // Moving a retained canvas between equally sized groups changes its origin
    // without firing ResizeObserver. Refresh pointer coordinates explicitly.
    invalidatePaintReadiness();
    if (visible) { measureViewport(); markGraphDirty('viewport'); }
    return invalidatePaintReadiness;
  }, [layoutRevision, visible, runtime, invalidatePaintReadiness, measureViewport, markGraphDirty]);

  const resetNodes = useCallback((options?: { preserveLayout?: boolean }) => {
    cancelGraphReveal();
    dragRelaxationRef.current = false;
    if (!viewportRef.current.width || !viewportRef.current.height) measureViewport();
    const { width, height } = viewportRef.current;
    if (!width || !height) { sceneSeedRef.current = null; invalidatePaintReadiness(); return; }
    physicsGenerationRef.current += 1;
    physicsMutationRevisionRef.current += 1;
    const preserveLayout = options?.preserveLayout === true;
    const seed = graphSeedRef.current;
    const seedNodes = seed.nodes;
    const seedEdges = seed.edges;
    if (!seedNodes.length) {
      nodesRef.current = [];
      edgesRef.current = [];
      sceneCacheRef.current = EMPTY_SCENE;
      sceneSeedRef.current = seed;
      focusedNodeRef.current = null;
      paramsRef.current.alpha = 1;
      markGraphDirty("scene", "layout");
      return;
    }
    const focusedKey = focusedNodeRef.current?.key || pendingSelectionRef.current || null;
    const draggingKey = draggingNodeRef.current?.key || null;
    const existingNodesByKey = preserveLayout
      ? new Map(nodesRef.current.map((node) => [node.key, node]))
      : new Map<string, GraphNode>();
    const layoutUnchanged = preserveLayout && edgesRef.current === seedEdges
      && nodesRef.current.length === seedNodes.length
      && seedNodes.every(node => existingNodesByKey.get(node.key)?.id === node.id);
    const degreeById = new Map<number, number>();
    for (const [a, b] of seedEdges) {
      degreeById.set(a, (degreeById.get(a) || 0) + 1);
      degreeById.set(b, (degreeById.get(b) || 0) + 1);
    }
    const seedPositions = graphSeedPositions(seedNodes, seedEdges, width, height);
    nodesRef.current = seedNodes.map((node) => {
      const existing = existingNodesByKey.get(node.key);
      const position = seedPositions.get(node.id)!;
      const links = degreeById.get(node.id) || 0;
      return {
        ...node,
        x: existing?.x ?? initialPositionsRef.current.get(node.key)?.x ?? position.x,
        y: existing?.y ?? initialPositionsRef.current.get(node.key)?.y ?? position.y,
        vx: existing?.vx ?? initialPositionsRef.current.get(node.key)?.vx ?? 0,
        vy: existing?.vy ?? initialPositionsRef.current.get(node.key)?.vy ?? 0,
        r: isMissingGraphNode(node) ? GRAPH_NODE_BASE_RADIUS : graphNodeRadiusForLinks(links),
        color: TYPE_COLORS[node.type],
        links,
        hidden: false,
        dimmed: false,
        labelShort: truncateGraphLabel(node.label, node.type === "note" ? 24 : 20),
      };
    });
    edgesRef.current = seedEdges;
    sceneSeedRef.current = seed;
    if (needsInitialFitRef.current) {
      const visible = nodesRef.current.filter(node => filtersRef.current[node.type] && (paramsRef.current.showIsolated || node.links > 0));
      const camera = fitGraphCamera(visible, width, height);
      if (camera) { setCameraImmediately(camera); needsInitialFitRef.current = false; }
    }
    focusedNodeRef.current = focusedKey ? nodesRef.current.find((node) => node.key === focusedKey) || null : null;
    if (focusedNodeRef.current) pendingSelectionRef.current = null;
    if (pendingRelationRef.current) {
      const restoredRelation = nodesRef.current.find(node => node.key === pendingRelationRef.current);
      if (restoredRelation) { setRelationSource(restoredRelation); pendingRelationRef.current = null; }
    }
    draggingNodeRef.current = draggingKey ? nodesRef.current.find((node) => node.key === draggingKey) || null : null;
    if (!layoutUnchanged) paramsRef.current.alpha = preserveLayout ? Math.max(paramsRef.current.alpha, 0.22) : 1;
    if (pendingPlaybackSnapshotRef.current) {
      const playback = pendingPlaybackSnapshotRef.current;
      const restored = restoreGraphPlayback(playback, seed, playbackClockRef.current.time(performance.now()));
      pendingPlaybackSnapshotRef.current = undefined;
      installPlaybackSession(playback, restored);
    }
    markGraphDirty("scene", "layout");
  }, [cancelGraphReveal, installPlaybackSession, invalidatePaintReadiness, markGraphDirty, measureViewport, setCameraImmediately]);

  const findContextNode = useCallback(() => {
    if (runtime) {
      const key = runtime.contextNodeKey();
      return nodesRef.current.find(node => node.key === key) || null;
    }
    const context = readActiveContext();
    const candidates = [
      context.asset?.id ? `material:${context.asset.id}` : "",
      context.note?.id ? `note:${context.note.id}` : "",
      context.tag?.id ? `tag:${context.tag.id}` : "",
      context.graph?.nodeId && context.graph.nodeType ? `${context.graph.nodeType}:${context.graph.nodeId}` : "",
    ].filter(Boolean);
    return nodesRef.current.find((node) => candidates.includes(`${node.type}:${node.entityId || node.id}`)) || null;
  }, [runtime]);

  const getNodeColor = useCallback((node: GraphNode) => {
    if (isMissingGraphNode(node)) return "#59606a";
    const group = colorGroupsRef.current.find(group => graphGroupMatches(group.query, node.label,
      realVaultDocumentPath(node) || safeRealVaultAssetRelativePath(node.entityId) || '', nodeTagsRef.current.get(node.id) || []));
    if (group) return group.color;
    const mode = paramsRef.current.colorMode;
    if (mode === "default") return graphPaletteRef.current.node;
    if (mode === "degree") return DEGREE_COLORS[Math.min(node.links, DEGREE_COLORS.length - 1)];
    return node.type === "note" ? graphPaletteRef.current.node : graphThemeNodeTone(node.type, graphThemeAccentRef.current);
  }, []);

  const rebuildSceneCache = useCallback(() => {
    const scopedNodeKeys = searchScopeNodeKeysRef.current;
    const visibleNodes = nodesRef.current.filter((node) => (
      filtersRef.current[node.type]
      && (!scopedNodeKeys || scopedNodeKeys.has(node.key))
    ));
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const nodesById = new Map(nodesRef.current.map((node) => [node.id, node]));
    const tags = new Map<number, string[]>();
    for (const [a, b] of edgesRef.current) {
      const left = nodesById.get(a), right = nodesById.get(b);
      if (left?.type === 'tag' && right) tags.set(b, [...(tags.get(b) || []), left.label]);
      if (right?.type === 'tag' && left) tags.set(a, [...(tags.get(a) || []), right.label]);
    }
    nodeTagsRef.current = tags;
    const edgeKinds = graphSeedRef.current.edgeKinds || {};
    const edgeDirections = graphSeedRef.current.edgeDirections || {};
    const visibleEdges: GraphRenderEdge[] = [];
    const adjacency = new Map<number, Set<number>>();
    for (const [aId, bId] of edgesRef.current) {
      if (!visibleIds.has(aId) || !visibleIds.has(bId)) continue;
      const a = nodesById.get(aId);
      const b = nodesById.get(bId);
      if (!a || !b) continue;
      visibleEdges.push({
        a,
        b,
        kind: edgeKinds[graphEdgeKey(aId, bId)] || "relation",
        direction: edgeDirections[graphEdgeKey(aId, bId)] || "undirected",
        relatedToFocus: false,
        dimmed: false,
      });
      let from = adjacency.get(aId);
      if (!from) adjacency.set(aId, from = new Set());
      from.add(bId);
      let to = adjacency.get(bId);
      if (!to) adjacency.set(bId, to = new Set());
      to.add(aId);
    }

    const hovered = hoveredRef.current;
    const selected = focusedNodeRef.current;
    const nearbyFocus = paramsRef.current.nearbyFilter
      ? (presentationFrozenRef.current ? selected : (hovered || selected || findContextNode()))
      : null;
    if (nearbyFocus) focusedNodeRef.current = nearbyFocus;
    const focusForEdges = draggingNodeRef.current || hovered || nearbyFocus || selected;
    const connectedIds = new Set<number>();
    if (focusForEdges) {
      connectedIds.add(focusForEdges.id);
      for (const id of adjacency.get(focusForEdges.id) || []) connectedIds.add(id);
    }
    const nearbyIds = nearbyFocus
      ? collectGraphNeighborhood(adjacency, nearbyFocus.id, paramsRef.current.nearbyDepth)
      : connectedIds;

    for (const node of nodesRef.current) {
      const isIsolated = (adjacency.get(node.id)?.size || 0) === 0;
      const preserveIsolated = !!scopedNodeKeys || selected?.id === node.id || nearbyFocus?.id === node.id;
      node.hidden = !visibleIds.has(node.id)
        || (!paramsRef.current.showIsolated && isIsolated && !preserveIsolated)
        || (!!nearbyFocus && !nearbyIds.has(node.id));
      node.color = getNodeColor(node);
      node.dimmed = node.hidden || (!!focusForEdges && !connectedIds.has(node.id));
    }
    for (const edge of visibleEdges) {
      edge.relatedToFocus = !!focusForEdges && (edge.a.id === focusForEdges.id || edge.b.id === focusForEdges.id);
      edge.dimmed = edge.a.hidden || edge.b.hidden || (!!focusForEdges && !edge.relatedToFocus);
    }

    physicsTopologyRef.current = updateGraphPhysicsTopology(
      physicsTopologyRef.current,
      visibleNodes,
      visibleEdges,
    );

    sceneCacheRef.current = {
      visibleNodes,
      visibleEdges,
      adjacency,
      connectedIds,
      nearbyFocusId: nearbyFocus?.id ?? null,
      hoverId: hovered?.id ?? null,
      activeFocusId: focusForEdges?.id ?? null,
    };
  }, [findContextNode, getNodeColor]);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const params = paramsRef.current;
    return {
      x: (sx - params.panX) / params.scale,
      y: (sy - params.panY) / params.scale,
    };
  }, []);

  const findNodeAt = useCallback((x: number, y: number) => {
    const nodes = sceneCacheRef.current.visibleNodes;
    const timeline = revealTimelineRef.current;
    const elapsed = timeline ? playbackClockRef.current.elapsed(timeline, performance.now()) : 0;
    let nearest: GraphNode | null = null, nearestDistance = Infinity;
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index];
      if (node.hidden) continue;
      const plan = timeline?.nodes.get(node.id);
      const visual = plan ? graphPlaybackNodeVisual(plan, elapsed, node) : null;
      if (plan && !visual) continue;
      const scale = paramsRef.current.scale;
      const radius = graphScreenRadius(node.r * paramsRef.current.nodeSizeMultiplier, scale) * (visual?.scale ?? 1) / scale;
      const dx = x - (visual?.x ?? node.x);
      const dy = y - (visual?.y ?? node.y);
      const distance = dx * dx + dy * dy;
      if (distance < (radius + 4 / scale) ** 2 && distance < nearestDistance) { nearest = node; nearestDistance = distance; }
    }
    return nearest;
  }, []);

  const drawArrow = useCallback((
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    targetRadius: number,
    viewportScale: number,
  ) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 1) return;
    const nx = dx / distance;
    const ny = dy / distance;
    const zoom = Math.max(0.1, viewportScale);
    // Keep arrows legible across camera zoom without letting them dominate the graph.
    const len = Math.max(3.4, Math.min(12, 5.8 / zoom));
    const gap = Math.max(0.7, Math.min(1.6, 1.2 / zoom));
    if (distance <= targetRadius + gap + len + 2) return;
    const tx = x2 - nx * (targetRadius + gap);
    const ty = y2 - ny * (targetRadius + gap);
    const angle = Math.PI / 6;
    const base = Math.atan2(ny, nx);
    ctx.save();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - len * Math.cos(base - angle), ty - len * Math.sin(base - angle));
    ctx.lineTo(tx - len * Math.cos(base + angle), ty - len * Math.sin(base + angle));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }, []);

  const simulate = useCallback((timestamp: number, activeNodeIds?: ReadonlySet<number> | null): SimulationState => {
    const params = paramsRef.current;
    const scene = sceneCacheRef.current;
    const visibleNodes = scene.visibleNodes;
    const activeNodeCount = activeNodeIds ? activeNodeIds.size : visibleNodes.length;
    if (params.alpha < 0.001 || !activeNodeCount) {
      dragRelaxationRef.current = false;
      return { active: false, stepped: false, delay: 0 };
    }
    const interactionPriority = Boolean(draggingNodeRef.current || revealActiveRef.current);
    // Keep neighbours moving at display cadence through release/settling, with
    // worker replies providing backpressure. Playback, background panes and the
    // synchronous fallback retain their existing budget.
    const smoothDragMotion = dragRelaxationRef.current && activePaneRef.current && !revealActiveRef.current;
    const cadence = graphSimulationCadence(
      activeNodeCount,
      physicsWorkTimeEwmaRef.current,
      activePaneRef.current,
      interactionPriority,
      smoothDragMotion && !!physicsWorkerRef.current && !physicsWorkerUnavailableRef.current,
    );
    const elapsed = timestamp - lastSimulationAtRef.current;
    if (lastSimulationAtRef.current && elapsed < cadence) {
      return { active: true, stepped: false, delay: cadence - elapsed };
    }
    const { width, height } = viewportRef.current;
    if (!width || !height) return { active: false, stepped: false, delay: 0 };
    // The worker response schedules the next graph frame. Avoid polling it from
    // the main thread while a step is still in flight.
    if (physicsInFlightRef.current) return { active: true, stepped: false, delay: Number.POSITIVE_INFINITY };

    const parameters: GraphPhysicsStepParameters = {
      draggedNodeId: draggingNodeRef.current?.id ?? null,
      width,
      height,
      alpha: params.alpha,
      repulsion: GRAPH_REPULSION * graphForceScale(params.repulsionForce, 0.35, 5),
      attraction: GRAPH_LINK_ATTRACTION * graphForceScale(params.linkAttraction, 0.3, 4.6),
      restLength: params.linkLength,
      centerPull: GRAPH_CENTER_PULL * graphForceScale(params.centerForce, 0.28, 4.2),
      collisionGap: graphNodeSpacingGap(params.nodeSpacing),
      damping: 0.6,
      alphaDecay: revealActiveRef.current ? 0.005 : 1 - Math.pow(0.001, 1 / 300),
    };

    const worker = physicsWorkerRef.current;
    if (worker && !physicsWorkerUnavailableRef.current) {
      let topology = physicsTopologyRef.current;
      if (!topology.revision) {
        topology = updateGraphPhysicsTopology(topology, visibleNodes, scene.visibleEdges);
        physicsTopologyRef.current = topology;
      }
      const requestId = ++physicsRequestSequenceRef.current;
      const reusableState = physicsStateBufferRef.current;
      const state = packGraphPhysicsState(visibleNodes, reusableState);
      physicsStateBufferRef.current = null;
      const packedActiveNodeIds = activeNodeIds ? Int32Array.from(activeNodeIds) : null;
      const includeTopology = physicsWorkerTopologyRevisionRef.current !== topology.revision;
      const topologyPayload: GraphPhysicsTopologyPayload | null = includeTopology
        ? {
            revision: topology.revision,
            nodeIds: Int32Array.from(topology.nodeIds),
            radii: Float64Array.from(topology.radii),
            edgePairs: Int32Array.from(topology.edgePairs),
          }
        : null;
      const request: GraphPhysicsStepRequest = {
        type: "step",
        requestId,
        generation: physicsGenerationRef.current,
        mutationRevision: physicsMutationRevisionRef.current,
        topologyRevision: topology.revision,
        topology: topologyPayload,
        state,
        activeNodeIds: packedActiveNodeIds,
        parameters,
      };
      physicsInFlightRef.current = {
        requestId,
        generation: request.generation,
        mutationRevision: request.mutationRevision,
        topologyRevision: topology.revision,
      };
      try {
        const transferables: Transferable[] = [state.buffer];
        if (packedActiveNodeIds) transferables.push(packedActiveNodeIds.buffer);
        if (topologyPayload) {
          transferables.push(
            topologyPayload.nodeIds.buffer,
            topologyPayload.radii.buffer,
            topologyPayload.edgePairs.buffer,
          );
        }
        worker.postMessage(request, transferables);
        if (includeTopology) physicsWorkerTopologyRevisionRef.current = topology.revision;
        return { active: true, stepped: false, delay: Number.POSITIVE_INFINITY };
      } catch {
        if (state.byteLength > 0) physicsStateBufferRef.current = state;
        physicsInFlightRef.current = null;
        physicsWorkerRef.current = null;
        physicsWorkerUnavailableRef.current = true;
        physicsWorkerTopologyRevisionRef.current = -1;
        worker.terminate();
      }
    }

    const input: GraphPhysicsInput = {
      nodes: visibleNodes.map(({ id, x, y, vx, vy, r }) => ({ id, x, y, vx, vy, r })),
      edges: scene.visibleEdges.map(({ a, b }) => ({ sourceId: a.id, targetId: b.id })),
      activeNodeIds: activeNodeIds ? Array.from(activeNodeIds) : null,
      ...parameters,
    };
    const output = stepGraphPhysics(input);
    recordGraphPhysicsWorkTime(output.workTime);
    applyGraphPhysicsOutput(output);
    const nextDelay = graphSimulationCadence(
      activeNodeCount,
      physicsWorkTimeEwmaRef.current,
      activePaneRef.current,
      interactionPriority,
    );
    return { active: paramsRef.current.alpha >= 0.001, stepped: true, delay: nextDelay };
  }, [applyGraphPhysicsOutput, recordGraphPhysicsWorkTime]);

  // This is called only at the end of a successful canvas draw. The following
  // frame permits presentation, then rechecks the live runtime, scene and layout.
  const reportGraphPaint = useCallback(() => {
    if (!currentRuntimeRef.current) {
      const main = mainGraphSourceRef.current, canvas = canvasRef.current, container = containerRef.current;
      if (!main || !canvas || !container || !workspaceVisibleRef.current || !presentationCommitRef.current
        || graphSeedRef.current !== main.seed || sceneSeedRef.current !== main.seed) return;
      const geometry = { ...viewportRef.current }, epoch = paintReadinessEpochRef.current;
      if (!canvas.isConnected || geometry.width <= 0 || geometry.height <= 0) return;
      window.requestAnimationFrame(() => {
        if (mainGraphSourceRef.current !== main || graphSeedRef.current !== main.seed || sceneSeedRef.current !== main.seed
          || epoch !== paintReadinessEpochRef.current || !workspaceVisibleRef.current || canvasRef.current !== canvas || !canvas.isConnected) return;
        const rect = container.getBoundingClientRect();
        if (rect.width !== geometry.width || rect.height !== geometry.height || rect.left !== geometry.left || rect.top !== geometry.top
          || (window.devicePixelRatio || 1) !== geometry.dpr || canvas.width !== Math.round(geometry.width * geometry.dpr) || canvas.height !== Math.round(geometry.height * geometry.dpr)) return;
        mainGraphPaintedSeedRef.current = main.seed;
        const pending = mainGraphApplyRef.current;
        if (!pending || pending.seed !== main.seed || pending.generation !== main.generation) return;
        mainGraphApplyRef.current = null;
        if (!sameGraphSessionSnapshot(sessionHandleRef.current.capture(), pending.state)) pending.reject(Error('workspace-graph-main-presentation-mismatch'));
        else pending.resolve(pending.acknowledgment);
      });
      return;
    }
    const loaded = loadedGraphProofRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!loaded || !canvas || !container || !revisionReadyRef.current || !workspaceVisibleRef.current
      || currentRuntimeRef.current !== loaded.runtime || graphSeedRef.current !== loaded.seed
      || sceneSeedRef.current !== loaded.seed || loaded.requestId !== graphLoadSequenceRef.current
      || !isCurrentGraphDataProof(loaded.runtime, loaded.proof, loaded.seed)) { invalidatePaintReadiness(); return; }
    const geometry = { ...viewportRef.current };
    if (!(geometry.width > 0 && geometry.height > 0) || !canvas.isConnected) { invalidatePaintReadiness(); return; }
    const epoch = paintReadinessEpochRef.current;
    const layout = currentLayoutRevisionRef.current;
    const key = JSON.stringify([epoch, loaded.requestId, layout, geometry]);
    if (pendingPaintReadyRef.current !== null || lastPaintReadyRef.current === key) return;
    pendingPaintReadyRef.current = window.requestAnimationFrame(() => {
      pendingPaintReadyRef.current = null;
      // An older deferred callback must never revoke a newer renderer lease.
      if (epoch !== paintReadinessEpochRef.current || currentLayoutRevisionRef.current !== layout
        || currentRuntimeRef.current !== loaded.runtime || loadedGraphProofRef.current !== loaded
        || loaded.requestId !== graphLoadSequenceRef.current) return;
      if (!workspaceVisibleRef.current || graphSeedRef.current !== loaded.seed || sceneSeedRef.current !== loaded.seed
        || canvasRef.current !== canvas || !canvas.isConnected
        || !isCurrentGraphDataProof(loaded.runtime, loaded.proof, loaded.seed)) { invalidatePaintReadiness(); return; }
      const rect = container.getBoundingClientRect();
      if (rect.width !== geometry.width || rect.height !== geometry.height
        || rect.left !== geometry.left || rect.top !== geometry.top
        || (window.devicePixelRatio || 1) !== geometry.dpr
        || canvas.width !== Math.round(geometry.width * geometry.dpr)
        || canvas.height !== Math.round(geometry.height * geometry.dpr)) { invalidatePaintReadiness(); return; }
      lastPaintReadyRef.current = key;
      if (presentationCommitRef.current) presentationRef.current?.painted(loaded.seed, loaded.proof);
      revisionReadyRef.current?.({ ...loaded.proof });
    });
  }, [invalidatePaintReadiness]);

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) { invalidatePaintReadiness(); return; }
    const ctx = canvasContextRef.current || canvas.getContext("2d");
    if (!ctx) { invalidatePaintReadiness(); return; }
    canvasContextRef.current = ctx;
    const { width, height, dpr } = viewportRef.current;
    if (!width || !height) { invalidatePaintReadiness(); return; }
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    const params = paramsRef.current;
    ctx.translate(params.panX, params.panY);
    ctx.scale(params.scale, params.scale);

    const scene = sceneCacheRef.current;
    const activeFocusId = scene.activeFocusId;
    const focusAccent = graphThemeAccentRef.current;
    const palette = graphPaletteRef.current;
    const labels: GraphLabelCandidate[] = [];
    const labelDetail = graphLabelDetail(params.scale, params.labelReveal);
    const revealTimeline = revealTimelineRef.current;
    const revealElapsed = revealTimeline ? Math.max(0, timestamp - revealTimeline.startedAt) : 0;
    const revealedNodes = new Map<number, {
      x: number;
      y: number;
      radius: number;
      progress: number;
      alpha: number;
    }>();
    const revealedEdgeProgress = new Map<string, number>();
    const revealedDegreeById = new Map<number, number>();

    for (const node of scene.visibleNodes) {
      if (node.hidden) continue;
      const revealPlan = revealTimeline?.nodes.get(node.id);
      const playbackVisual = revealPlan ? graphPlaybackNodeVisual(revealPlan, revealElapsed, node) : null;
      if (revealPlan && !playbackVisual) continue;
      const baseRadius = (revealTimeline ? GRAPH_NODE_BASE_RADIUS : node.r) * params.nodeSizeMultiplier;
      revealedNodes.set(node.id, {
        x: playbackVisual?.x ?? node.x,
        y: playbackVisual?.y ?? node.y,
        radius: graphScreenRadius(baseRadius, params.scale) / params.scale * (playbackVisual?.scale ?? 1),
        progress: playbackVisual?.progress ?? 1,
        alpha: playbackVisual?.alpha ?? 1,
      });
    }

    if (revealTimeline) {
      for (const edge of scene.visibleEdges) {
        if (!revealedNodes.has(edge.a.id) || !revealedNodes.has(edge.b.id)) continue;
        const key = graphPlaybackEdgeKey(edge.a.id, edge.b.id);
        const edgePlan = revealTimeline.edges.get(key);
        const progress = edgePlan ? graphPlaybackEdgeProgress(edgePlan, revealElapsed) : 1;
        if (progress <= 0) continue;
        revealedEdgeProgress.set(key, progress);
        revealedDegreeById.set(edge.a.id, (revealedDegreeById.get(edge.a.id) || 0) + progress);
        revealedDegreeById.set(edge.b.id, (revealedDegreeById.get(edge.b.id) || 0) + progress);
      }

      for (const node of scene.visibleNodes) {
        const visual = revealedNodes.get(node.id);
        if (!visual) continue;
        const playbackPlan = revealTimeline.nodes.get(node.id);
        const playbackVisual = playbackPlan ? graphPlaybackNodeVisual(playbackPlan, revealElapsed, node) : null;
        visual.radius = graphScreenRadius((isMissingGraphNode(node) ? GRAPH_NODE_BASE_RADIUS : graphNodeRadiusForLinks(revealedDegreeById.get(node.id) || 0))
          * params.nodeSizeMultiplier, params.scale) / params.scale * (playbackVisual?.scale ?? 1);
      }
    }

    for (const edge of scene.visibleEdges) {
      const { a, b } = edge;
      if (a.hidden || b.hidden) continue;
      const aVisual = revealedNodes.get(a.id);
      const bVisual = revealedNodes.get(b.id);
      if (!aVisual || !bVisual) continue;
      const revealKey = graphPlaybackEdgeKey(a.id, b.id);
      const revealPlan = revealTimeline?.edges.get(revealKey);
      const revealProgress = revealTimeline
        ? (revealedEdgeProgress.get(revealKey) || 0)
        : 1;
      if (revealProgress <= 0) continue;
      const visual = GRAPH_EDGE_VISUALS[edge.kind];
      const from = revealPlan?.fromId === b.id ? b : a;
      const to = revealPlan?.toId === a.id ? a : b;
      const fromVisual = revealedNodes.get(from.id)!;
      const toVisual = revealedNodes.get(to.id)!;
      // A tree edge is the child's tether: it follows the emerging node from
      // its first frame instead of being drawn after the node has arrived.
      const edgeEnd = { x: toVisual.x, y: toVisual.y };
      ctx.beginPath();
      ctx.moveTo(fromVisual.x, fromVisual.y);
      ctx.lineTo(edgeEnd.x, edgeEnd.y);
      if (edge.relatedToFocus) {
        ctx.strokeStyle = focusAccent;
        ctx.lineWidth = params.edgeWidthBase * (visual.width + 0.42);
      } else if (edge.dimmed) {
        ctx.strokeStyle = palette.dimmed;
        ctx.lineWidth = params.edgeWidthBase * 0.56;
      } else {
        ctx.strokeStyle = palette.edge;
        ctx.lineWidth = params.edgeWidthBase * visual.width;
      }
      ctx.globalAlpha = revealPlan?.treeEdge
        ? Math.min(fromVisual.alpha, toVisual.alpha, revealProgress)
        : revealProgress;
      const detail = graphEdgeDetail(params.scale);
      ctx.lineWidth *= detail.width / params.scale;
      const missingEndpoint = isMissingGraphNode(a) || isMissingGraphNode(b);
      ctx.globalAlpha *= edge.relatedToFocus ? 0.8 : edge.dimmed ? 0.14 : detail.alpha * (missingEndpoint ? 0.65 : 1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (params.showArrows && !edge.dimmed && !missingEndpoint && (!revealPlan?.treeEdge || revealProgress >= 0.98)) {
        if (edge.direction === "forward" || edge.direction === "bidirectional") {
          drawArrow(ctx, aVisual.x, aVisual.y, bVisual.x, bVisual.y, bVisual.radius, params.scale);
        }
        if (edge.direction === "reverse" || edge.direction === "bidirectional") {
          drawArrow(ctx, bVisual.x, bVisual.y, aVisual.x, aVisual.y, aVisual.radius, params.scale);
        }
      }
    }

    // Draw the focus node last so ordinary nodes can never cover it.
    for (let pass = 0; pass < 2; pass++) {
      for (const node of scene.visibleNodes) {
        if (node.hidden) continue;
        const isFocused = activeFocusId === node.id;
        if ((pass === 0 && isFocused) || (pass === 1 && !isFocused)) continue;
        const revealPlan = revealTimeline?.nodes.get(node.id);
        const revealedNode = revealedNodes.get(node.id);
        if (!revealedNode) continue;
        const { x: revealedX, y: revealedY, radius: revealedRadius, progress: revealProgress, alpha: revealAlpha } = revealedNode;
        const isNeighbor = activeFocusId !== null && !isFocused && scene.connectedIds.has(node.id);
        const documentNode = node.type === "note";
        const nodeFill = isFocused
          ? mixGraphHexColors(focusAccent, palette.background, 0.95)
          : mixGraphHexColors(
            node.color,
            palette.background,
            node.dimmed ? (documentNode ? 0.16 : 0.12) : isNeighbor ? (documentNode ? 0.9 : 0.8) : documentNode ? 0.88 : 0.72,
          );
        if (revealPlan && revealProgress < 0.99) {
          ctx.save();
          ctx.shadowColor = "rgba(0, 0, 0, 0.24)";
          ctx.shadowBlur = Math.max(1.5, revealedRadius * 0.8) * (1 - revealProgress * 0.45);
          ctx.shadowOffsetY = Math.max(0.5, (1 - revealProgress) * 2.4);
        }
        ctx.beginPath();
        ctx.arc(revealedX, revealedY, revealedRadius, 0, Math.PI * 2);
        ctx.fillStyle = nodeFill;
        ctx.globalAlpha = revealAlpha;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (revealPlan && revealProgress < 0.99) ctx.restore();

        const contextLabelAlpha = graphLabelFocusAlpha(labelDetail.alpha, isFocused, isNeighbor, activeFocusId !== null);
        const revealedLabelAlpha = contextLabelAlpha * smoothstep(0.48, 0.9, revealProgress);
        if (params.showLabels) labels.push({id: node.id, text: node.label,
          x: revealedX * params.scale + params.panX, y: revealedY * params.scale + params.panY,
          radius: revealedRadius * params.scale, degree: node.links,
          fontSize: isFocused ? Math.max(12, labelDetail.fontSize) : labelDetail.fontSize,
          priority: isFocused ? 3 : isNeighbor ? 2 : 0, alpha: revealedLabelAlpha});
      }
    }

    ctx.restore();
    labelsAnimatingRef.current = false;
    if (params.showLabels) {
      ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const measure = (text: string) => {
        const cache = labelMeasurementsRef.current;
        const cached = cache.get(text);
        if (cached !== undefined) return cached;
        const width = ctx.measureText(text).width;
        if (cache.size >= 5000) cache.clear();
        cache.set(text, width); return width;
      };
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const {labels: placed, animating} = updateGraphLabels(labels, width, height, measure, labelMemoryRef.current, timestamp, prefersReducedMotion());
      labelsAnimatingRef.current = animating;
      let fontSize = 12;
      for (const label of placed) {
        if (label.fontSize !== undefined && label.fontSize !== fontSize) {
          fontSize = label.fontSize;
          ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        }
        ctx.globalAlpha = label.alpha * label.opacity;
        ctx.fillStyle = label.priority === 3 ? focusAccent : palette.text;
        ctx.fillText(label.text, label.left + 4, label.top + 2);
      }
      ctx.globalAlpha = 1;
    } else { labelMemoryRef.current.clear(); }
    reportGraphPaint();
  }, [drawArrow, invalidatePaintReadiness, reportGraphPaint]);

  const loadGraphData = useCallback(async (options?: { preserveLayout?: boolean; refresh?: boolean }) => {
    if(!runtime && scopeVaultId && knowledgeStore.getSnapshot().vault?.id!==scopeVaultId)return;
    cancelGraphReveal();
    invalidatePaintReadiness();
    loadedGraphProofRef.current = null;
    const preserveLayout = options?.preserveLayout === true;
    const requestId = graphLoadSequenceRef.current + 1;
    graphLoadSequenceRef.current = requestId;
    if (!preserveLayout) setGraphStatus("loading");
    try {
      const seed = runtime ? await runtime.readSeed({ refresh: options?.refresh === true }) : await readSharedGraphSeed(options?.refresh === true);
      if (requestId !== graphLoadSequenceRef.current || currentRuntimeRef.current !== runtime) return;
      if(!runtime && scopeVaultId && knowledgeStore.getSnapshot().vault?.id!==scopeVaultId)return;
      graphSeedRef.current = seed;
      const provenance = runtime ? null : readGraphSeedProvenance(seed);
      if (!runtime && provenance && seed.sourceKind === 'real-vault') {
        const held = { ...provenance, generation: requestId, seed, verified: null as ScopedGraphSnapshot | null };
        mainGraphSourceRef.current = held;
        const binding = { viewId: sessionId || paneId, vaultId: held.vault.id, title: held.vault.name, generation: requestId, materialLibraryId: held.materialLibraryId, materialLibraryGeneration: held.materialLibraryGeneration, materialSourceVersion: held.materialSourceVersion, vault: { ...held.vault } };
        void graphNativeViews.verifySource(binding).then(dto => {
          if (mainGraphSourceRef.current === held && graphSeedRef.current === seed && graphLoadSequenceRef.current === requestId && isNativeGraphAdmission(seed, held, dto)) held.verified = dto;
        }).catch(() => {});
      } else if (!runtime) mainGraphSourceRef.current = null;
      const proof = runtime?.dataProof(seed);
      loadedGraphProofRef.current = runtime && proof ? { runtime, proof: { ...proof }, seed, requestId } : null;
      setRelationSource(null);
      setGraphStatus(seed.source);
      resetNodes({ preserveLayout });
    } catch (error) {
      if (requestId !== graphLoadSequenceRef.current || currentRuntimeRef.current !== runtime) return;
      loadedGraphProofRef.current = null;
      invalidatePaintReadiness();
      console.warn("[graph] build graph failed", error);
      graphSeedRef.current = { source: "empty", nodes: [], edges: [] };
      setGraphStatus("error");
      resetNodes({ preserveLayout });
      showNotice(t("editor.graph.status.loadFailedNotice"));
    }
  }, [cancelGraphReveal, invalidatePaintReadiness, resetNodes, showNotice, t, scopeVaultId, runtime, paneId, sessionId]);

  const selectRelationStart = useCallback((node: GraphNode) => {
    if (node.type === "web" || !node.entityId) {
      showNotice(t("editor.graph.status.webReadOnly"));
      setNodeMenu(null);
      return;
    }
    if (node.entityId.startsWith("real-vault-asset:")) {
      showNotice(t("editor.graph.status.vaultReadOnly"));
      setNodeMenu(null);
      return;
    }
    setRelationSource(node);
    publishCurrentGraphContext({
      nodeId: node.entityId,
      nodeType: node.type,
      label: node.label,
    });
    showNotice(t("editor.graph.status.originSelected", { label: node.label }));
    setNodeMenu(null);
  }, [showNotice, t]);

  const clearRelationStart = useCallback(() => {
    if (!paramsRef.current.nearbyFilter && focusedNodeRef.current?.id === relationSource?.id) {
      focusedNodeRef.current = null;
    }
    setRelationSource(null);
    publishCurrentGraphContext(null);
    setNodeMenu(null);
    markGraphDirty("scene");
    showNotice(t("editor.graph.status.originCancelled"));
  }, [markGraphDirty, relationSource, showNotice, t]);

  const clearFocusedNode = useCallback(() => {
    focusedNodeRef.current = null;
    hoveredRef.current = null;
    lastPublishedHoverKeyRef.current = null;
    tooltipKeyRef.current = null;
    setTooltip(null);
    setNodeMenu(null);
    publishCurrentGraphContext(null);
    markGraphDirty("scene", "hover");
    showNotice(t("editor.graph.status.selectionCleared"));
  }, [markGraphDirty, showNotice, t]);

  const editTagRelation = useCallback(async (target: GraphNode, mode: "connect" | "disconnect") => {
    if (!relationSource || presentationFrozenRef.current) return;
    setNodeMenu(null);
    graphMutationPendingRef.current++;
    try {
      const result = runtime ? await runtime.mutateRelation("tag", mode, relationSource, target) : mode === "connect"
        ? await connectGraphTagRelation(relationSource, target)
        : await disconnectGraphTagRelation(relationSource, target);
      showNotice(result.message);
      if (result.changed) {
        setRelationSource(null);
        await loadGraphData({ refresh: true });
      }
    } catch (error) {
      showNotice(t("editor.graph.status.relationFailed"));
    } finally { graphMutationPendingRef.current--; }
  }, [loadGraphData, relationSource, showNotice, t, runtime]);

  const editBodyRelation = useCallback(async (target: GraphNode, mode: "connect" | "disconnect") => {
    if (presentationFrozenRef.current) return;
    if (!relationSource) return;
    setNodeMenu(null);
    if (!runtime && (parseKnowledgeDocumentNoteId(relationSource.entityId || "") || parseKnowledgeDocumentNoteId(target.entityId || ""))) {
      showNotice(t("editor.graph.status.bodyEditInDocument"));
      return;
    }
    graphMutationPendingRef.current++;
    try {
      const result = runtime ? await runtime.mutateRelation("body", mode, relationSource, target) : mode === "connect"
        ? await connectGraphBodyRelation(relationSource, target)
        : await disconnectGraphBodyRelation(relationSource, target);
      showNotice(result.message);
      if (result.changed) {
        setRelationSource(null);
        await loadGraphData({ refresh: true });
      }
    } catch (error) {
      showNotice(t("editor.graph.status.bodyRelationFailed"));
    } finally { graphMutationPendingRef.current--; }
  }, [loadGraphData, relationSource, showNotice, t, runtime]);

  useLayoutEffect(() => {
    filtersRef.current = filters;
    paramsRef.current.showIsolated = showIsolated;
    paramsRef.current.nearbyFilter = nearbyFilter;
    paramsRef.current.nearbyDepth = nearbyDepth;
    paramsRef.current.colorMode = colorMode;
    paramsRef.current.showArrows = showArrows;
    paramsRef.current.showLabels = showLabels;
    paramsRef.current.labelReveal = labelReveal;
    paramsRef.current.nodeSizeMultiplier = nodeSize / 6;
    paramsRef.current.edgeWidthBase = edgeWidth;
    paramsRef.current.centerForce = centerForce;
    paramsRef.current.repulsionForce = repulsionForce;
    paramsRef.current.linkAttraction = linkAttraction;
    paramsRef.current.linkLength = linkLength;
    paramsRef.current.nodeSpacing = nodeSpacing;
    saveGraphView();
    markGraphDirty("scene");
  }, [centerForce, colorMode, edgeWidth, filters, labelReveal, linkAttraction, linkLength, markGraphDirty, nearbyDepth, nearbyFilter, nodeSize, nodeSpacing, repulsionForce, saveGraphView, showArrows, showIsolated, showLabels]);

  useEffect(() => {
    if (!runtime?.subscribeReadiness) return;
    return runtime.subscribeReadiness(() => { invalidatePaintReadiness(); setRuntimeCapabilityVersion(version => version + 1); requestGraphFrame('scene', 'viewport'); });
  }, [runtime, invalidatePaintReadiness, requestGraphFrame]);
  useEffect(() => {
    if (runtime) {
      const release = runtime.subscribe(() => { void loadGraphData({ preserveLayout: true, refresh: true }); });
      void loadGraphData({ preserveLayout: nodesRef.current.length > 0 });
      return () => { release(); graphLoadSequenceRef.current += 1; loadedGraphProofRef.current = null; invalidatePaintReadiness(); };
    }
    const queueRealVaultSeedRefresh = (delay = 180) => {
      if (graphSeedRefreshTimerRef.current !== null) window.clearTimeout(graphSeedRefreshTimerRef.current);
      graphSeedRefreshTimerRef.current = window.setTimeout(() => {
        graphSeedRefreshTimerRef.current = null;
        invalidateSharedGraphSeed();
        void loadGraphData({ preserveLayout: true });
      }, delay);
    };
    const releaseMaterialChangeProtocol = materialStore.retainChangeProtocol();
    const unsubscribeMaterialStore = materialStore.subscribe(() => {
      const changeVersion = materialStore.getSnapshot().lastChange?.version || 0;
      if (!changeVersion || changeVersion <= graphMaterialVersionRef.current) return;
      graphMaterialVersionRef.current = changeVersion;
      if (graphSeedRef.current.sourceKind === "real-vault") queueRealVaultSeedRefresh(320);
    });
    void loadGraphData({ preserveLayout: nodesRef.current.length > 0 });
    const handleBridgeReady = () => {
      invalidateSharedGraphSeed();
      void loadGraphData({ preserveLayout: nodesRef.current.length > 0 });
    };
    const queueRealVaultIndexRefresh = () => queueRealVaultSeedRefresh();
    const handleKnowledgeSourceChange = () => {
      if (graphSeedRefreshTimerRef.current !== null) window.clearTimeout(graphSeedRefreshTimerRef.current);
      graphSeedRefreshTimerRef.current = null;
      invalidateSharedGraphSeed();
      void loadGraphData();
    };
    window.addEventListener("luckyray:bridge-ready", handleBridgeReady);
    window.addEventListener("luckyray:notes-vault-index-changed", queueRealVaultIndexRefresh);
    window.addEventListener(KNOWLEDGE_SOURCE_CHANGED_EVENT, handleKnowledgeSourceChange);
    return () => {
      window.removeEventListener("luckyray:bridge-ready", handleBridgeReady);
      window.removeEventListener("luckyray:notes-vault-index-changed", queueRealVaultIndexRefresh);
      window.removeEventListener(KNOWLEDGE_SOURCE_CHANGED_EVENT, handleKnowledgeSourceChange);
      unsubscribeMaterialStore();
      releaseMaterialChangeProtocol();
      if (graphSeedRefreshTimerRef.current !== null) {
        window.clearTimeout(graphSeedRefreshTimerRef.current);
        graphSeedRefreshTimerRef.current = null;
      }
      graphLoadSequenceRef.current += 1;
    };
  }, [loadGraphData, runtime, invalidatePaintReadiness]);

  useEffect(() => {
    const onReset = (event: Event) => {
      if (presentationFrozenRef.current) return;
      const target = (event as CustomEvent<{ tabId?: string; paneId?: string }>).detail;
      const requestedId = target?.tabId || target?.paneId;
      if (requestedId ? requestedId !== (sessionId || paneId) : !activePaneRef.current || !workspaceVisibleRef.current) return;
      setCameraImmediately({ scale: 1, panX: 0, panY: 0 });
      paramsRef.current.alpha = 1;
      cancelGraphReveal();
      resetNodes();
      saveGraphView();
    };
    window.addEventListener("luckyray:graph-reset", onReset);
    return () => window.removeEventListener("luckyray:graph-reset", onReset);
  }, [cancelGraphReveal, paneId, sessionId, resetNodes, saveGraphView, setCameraImmediately]);

  useEffect(() => {
    if (!visible || !active || (!moreOpen && !nodeMenu)) return;
    const closeFloating = () => {
      setMoreOpen(false);
      setNodeMenu(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (resolveScopedShortcut(event, "graph", undefined, { ids: ["graphCloseFloating"] }) === "graphCloseFloating") closeFloating();
    };
    window.addEventListener("pointerdown", closeFloating);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", closeFloating);
      window.removeEventListener("keydown", handleKey);
    };
  }, [moreOpen, nodeMenu, visible, active]);

  const setCanvasCursor = useCallback((cursor: string) => {
    if (canvasCursorRef.current === cursor) return;
    canvasCursorRef.current = cursor;
    if (canvasRef.current) canvasRef.current.style.cursor = cursor;
  }, []);

  const publishGraphNode = useCallback((node: GraphNode | null) => {
    if (!activePaneRef.current || !workspaceVisibleRef.current) return;
    publishCurrentGraphContext(
      node ? {
        nodeId: node.entityId || String(node.id),
        nodeType: node.type,
        label: node.label,
      } : null,
    );
  }, []);

  const getCanvasPoint = useCallback((clientX: number, clientY: number) => {
    if (!viewportRef.current.width || !viewportRef.current.height) measureViewport();
    const viewport = viewportRef.current;
    return { x: clientX - viewport.left, y: clientY - viewport.top };
  }, [measureViewport]);

  const updateTooltipPosition = useCallback((x: number, y: number) => {
    const position = { x: x + 12, y: y - 10 };
    tooltipPositionRef.current = position;
    if (tooltipRef.current) {
      tooltipRef.current.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
    }
  }, []);

  const updatePlaybackCamera = useCallback((timestamp: number) => {
    const timeline = revealTimelineRef.current;
    if (!timeline || !revealActiveRef.current || !playbackCameraFollowRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport.width || !viewport.height) return;
    const elapsed = Math.max(0, timestamp - timeline.startedAt);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let visibleCount = 0;
    for (const node of sceneCacheRef.current.visibleNodes) {
      if (node.hidden) continue;
      const plan = timeline.nodes.get(node.id);
      if (!plan) continue;
      const visual = graphPlaybackNodeVisual(plan, elapsed, node);
      if (!visual) continue;
      const radius = node.r * paramsRef.current.nodeSizeMultiplier * visual.scale + 14;
      minX = Math.min(minX, visual.x - radius);
      minY = Math.min(minY, visual.y - radius);
      maxX = Math.max(maxX, visual.x + radius);
      maxY = Math.max(maxY, visual.y + radius);
      visibleCount += 1;
    }
    if (!visibleCount) return;

    const padding = Math.max(52, Math.min(112, Math.min(viewport.width, viewport.height) * 0.14));
    const contentWidth = Math.max(36, maxX - minX);
    const contentHeight = Math.max(36, maxY - minY);
    const fitScale = Math.min(
      Math.max(80, viewport.width - padding * 2) / contentWidth,
      Math.max(80, viewport.height - padding * 2) / contentHeight,
    );
    const desiredScale = clampGraphNumber(
      visibleCount <= 2 ? Math.min(1.65, fitScale) : fitScale,
      paramsRef.current.scale,
      0.28,
      1.65,
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const desiredPanX = viewport.width / 2 - centerX * desiredScale;
    const desiredPanY = viewport.height / 2 - centerY * desiredScale;
    const target = cameraTargetRef.current;
    const targetBlend = 0.14;
    target.scale += (desiredScale - target.scale) * targetBlend;
    target.panX += (desiredPanX - target.panX) * targetBlend;
    target.panY += (desiredPanY - target.panY) * targetBlend;
    cameraZoomAnchorRef.current = null;
    cancelCameraInertia();
  }, [cancelCameraInertia]);

  const updateCamera = useCallback((timestamp: number) => {
    const params = paramsRef.current;
    const target = cameraTargetRef.current;
    const velocity = cameraVelocityRef.current;
    const reducedMotion = prefersReducedMotion();
    const previousTimestamp = lastCameraFrameAtRef.current;
    const deltaTime = Math.min(48, Math.max(1, previousTimestamp ? timestamp - previousTimestamp : CAMERA_FRAME_DELAY_MS));
    lastCameraFrameAtRef.current = timestamp;

    if (!panningRef.current && !reducedMotion) {
      const speed = Math.hypot(velocity.panX, velocity.panY);
      if (speed >= CAMERA_INERTIA_STOP_SPEED) {
        target.panX += velocity.panX * deltaTime;
        target.panY += velocity.panY * deltaTime;
        const friction = Math.exp(-CAMERA_INERTIA_FRICTION * deltaTime);
        velocity.panX *= friction;
        velocity.panY *= friction;
      } else {
        velocity.panX = 0;
        velocity.panY = 0;
      }
    } else if (reducedMotion) {
      cancelCameraInertia();
    }

    const {camera, moving} = stepCamera(params, target, cameraZoomAnchorRef.current, deltaTime, reducedMotion);
    if (params.scale !== camera.scale || params.panX !== camera.panX || params.panY !== camera.panY) {
      Object.assign(params, camera);
      cameraNeedsPersistRef.current = true;
      dirtyRef.current.viewport = true;
    }
    const active = moving || Math.hypot(velocity.panX, velocity.panY) >= CAMERA_INERTIA_STOP_SPEED;
    if (!active) { cameraZoomAnchorRef.current = null; lastCameraFrameAtRef.current = 0; }
    return active;
  }, [cancelCameraInertia]);

  const applyPendingInputs = useCallback(() => {
    const pointer = pendingPointerRef.current;
    pendingPointerRef.current = null;
    if (pointer) {
      hoverPointerRef.current = pointer;
      const point = getCanvasPoint(pointer.clientX, pointer.clientY);
      const downPoint = mouseDownPointRef.current;
      if (downPoint && Math.hypot(pointer.clientX - downPoint.x, pointer.clientY - downPoint.y) > 4) {
        draggedRef.current = true;
      }
      if (draggingNodeRef.current) {
        const world = screenToWorld(point.x, point.y);
        const draggingNode = draggingNodeRef.current;
        const previousX = draggingNode.x;
        const previousY = draggingNode.y;
        const params = paramsRef.current;
        // Only the grabbed node is owned by pointer input. Neighbours continue
        // through the worker; sweeping unrelated nodes invalidates every result
        // and creates input-rate-dependent impulses through the whole graph.
        draggingNode.x = world.x;
        draggingNode.y = world.y;
        draggingNode.vx = 0;
        draggingNode.vy = 0;
        params.alpha = Math.max(params.alpha, 0.3);
        const timeline = revealTimelineRef.current;
        const plan = timeline?.nodes.get(draggingNode.id);
        if (timeline && plan) {
          const elapsed = Math.max(0, performance.now() - timeline.startedAt);
          const deltaX = world.x - previousX;
          const deltaY = world.y - previousY;
          plan.spawnX = world.x;
          plan.spawnY = world.y;
          plan.targetX = world.x;
          plan.targetY = world.y;
          plan.startAt = elapsed - plan.duration;
          for (const childPlan of timeline.nodes.values()) {
            if (childPlan.parentId !== draggingNode.id || childPlan.startAt <= elapsed) continue;
            childPlan.spawnX += deltaX;
            childPlan.spawnY += deltaY;
          }
        }
        dirtyRef.current.layout = true;
      } else if (panningRef.current) {
        const panGesture = panningRef.current;
        const panX = panGesture.panX + (pointer.clientX - panGesture.startX);
        const panY = panGesture.panY + (pointer.clientY - panGesture.startY);
        const now = performance.now();
        const elapsed = Math.max(1, now - panGesture.lastAt);
        const rawVelocityX = (pointer.clientX - panGesture.lastX) / elapsed;
        const rawVelocityY = (pointer.clientY - panGesture.lastY) / elapsed;
        panGesture.velocityX = panGesture.velocityX * 0.4 + rawVelocityX * 0.6;
        panGesture.velocityY = panGesture.velocityY * 0.4 + rawVelocityY * 0.6;
        panGesture.lastX = pointer.clientX;
        panGesture.lastY = pointer.clientY;
        panGesture.lastAt = now;
        panGesture.moved ||= Math.abs(pointer.clientX - panGesture.startX) > 1 || Math.abs(pointer.clientY - panGesture.startY) > 1;
        paramsRef.current.panX = panX;
        paramsRef.current.panY = panY;
        cameraTargetRef.current.panX = panX;
        cameraTargetRef.current.panY = panY;
        cameraTargetRef.current.scale = paramsRef.current.scale;
        cameraZoomAnchorRef.current = null;
        cancelCameraInertia();
        cameraNeedsPersistRef.current = true;
        dirtyRef.current.viewport = true;
      } else {
        const world = screenToWorld(point.x, point.y);
        const node = findNodeAt(world.x, world.y);
        const previousKey = hoveredRef.current?.key || null;
        const nextKey = node?.key || null;
        hoveredRef.current = node;
        setCanvasCursor(node ? "pointer" : "default");
        if (nextKey !== previousKey) dirtyRef.current.hover = true;
        if (nextKey !== lastPublishedHoverKeyRef.current) {
          lastPublishedHoverKeyRef.current = nextKey;
          publishGraphNode(node);
        }
        updateTooltipPosition(point.x, point.y);
        if (nextKey !== tooltipKeyRef.current) {
          tooltipKeyRef.current = nextKey;
          setTooltip(node ? {
            key: node.key,
            title: node.label,
            meta: `${t(`editor.graph.type.${node.type}`)} · ${t("editor.graph.connections", { count: node.links })}`,
          } : null);
        }
      }
    }

    const wheel = pendingWheelRef.current;
    pendingWheelRef.current = null;
    if (wheel) {
      const displayed = paramsRef.current;
      const target = cameraTargetRef.current;
      const world = screenToWorld(wheel.x, wheel.y);
      const anchor = wheelZoomPoint(displayed, wheel, findNodeAt(world.x, world.y));
      Object.assign(target, wheelCamera(displayed, target, anchor, wheel.delta));
      cameraZoomAnchorRef.current = anchor;
      cancelCameraInertia();
      cameraNeedsPersistRef.current = true;
      dirtyRef.current.viewport = true;
    }
  }, [cancelCameraInertia, findNodeAt, getCanvasPoint, publishGraphNode, screenToWorld, setCanvasCursor, updateTooltipPosition, t]);

  const runGraphFrame = useCallback((timestamp: number) => {
    if(!workspaceVisibleRef.current)return;
    if (presentationFrozenRef.current) {
      if (!presentationCommitRef.current) return;
      rebuildSceneCache();
      dirtyRef.current = { scene: false, viewport: false, hover: false, layout: false };
      draw(playbackClockRef.current.time(timestamp));
      return;
    }
    // Physics can move a node away from a stationary pointer, including a final
    // pointermove delivered after release by a native WebView. Re-hit-test only
    // while a hover exists and a frame is already needed; never poll when idle.
    const hoverPointer = hoverPointerRef.current;
    if (hoveredRef.current && hoverPointer && activePointerIdRef.current === null && !pendingPointerRef.current) {
      const point = getCanvasPoint(hoverPointer.clientX, hoverPointer.clientY);
      const world = screenToWorld(point.x, point.y);
      if (findNodeAt(world.x, world.y)?.id !== hoveredRef.current.id) pendingPointerRef.current = hoverPointer;
    }
    applyPendingInputs();
    const revealActive = advanceGraphReveal(timestamp);
    const dirty = dirtyRef.current;
    const needsSceneCache = dirty.scene || dirty.hover;
    if (dirty.scene || (dirty.hover && paramsRef.current.nearbyFilter)) {
      physicsGenerationRef.current += 1;
      physicsMutationRevisionRef.current += 1;
    }
    if (needsSceneCache) rebuildSceneCache();
    const revealSimulationNodes = revealActive ? activateGraphRevealNodes(timestamp) : null;
    updatePlaybackCamera(timestamp);
    const cameraMoving = updateCamera(timestamp);
    const simulation = simulate(timestamp, revealSimulationNodes);
    if (settledFitRef.current && paramsRef.current.alpha < .001 && sceneCacheRef.current.visibleNodes.length) {
      settledFitRef.current = false;
      const {width,height} = viewportRef.current;
      const camera = fitGraphCamera(sceneCacheRef.current.visibleNodes,width,height);
      if(camera) { setCameraImmediately(camera); dirty.viewport = true; cameraNeedsPersistRef.current = true; }
    }
    const shouldDraw = dirty.scene || dirty.viewport || dirty.hover || dirty.layout || simulation.stepped || cameraMoving || revealActive || labelsAnimatingRef.current;
    dirtyRef.current = { scene: false, viewport: false, hover: false, layout: false };
    if (shouldDraw) draw(timestamp);

    if (!cameraMoving && !panningRef.current && cameraNeedsPersistRef.current) {
      cameraNeedsPersistRef.current = false;
      flushGraphView();
    }

    // Camera frames follow display refresh directly; physics keeps its own cadence.
    if (cameraMoving || labelsAnimatingRef.current) { requestGraphFrame(); return; }
    const nextDelay = Math.min(
      simulation.active ? simulation.delay : Number.POSITIVE_INFINITY,
      revealActive ? GRAPH_REVEAL_FRAME_DELAY_MS : Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nextDelay)) {
      engineTimerRef.current = window.setTimeout(() => {
        engineTimerRef.current = null;
        requestGraphFrame();
      }, nextDelay);
    }
  }, [activateGraphRevealNodes, advanceGraphReveal, applyPendingInputs, draw, findNodeAt, flushGraphView, getCanvasPoint, rebuildSceneCache, requestGraphFrame, screenToWorld, setCameraImmediately, simulate, updateCamera, updatePlaybackCamera]);

  useEffect(()=>{
    if(!visible){
      playbackClockRef.current.hold('hidden', true, performance.now(), revealTimelineRef.current);
      physicsGenerationRef.current += 1;
      pendingPointerRef.current = null;
      pendingWheelRef.current = null;
      hoverPointerRef.current = null;
      hoveredRef.current = null;
      setTooltip(null);
      setNodeMenu(null);
      setMoreOpen(false);
      flushGraphView();
      if(engineFrameRef.current)window.cancelAnimationFrame(engineFrameRef.current);
      if(engineTimerRef.current!==null)window.clearTimeout(engineTimerRef.current);
      engineFrameRef.current=0;engineTimerRef.current=null;
    }else{
      playbackClockRef.current.hold('hidden', false, performance.now(), revealTimelineRef.current);
      measureViewport();
      if (sceneSeedRef.current !== graphSeedRef.current) resetNodes({ preserveLayout: true });
      requestGraphFrame('viewport');
    }
  },[visible,requestGraphFrame,flushGraphView,measureViewport,resetNodes]);
  useEffect(() => {
    runGraphFrameRef.current = runGraphFrame;
    measureViewport();
    resetNodes({ preserveLayout: true });
    const container = containerRef.current;
    const observer = container ? new ResizeObserver(() => {
      if (!measureViewport()) return;
      if (sceneSeedRef.current !== graphSeedRef.current) resetNodes({ preserveLayout: true });
      physicsMutationRevisionRef.current += 1;
      if (!presentationFrozenRef.current) paramsRef.current.alpha = Math.max(paramsRef.current.alpha, 0.2);
      markGraphDirty("viewport", "layout");
    }) : null;
    if (container && observer) observer.observe(container);
    requestGraphFrame("scene", "viewport", "layout");
    return () => {
      if (runGraphFrameRef.current === runGraphFrame) runGraphFrameRef.current = null;
      revealTimelineRef.current = null;
      revealActiveRef.current = false;
      revealActivatedNodeIdsRef.current.clear();
      observer?.disconnect();
      if (engineFrameRef.current) window.cancelAnimationFrame(engineFrameRef.current);
      if (engineTimerRef.current !== null) window.clearTimeout(engineTimerRef.current);
      engineFrameRef.current = 0;
      engineTimerRef.current = null;
      flushGraphView();
    };
  }, [flushGraphView, markGraphDirty, measureViewport, requestGraphFrame, resetNodes, runGraphFrame]);

  const openExternalGraphUrl = useCallback(async (url: string) => {
    try {
      const bridge = getLuckyRayBridgeSync();
      if (bridge?.openExternalUrl) await bridge.openExternalUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, []);

  const resolveGraphLocalPath = useCallback((node: GraphNode) => {
    if (runtime) return null;
    if (!node.entityId) return null;
    const knowledgeSnapshot = knowledgeStore.getSnapshot();
    const documentRef = node.type === "note" ? parseKnowledgeDocumentNoteId(node.entityId) : null;
    if (documentRef && (knowledgeSnapshot.mode !== "real-vault" || knowledgeSnapshot.vault?.id !== documentRef.vaultId)) {
      return null;
    }
    const relativePath = node.type === "material"
      ? safeRealVaultAssetRelativePath(node.entityId)
      : node.type === "note"
        ? safeRealVaultDocumentRelativePath(node.entityId)
        : null;
    if (relativePath) {
      const rootPath = knowledgeSnapshot.mode === "real-vault" ? knowledgeSnapshot.vault?.rootPath?.replace(/[\\/]+$/, "") : "";
      return rootPath ? `${rootPath}\\${relativePath.replace(/\//g, "\\")}` : null;
    }

    if (node.type !== "material") return null;

    const snapshot = materialStore.getSnapshot();
    const asset = snapshot.allAssets.find((item) => item.id === node.entityId)
      || snapshot.assets.find((item) => item.id === node.entityId);
    const candidate = asset?.libraryPath || asset?.originalPath || "";
    if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(candidate)) return null;
    return candidate;
  }, [runtime]);

  const openGraphLocalPath = useCallback(async (node: GraphNode, action: "open" | "reveal") => {
    setNodeMenu(null);
    if (runtime) {
      try { await runtime.act(action === "open" ? "openDefault" : "reveal", node); }
      catch (error) { showNotice(String(error)); }
      return;
    }
    const absolutePath = resolveGraphLocalPath(node);
    if (!absolutePath) {
      showNotice(t("editor.graph.status.noLocalPath"));
      return;
    }
    const bridge = getLuckyRayBridgeSync();
    try {
      let succeeded = false;
      if (action === "reveal") {
        succeeded = await bridge?.revealAssetPath?.(absolutePath) || false;
      } else {
        const documentRef = node.type === "note" && node.entityId ? parseKnowledgeDocumentNoteId(node.entityId) : null;
        const relativeDocumentPath = documentRef?.relativePath || null;
        const vault = knowledgeStore.getSnapshot().vault;
        if (relativeDocumentPath && vault && vault.id === documentRef?.vaultId && bridge?.openNotesVaultMarkdownFileWithDefaultApp) {
          await bridge.openNotesVaultMarkdownFileWithDefaultApp({ vault, relativePath: relativeDocumentPath });
          succeeded = true;
        } else {
          succeeded = await bridge?.openFilePath?.(absolutePath) || false;
        }
      }
      showNotice(succeeded
        ? action === "reveal" ? t("editor.graph.status.revealed") : t("editor.graph.status.openedDefault")
        : action === "reveal" ? t("editor.graph.status.revealFailed") : t("editor.graph.status.openDefaultFailed"));
    } catch (error) {
      console.warn(`[graph] ${action} local path failed`, error);
      showNotice(action === "reveal" ? t("editor.graph.status.revealFailed") : t("editor.graph.status.openDefaultFailed"));
    }
  }, [resolveGraphLocalPath, showNotice, t, runtime]);

  const clearGraphFocusForNavigation = useCallback(() => {
    focusedNodeRef.current = null;
    hoveredRef.current = null;
    lastPublishedHoverKeyRef.current = null;
    tooltipKeyRef.current = null;
    setTooltip(null);
    setNodeMenu(null);
    publishCurrentGraphContext(null);
    markGraphDirty("scene", "hover");
  }, [markGraphDirty]);

  const navigateFromGraph = useCallback((hash: string, type: "note" | "tag", id: string) => {
    clearGraphFocusForNavigation();
    window.location.hash = hash;
    window.requestAnimationFrame(() => focusEntity(type, id, { source: "graph" }));
  }, [clearGraphFocusForNavigation]);

  const createMissingGraphDocument = useCallback(async (node: GraphNode) => {
    if (presentationFrozenRef.current) return;
    if (runtime) { await runtime.act("createMissing", node); return; }
    const target = graphMissingDocumentTarget(node);
    const snapshot = knowledgeStore.getSnapshot();
    const bridge = getLuckyRayBridgeSync();
    if (target && !hasTrustedGraphMissingDocumentMetadata(target)) {
      setNodeMenu(null);
      showNotice(t("editor.graph.status.staleMissingLink"));
      return;
    }
    if (!target || !isSafeGraphMissingDocumentTarget(target)) {
      setNodeMenu(null);
      showNotice(t("editor.graph.status.invalidMissingLink"));
      return;
    }
    if (snapshot.mode !== "real-vault" || !snapshot.vault
      || !bridge?.createNotesVaultMarkdownFile || !bridge.getCurrentNotesVault) {
      showNotice(t("editor.graph.status.vaultNotReady"));
      return;
    }
    const creationKey = normalizeVaultRelativePath(target.relativePath).toLocaleLowerCase();
    if (missingDocumentCreationRef.current.has(creationKey)) return;
    missingDocumentCreationRef.current.add(creationKey);
    setNodeMenu(null);
    try {
      const expectedVault = snapshot.vault;
      const requireMatchingLiveVault = async () => {
        const currentVault = await bridge.getCurrentNotesVault!();
        if (!graphVaultsMatch(expectedVault, currentVault)) {
          throw new Error(t("editor.graph.status.vaultSwitched"));
        }
        return currentVault!;
      };
      const liveVault = await requireMatchingLiveVault();
      let relativePath = target.relativePath;
      try {
        const created = await bridge.createNotesVaultMarkdownFile({
          vault: liveVault,
          parentRelativePath: target.parentPath,
          name: target.fileName,
        });
        relativePath = normalizeVaultRelativePath(created.relativePath || target.relativePath);
      } catch (error) {
        if (!/already-exists/i.test(String(error))) throw error;
      }
      const verified = await bridge.readNotesVaultMarkdownFile?.({ vault: liveVault, relativePath });
      if (!verified) throw new Error(t("editor.graph.status.createdDocumentUnreadable"));
      relativePath = normalizeVaultRelativePath(verified.relativePath || relativePath);
      await requireMatchingLiveVault();
      const refreshed = await knowledgeStore.revalidate({ reason: "graph-create-missing-wiki", force: true });
      await requireMatchingLiveVault();
      if (refreshed.mode !== "real-vault" || !graphVaultsMatch(expectedVault, refreshed.vault)) {
        throw new Error(t("editor.graph.status.vaultSwitchedDuringCreate"));
      }
      const indexedDocument = refreshed.markdownIndex?.documents?.find((document) => (
        normalizeVaultRelativePath(document.relativePath).toLocaleLowerCase() === relativePath.toLocaleLowerCase()
      ));
      if (!indexedDocument) {
        throw new Error(t("editor.graph.status.createdDocumentNotIndexed"));
      }
      relativePath = normalizeVaultRelativePath(indexedDocument.relativePath);
      invalidateSharedGraphSeed();
      navigateFromGraph("#notes", "note", knowledgeDocumentNoteId({ vaultId: refreshed.vault!.id, relativePath }));
    } catch (error) {
      console.warn("[graph] create missing wiki document failed", error);
      showNotice(t("editor.graph.status.createDocumentFailed"));
    } finally {
      missingDocumentCreationRef.current.delete(creationKey);
    }
  }, [navigateFromGraph, showNotice, t, runtime]);

  const openGraphNode = useCallback((node: GraphNode) => {
    setNodeMenu(null);
    if (runtime) {
      void runtime.act(isMissingGraphNode(node) ? "createMissing" : "open", node).catch(error => showNotice(String(error)));
      return;
    }
    if (!node.entityId) {
      showNotice(t("editor.graph.status.noOpenTarget"));
      return;
    }
    if (isMissingGraphNode(node)) {
      void createMissingGraphDocument(node);
      return;
    }
    if (node.type === "material") {
      if (node.entityId.startsWith(REAL_VAULT_ASSET_PREFIX)) {
        showNotice(t("editor.graph.status.materialDetailsUnavailable"));
        return;
      }
      clearGraphFocusForNavigation();
      focusEntity("asset", node.entityId);
      window.location.hash = "#materials";
      return;
    }
    if (node.type === "note") {
      navigateFromGraph("#notes", "note", node.entityId);
      return;
    }
    if (node.type === "tag") {
      if (node.entityId.startsWith("real-vault-tag:")) {
        navigateFromGraph("#tags", "tag", node.entityId);
        return;
      }
      navigateFromGraph("#tags", "tag", node.entityId);
      return;
    }
    if (/^https?:\/\//i.test(node.entityId)) {
      clearGraphFocusForNavigation();
      void openExternalGraphUrl(node.entityId);
      return;
    }
    showNotice(t("editor.graph.status.noOpenTarget"));
  }, [clearGraphFocusForNavigation, createMissingGraphDocument, navigateFromGraph, openExternalGraphUrl, showNotice, t, runtime]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    settledFitRef.current = false;
    const primaryButton = event.button === 0 && (event.buttons & 1) !== 0;
    const middleButton = event.button === 1 && (event.buttons & 4) !== 0;
    if (!primaryButton && !middleButton) {
      pendingPointerRef.current = null;
      return;
    }
    if (activePointerIdRef.current !== null) return;
    if (middleButton) event.preventDefault();
    setNodeMenu(null);
    const point = getCanvasPoint(event.clientX, event.clientY);
    const world = screenToWorld(point.x, point.y);
    const node = middleButton ? null : findNodeAt(world.x, world.y);
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    mouseDownPointRef.current = { x: event.clientX, y: event.clientY };
    mouseDownNodeRef.current = node;
    draggedRef.current = false;
    takeCameraControl();
    if (node) {
      physicsMutationRevisionRef.current += 1;
      draggingNodeRef.current = node;
      dragRelaxationRef.current = true;
      paramsRef.current.alpha = Math.max(paramsRef.current.alpha, 0.3);
      setCanvasCursor("grabbing");
      markGraphDirty("layout", "hover");
      return;
    }
    panningRef.current = {
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      panX: paramsRef.current.panX,
      panY: paramsRef.current.panY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: performance.now(),
      velocityX: 0,
      velocityY: 0,
      moved: false,
    };
    setCanvasCursor("grabbing");
    markGraphDirty("viewport");
  }, [findNodeAt, getCanvasPoint, markGraphDirty, screenToWorld, setCanvasCursor, takeCameraControl]);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const point = getCanvasPoint(event.clientX, event.clientY);
    const world = screenToWorld(point.x, point.y);
    const node = findNodeAt(world.x, world.y);
    pendingPointerRef.current = null;
    hoveredRef.current = null;
    lastPublishedHoverKeyRef.current = null;
    if (tooltipKeyRef.current !== null) {
      tooltipKeyRef.current = null;
      setTooltip(null);
    }
    markGraphDirty("hover");
    setMoreOpen(false);
    if (!node) {
      setNodeMenu(null);
      return;
    }
    setNodeMenuPosition({ left: point.x, top: point.y });
    setNodeMenu({ x: point.x, y: point.y, node });
  }, [findNodeAt, getCanvasPoint, markGraphDirty, screenToWorld]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return;
    if (activePointerIdRef.current === null && event.buttons !== 0) return;
    pendingPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    requestGraphFrame();
  }, [requestGraphFrame]);

  const stopPointerInteraction = useCallback((canvas?: HTMLCanvasElement, pointerId?: number, allowOpen = true) => {
    const activePointerId = activePointerIdRef.current;
    if (pointerId !== undefined && activePointerId !== null && pointerId !== activePointerId) return;
    const clickedNode = mouseDownNodeRef.current;
    const shouldOpen = allowOpen && clickedNode && !draggedRef.current;
    const panGesture = panningRef.current;
    const reducedMotion = prefersReducedMotion();
    const panSpeed = panGesture ? Math.hypot(panGesture.velocityX, panGesture.velocityY) : 0;
    const shouldInertiallyPan = !!panGesture
      // A mouse drag is precise placement. Only direct touch gestures coast.
      && panGesture.pointerType === "touch"
      && panGesture.moved
      && !reducedMotion
      && panSpeed >= CAMERA_INERTIA_STOP_SPEED;
    if (shouldInertiallyPan && panGesture) {
      const velocityScale = Math.min(1, CAMERA_INERTIA_MAX_SPEED / panSpeed);
      cameraVelocityRef.current.panX = panGesture.velocityX * velocityScale;
      cameraVelocityRef.current.panY = panGesture.velocityY * velocityScale;
      cameraNeedsPersistRef.current = true;
    } else {
      cancelCameraInertia();
    }
    if (draggingNodeRef.current) {
      physicsMutationRevisionRef.current += 1;
      // The node can relax away from the pointer after release. A stale hover
      // must not keep its neighbours highlighted until the next mouse move.
      hoveredRef.current = null;
      lastPublishedHoverKeyRef.current = null;
      tooltipKeyRef.current = null;
      setTooltip(null);
      publishGraphNode(null);
      dirtyRef.current.hover = true;
    }
    draggingNodeRef.current = null;
    panningRef.current = null;
    if (canvas && activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
      canvas.releasePointerCapture(activePointerId);
    }
    activePointerIdRef.current = null;
    mouseDownNodeRef.current = null;
    mouseDownPointRef.current = null;
    draggedRef.current = false;
    setCanvasCursor("default");
    markGraphDirty("layout", "viewport");
    if (!shouldInertiallyPan) {
      flushGraphView();
      cameraNeedsPersistRef.current = false;
    }
    if (shouldOpen) openGraphNode(clickedNode);
  }, [cancelCameraInertia, flushGraphView, markGraphDirty, openGraphNode, publishGraphNode, setCanvasCursor]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    pendingPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    applyPendingInputs();
    stopPointerInteraction(event.currentTarget, event.pointerId);
  }, [applyPendingInputs, stopPointerInteraction]);

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    pendingPointerRef.current = null;
    stopPointerInteraction(event.currentTarget, event.pointerId, false);
  }, [stopPointerInteraction]);

  const handlePointerLeave = useCallback(() => {
    if (activePointerIdRef.current !== null) return;
    pendingPointerRef.current = null;
    hoverPointerRef.current = null;
    hoveredRef.current = null;
    lastPublishedHoverKeyRef.current = null;
    if (tooltipKeyRef.current !== null) {
      tooltipKeyRef.current = null;
      setTooltip(null);
    }
    mouseDownNodeRef.current = null;
    mouseDownPointRef.current = null;
    draggedRef.current = false;
    setCanvasCursor("default");
    markGraphDirty("hover");
  }, [markGraphDirty, setCanvasCursor]);

  const suppressMiddleAutoScroll = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button === 1) event.preventDefault();
  }, []);

  const handleAuxClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button === 1) event.preventDefault();
  }, []);

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    settledFitRef.current = false;
    playbackCameraFollowRef.current = false;
    // Re-hit-test the actual wheel location; do not discard a node that stays
    // under a stationary pointer throughout anchored zoom.
    pendingPointerRef.current = {clientX: event.clientX, clientY: event.clientY};
    const point = getCanvasPoint(event.clientX, event.clientY);
    needsInitialFitRef.current = false;
    const previous = pendingWheelRef.current;
    const delta = normalizeWheelDelta(event, viewportRef.current.height);
    if (!delta) return;
    pendingWheelRef.current = {
      x: point.x,
      y: point.y,
      delta: (previous && Math.sign(previous.delta) === Math.sign(delta) ? previous.delta : 0) + delta,
    };
    requestGraphFrame();
  }, [getCanvasPoint, requestGraphFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // React delegates wheel events passively; use a local listener so zoom
    // consumes the gesture without scrolling the surrounding workspace.
    canvas.addEventListener('wheel', handleWheel, {passive: false});
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const toggleFilter = useCallback((type: GraphType) => {
    cancelGraphReveal();
    setFilters((current) => {
      const next = { ...current, [type]: !current[type] };
      filtersRef.current = next;
      paramsRef.current.alpha = Math.max(paramsRef.current.alpha, 0.12);
      saveGraphView();
      markGraphDirty("scene", "layout");
      return next;
    });
  }, [cancelGraphReveal, markGraphDirty, saveGraphView]);

  const toggleIsolatedNodes = useCallback(() => {
    setShowIsolated((current) => {
      const next = !current;
      updateParam("showIsolated", next);
      saveGraphView();
      markGraphDirty("scene");
      return next;
    });
  }, [markGraphDirty, saveGraphView, updateParam]);

  const clearNearbyModeContext = useCallback(() => {
    focusedNodeRef.current = null;
    hoveredRef.current = null;
    lastPublishedHoverKeyRef.current = null;
    tooltipKeyRef.current = null;
    setTooltip(null);
    setNodeMenu(null);
    setRelationSource(null);
    publishCurrentGraphContext(null);
  }, []);

  const toggleNearby = useCallback(() => {
    cancelGraphReveal();
    setNearbyFilter((current) => {
      const next = !current;
      if (next && !focusedNodeRef.current) {
        focusedNodeRef.current = hoveredRef.current || null;
        if (!focusedNodeRef.current) {
          showNotice(t("editor.graph.status.nearbyEnabled"));
        }
      } else if (!next) {
        clearNearbyModeContext();
      }
      updateParam("nearbyFilter", next);
      saveGraphView();
      markGraphDirty("scene");
      return next;
    });
  }, [cancelGraphReveal, clearNearbyModeContext, markGraphDirty, saveGraphView, showNotice, updateParam, t]);

  const setNearbyDepthValue = useCallback((depth: 1 | 2) => {
    setNearbyDepth(depth);
    updateParam("nearbyDepth", depth);
    saveGraphView();
    markGraphDirty("scene");
  }, [markGraphDirty, saveGraphView, updateParam]);

  const showFullGraph = useCallback(() => {
    cancelGraphReveal();
    clearNearbyModeContext();
    setNearbyFilter(false);
    updateParam("nearbyFilter", false);
    setNodeMenu(null);
    saveGraphView();
    markGraphDirty("scene");
    showNotice(t("editor.graph.status.fullGraphShown"));
  }, [cancelGraphReveal, clearNearbyModeContext, markGraphDirty, saveGraphView, showNotice, updateParam, t]);

  const setColorMode = useCallback((mode: GraphParams["colorMode"]) => {
    setColorModeState(mode);
    updateParam("colorMode", mode);
    saveGraphView();
    markGraphDirty("scene");
  }, [markGraphDirty, saveGraphView, updateParam]);

  const resetGraph = useCallback(() => {
    setCameraImmediately({ scale: 1, panX: 0, panY: 0 });
    paramsRef.current.alpha = 1;
    cancelGraphReveal();
    needsInitialFitRef.current = true;
    settledFitRef.current = true;
    resetNodes();
    saveGraphView();
    markGraphDirty("scene", "layout");
  }, [cancelGraphReveal, markGraphDirty, resetNodes, saveGraphView, setCameraImmediately]);

  const focusCurrent = useCallback(() => {
    rebuildSceneCache();
    const visible = sceneCacheRef.current.visibleNodes.filter(node => !node.hidden);
    const { width, height } = viewportRef.current;
    const camera = fitGraphCamera(visible, width, height);
    if (!camera) return;
    setCameraImmediately(camera);
    saveGraphView();
    markGraphDirty("viewport");
  }, [markGraphDirty, rebuildSceneCache, saveGraphView, setCameraImmediately]);

  const clearGraphSearchScope = useCallback(() => {
    cancelGraphReveal();
    searchScopeNodeKeysRef.current = null;
    setGraphSearchScope(null);
    focusedNodeRef.current = null;
    hoveredRef.current = null;
    paramsRef.current.alpha = Math.max(paramsRef.current.alpha, 0.18);
    rebuildSceneCache();
    focusCurrent();
    markGraphDirty("scene", "layout", "viewport");
  }, [cancelGraphReveal, focusCurrent, markGraphDirty, rebuildSceneCache]);

  const applyGraphSearchResult = useCallback((result: GraphSearchResult) => {
    const nodeKeys = new Set(result.kind === "folder" ? result.nodeKeys : [result.node.key]);
    if (result.kind === "document") {
      const nodesById = new Map(nodesRef.current.map((node) => [node.id, node]));
      for (const [aId, bId] of edgesRef.current) {
        if (aId !== result.node.id && bId !== result.node.id) continue;
        const neighbor = nodesById.get(aId === result.node.id ? bId : aId);
        if (neighbor) nodeKeys.add(neighbor.key);
      }
    }
    if (!nodeKeys.size) {
      showNotice(t("editor.graph.status.noNodes"));
      return;
    }

    cancelGraphReveal();
    searchScopeNodeKeysRef.current = nodeKeys;
    setGraphSearchScope({ kind: result.kind, label: result.label, nodeKeys: [...nodeKeys] });
    focusedNodeRef.current = result.kind === "document" ? result.node : null;
    hoveredRef.current = null;
    setNearbyFilter(false);
    updateParam("nearbyFilter", false);
    if (result.kind === "document") publishGraphNode(result.node);
    setNodeQuery("");
    setFindActiveIndex(0);
    findInputRef.current?.blur();
    paramsRef.current.alpha = Math.max(paramsRef.current.alpha, 0.24);
    rebuildSceneCache();
    focusCurrent();
    markGraphDirty("scene", "layout", "viewport");
  }, [cancelGraphReveal, focusCurrent, markGraphDirty, publishGraphNode, rebuildSceneCache, showNotice, updateParam, t]);

  const handleNodeSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setNodeQuery("");
      setFindActiveIndex(0);
      event.currentTarget.blur();
      if (graphSearchScope) clearGraphSearchScope();
      return;
    }
    if (!nodeSearchResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFindActiveIndex((index) => Math.min(index + 1, nodeSearchResults.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFindActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      applyGraphSearchResult(nodeSearchResults[Math.min(findActiveIndex, nodeSearchResults.length - 1)]);
    }
  }, [applyGraphSearchResult, clearGraphSearchScope, findActiveIndex, graphSearchScope, nodeSearchResults]);

  const focusAroundNode = useCallback((node: GraphNode) => {
    focusedNodeRef.current = node;
    setNearbyFilter(true);
    updateParam("nearbyFilter", true);
    setNodeMenu(null);
    showNotice(t("editor.graph.status.focused", { label: node.label, hops: paramsRef.current.nearbyDepth }));
    saveGraphView();
    markGraphDirty("scene");
  }, [markGraphDirty, saveGraphView, showNotice, updateParam, t]);

  const copyNodeLabel = useCallback(async (node: GraphNode) => {
    setNodeMenu(null);
    try {
      await navigator.clipboard.writeText(node.label);
      showNotice(t("editor.graph.status.nameCopied"));
    } catch {
      showNotice(t("editor.graph.status.copyFailed"));
    }
  }, [showNotice, t]);

  const askAiAboutNode = useCallback((node: GraphNode) => {
    setNodeMenu(null);
    if (runtime) {
      void runtime.act("askAi", node).catch(error => showNotice(String(error)));
      return;
    }
    try {
      openInLightSeek({
        source: "graph",
        text: `请解释图谱节点「${node.label}」的上下文关系，并给出我下一步可以整理的素材/笔记建议。`,
      });
      showNotice(t("editor.graph.status.lightSeekReady"));
    } catch {
      showNotice(t("editor.graph.status.lightSeekFailed"));
    }
  }, [showNotice, t, runtime]);

  const closeCurrentView = useCallback(() => {
    setMoreOpen(false);
    if (!onClose(paneId)) showNotice(t("editor.graph.status.lastPane"));
  }, [onClose, paneId, showNotice, t]);

  const captureSession = (): GraphSessionSnapshot => ({
    camera: { scale: paramsRef.current.scale, panX: paramsRef.current.panX, panY: paramsRef.current.panY },
    view: { ...currentGraphView(), spatialVersion: 3 },
    positions: nodesRef.current.map(({ key, x, y, vx, vy }) => ({ key, x, y, vx, vy })),
    focusedKey: focusedNodeRef.current?.key || pendingSelectionRef.current,
    relationSourceKey: relationSource?.key || pendingRelationRef.current,
    searchScope: graphSearchScope ? { ...graphSearchScope, nodeKeys: [...graphSearchScope.nodeKeys] } : null,
    searchQuery: nodeQuery,
    sideOpen,
    ...(revealActiveRef.current && revealTimelineRef.current ? { playback: captureGraphPlayback({
      timeline: revealTimelineRef.current, elapsedMs: playbackClockRef.current.elapsed(revealTimelineRef.current, performance.now()),
      nodes: nodesRef.current, activatedIds: revealActivatedNodeIdsRef.current,
      activationIds: playbackActivationRef.current?.timeline === revealTimelineRef.current ? playbackActivationRef.current.ids : new Map(),
      activationOrder: playbackActivationRef.current?.timeline === revealTimelineRef.current ? playbackActivationRef.current.order : new Map(),
      cameraFollow: playbackCameraFollowRef.current, cameraTarget: cameraTargetRef.current,
      cameraVelocity: cameraVelocityRef.current, cameraZoomAnchor: cameraZoomAnchorRef.current, alpha: paramsRef.current.alpha,
    }) } : {}),
  });
  const restoreSession = (snapshot: GraphSessionSnapshot) => {
    if (!validateGraphSessionSnapshot(snapshot)) throw Error('workspace-graph-presentation-invalid');
    const restoredPlayback = snapshot.playback ? restoreGraphPlayback(snapshot.playback,
      { nodes: nodesRef.current, edges: edgesRef.current }, playbackClockRef.current.time(performance.now())) : null;
    invalidatePaintReadiness();
    const view = snapshot.view;
    cancelGraphReveal();
    setCameraImmediately(snapshot.camera);
    needsInitialFitRef.current = false;
    settledFitRef.current = false;
    setFilters(normalizeGraphFilters(view.filters));
    setShowIsolated(view.showIsolated ?? true);
    setNearbyFilter(view.nearbyFilter ?? false);
    setNearbyDepth(view.nearbyDepth === 2 ? 2 : 1);
    setColorModeState(view.colorMode || 'type');
    setShowArrows(view.showArrows ?? false);
    setShowLabels(view.showLabels ?? true);
    setLabelReveal(readSavedLabelReveal(view));
    setNodeSize(clampGraphNumber(view.nodeSize, 6, 3, 12));
    setEdgeWidth(clampGraphNumber(view.edgeWidth, 1, .5, 4));
    setCenterForce(readSavedForceControl(view, 'centerForce'));
    setRepulsionForce(readSavedForceControl(view, 'repulsionForce'));
    setLinkAttraction(readSavedForceControl(view, 'linkAttraction'));
    setLinkLength(clampGraphNumber(view.linkLength, GRAPH_REST_LENGTH, GRAPH_LINK_LENGTH_MIN, GRAPH_LINK_LENGTH_MAX));
    setNodeSpacing(clampGraphNumber(view.nodeSpacing, INITIAL_PARAMS.nodeSpacing, GRAPH_FORCE_CONTROL_MIN, GRAPH_FORCE_CONTROL_MAX));
    colorGroupsRef.current = normalizeGraphColorGroups(view.colorGroups);
    sectionsRef.current = normalizeGraphSections(view.sections);
    setColorGroups(colorGroupsRef.current);
    setSideOpen(snapshot.sideOpen ?? false);
    setNodeQuery(snapshot.searchQuery || '');
    setGraphSearchScope(snapshot.searchScope || null);
    searchScopeNodeKeysRef.current = snapshot.searchScope ? new Set(snapshot.searchScope.nodeKeys) : null;
    pendingSelectionRef.current = snapshot.focusedKey || null;
    focusedNodeRef.current = nodesRef.current.find(node => node.key === snapshot.focusedKey) || null;
    pendingRelationRef.current = snapshot.relationSourceKey || null;
    setRelationSource(nodesRef.current.find(node => node.key === snapshot.relationSourceKey) || null);
    const positions = new Map(snapshot.positions.map(node => [node.key, node]));
    initialPositionsRef.current = positions;
    for (const node of nodesRef.current) { const next = positions.get(node.key); if (next) Object.assign(node, next); }
    physicsGenerationRef.current += 1;
    if (snapshot.playback && restoredPlayback) installPlaybackSession(snapshot.playback, restoredPlayback);
    markGraphDirty('scene', 'layout', 'viewport');
  };
  const sessionHandleRef = useRef({ capture: captureSession, restore: restoreSession });
  sessionHandleRef.current = { capture: captureSession, restore: restoreSession };
  useEffect(() => {
    if (!sessionId || runtime) return;
    return graphSessionStore.registerView(sessionId, {
      capture: () => sessionHandleRef.current.capture(),
      restore: snapshot => sessionHandleRef.current.restore(snapshot),
    });
  }, [sessionId, runtime]);

  useLayoutEffect(() => {
    if (!presentation || !runtime || presentation.identity.viewId !== paneId || presentation.identity.vaultId !== runtime.vaultId) return;
    return presentation.attach({
      scene: () => {
        const loaded = loadedGraphProofRef.current;
        return loaded && loaded.runtime === runtime && sceneSeedRef.current === loaded.seed
          && lastPaintReadyRef.current ? { seed: loaded.seed, proof: loaded.proof } : null;
      },
      capture: () => sessionHandleRef.current.capture(),
      restore: snapshot => sessionHandleRef.current.restore(snapshot),
      flush: async () => {
        if (runtime.flush && !await runtime.flush()) return false;
        if (!presentationFrozenRef.current) applyPendingInputs();
        flushGraphView();
        return Boolean(loadedGraphProofRef.current && lastPaintReadyRef.current);
      },
      freeze: frozen => {
        runtime.setFrozen?.(frozen);
        setGraphPresentationFrozen(frozen);
      },
      requestPaint: () => {
        presentationCommitRef.current = false;
        setPresentationPaintVersion(version => version + 1);
      },
    });
  }, [presentation, runtime, paneId, applyPendingInputs, flushGraphView, setGraphPresentationFrozen, requestGraphFrame]);
  useLayoutEffect(() => {
    presentationCommitRef.current = true;
    if (presentationPaintVersion) requestGraphFrame('scene', 'layout', 'viewport');
  }, [presentationPaintVersion, requestGraphFrame]);

  const mainNativeHandleRef = useRef({
    freeze: () => {}, unfreeze: () => {}, flush: async () => false, restore: (_snapshot: GraphSessionSnapshot) => {},
  });
  mainNativeHandleRef.current = {
    freeze: () => setGraphPresentationFrozen(true),
    unfreeze: () => setGraphPresentationFrozen(false),
    flush: async () => { if (graphMutationPendingRef.current || missingDocumentCreationRef.current.size) return false; if (!presentationFrozenRef.current) applyPendingInputs(); flushGraphView(); return Boolean(mainGraphSourceRef.current?.verified && mainGraphPaintedSeedRef.current === graphSeedRef.current); },
    restore: snapshot => { sessionHandleRef.current.restore(snapshot); presentationCommitRef.current = false; setPresentationPaintVersion(version => version + 1); },
  };
  useLayoutEffect(() => {
    if (!sessionId || runtime) return;
    const binding = (): GraphNativeViewBinding => {
      const held = mainGraphSourceRef.current;
      if (!held || graphSeedRef.current !== held.seed || sceneSeedRef.current !== held.seed) throw Error('workspace-graph-main-source-unavailable');
      return { viewId: sessionId, vaultId: held.vault.id, title: held.vault.name, generation: held.generation, sourceId: held.verified?.sourceId, materialLibraryId: held.materialLibraryId, materialLibraryGeneration: held.materialLibraryGeneration, materialSourceVersion: held.materialSourceVersion, vault: { ...held.vault } };
    };
    const baseline = (expected: ScopedGraphSnapshot) => {
      const held = mainGraphSourceRef.current, bound = binding();
      if (!held?.verified || expected.revision !== held.verified.revision || !bound.sourceId || expected.sourceId !== bound.sourceId || expected.vaultId !== bound.vaultId
        || !sameNativeGraphSeed(held.seed, expected) || mainGraphPaintedSeedRef.current !== held.seed) throw Error('workspace-graph-main-proof-mismatch');
      return { held, source: graphNativeIdentity(bound), proof: { kind: 'graph' as const, snapshotId: expected.snapshotId, revision: expected.revision, sourceId: expected.sourceId } };
    };
    const unlock = async () => { if (mainGraphApplyRef.current) { mainGraphApplyRef.current.reject(Error('workspace-graph-main-presentation-aborted')); mainGraphApplyRef.current = null; } mainNativeHandleRef.current.unfreeze(); };
    return graphNativeViews.register(sessionId, {
      binding,
      freeze: () => mainNativeHandleRef.current.freeze(),
      flush: () => mainNativeHandleRef.current.flush(),
      capture: async expected => {
        const checked = baseline(expected), state = sessionHandleRef.current.capture();
        if (!validateGraphSessionSnapshot(state)) throw Error('workspace-graph-presentation-invalid');
        assertGraphPresentationSceneState(state, checked.held.seed);
        return { version: 1, kind: 'graph', captureId: `${sessionId}:${checked.source.generation}:${++mainGraphCaptureSequenceRef.current}`, source: checked.source, proof: checked.proof, state: JSON.parse(JSON.stringify(state)) };
      },
      restore: (expected, snapshot, expectedSource, presentationHash) => {
        const checked = baseline(expected);
        if (!validateGraphViewPresentation(snapshot) || !sameGraphViewIdentity(snapshot.source, expectedSource) || (presentationHash !== undefined && (typeof presentationHash !== 'string' || !presentationHash || presentationHash.length > 256)) || snapshot.source.vaultId !== checked.source.vaultId
          || snapshot.source.sourceId !== checked.source.sourceId || snapshot.proof.sourceId !== checked.proof.sourceId || snapshot.proof.revision !== checked.proof.revision) return Promise.reject(Error('workspace-graph-main-presentation-scope-mismatch'));
        if (mainGraphApplyRef.current) return Promise.reject(Error('workspace-graph-main-presentation-busy'));
        assertGraphPresentationSceneState(snapshot.state, checked.held.seed);
        const captured = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
        mainNativeHandleRef.current.freeze();
        mainNativeHandleRef.current.restore(captured.state);
        return new Promise((resolve, reject) => { mainGraphApplyRef.current = { seed: checked.held.seed, generation: checked.held.generation, state: captured.state, resolve, reject,
          acknowledgment: { kind: 'graph', captureId: captured.captureId, source: captured.source, target: checked.source, sourceProof: captured.proof, proof: checked.proof, ...(presentationHash ? { presentationHash } : {}) } }; });
      },
      release: async () => { mainNativeHandleRef.current.freeze(); },
      commitRelease: async () => { if (!presentationFrozenRef.current) throw Error('workspace-graph-main-release-not-frozen'); if (!graphSessionStore.releaseNative(sessionId)) throw Error('workspace-graph-main-release-failed'); },
      activate: async () => { graphSessionStore.select(sessionId); await unlock(); },
      abort: unlock,
    });
  }, [sessionId, runtime, requestGraphFrame]);
  useEffect(() => {
    if (runtime) return;
    return graphNativeViews.onVerifierInstalled(() => { void loadGraphData({ preserveLayout: true }); });
  }, [runtime, loadGraphData]);

  const splitCurrentView = (orientation: 'row' | 'column') => {
    setMoreOpen(false);
    onSplit?.(paneId, orientation, captureSession());
  };

  const downloadGraphScreenshot = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `luckyray-graph-${Date.now()}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const copyCurrentView = useCallback(async () => {
    setMoreOpen(false);
    const canvas = canvasRef.current;
    if (runtime && (!runtime.capability('screenshot').available || !runtime.exportScreenshot)) {
      showNotice(graphText('screenshotUnavailable'));
      return;
    }
    if (!canvas) {
      showNotice(t("editor.graph.status.screenshotNotReady"));
      return;
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      showNotice(t("editor.graph.status.screenshotFailed"));
      return;
    }
    if (runtime) {
      try {
        const result = await runtime.exportScreenshot!(blob);
        if (result !== 'copied' && result !== 'saved') throw new Error('workspace-graph-screenshot-unconfirmed');
        showNotice(result === 'copied' ? t("editor.graph.status.screenshotCopied") : graphText("screenshotSaved"));
      } catch (error) { showNotice(String(error)); }
      return;
    }
    try {
      if (!navigator.clipboard?.write || !("ClipboardItem" in window)) throw new Error("image clipboard unsupported");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showNotice(t("editor.graph.status.screenshotCopied"));
    } catch {
      downloadGraphScreenshot(blob);
      showNotice(t("editor.graph.status.screenshotDownloaded"));
    }
  }, [downloadGraphScreenshot, graphText, showNotice, t, runtime]);

  const togglePlaying = useCallback(() => {
    if (prefersReducedMotion()) {
      cancelGraphReveal();
      paramsRef.current.alpha = 0;
      markGraphDirty("scene", "layout");
      showNotice(t("editor.graph.status.reducedMotion"));
      return;
    }
    rebuildSceneCache();
    const scene = sceneCacheRef.current;
    const timeline = buildGraphPlaybackPlan({
      startedAt: performance.now(),
      nodes: scene.visibleNodes
        .filter((node) => !node.hidden)
        .map((node) => ({
          id: node.id,
          x: node.x,
          y: node.y,
          links: node.links,
          timelineAt: node.timelineAt,
        })),
      edges: scene.visibleEdges
        .filter((edge) => !edge.a.hidden && !edge.b.hidden)
        .map((edge) => ({ a: edge.a.id, b: edge.b.id })),
    });
    if (!timeline) {
      showNotice(t("editor.graph.status.noPlayback"));
      return;
    }
    // Starting again deliberately replaces an in-flight reveal from frame zero.
    paramsRef.current.alpha = Math.max(paramsRef.current.alpha, 0.24);
    revealTimelineRef.current = timeline;
    revealActivatedNodeIdsRef.current.clear();
    revealActiveRef.current = true;
    playbackCameraFollowRef.current = true;
    cameraZoomAnchorRef.current = null;
    cancelCameraInertia();
    setPlaying(true);
    markGraphDirty("scene", "layout");
  }, [cancelCameraInertia, cancelGraphReveal, markGraphDirty, rebuildSceneCache, showNotice, t]);

  const tagRelationMenuState = relationSource && nodeMenu && isEditableGraphRelationPair(relationSource, nodeMenu.node)
    ? {
      connected: graphNodesAreConnected(edgesRef.current, relationSource, nodeMenu.node),
      source: relationSource,
      target: nodeMenu.node,
    }
    : null;
  const bodyRelationMenuState = relationSource && nodeMenu && isEditableGraphBodyRelationPair(relationSource, nodeMenu.node)
    ? {
      connected: graphNodesAreConnected(edgesRef.current, relationSource, nodeMenu.node),
      source: relationSource,
      target: nodeMenu.node,
    }
    : null;

  useLayoutEffect(() => {
    const menu = nodeMenuRef.current;
    const container = containerRef.current;
    if (!nodeMenu || !menu || !container) return;

    const updatePosition = () => {
      const next = clampGraphNodeMenuPosition(
        nodeMenu.x,
        nodeMenu.y,
        menu.offsetWidth,
        menu.offsetHeight,
        container.clientWidth,
        container.clientHeight,
      );
      setNodeMenuPosition((current) => current.left === next.left && current.top === next.top ? current : next);
    };

    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(container);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [bodyRelationMenuState?.connected, nearbyFilter, nodeMenu, relationSource?.id, tagRelationMenuState?.connected]);

  return (
    <div
      className={`graph-pane${active ? " active" : ""}`}
      data-graph-pane={paneId}
      data-graph-frozen={presentationFrozen || undefined}
      inert={presentationFrozen || undefined}
      onPointerDownCapture={event => { if (presentationFrozenRef.current) { event.preventDefault(); event.stopPropagation(); } else onActivate(paneId); }}
      onKeyDownCapture={event => { if (presentationFrozenRef.current) { event.preventDefault(); event.stopPropagation(); } }}
    >
      {!primary && !headerInTitlebar && (
        <div className="graph-pane-header" onPointerDown={(event) => event.stopPropagation()}>
          <div className={`graph-pane-tab${active ? " active" : ""}`}>
            <button
              type="button"
              className="graph-pane-tab-select"
              onClick={() => onActivate(paneId)}
              aria-current={active ? "page" : undefined}
              title={t("editor.graph.action.activate")}
            >
              <span>{t("editor.graph.title")}</span>
            </button>
            {canClose && (
              <button
                type="button"
                className="graph-pane-close"
                onClick={(event) => {
                  event.stopPropagation();
                  if (!onClose(paneId)) showNotice(t("editor.graph.action.closePane"));
                }}
                aria-label={t("editor.graph.action.closePane")}
                title={t("editor.graph.action.closePane")}
              >
                {iconClose()}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="graph-container" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="graph-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
          onMouseDown={suppressMiddleAutoScroll}
          onAuxClick={handleAuxClick}
          onContextMenu={handleContextMenu}
        />

        {graphStatus !== "real" && (
          <div className={`graph-status${graphStatus === "error" ? " error" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
            <span>
              {graphStatus === "loading" && t("editor.graph.status.building")}
              {graphStatus === "empty" && t("editor.graph.status.empty")}
              {graphStatus === "error" && t("editor.graph.status.loadFailed")}
            </span>
            {graphStatus === "error" && (
              <button type="button" onClick={() => void loadGraphData({ refresh: true })}>{t("editor.graph.action.retry")}</button>
            )}
          </div>
        )}

        {(nearbyFilter || relationSource) && (
          <div className="graph-context-scopes" onPointerDown={(event) => event.stopPropagation()}>
            {nearbyFilter && (
              <div className="graph-context-scope">
                <span>{t("editor.graph.mode.local", { hops: nearbyDepth })}</span>
                <button type="button" onClick={showFullGraph} title={t("editor.graph.action.fullGraph")} aria-label={t("editor.graph.action.fullGraph")}>
                  {iconClose()}
                </button>
              </div>
            )}
            {relationSource && (
              <div className="graph-context-scope">
                <span title={relationSource.label}>{t("editor.graph.origin", { label: relationSource.label })}</span>
                <button type="button" onClick={clearRelationStart} title={t("editor.graph.action.cancelOrigin")} aria-label={t("editor.graph.action.cancelOrigin")}>
                  {iconClose()}
                </button>
              </div>
            )}
          </div>
        )}

        {tooltip && (
          <div
            ref={tooltipRef}
            className="graph-tooltip show"
            style={{ transform: `translate3d(${tooltipPositionRef.current.x}px, ${tooltipPositionRef.current.y}px, 0)` }}
          >
            <div className="graph-tooltip-title">{tooltip.title}</div>
            <div className="graph-tooltip-meta">{tooltip.meta}</div>
          </div>
        )}

        <button
          className={`graph-more-toggle${sideOpen ? " hidden" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            setMoreOpen((current) => !current);
          }}
          title={t("editor.graph.action.more")}
        >
          <svg viewBox="0 0 16 16"><circle cx="8" cy="4" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="12" r="1.2" fill="currentColor" /></svg>
        </button>
        <div
          className={`graph-more-menu${moreOpen ? " show" : ""}`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {onSplit && <>
          <button className="graph-more-item" onClick={() => splitCurrentView("row")}>
            <svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M8 3v10" /></svg>{t("editor.graph.action.splitHorizontal")}
          </button>
          <button className="graph-more-item" onClick={() => splitCurrentView("column")}>
            <svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 8h11" /></svg>{t("editor.graph.action.splitVertical")}
          </button>
          <div className="graph-more-separator" />
          </>}
          {onDuplicate && <button className="graph-more-item" onClick={() => { setMoreOpen(false); onDuplicate(); }}>
            <svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M3 10V3h7" /></svg>{graphText('duplicateTab')}
          </button>}
          <button className="graph-more-item" onClick={() => void copyCurrentView()}>
            <svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1" /><path d="M5 10h6M5 8h6" /></svg>{t("editor.graph.action.duplicate")}
          </button>
          {canClose && (
            <>
              <div className="graph-more-separator" />
              <button className="graph-more-item" onClick={closeCurrentView}>
                <svg viewBox="0 0 16 16"><line x1="3" y1="3" x2="13" y2="13" /><line x1="13" y1="3" x2="3" y2="13" /></svg>{t("editor.graph.action.closePane")}
              </button>
            </>
          )}
        </div>

        {nodeMenu && (
          <div ref={nodeMenuRef} className="graph-node-menu show" style={{ left: nodeMenuPosition.left, top: nodeMenuPosition.top }} onPointerDown={(event) => event.stopPropagation()}>
            <div className="graph-node-menu-title">
              <span className="graph-node-menu-dot" style={{ background: TYPE_COLORS[nodeMenu.node.type] }} />
              <span>{nodeMenu.node.label}</span>
            </div>
            <div className="graph-node-menu-separator" />
            <button className="graph-node-menu-item" disabled={runtimeActionUnavailable(isMissingGraphNode(nodeMenu.node) ? "createMissing" : "open", nodeMenu.node)} onClick={() => openGraphNode(nodeMenu.node)}>
              <svg viewBox="0 0 16 16"><path d="M6 3h7v7M13 3 6 10" /><path d="M12 12H4V4" /></svg>
              {isMissingGraphNode(nodeMenu.node) ? t("editor.graph.action.createDocument") : t("editor.graph.action.openNode")}
            </button>
            {(runtime ? runtime.capability("openDefault", nodeMenu.node).available || runtime.capability("reveal", nodeMenu.node).available : resolveGraphLocalPath(nodeMenu.node)) && (
              <>
                <button className="graph-node-menu-item" disabled={runtimeActionUnavailable("openDefault", nodeMenu.node)} onClick={() => void openGraphLocalPath(nodeMenu.node, "open")}>
                  <svg viewBox="0 0 16 16"><path d="M6 3h7v7M13 3 6 10" /><path d="M12 12H4V4" /></svg>
                  {t("editor.graph.action.openDefault")}
                </button>
                <button className="graph-node-menu-item" disabled={runtimeActionUnavailable("reveal", nodeMenu.node)} onClick={() => void openGraphLocalPath(nodeMenu.node, "reveal")}>
                  <svg viewBox="0 0 16 16"><path d="M2.5 5h4l1.2 1.3h5.8v6.2h-11z" /><path d="M2.5 5V3.5h4l1 1h3" /></svg>
                  {t("editor.graph.action.reveal")}
                </button>
              </>
            )}
            <button className="graph-node-menu-item" onClick={() => focusAroundNode(nodeMenu.node)}>
              <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.5" /></svg>
              {t("editor.graph.action.only")} {nearbyDepth} {t("editor.graph.action.nearby")}
            </button>
            {nearbyFilter && (
              <button className="graph-node-menu-item" onClick={showFullGraph}>
                <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" /><path d="M5 8h6" /></svg>
                {t("editor.graph.action.fullGraph")}
              </button>
            )}
            <button className="graph-node-menu-item" onClick={clearFocusedNode}>
              <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" /><path d="m5.5 5.5 5 5M10.5 5.5l-5 5" /></svg>
              {t("editor.graph.action.clearSelection")}
            </button>
            {nodeMenu.node.type !== "web" && !isMissingGraphNode(nodeMenu.node) && (
              <button
                className="graph-node-menu-item"
                onClick={() => relationSource?.id === nodeMenu.node.id ? clearRelationStart() : selectRelationStart(nodeMenu.node)}
              >
                <svg viewBox="0 0 16 16"><circle cx="5" cy="8" r="2.2" /><circle cx="11" cy="8" r="2.2" /><path d="M7.2 8h1.6" /></svg>
                {relationSource?.id === nodeMenu.node.id ? t("editor.graph.action.cancelOrigin") : t("editor.graph.action.setOrigin")}
              </button>
            )}
            {relationSource && relationSource.id !== nodeMenu.node.id && (
              <button className="graph-node-menu-item" onClick={clearRelationStart}>
                <svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>
                {t("editor.graph.action.clearCurrentOrigin")}
              </button>
            )}
            {tagRelationMenuState && (!runtime || runtime.capability("tagRelation", relationSource || undefined).available && runtime.capability("tagRelation", tagRelationMenuState.target).available) && (
              <button className="graph-node-menu-item" onClick={() => void editTagRelation(tagRelationMenuState.target, tagRelationMenuState.connected ? "disconnect" : "connect")}>
                <svg viewBox="0 0 16 16"><path d="M6.5 5.5 5.2 4.2a2.5 2.5 0 0 0-3.5 3.5l1.6 1.6a2.5 2.5 0 0 0 3.5 0" /><path d="M9.5 10.5l1.3 1.3a2.5 2.5 0 0 0 3.5-3.5l-1.6-1.6a2.5 2.5 0 0 0-3.5 0" /><path d="M5.8 10.2l4.4-4.4" /></svg>
                {tagRelationMenuState.connected ? t("editor.graph.action.disconnect") : t("editor.graph.action.connect")}
              </button>
            )}
            {bodyRelationMenuState && (!runtime || runtime.capability("bodyRelation").available) && (
              <>
                <button className="graph-node-menu-item" onClick={() => void editBodyRelation(bodyRelationMenuState.target, "connect")}>
                  <svg viewBox="0 0 16 16"><path d="M3.5 4.5h4l1 1h4v6h-9z" /><path d="M5 8h6" /><path d="M5 10h4" /></svg>
                  {t("editor.graph.action.connectBody")}
                </button>
                {bodyRelationMenuState.connected && (
                  <button className="graph-node-menu-item" onClick={() => void editBodyRelation(bodyRelationMenuState.target, "disconnect")}>
                    <svg viewBox="0 0 16 16"><path d="M6.5 5.5 5.2 4.2a2.5 2.5 0 0 0-3.5 3.5l1.6 1.6a2.5 2.5 0 0 0 3.5 0" /><path d="M9.5 10.5l1.3 1.3a2.5 2.5 0 0 0 3.5-3.5l-1.6-1.6a2.5 2.5 0 0 0-3.5 0" /><path d="M5.8 10.2l4.4-4.4" /></svg>
                    {t("editor.graph.action.disconnectBody")}
                  </button>
                )}
              </>
            )}
            <button className="graph-node-menu-item" onClick={() => copyNodeLabel(nodeMenu.node)}>
              <svg viewBox="0 0 16 16"><rect x="5" y="3" width="8" height="10" rx="1" /><path d="M3 6v7h7" /></svg>
              {t("editor.graph.action.copyName")}
            </button>
            <button className="graph-node-menu-item" disabled={runtimeActionUnavailable("askAi", nodeMenu.node)} onClick={() => askAiAboutNode(nodeMenu.node)}>
              <svg viewBox="0 0 16 16"><path d="M8 2.5 9.2 6.2 13 8 9.2 9.8 8 13.5 6.8 9.8 3 8 6.8 6.2Z" /></svg>
              {t("editor.graph.action.sendLightSeek")}
            </button>
          </div>
        )}

        <button className={`graph-side-toggle${sideOpen ? " hidden" : ""}`} onClick={() => setSideOpen(true)} title={t("editor.graph.action.settings")}>
          <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.3 3.3l1 1M11.7 11.7l1 1M3.3 11.7l1-1M11.7 3.3l1-1" /></svg>
        </button>

        <button className={`graph-anim-toggle${sideOpen ? " hidden" : ""}`} onClick={togglePlaying} title={playing ? t("editor.graph.action.replay") : t("editor.graph.action.play")}>
          {playIcon()}
        </button>

        <div className={`graph-side-panel${sideOpen ? " open" : ""}`}>
          <div className="graph-side-panel-inner">
            <div className="graph-side-header">
              <span className="graph-side-title">{t("editor.graph.action.settings")}</span>
              <button className="graph-side-close" onClick={() => setSideOpen(false)}>{iconClose()}</button>
            </div>

            <div className="graph-side-section graph-node-finder">
              <div className="graph-side-label">{t("editor.graph.search.title")}</div>
              <div className="graph-find-input-wrap">
                <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3 3" /></svg>
                <input
                  ref={findInputRef}
                  value={nodeQuery}
                  onChange={(event) => {
                    setNodeQuery(event.target.value);
                    setFindActiveIndex(0);
                  }}
                  onKeyDown={handleNodeSearchKeyDown}
                  placeholder={t("editor.graph.search.placeholder")}
                  aria-label={t("editor.graph.search.aria")}
                  aria-controls={`graph-find-results-${paneId}`}
                />
              </div>
              {normalizedNodeQuery && (
                <div id={`graph-find-results-${paneId}`} className="graph-find-results" role="listbox" aria-label={t("editor.graph.search.results")}>
                  {nodeSearchResults.length ? nodeSearchResults.map((result, index) => (
                    <button
                      key={result.key}
                      className={`graph-find-result${index === findActiveIndex ? " active" : ""}`}
                      role="option"
                      aria-selected={index === findActiveIndex}
                      onMouseEnter={() => setFindActiveIndex(index)}
                      onClick={() => applyGraphSearchResult(result)}
                    >
                      <span>{result.label}</span>
                      <small>{result.secondary}</small>
                    </button>
                  )) : (
                    <div className="graph-find-empty">{t("editor.graph.search.empty")}</div>
                  )}
                </div>
              )}
              {graphSearchScope && (
                <div className="graph-search-scope">
                  <span>{graphSearchScope.kind === "folder" ? t("editor.graph.search.folder") : t("editor.graph.search.document")}：{graphSearchScope.label}</span>
                  <button type="button" onClick={clearGraphSearchScope} title={t("editor.graph.search.clearScope")} aria-label={t("editor.graph.search.clearScope")}>×</button>
                </div>
              )}
            </div>

            <details className="graph-side-section graph-force-details" open={sectionsRef.current.filter ?? true} onToggle={event => { sectionsRef.current.filter = event.currentTarget.open; saveGraphView(); }}>
              <summary><span className="graph-side-label">{t("editor.graph.section.filter")}</span></summary>
              {(["material", "note", "tag", "web"] as GraphType[]).map((type) => (
                <button key={type} className="graph-side-row" onClick={() => toggleFilter(type)}>
                  <span className={`graph-side-toggle-btn${filters[type] ? " on" : ""}`} />
                  {t(`editor.graph.type.${type}`)}
                </button>
              ))}
              <button className="graph-side-row" onClick={toggleIsolatedNodes}>
                <span className={`graph-side-toggle-btn${showIsolated ? " on" : ""}`} />
                {t("editor.graph.filter.isolated")}
              </button>
              <div className="graph-side-sep" />
              <button className="graph-side-row" onClick={toggleNearby}>
                <span className={`graph-side-toggle-btn${nearbyFilter ? " on" : ""}`} />
                {t("editor.graph.filter.nearbyOnly")}
              </button>
              {nearbyFilter && (
                <div className="graph-nearby-depth" role="group" aria-label={t("editor.graph.filter.range")}>
                  <span>{t("editor.graph.filter.rangeAria")}</span>
                  <div>
                    <button type="button" className={nearbyDepth === 1 ? "active" : ""} onClick={() => setNearbyDepthValue(1)}>{t("editor.graph.filter.oneHop")}</button>
                    <button type="button" className={nearbyDepth === 2 ? "active" : ""} onClick={() => setNearbyDepthValue(2)}>{t("editor.graph.filter.twoHops")}</button>
                  </div>
                </div>
              )}
              {relationSource && (
                <button className="graph-side-row" onClick={clearRelationStart} title={t("editor.graph.relationOrigin.cancel", { label: relationSource.label })}>
                  <span className="graph-side-row-action">×</span>
                  {t("editor.graph.action.cancelOrigin")}
                </button>
              )}
            </details>

            <details className="graph-side-section graph-force-details" open={sectionsRef.current.appearance ?? true} onToggle={event => { sectionsRef.current.appearance = event.currentTarget.open; saveGraphView(); }}>
              <summary><span className="graph-side-label">{t("editor.graph.section.appearance")}</span></summary>
              <div className="graph-side-row">
                <select className="graph-side-select" value={colorMode} onChange={(event) => setColorMode(event.target.value as GraphParams["colorMode"])}>
                  <option value="default">{t("editor.graph.color.default")}</option>
                  <option value="type">{t("editor.graph.color.type")}</option>
                  <option value="degree">{t("editor.graph.color.degree")}</option>
                </select>
              </div>
              <button className="graph-side-row" onClick={() => {
              const next = !showArrows;
              setShowArrows(next);
              updateParam("showArrows", next);
              saveGraphView();
            }}>
                <span className={`graph-side-toggle-btn${showArrows ? " on" : ""}`} />
                {t("editor.graph.appearance.arrows")}
              </button>
              <button className="graph-side-row" onClick={() => {
              const next = !showLabels;
              setShowLabels(next);
              updateParam("showLabels", next);
              saveGraphView();
            }}>
                <span className={`graph-side-toggle-btn${showLabels ? " on" : ""}`} />
                {t("editor.graph.appearance.labels")}
              </button>
              <div className="graph-side-slider-row graph-side-slider-row-bounded">
                <span className="graph-side-slider-name">{t("editor.graph.appearance.fade")}</span>
                <span className="graph-side-slider-hint" aria-hidden="true">{t("editor.graph.appearance.fadeEarly")}</span>
                <input
                  aria-label={t("editor.graph.appearance.fadeHelp")}
                  title={t("editor.graph.appearance.fadeAria")}
                  className="graph-side-slider"
                  type="range"
                  min="0"
                  max={GRAPH_LABEL_REVEAL_MAX}
                  step="0.05"
                  value={labelReveal}
                  style={rangeFillStyle(labelReveal, 0, GRAPH_LABEL_REVEAL_MAX)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setLabelReveal(value);
                    updateParam("labelReveal", value);
                    saveGraphView();
                  }}
                />
                <span className="graph-side-slider-hint" aria-hidden="true">{t("editor.graph.appearance.fadeLate")}</span>
              </div>
              <div className="graph-side-slider-row graph-side-slider-row-bounded">
                <span className="graph-side-slider-name">{t("editor.graph.appearance.node")}</span>
                <span className="graph-side-slider-hint" aria-hidden="true">{t("editor.graph.appearance.small")}</span>
                <input
                  aria-label={t("editor.graph.appearance.nodeSize")}
                  className="graph-side-slider"
                  type="range"
                  min="3"
                  max="12"
                  value={nodeSize}
                  style={rangeFillStyle(nodeSize, 3, 12)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setNodeSize(value);
                    updateParam("nodeSizeMultiplier", value / 6);
                    saveGraphView();
                  }}
                />
                <span className="graph-side-slider-hint" aria-hidden="true">{t("editor.graph.appearance.large")}</span>
              </div>
              <div className="graph-side-slider-row graph-side-slider-row-bounded">
                <span className="graph-side-slider-name">{t("editor.graph.appearance.edge")}</span>
                <span className="graph-side-slider-hint" aria-hidden="true">{t("editor.graph.appearance.thin")}</span>
                <input
                  aria-label={t("editor.graph.appearance.edgeWidth")}
                  className="graph-side-slider"
                  type="range"
                  min="0.5"
                  max="4"
                  step="0.5"
                  value={edgeWidth}
                  style={rangeFillStyle(edgeWidth, 0.5, 4)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setEdgeWidth(value);
                    updateParam("edgeWidthBase", value);
                    saveGraphView();
                  }}
                />
                <span className="graph-side-slider-hint" aria-hidden="true">{t("editor.graph.appearance.thick")}</span>
              </div>
            </details>

            <details className="graph-side-section graph-force-details" open={sectionsRef.current.groups ?? false} onToggle={event => { sectionsRef.current.groups = event.currentTarget.open; saveGraphView(); }}>
              <summary><span className="graph-side-label">{graphText('groups')}</span></summary>
              <GraphColorGroups groups={colorGroups} onChange={groups => { colorGroupsRef.current = groups; setColorGroups(groups); markGraphDirty('scene'); saveGraphView(); }} />
            </details>
            <details className="graph-side-section graph-force-details" open={sectionsRef.current.force ?? false} onToggle={event => { sectionsRef.current.force = event.currentTarget.open; saveGraphView(); }}>
              <summary>
                <span className="graph-side-label">{t("editor.graph.section.force")}</span>
              </summary>
              <p className="graph-force-copy">{t("editor.graph.force.help")}</p>
              <div className="graph-side-slider-row">
                <span className="graph-side-slider-name">{t("editor.graph.force.center")}</span>
                <input
                  aria-label={t("editor.graph.force.centerAria")}
                  title={t("editor.graph.force.centerHelp")}
                  className="graph-side-slider"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={centerForce}
                  style={rangeFillStyle(centerForce, 0, 100)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setCenterForce(value);
                    updateParam("centerForce", value);
                    reheatGraphLayout();
                  }}
                />
                <span className="graph-side-slider-value">{t(`editor.graph.level.${graphForceLevel(centerForce)}`)}</span>
              </div>
              <div className="graph-side-slider-row">
                <span className="graph-side-slider-name">{t("editor.graph.force.repulsion")}</span>
                <input
                  aria-label={t("editor.graph.force.repulsionAria")}
                  title={t("editor.graph.force.repulsionHelp")}
                  className="graph-side-slider"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={repulsionForce}
                  style={rangeFillStyle(repulsionForce, 0, 100)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setRepulsionForce(value);
                    updateParam("repulsionForce", value);
                    reheatGraphLayout();
                  }}
                />
                <span className="graph-side-slider-value">{t(`editor.graph.level.${graphForceLevel(repulsionForce)}`)}</span>
              </div>
              <div className="graph-side-slider-row">
                <span className="graph-side-slider-name">{t("editor.graph.force.attraction")}</span>
                <input
                  aria-label={t("editor.graph.force.attractionAria")}
                  title={t("editor.graph.force.attractionHelp")}
                  className="graph-side-slider"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={linkAttraction}
                  style={rangeFillStyle(linkAttraction, 0, 100)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setLinkAttraction(value);
                    updateParam("linkAttraction", value);
                    reheatGraphLayout();
                  }}
                />
                <span className="graph-side-slider-value">{t(`editor.graph.level.${graphForceLevel(linkAttraction)}`)}</span>
              </div>
              <div className="graph-side-slider-row">
                <span className="graph-side-slider-name">{t("editor.graph.force.length")}</span>
                <input
                  aria-label={t("editor.graph.force.lengthAria")}
                  title={t("editor.graph.force.lengthHelp")}
                  className="graph-side-slider"
                  type="range"
                  min={GRAPH_LINK_LENGTH_MIN}
                  max={GRAPH_LINK_LENGTH_MAX}
                  step="2"
                  value={linkLength}
                  style={rangeFillStyle(linkLength, GRAPH_LINK_LENGTH_MIN, GRAPH_LINK_LENGTH_MAX)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setLinkLength(value);
                    updateParam("linkLength", value);
                    reheatGraphLayout();
                  }}
                />
                <span className="graph-side-slider-value">{t(`editor.graph.level.${graphLinkLengthLevel(linkLength)}`)}</span>
              </div>
              <div className="graph-side-slider-row">
                <span className="graph-side-slider-name">{t("editor.graph.force.spacing")}</span>
                <input
                  aria-label={t("editor.graph.force.spacingAria")}
                  title={t("editor.graph.force.spacingHelp")}
                  className="graph-side-slider"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={nodeSpacing}
                  style={rangeFillStyle(nodeSpacing, 0, 100)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setNodeSpacing(value);
                    updateParam("nodeSpacing", value);
                    reheatGraphLayout(0.26, true);
                  }}
                />
                <span className="graph-side-slider-value">{t(`editor.graph.level.${graphNodeSpacingLevel(nodeSpacing)}`)}</span>
              </div>
            </details>
            <div className="graph-side-section graph-side-actions">
              <div className="graph-side-button-row">
                <button className="graph-side-btn" onClick={focusCurrent}>{t("editor.graph.action.resetFocus")}</button>
                <button className="graph-side-btn" onClick={resetGraph}>{t("editor.graph.action.resetView")}</button>
              </div>
              <button className="graph-side-play-btn" onClick={togglePlaying}>
                {playIcon()}
                <span>{playing ? t("editor.graph.action.replay") : t("editor.graph.action.play")}</span>
              </button>
            </div>
          </div>
        </div>

        {notice && <div className="graph-toast">{notice}</div>}
      </div>
    </div>
  );
}

export default function GraphPage({visible:routeVisible=true}:{visible?:boolean}={}) {
  const { t } = useI18n();
  const { t: graphText } = useMessages(graphMessages);
  const interactionFrozen=useSyncExternalStore(graphNativeViews.subscribe,graphNativeViews.hasFrozenViews);
  const selectView=(id:string)=>{if(!graphNativeViews.hasFrozenViews())graphSessionStore.select(id);};
  const closeView=(id:string)=>graphNativeViews.hasFrozenViews()?false:graphSessionStore.close(id);
  const state = useSyncExternalStore(graphSessionStore.subscribe, graphSessionStore.getSnapshot);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const dividerDragRef = useRef<{ split: GraphSplitRect; pointerId: number; left: number; top: number; target: HTMLDivElement } | null>(null);
  const geometry = graphSessionRects(state.layout, size.width, size.height);
  const grouped = state.groups.length > 1;
  const title = (tab: { title: string; number: number }) => tab.title || (tab.number === 1 ? t('sidebar.graph.title') : t('sidebar.graph.numberedTitle', { number: tab.number }));

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => { const rect = host.getBoundingClientRect(); setSize(current => current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => registerIntegratedLayout('graph', graphSessionStore), []);
  useEffect(() => graphNativeViews.registerReceiver(async incoming => {
    const mounted = graphNativeViews.list().find(view => view.viewId === incoming.viewId);
    if (mounted) {
      if (mounted.vaultId !== incoming.vaultId || mounted.sourceId !== incoming.sourceId) throw Error('workspace-graph-main-receiver-source-mismatch');
      const adapter = graphNativeViews.get(incoming.viewId); adapter.freeze(); graphSessionStore.select(incoming.viewId); return adapter;
    }
    // Match an already captured Main source, never activate a vault for import.
    if (!graphNativeViews.list().some(view => view.vaultId === incoming.vaultId && view.sourceId === incoming.sourceId)) throw Error('workspace-graph-main-receiver-source-unavailable');
    graphSessionStore.openNative(incoming.viewId, incoming.title);
    const deadline = performance.now() + 5000;
    try {
      while (performance.now() < deadline) {
        const bound = graphNativeViews.list().find(view => view.viewId === incoming.viewId);
        if (bound?.sourceId) {
          if (bound.vaultId !== incoming.vaultId || bound.sourceId !== incoming.sourceId) throw Error('workspace-graph-main-receiver-source-mismatch');
          const adapter = graphNativeViews.get(incoming.viewId); adapter.freeze();
          if (await adapter.flush()) return adapter;
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      throw Error('workspace-graph-main-receiver-not-ready');
    } catch (error) { graphSessionStore.close(incoming.viewId); throw error; }
  }), []);
  useEffect(() => {
    const cancel = () => {
      const drag = dividerDragRef.current;
      if (!drag) return;
      dividerDragRef.current = null;
      graphSessionStore.setRatio(drag.split.id, drag.split.ratio);
      if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dividerDragRef.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancel); cancel(); };
  }, []);


  const splitPane = useCallback((id: string, orientation: 'row' | 'column', snapshot: GraphPaneSnapshot) => {
    if(!graphNativeViews.hasFrozenViews())graphSessionStore.split(id, orientation, { snapshot });
  }, []);
  const endDivider = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dividerDragRef.current?.pointerId !== event.pointerId) return;
    dividerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const cancelDivider = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dividerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    graphSessionStore.setRatio(drag.split.id, drag.split.ratio);
    endDivider(event);
  };

  return <div inert={interactionFrozen} id="page-graph" ref={hostRef} className="page graph-split-workspace graph-session-workspace">
    {state.groups.map(group => {
      const rect = geometry.groups.get(group.id)!;
      return <div key={group.id} className={`graph-session-group${state.activeGroupId === group.id ? ' active' : ''}`} data-graph-drop-group={group.id} style={rect}>
        {grouped && <div className="graph-session-tab-strip" data-graph-tab-strip={group.id} role="tablist" aria-label={graphText('viewTabs')}>
          {group.tabIds.map(id => {
            const tab = state.views[id];
            return <div key={id} className={`graph-session-tab${group.activeTabId === id ? ' active' : ''}`} data-graph-tab-id={id} role="tab" aria-selected={group.activeTabId === id} tabIndex={group.activeTabId === id ? 0 : -1}
              onClick={() => selectView(id)}
              onPointerDown={event => beginGraphTabPointerDrag(event, { tabId: id, title: title(tab) })}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectView(id); }
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault(); const offset = event.key === 'ArrowRight' ? 1 : -1;
                  const next = group.tabIds[(group.tabIds.indexOf(id) + offset + group.tabIds.length) % group.tabIds.length];
                  selectView(next);
                  event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-graph-tab-id="${next}"]`)?.focus();
                }
              }}>
              <span>{title(tab)}</span>
              <button type="button" data-graph-tab-close aria-label={graphText('closeTab')} title={graphText('closeTab')} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); closeView(id); }}>×</button>
            </div>;
          })}
          <button type="button" className="graph-session-add" aria-label={graphText('newTab')} title={graphText('newTab')} onClick={() => {if(!graphNativeViews.hasFrozenViews())graphSessionStore.add({ groupId: group.id });}}>+</button>
        </div>}
      </div>;
    })}
    {/* Every canvas has one permanent keyed sibling slot. Moving it changes only
        coordinates: React never remounts it under a different split parent. */}
    {Object.values(state.views).map(tab => {
      const group = state.groups.find(item => item.tabIds.includes(tab.id))!;
      const rect = geometry.groups.get(group.id)!;
      const visible = routeVisible && group.activeTabId === tab.id;
      const header = grouped ? 35 : 0;
      return <div key={tab.id} className="graph-session-view" data-graph-session-view={tab.id} data-graph-drop-group={group.id} hidden={!visible} aria-hidden={!visible || undefined} inert={!visible || undefined}
        style={{ left: rect.left, top: rect.top + header, width: rect.width, height: Math.max(0, rect.height - header) }}>
        <GraphViewport paneId={tab.id} sessionId={tab.id} layoutRevision={`${rect.left}:${rect.top}:${rect.width}:${rect.height}:${header}`} initialSnapshot={graphSessionStore.getInitialSnapshot(tab.id)} visible={visible}
          active={visible && state.activeGroupId === group.id} primary={false} headerInTitlebar persistView={Object.keys(state.views).length === 1} canClose={Object.keys(state.views).length > 1}
          onActivate={selectView} onSplit={splitPane} onClose={closeView}
          onDuplicate={() => {if(!graphNativeViews.hasFrozenViews())graphSessionStore.add({ duplicate: true, sourceTabId: tab.id });}} />
      </div>;
    })}
    {geometry.splits.map(split => <div key={split.id} className={`graph-session-divider graph-split-divider graph-split-divider-${split.orientation}`}
      style={{ left: split.left, top: split.top, width: split.width, height: split.height }} role="separator" tabIndex={0}
      aria-valuemin={12} aria-valuemax={88} aria-valuenow={Math.round(split.ratio * 100)}
      aria-orientation={split.orientation === 'row' ? 'vertical' : 'horizontal'}
      aria-label={split.orientation === 'row' ? t('editor.graph.split.resizeHorizontal') : t('editor.graph.split.resizeVertical')}
      onPointerDown={event => { if (graphNativeViews.hasFrozenViews()||event.button !== 0) return; event.preventDefault(); const rect = hostRef.current!.getBoundingClientRect(); dividerDragRef.current = { split, pointerId: event.pointerId, left: rect.left, top: rect.top, target: event.currentTarget }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if(graphNativeViews.hasFrozenViews())return;const drag = dividerDragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const row = drag.split.orientation === 'row'; const offset = row ? event.clientX - drag.left - drag.split.bounds.left : event.clientY - drag.top - drag.split.bounds.top; graphSessionStore.setRatio(drag.split.id, offset / Math.max(1, (row ? drag.split.bounds.width : drag.split.bounds.height) - 6)); }}
      onPointerUp={endDivider} onPointerCancel={cancelDivider} onLostPointerCapture={cancelDivider}
      onKeyDown={event => { if(graphNativeViews.hasFrozenViews())return;if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); graphSessionStore.setRatio(split.id, split.ratio + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -.04 : .04)); } }}
    />)}
  </div>;
}
