import {readActiveKnowledgeWriteSource} from "./core/services/knowledgeSource";
import {registerWorkspaceFlush} from "./workspace/windowLifecycle";
import {flushCanvasBeforeQuit} from "./features/canvas/canvasQuitBarrier";
import {canvasNoteBody,canvasNoteTitle,canvasNodeLibraryCandidates,createCanvasSaveGate} from "./core/canvas/nodeSaving";
import {useCanvasHistoryPopover} from "./features/canvas/useCanvasHistoryPopover";
// D65 正式画布 MVP
// 基于 React Flow 12，沿用 D47/D64-R2 节点能力。
// 改造点：
//   1. 去掉 D64-R2 压测按钮（DEV/压测 100/500），D65 正式页不展示 dev 控件
//   2. 持久化从 localStorage 升级到 Tauri 文件存储 <APP_DATA>/canvases/<id>.json
//   3. 新增左侧多画布列表侧栏（新建/打开/重命名/删除+确认）
//   4. 保留 D64-R2: React.memo(SpikeNodeView) / onlyRenderVisibleElements / MiniMap 降级
//   5. localStorage v2 一次性迁移到默认画布（保留 -archive 备份）
//   6. AI 节点已接入现有 aiChatComplete bridge
//
// D65 必做范围（来自 043 任务卡）：
//   - 文本、图片/视频生成、图片/视频素材引用、笔记引用；旧 AI 结果节点仅用于加载迁移
//   - 从素材库选/从知识库选
//   - 多画布列表（新建/打开/重命名/删除+确认）
//   - 文件存储 + localStorage 一次性迁移
//   - 引用节点只存 assetId / noteId，不复制真实素材或笔记正文
//
// 禁止范围（不破坏）：
//   - 不新增 SQLite 表
//   - 不新增远程市场/账号/同步/协作
//   - 不改素材库瀑布流/知识库编辑器/插件直收主链路
//   - 不新增 UI emoji 图标
//
// 文件名仍叫 CanvasSpike.tsx 以兼容 main.tsx 路由；内容是 D65 正式画布。

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { resolveScopedShortcut } from "./app/shortcuts";
import { I18nProvider, useI18n, type I18nContextValue } from "./core/i18n/index";
import { useSavedLocale } from "./features/settings/useSettings";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type NodeProps,
  Handle,
  Position,
  Panel,
  NodeResizeControl,
  ResizeControlVariant,
  SelectionMode,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getLuckyRayBridgeSync } from "./core/bridge/luckyRayBridge";
import { focusEntity, publishCurrentCanvasContext } from "./core/services/context";
import { getAiProviderMeta } from "./core/services/aiProviders";
import { completeCanvasProfileText, resolveCanvasTextSelection, canvasMediaProfilesClient, type CanvasMediaProfilesSnapshot, type CanvasMediaProfile } from "./core/services/canvasMediaProfiles";
import { CanvasAspectOptions } from "./features/canvas/CanvasAspectOptions";
import { mediaParameterKind, mediaParameterLabel, mediaPixelSize } from "./core/canvas/mediaOptionPresentation";
import { mediaCapabilities, mediaOption, mediaQualityOption } from "./core/canvas/mediaCapabilities";
import { PromptStarterSelect } from "./features/canvas/PromptStarterSelect";
import { CanvasVersionReview } from "./features/canvas/CanvasVersionReview";
import { CanvasReferencePacks } from "./features/canvas/CanvasReferencePacks";
import { CanvasImageTools } from "./features/canvas/CanvasImageTools";
import { CanvasDeliveryPanel } from "./features/canvas/CanvasDeliveryPanel";
import { selectedCanvasMedia } from "./core/canvas/mediaSelection";
import { safeDeliveryName, type DeliveryItem } from "./core/canvas/mediaDelivery";
import type { ImageEdit } from "./core/canvas/imageEditing";
import { CanvasCreativeRail, type CreativeAction } from "./features/canvas/CanvasCreativeRail";
import { hydrateNotePreviews, notePreviewText, noteBodyText, type CanvasNoteDetail } from "./core/canvas/notePreview";
import { CanvasSharpImage } from "./features/canvas/CanvasSharpImage";
import { hasInvalidCanvasReference, parseCanvasReference } from "./core/canvas/referenceIdentity";
import { CanvasWorkflowLibrary } from "./features/canvas/CanvasWorkflowLibrary";
import { captureWorkflow, instantiateWorkflow, WorkflowError, type WorkflowTemplate } from "./core/canvas/workflowTemplates";
import { isReferencePack, packMembers, usablePackMember, planReferencePack, type ReferencePackTag, type ReferencePackKind } from "./core/canvas/creativeReview";
import { matchesGenerationHistory } from "./core/canvas/workflowHelpers";
import { CanvasMediaProfilesPanel } from "./features/canvas/CanvasMediaProfilesPanel";
import {
  canConnectCanvasNodes,
  getCanvasNodeCapabilities,
  normalizeCanvasNodeCapabilityData,
  type CanvasNodeKind,
  type CanvasNodeRole,
  type CanvasResultKind,
} from "./core/canvas/nodeCapabilities";
import {
  isCanvasEdgeRole,
  normalizeCanvasEdgeSemantics,
  resolveCanvasEdgeSemanticData,
  type CanvasEdgeRole,
  type CanvasEdgeSemanticData,
} from "./core/canvas/edgeSemantics";
import {
  CANVAS_NODE_COMMAND_IDS,
  getCanvasNodeCommands,
  type CanvasNodeCommand,
  type CanvasNodeCommandId,
} from "./core/canvas/nodeCommands";
import {
  canCancelCanvasGenerationTask,
  canRetryCanvasGenerationTask,
  createCanvasGenerationTask,
  transitionCanvasGenerationTask,
  type CanvasGenerationKind,
  type CanvasGenerationRequestSnapshot,
  type CanvasGenerationTask,
} from "./core/canvas/generationTasks";
import {
  executeCanvasGenerationTask,
  type CanvasGenerationAdapter,
  type CanvasGenerationOutput,
} from "./core/canvas/generationRunner";
import { CanvasReferencePreview } from "./features/canvas/CanvasReferencePreview";
import { compileCanvasGenerationInputs, orderCanvasGenerationReferences } from "./core/canvas/generationInputCompiler";
import { PENDING_CANVAS_OPEN_KEY, resolveCanvasOpenTarget } from "./features/canvas/canvasNavigation";
import {
  appendCanvasHistoryEntry,
  canvasBeginPendingEdit,
  canvasHistorySnapshotsEqual,
  canvasResizeEndDecision,
  createCanvasHistorySnapshot,
  restoreCanvasNodeDimensionRepresentation,
  type CanvasHistorySnapshot as CanvasHistorySnapshotBase,
} from "./features/canvas/canvasHistory";
import {
  advanceCanvasEditGeneration,
  canvasSaveCompletionMayMarkClean,
  canvasSaveIdentityMatchesCanvas,
  canvasStaleSaveShouldFollowUp,
  edgeChangesContainDurableEdit,
  nodeChangesContainDurableEdit,
  releaseCanvasSaveSlot,
  sanitizeCanvasEdgesForPersistence,
  sanitizeCanvasNodesForPersistence,
  tryAcquireCanvasSaveSlot,
  type CanvasSaveSlot,
} from "./features/canvas/canvasPersistence";
import {
  arrangeCanvasNodes,
  attachCanvasNodesToGroup,
  createCanvasGroupDraft,
  ungroupCanvasNodes,
} from "./core/canvas/canvasArrangement";
import {
  canUngroupCanvasSelection,
  isSafeCanvasTransformSelection,
  planCanvasHorizontalDistribution,
  planCanvasLeftAlignment,
  selectedCanvasGroupContainerIds,
  selectedCanvasIdsEqual,
  synchronizeCanvasNodeSelection,
} from "./features/canvas/canvasSelectionTransform";
import {
  createCanvasTextGenerationAdapter,
  sanitizeCanvasTextGenerationOutput,
} from "./core/canvas/textGenerationAdapter";
import {
  createCanvasImageGenerationAdapter,
  type CanvasAiImageGeneration,
} from "./core/canvas/imageGenerationAdapter";
import {
  createCanvasVideoGenerationAdapter,
  type CanvasAiVideoGeneration,
} from "./core/canvas/videoGenerationAdapter";
import {
  generationTaskFromHistory,
  normalizeGenerationHistory,
  toGenerationLibraryCandidate,
  upsertGenerationHistory,
  type CanvasGenerationHistoryEntry,
  type CanvasGenerationLibraryCandidate,
} from "./core/canvas/generationHistory";
import "@xyflow/react/dist/style.css";
import "./canvas-spike-scroll.css";

// ========== 类型 ==========

type NodeKind = CanvasNodeKind;
type AiResultKind = CanvasResultKind;
type GenerationKind = "image" | "video";
type CanvasDensity = "compact" | "standard";

type GenerationReference = {
  id: string;
  label: string;
  kind: string;
  role?: CanvasEdgeRole;
  thumbnailUrl?: string | null;
  mediaUrl?: string | null;
  text?: string | null;
};

const CANVAS_GENERATION_CONCURRENCY: Record<CanvasGenerationKind, number> = {
  text: 2,
  image: 1,
  video: 1,
};

type ConnectedGenerationInput = {
  edgeId: string;
  sourceNodeId: string;
  role: CanvasEdgeRole;
  reference: GenerationReference;
};

type ComposerReferenceEntry = {
  key: string;
  source: "connected" | "stored";
  role: CanvasEdgeRole;
  reference: GenerationReference;
  edgeId?: string;
  storedIndex?: number;
};

type CanvasReferenceCandidate = {
  nodeId: string;
  label: string;
  kind: string;
  thumbnailUrl?: string | null;
  mediaUrl?: string | null;
};

type CanvasUiSettings = {
  fanInspector: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  showHandles: boolean;
  minimap: boolean;
  density: CanvasDensity;
  reduceMotion: boolean;
  creativeRailAlwaysVisible: boolean;
  noteReferenceIncludeTitle: boolean;
};

const TEXT_NODE_PLACEHOLDER_LABELS = new Set(["新文本节点", "双击开始编辑..."]);

type SpikeNodeData = {
  label: string;
  payload?: string; // 素材 id / 笔记 id / AI 提示词
  kind: NodeKind;
  role?: CanvasNodeRole;
  capabilitiesVersion?: number;
  result?: string; // 当前卡片最近一次文字生成结果
  resultKind?: AiResultKind; // 旧结果节点兼容字段；新任务直接写回发起卡片
  resultMediaUrl?: string | null; // AI 图片/视频结果原始地址
  resultThumbnailUrl?: string | null; // AI 视频结果封面
  resultMediaItems?: Array<{ url: string; thumbnailUrl?: string | null }>;
  // D70：引用节点快照字段
  refThumbnailUrl?: string | null; // 素材缩略图 URL
  refMediaUrl?: string | null; // 原始图片/视频文件 URL
  refKind?: string; // image / video / audio
  derivedFromNodeId?: string;
  imageEdit?: ImageEdit;
  refSummary?: string; // 笔记预览缓存（正文摘要）
  refContextText?: string; // 生成上下文，独立于卡片预览，最多 8000 字符
  refUpdatedAt?: string | null; // 素材/笔记更新时间
  _manualSize?: boolean; // 文本/笔记节点是否已经手动缩放
  _emptyMedia?: boolean; // 双击画布创建的空图片/视频占位卡片
  // 临时视觉标记：新建节点蓝色脉冲。约 4.3s 后由 addNode 自动清除。
  generationPrompt?: string;
  generationKind?: GenerationKind;
  generationModel?: string;
  generationAspect?: string;
  generationDuration?: number;
  generationSound?: boolean;
  generationQuality?: string;
  generationResolution?: string;
  generationCount?: number;
  generationCameraStrength?: number;
  generationReferences?: GenerationReference[];
  generationTask?: CanvasGenerationTask;
  sourceGenerationTaskId?: string;
  sourceGenerationHistoryId?: string;
  sourceGenerationMediaUrl?: string;
  groupMemberCount?: number;
  referencePack?: ReferencePackTag;
  _newHighlight?: boolean;
};

type SpikeNode = Node<SpikeNodeData>;
type SpikeEdge = Edge<CanvasEdgeSemanticData>;

type CanvasNodeUiActions = {
  inlineEditingNodeId: string | null;
  openNodeComposer: (nodeId: string) => void;
  startInlineEdit: (nodeId: string) => void;
  updateInlineLabel: (nodeId: string, text: string) => void;
  updateNodeData: (nodeId: string, patch: Partial<SpikeNodeData>) => void;
  openMediaAssetPicker: (nodeId: string) => void;
  clearMediaAsset: (nodeId: string) => void;
  openGeneratorAssetPicker: (nodeId: string, role?: CanvasEdgeRole) => void;
  getCanvasReferenceCandidates: (nodeId: string) => CanvasReferenceCandidate[];
  addCanvasReference: (nodeId: string, candidate: CanvasReferenceCandidate, role: CanvasEdgeRole) => void;
  getIncomingGenerationInputs: (nodeId: string) => ConnectedGenerationInput[];
  updateIncomingEdgeRole: (edgeId: string, role: CanvasEdgeRole) => void;
  removeIncomingEdge: (edgeId: string) => void;
  submitGeneration: (nodeId: string) => void;
  cancelGeneration: (nodeId: string) => void;
  retryGeneration: (nodeId: string) => void;
  rerunGeneration: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  finishInlineEdit: () => void;
  resizeNodeStart: () => void;
  resizeNodeEnd: (nodeId: string) => void;
  runAI: (nodeId: string) => void;
  runningAiNodeId: string | null;
  mediaImportingNodeId: string | null;
  imageModels: readonly string[];
  defaultImageModel: string;
  videoModels: readonly string[];
  defaultVideoModel: string;
};

const CanvasNodeUiContext = createContext<CanvasNodeUiActions>({
  inlineEditingNodeId: null,
  openNodeComposer: () => {},
  startInlineEdit: () => {},
  updateInlineLabel: () => {},
  updateNodeData: () => {},
  openMediaAssetPicker: () => {},
  clearMediaAsset: () => {},
  openGeneratorAssetPicker: () => {},
  getCanvasReferenceCandidates: () => [],
  addCanvasReference: () => {},
  getIncomingGenerationInputs: () => [],
  updateIncomingEdgeRole: () => {},
  removeIncomingEdge: () => {},
  submitGeneration: () => {},
  cancelGeneration: () => {},
  retryGeneration: () => {},
  rerunGeneration: () => {},
  deleteNode: () => {},
  finishInlineEdit: () => {},
  resizeNodeStart: () => {},
  resizeNodeEnd: () => {},
  runAI: () => {},
  runningAiNodeId: null,
  mediaImportingNodeId: null,
  imageModels: [],
  defaultImageModel: "",
  videoModels: [],
  defaultVideoModel: "",
});

type CanvasListEntry = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  coverVersion: number;
  coverKind: "image" | "video" | null;
  coverUrl: string | null;
  coverPoster: string | null;
  revision: number;
  contentDigest: string;
};

type CanvasStorageCheck = {
  ok: boolean;
  storageDir: string;
  canvasCount: number;
  checkedFiles: number;
  issues: string[];
};

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type CanvasIdentity = {
  canvasId: string;
  revision: number;
  contentDigest: string;
  loadEpoch: number;
};
type CanvasHistorySnapshot = CanvasHistorySnapshotBase<SpikeNode, SpikeEdge, CanvasGenerationHistoryEntry>;

type CanvasAiRuntimeConfig = {
  ready: boolean;
  providerLabel: string;
  model: string;
  models: string[];
  imageModel: string;
  imageModels: string[];
  imageApiKeyConfigured: boolean;
  imageApiKey: string;
  imageBaseURL: string;
  videoModel: string;
  videoModels: string[];
  error: string | null;
};

type CanvasViewport = { x: number; y: number; zoom: number };

const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

function normalizeCanvasViewport(value: unknown): CanvasViewport {
  if (!value || typeof value !== "object") return { ...DEFAULT_CANVAS_VIEWPORT };
  const candidate = value as Partial<CanvasViewport>;
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const zoom = Number(candidate.zoom);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    zoom: Number.isFinite(zoom) && zoom > 0 ? Math.min(2.4, Math.max(0.08, zoom)) : 1,
  };
}

type BridgeApi = {
  getCanvasStorageDir?: () => Promise<string>;
  checkCanvasFiles?: () => Promise<CanvasStorageCheck>;
  openDirectory?: (path: string) => Promise<void>;
  listCanvases: () => Promise<CanvasListEntry[]>;
  loadCanvas: (canvasId: string) => Promise<{ canvasId: string; name: string; createdAt: string; updatedAt: string; nodes: unknown; edges: unknown; viewport: CanvasViewport; generationHistory?: unknown; revision?: number; contentDigest?: string }>;
  saveCanvas: (canvas: { schemaVersion: number; canvasId: string; name: string; createdAt: string; updatedAt: string; nodes: unknown; edges: unknown; viewport: CanvasViewport; generationHistory?: unknown; revision?: number; contentDigest?: string }) => Promise<CanvasListEntry>;
  createCanvas: (name?: string) => Promise<CanvasListEntry>;
  renameCanvas: (canvasId: string, name: string) => Promise<CanvasListEntry | null>;
  deleteCanvas: (canvasId: string) => Promise<void>;
  saveCanvasThumbnail: (canvasId: string, data: Uint8Array) => Promise<void>;
  deleteCanvasThumbnail: (canvasId: string) => Promise<void>;
  listAssets: () => Promise<any[]>;
  importAssets?: (options?: { paths?: string[] }) => Promise<{ assets: any[]; source: "tauri" | "browser"; skippedDuplicates: number }>;
  listNotes: () => Promise<any[]>;
  createNote?: (input:{title?:string;contentText?:string})=>Promise<{id:string}>;
  getNote?: (id:string) => Promise<CanvasNoteDetail|null>;
  getSettings?: () => Promise<{
    aiProvider: string | null;
    aiModel: string | null;
    aiImageApiKey: string | null;
    aiImageApiKeyConfigured?: boolean;
    aiImageBaseURL: string | null;
    aiImageModel: string | null;
    aiVideoModel: string | null;
  }>;
  setSettings?: (patch: {
    aiImageApiKey?: string;
    aiImageBaseURL?: string;
    aiImageModel?: string;
    aiVideoModel?: string;
  }) => Promise<unknown>;
  aiChatComplete?: (
    messages: Array<{ role: string; content: string }>,
    options?: { systemPrompt?: string; temperature?: number; maxTokens?: number; model?: string },
  ) => Promise<{ success: boolean; content?: string; error_kind?: string; error_message?: string; error_detail?: string }>;
  createAiConversation?: (title?: string) => Promise<{ id: string; title: string; createdAt: string; updatedAt: string }>;
  aiImageGenerate?: CanvasAiImageGeneration;
  aiVideoGenerate?: CanvasAiVideoGeneration;
  /** Canvas-owned seam. The desktop host may implement it when the material library is reconnected. */
  saveCanvasGenerationToLibrary?: (candidate: CanvasGenerationLibraryCandidate) => Promise<{ success: boolean; assetId?: string; message?: string }>;
};

const STORAGE_KEY_V2 = "luckyray-canvas-v2";
const STORAGE_KEY_V1 = "luckyray-canvas-spike-v1";
const STORAGE_KEY_V2_ARCHIVE = "luckyray-canvas-v2-archive";
// 迁移标记位：迁移成功后置 "1"，避免每次打开重复创建"从 spike 导入"画布
const STORAGE_KEY_MIGRATED = "luckyray-canvas-migrated-v2";
const CANVAS_UI_SETTINGS_KEY = "luckyray:canvas-ui-settings-v1";
const DEFAULT_CANVAS_UI_SETTINGS: CanvasUiSettings = {
  fanInspector: false,
  showGrid: true,
  snapToGrid: true,
  showHandles: true,
  minimap: false,
  density: "standard",
  reduceMotion: false,
  creativeRailAlwaysVisible: false,
  noteReferenceIncludeTitle: false,
};

function loadCanvasUiSettings(): CanvasUiSettings {
  try {
    const raw = window.localStorage.getItem(CANVAS_UI_SETTINGS_KEY);
    return raw ? { ...DEFAULT_CANVAS_UI_SETTINGS, ...JSON.parse(raw) } : DEFAULT_CANVAS_UI_SETTINGS;
  } catch {
    return DEFAULT_CANVAS_UI_SETTINGS;
  }
}

function resolveCanvasMediaUrl(value: string | null | undefined): string {
  if (!value) return "";
  if (/^(https?:|asset:|blob:|data:)/i.test(value)) return value;
  return convertFileSrc(value);
}

// 与 Rust 端 CANVAS_SCHEMA_VERSION 保持一致
const CANVAS_SCHEMA_VERSION = 2;

function returnToLuckyRay() {
  try { window.sessionStorage.removeItem("luckyray-canvas-return"); } catch {}
  if (window.location.hash.startsWith("#canvas")) {
    window.location.hash = "#canvas";
    return;
  }
  window.location.href = "/index.html#canvas";
}

// ========== 节点样式（保留 D47 风格） ==========

const NODE_STROKE: Record<NodeKind, string> = {
  text: "rgba(124,138,255,.6)",
  image: "rgba(74,222,128,.6)",
  video: "rgba(167,139,250,.6)",
  noteRef: "rgba(251,191,36,.6)",
  aiPrompt: "rgba(244,114,182,.6)",
  aiResult: "rgba(56,189,248,.6)",
  generator: "rgba(255,255,255,.68)",
  group: "rgba(255,255,255,.38)",
};
function canvasNodeKindLabel(kind: NodeKind, t: I18nContextValue["t"]): string {
  return t(`editor.canvas.node.kind.${kind}` as Parameters<I18nContextValue["t"]>[0]);
}

function isSquareNodeKind(kind: NodeKind): boolean {
  return kind === "text" || kind === "noteRef";
}

function squareNodeSize(data: Pick<SpikeNodeData, "label" | "refSummary">): number {
  const contentLength = `${data.label || ""}${data.refSummary || ""}`.trim().length;
  return Math.round(Math.min(380, Math.max(190, 170 + Math.sqrt(Math.max(1, contentLength)) * 9)));
}

function textNodeSize(data: Pick<SpikeNodeData, "label">): { width: number; height: number } {
  const contentLength = (data.label || "").trim().length;
  const width = Math.round(Math.min(520, Math.max(300, 280 + Math.sqrt(Math.max(1, contentLength)) * 8)));
  const height = Math.round(Math.min(420, Math.max(180, 150 + Math.ceil(contentLength / 30) * 26)));
  return { width, height };
}

function applyGenerationTaskToNodes(
  current: SpikeNode[],
  task: CanvasGenerationTask,
  output?: CanvasGenerationOutput,
): SpikeNode[] {
  return current.map((node) => {
    if (node.data.generationTask?.id !== task.id) return node;
    if (!output) {
      return { ...node, data: { ...node.data, generationTask: task } };
    }
    const nextLabel = output.kind === "text"
      ? sanitizeCanvasTextGenerationOutput(output.text || "").trim() || node.data.label
      : node.data.label;
    return {
      ...node,
      style: output.kind === "text" && !node.data._manualSize
        ? { ...node.style, ...textNodeSize({ label: nextLabel }) }
        : node.style,
      data: {
        ...node.data,
        label: nextLabel,
        generationTask: task,
        resultKind: output.kind,
        result: output.kind === "text" ? output.text || "" : "",
        resultMediaUrl: output.kind === "image" || output.kind === "video"
          ? output.mediaUrl || ""
          : undefined,
        resultThumbnailUrl: output.kind === "image" || output.kind === "video"
          ? output.thumbnailUrl
          : undefined,
        resultMediaItems: output.kind === "image" ? output.mediaItems : undefined,
      },
    };
  });
}

function migrateLegacyCanvasNode(node: SpikeNode): SpikeNode {
  const data = node.data;
  if ((data.kind === "image" || data.kind === "video") && data._emptyMedia === true) {
    const generationKind = data.kind;
    return {
      ...node,
      style: undefined,
      dragHandle: ".canvas-node-drag-handle",
      data: normalizeCanvasNodeCapabilityData({
        ...data,
        kind: "generator",
        label: generationKind === "video" ? "视频生成" : "图片生成",
        generationKind,
        generationAspect: data.generationAspect || (generationKind === "video" ? "16:9" : "1:1"),
        generationDuration: generationKind === "video" ? data.generationDuration || 5 : undefined,
        generationQuality: data.generationQuality || (generationKind === "video" ? "1080p" : "高清"),
        generationCount: generationKind === "image" ? data.generationCount || 1 : undefined,
        _emptyMedia: undefined,
      }),
    };
  }
  if (data.kind !== "aiResult") return node;

  const resultKind = data.resultKind || data.generationTask?.request.kind || "text";
  if (resultKind === "text") {
    const label = sanitizeCanvasTextGenerationOutput(data.result || "").trim()
      || data.generationPrompt?.trim()
      || "双击开始编辑...";
    return {
      ...node,
      dragHandle: undefined,
      data: normalizeCanvasNodeCapabilityData({ ...data, kind: "text", role: "editable", label, resultKind: undefined }),
      style: textNodeSize({ label }),
    };
  }

  const mediaItem = data.resultMediaItems?.[0];
  const mediaUrl = data.resultMediaUrl || mediaItem?.url || "";
  const thumbnailUrl = data.resultThumbnailUrl || mediaItem?.thumbnailUrl || mediaUrl;
  if (mediaUrl) {
    return {
      ...node,
      dragHandle: undefined,
      style: undefined,
      data: normalizeCanvasNodeCapabilityData({
        ...data,
        kind: resultKind,
        role: "resource",
        label: resultKind === "video" ? "视频素材" : "图片素材",
        refKind: resultKind,
        refMediaUrl: mediaUrl,
        refThumbnailUrl: thumbnailUrl,
        resultKind: undefined,
        _emptyMedia: false,
      }),
    };
  }

  return {
    ...node,
    style: undefined,
    dragHandle: ".canvas-node-drag-handle",
    data: normalizeCanvasNodeCapabilityData({
      ...data,
      kind: "generator",
      role: "generator",
      label: resultKind === "video" ? "视频生成" : "图片生成",
      generationKind: resultKind,
      resultKind: undefined,
      _emptyMedia: undefined,
    }),
  };
}

function withInitialSquareSize(node: SpikeNode): SpikeNode {
  node = migrateLegacyCanvasNode(node);
  const normalizedNode = {
    ...node,
    data: normalizeCanvasNodeCapabilityData(node.data),
  };
  if (normalizedNode.data.kind === "generator") {
    return { ...normalizedNode, dragHandle: ".canvas-node-drag-handle" };
  }
  if (!isSquareNodeKind(normalizedNode.data.kind)) return normalizedNode;
  if (normalizedNode.style?.width && normalizedNode.style?.height) return normalizedNode;
  if (normalizedNode.data.kind === "text") {
    return { ...normalizedNode, style: { ...normalizedNode.style, ...textNodeSize(normalizedNode.data) } };
  }
  const size = squareNodeSize(normalizedNode.data);
  return { ...normalizedNode, style: { ...normalizedNode.style, width: size, height: size } };
}

function CanvasToolButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`canvas-editor-tool-button${active ? " is-active" : ""}`}
      title={label}
      data-tooltip={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CanvasSettingToggle({
  label,
  hint,
  checked,
  onChange,
  experimental = false,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  experimental?: boolean;
}) {
  const { t } = useI18n();
  return (
    <button type="button" className="canvas-settings-toggle" aria-pressed={checked} onClick={() => onChange(!checked)}>
      <span><strong>{label}{experimental ? <em>{t("editor.canvas.settings.experimental")}</em> : null}</strong><small>{hint}</small></span>
      <i className={checked ? "is-on" : ""}><b /></i>
    </button>
  );
}

type ToolIconType = "text" | "image" | "video" | "audio" | "aiPrompt" | "aiResult" | "asset" | "note" | "search" | "history" | "delete" | "zoomIn" | "zoomOut" | "fitView" | "center" | "minimap" | "minimapOff" | "plus" | "settings" | "duplicate" | "focusEdit" | "group" | "ungroup" | "arrange";

function ToolIcon({ type }: { type: ToolIconType }) {
  if (type === "plus") {
    return <svg viewBox="0 0 18 18"><path d="M9 3v12M3 9h12" /></svg>;
  }
  if (type === "settings") {
    return <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="2.5" /><path d="M9 2.5v2M9 13.5v2M2.5 9h2M13.5 9h2M4.4 4.4l1.4 1.4M12.2 12.2l1.4 1.4M13.6 4.4l-1.4 1.4M5.8 12.2l-1.4 1.4" /></svg>;
  }
  if (type === "duplicate") {
    return <svg viewBox="0 0 18 18"><rect x="6" y="6" width="8" height="8" rx="1.5" /><path d="M11 4H5a1 1 0 0 0-1 1v6" /></svg>;
  }
  if (type === "focusEdit") {
    return <svg viewBox="0 0 18 18"><path d="M6 3H3v3M12 3h3v3M6 15H3v-3M12 15h3v-3" /><circle cx="9" cy="9" r="2.4" /><path d="M9 5.5v1M9 11.5v1M5.5 9h1M11.5 9h1" /></svg>;
  }
  if (type === "group") {
    return <svg viewBox="0 0 18 18"><rect x="2.5" y="3" width="13" height="12" rx="2.5" /><rect x="5" y="6" width="3" height="3" rx=".7" /><rect x="10" y="9" width="3" height="3" rx=".7" /></svg>;
  }
  if (type === "ungroup") {
    return <svg viewBox="0 0 18 18"><path d="M7 3H4a1 1 0 0 0-1 1v3M11 15h3a1 1 0 0 0 1-1v-3" /><rect x="4.5" y="8" width="4" height="4" rx="1" /><rect x="9.5" y="5" width="4" height="4" rx="1" /></svg>;
  }
  if (type === "arrange") {
    return <svg viewBox="0 0 18 18"><rect x="2.5" y="3" width="4" height="4" rx="1" /><rect x="11.5" y="3" width="4" height="4" rx="1" /><rect x="7" y="11" width="4" height="4" rx="1" /><path d="M6.5 5h5M9 7v4" /></svg>;
  }
  if (type === "text") {
    return <svg viewBox="0 0 18 18"><path d="M4 4h10M9 4v10M6 14h6" /></svg>;
  }
  if (type === "aiPrompt") {
    return <svg viewBox="0 0 18 18"><path d="M9 2.5l1.1 3.2 3.4 1.1-3.4 1.1L9 11.5 7.9 7.9 4.5 6.8l3.4-1.1Z" /><path d="M13 11l.7 1.8 1.8.7-1.8.7L13 16l-.7-1.8-1.8-.7 1.8-.7Z" /></svg>;
  }
  if (type === "aiResult") {
    return <svg viewBox="0 0 18 18"><path d="M4 3h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8l-4 3v-3H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M6 7h6M6 10h4" /></svg>;
  }
  if (type === "image") {
    return <svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="2" /><circle cx="11.5" cy="6.5" r="1.2" /><path d="M4.5 13l3.4-3.5 2.2 2.1 1.5-1.4 2.1 2.8" /></svg>;
  }
  if (type === "video") {
    return <svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="2" /><path d="M7.5 6.3l4 2.7-4 2.7Z" /></svg>;
  }
  if (type === "audio") {
    return <svg viewBox="0 0 18 18"><path d="M3 10V8M6 13V5M9 15V3M12 12V6M15 10V8" /></svg>;
  }
  if (type === "asset") {
    return <svg viewBox="0 0 18 18"><rect x="3" y="4" width="12" height="10" rx="2" /><circle cx="7" cy="8" r="1.2" /><path d="M4 13l3.2-3 2.1 2 1.7-1.7 3 2.7" /></svg>;
  }
  if (type === "note") {
    return <svg viewBox="0 0 18 18"><path d="M5 3h6l3 3v9H5Z" /><path d="M11 3v4h4M7 10h5M7 13h4" /></svg>;
  }
  if (type === "search") {
    return <svg viewBox="0 0 18 18"><circle cx="7.5" cy="7.5" r="4.5" /><path d="M11 11l4 4" /></svg>;
  }
  if (type === "history") {
    return <svg viewBox="0 0 18 18"><path d="M4.4 5.2A6 6 0 1 1 3 9" /><path d="M3 4v4h4M9 5.5V9l2.5 1.5" /></svg>;
  }
  if (type === "zoomIn") {
    return <svg viewBox="0 0 18 18"><circle cx="8" cy="8" r="5" /><path d="M12 12l4 4M5 8h6M8 5v6" /></svg>;
  }
  if (type === "zoomOut") {
    return <svg viewBox="0 0 18 18"><circle cx="8" cy="8" r="5" /><path d="M12 12l4 4M5 8h6" /></svg>;
  }
  if (type === "fitView") {
    return <svg viewBox="0 0 18 18"><path d="M3 6V3h3M15 6V3h-3M3 12v3h3M15 12v3h-3" /><path d="M6 9h6M9 6v6" /></svg>;
  }
  if (type === "center") {
    return <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="2.5" /><path d="M9 3v3M9 12v3M3 9h3M12 9h3" /></svg>;
  }
  if (type === "minimap") {
    return <svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="2" /><path d="M6 7h2v4H6zM10 7h2v4h-2z" /></svg>;
  }
  if (type === "minimapOff") {
    return <svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="2" /><path d="M5 5l8 8" strokeWidth="2" /></svg>;
  }
  return <svg viewBox="0 0 18 18"><path d="M4 5h10M7 5V3h4v2M6 7v8h6V7" /><path d="M8 9v4M10 9v4" /></svg>;
}

function CanvasNodeCommandIcon({ command }: { command: CanvasNodeCommand }) {
  const iconByCommand: Record<CanvasNodeCommand["icon"], ToolIconType> = {
    detail: "note",
    edit: "text",
    open: "asset",
    replace: "focusEdit",
    clear: "delete",
    derive: "aiPrompt",
    save: "asset",
    duplicate: "duplicate",
    delete: "delete",
  };
  return <ToolIcon type={iconByCommand[command.icon]} />;
}

function formatVideoTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function parseGeneratorAspectRatio(value?: string | null): number {
  if (!value) return 1;
  const [width, height] = value.split(":").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return width / height;
}

function generatorCardDimensions(aspectRatio: number): { width: number; height: number } {
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  if (ratio >= 1.15) {
    const width = 430;
    return { width, height: Math.max(204, Math.min(374, Math.round(width / ratio))) };
  }
  if (ratio <= .88) {
    const height = 430;
    return { width: Math.max(242, Math.min(378, Math.round(height * ratio))), height };
  }
  return { width: 360, height: 360 };
}

function generationMotionLabel(task: CanvasGenerationTask | undefined, t: I18nContextValue["t"]): string {
  if (!task || (task.status !== "queued" && task.status !== "running")) return "";
  if (task.providerStage === "downloading") return t("editor.canvas.generation.receiving");
  if (task.status === "queued" || task.providerStage === "queued") return t("editor.canvas.generation.preparing");
  const progress = typeof task.progress === "number" ? Math.max(0, Math.min(100, Math.round(task.progress))) : null;
  return progress === null ? t("editor.canvas.generation.generating") : t("editor.canvas.generation.progress", { progress });
}

function generationHistoryStatusLabel(entry: CanvasGenerationHistoryEntry, queuePosition: number | undefined, t: I18nContextValue["t"]): string {
  const progress = typeof entry.progress === "number" ? Math.max(0, Math.min(100, Math.round(entry.progress))) : 0;
  if (entry.status === "succeeded") return t("editor.canvas.history.status.completed");
  if (entry.status === "failed") return t("editor.canvas.history.status.failed");
  if (entry.status === "cancelled") return t("editor.canvas.history.status.cancelled");
  if (entry.resumedAt) {
    if (entry.providerStage === "downloading") return t("editor.canvas.history.status.resumedDownloading", { progress });
    if (entry.providerStage === "generating") return t("editor.canvas.history.status.resumedGenerating", { progress });
    return t("editor.canvas.history.status.resuming");
  }
  if (entry.status === "queued") return queuePosition ? t("editor.canvas.history.status.queuePosition", { position: queuePosition }) : t("editor.canvas.history.status.queued");
  if (entry.providerStage === "downloading") return t("editor.canvas.history.status.downloading", { progress });
  if (entry.providerStage === "queued") return t("editor.canvas.history.status.waitingAgnes");
  return t("editor.canvas.history.status.generating", { progress });
}

function CanvasVideoPreview({
  source,
  poster,
  selected,
  onAspectRatio,
}: {
  source: string;
  poster?: string;
  selected: boolean;
  onAspectRatio?: (aspectRatio: number) => void;
}) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resolvedSource = resolveCanvasMediaUrl(source);
  const resolvedPoster = resolveCanvasMediaUrl(poster);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [manualPlaying, setManualPlaying] = useState(false);
  const [hasError, setHasError] = useState(false);

  const playVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => setIsPlaying(false));
  }, []);

  const pauseVideo = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  useEffect(() => {
    if (selected) return;
    setManualPlaying(false);
    if (!isHovering) pauseVideo();
  }, [isHovering, pauseVideo, selected]);

  const toggleManualPlayback = useCallback(() => {
    if (isPlaying) {
      setManualPlaying(false);
      pauseVideo();
      return;
    }
    setManualPlaying(true);
    playVideo();
  }, [isPlaying, pauseVideo, playVideo]);

  const seekFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const nextTime = video.duration * ratio;
    video.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, []);

  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  if (hasError) {
    return <div className="canvas-node-media-fallback">{t("editor.canvas.node.videoUnavailable")}</div>;
  }

  return (
    <div
      className={`canvas-video-preview ${selected ? "is-selected" : ""} ${isPlaying ? "is-playing" : ""}`}
      onMouseEnter={() => {
        setIsHovering(true);
        playVideo();
      }}
      onMouseLeave={() => {
        setIsHovering(false);
        if (!manualPlaying) pauseVideo();
      }}
    >
      <video
        ref={videoRef}
        src={resolvedSource}
        poster={resolvedPoster || undefined}
        muted
        playsInline
        preload="metadata"
        className="canvas-node-media"
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration || 0);
          setCurrentTime(event.currentTarget.currentTime || 0);
          const { videoWidth, videoHeight } = event.currentTarget;
          if (videoWidth > 0 && videoHeight > 0) onAspectRatio?.(videoWidth / videoHeight);
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setManualPlaying(false);
          setIsPlaying(false);
          if (isHovering) {
            const video = videoRef.current;
            if (video) video.currentTime = 0;
          }
        }}
        onError={() => setHasError(true)}
      />
      <div
        className="canvas-video-controls nodrag nopan"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="canvas-video-toggle"
          title={isPlaying ? t("editor.canvas.node.pause") : t("editor.canvas.node.play")}
          aria-label={isPlaying ? t("editor.canvas.node.pauseVideo") : t("editor.canvas.node.playVideo")}
          onClick={(event) => {
            event.stopPropagation();
            toggleManualPlayback();
          }}
        >
          {isPlaying ? (
            <svg viewBox="0 0 18 18"><path d="M6 5v8M12 5v8" /></svg>
          ) : (
            <svg viewBox="0 0 18 18"><path className="canvas-video-play-glyph" d="m7 5 6 4-6 4Z" /></svg>
          )}
        </button>
        <div
          className="canvas-video-progress"
          title={t("editor.canvas.node.seekHint")}
          onPointerDown={seekFromPointer}
          onPointerMove={seekFromPointer}
        >
          <span className="canvas-video-progress-fill" style={{ width: `${progress}%` }} />
          <i className="canvas-video-progress-thumb" style={{ left: `${progress}%` }} />
        </div>
        <span className="canvas-video-time">{formatVideoTime(currentTime)} / {formatVideoTime(duration)}</span>
      </div>
    </div>
  );
}

function updateMagneticHandle(event: ReactPointerEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  const offsetX = Math.max(-7, Math.min(7, (event.clientX - (rect.left + rect.width / 2)) * .22));
  const offsetY = Math.max(-9, Math.min(9, (event.clientY - (rect.top + rect.height / 2)) * .22));
  event.currentTarget.style.setProperty("--handle-magnet-x", `${offsetX}px`);
  event.currentTarget.style.setProperty("--handle-magnet-y", `${offsetY}px`);
}

function resetMagneticHandle(event: ReactPointerEvent<HTMLDivElement>) {
  event.currentTarget.style.setProperty("--handle-magnet-x", "0px");
  event.currentTarget.style.setProperty("--handle-magnet-y", "0px");
}

const SpikeNodeView = memo(function SpikeNodeView({ id, data, selected }: NodeProps<SpikeNode>) {
  const { t, locale } = useI18n();
  const nodeUi = useContext(CanvasNodeUiContext);
  const kind = data.kind || "text";
  const generatorMediaKey = kind === "generator"
    ? data.resultMediaItems?.[0]?.url || data.resultMediaUrl || ""
    : "";
  const [detectedGeneratorAspect, setDetectedGeneratorAspect] = useState<number | null>(null);
  useEffect(() => {
    setDetectedGeneratorAspect(null);
  }, [generatorMediaKey, kind]);
  const capabilities = getCanvasNodeCapabilities({ ...data, kind });
  const isAsset = kind === "image" || kind === "video";
  const isNote = kind === "noteRef";
  const isFreeformResizable = kind === "text" || kind === "noteRef";
  const isInlineEditing = kind === "text" && nodeUi.inlineEditingNodeId === id;
  const isTextPlaceholder = kind === "text" && TEXT_NODE_PLACEHOLDER_LABELS.has(data.label.trim());
  const isEmptyMedia = isAsset && data._emptyMedia === true;
  const hasRefSnapshot = isAsset ? !!(data.refThumbnailUrl || data.refMediaUrl) : isNote ? !!data.refSummary : false;
  const isBroken = hasInvalidCanvasReference(data);
  const isNewHighlight = (data as SpikeNodeData & { _newHighlight?: boolean })._newHighlight === true;
  const legacyVideoSource = kind === "video"
    && data.refThumbnailUrl
    && /\.(mp4|webm|mov|m4v|avi)(?:$|[?#])/i.test(data.refThumbnailUrl)
      ? data.refThumbnailUrl
      : null;
  const videoSource = kind === "video" ? (data.refMediaUrl || legacyVideoSource) : null;
  const videoPoster = videoSource && data.refThumbnailUrl !== videoSource ? data.refThumbnailUrl || undefined : undefined;
  const requestedGeneratorAspect = parseGeneratorAspectRatio(data.generationAspect || (data.generationKind === "video" ? "16:9" : "1:1"));
  const generatorDimensions = generatorCardDimensions(detectedGeneratorAspect || requestedGeneratorAspect);
  const generatedMediaItems = data.resultMediaItems || [];
  const primaryGeneratedImage = generatedMediaItems[0];
  const activeGenerationTask = kind === "generator"
    && (data.generationTask?.status === "queued" || data.generationTask?.status === "running")
      ? data.generationTask
      : undefined;
  const generatorCardStyle = kind === "generator" ? {
    "--generator-card-width": `${generatorDimensions.width}px`,
    "--generator-card-height": `${generatorDimensions.height}px`,
  } as CSSProperties : undefined;
  const cardClass = [
    "canvas-node-card",
    `canvas-node-${kind}`,
    `canvas-node-role-${capabilities.role}`,
    selected ? "selected" : "",
    isInlineEditing ? "is-inline-editing" : "",
    isBroken ? "node-disabled-blur" : "",
    isNewHighlight ? "node-new-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cardClass}
      data-reference-message={locale === "en-US" ? "Reference information is incomplete" : "引用信息不完整"}
      style={generatorCardStyle}
      data-node-role={capabilities.role}
      data-content-kind={capabilities.contentKind}
      data-can-receive={capabilities.canReceive ? "true" : "false"}
      onDoubleClick={(event) => {
        if (kind !== "text" || !capabilities.contentActions.includes("edit")) return;
        event.stopPropagation();
        nodeUi.startInlineEdit(id);
      }}
    >
      {isFreeformResizable ? (
        <>
          {(["right", "bottom", "left"] as const).map((position) => (
            <NodeResizeControl
              key={position}
              nodeId={id}
              position={position}
              variant={ResizeControlVariant.Line}
              resizeDirection={position === "left" || position === "right" ? "horizontal" : "vertical"}
              minWidth={180}
              minHeight={120}
              maxWidth={760}
              maxHeight={640}
              autoScale={false}
              className={`canvas-freeform-resize-edge canvas-freeform-resize-${position} nodrag nopan`}
              onResizeStart={nodeUi.resizeNodeStart}
              onResizeEnd={() => { nodeUi.resizeNodeEnd(id); }}
            />
          ))}
          {selected ? (
            <NodeResizeControl
              nodeId={id}
              position="bottom-right"
              minWidth={180}
              minHeight={120}
              maxWidth={760}
              maxHeight={640}
              autoScale={false}
              className="canvas-freeform-resize-corner nodrag nopan"
              onResizeStart={nodeUi.resizeNodeStart}
              onResizeEnd={() => { nodeUi.resizeNodeEnd(id); }}
            >
              <svg viewBox="0 0 30 30" aria-hidden="true">
                <path d="M3 27c13.25 0 24-10.75 24-24" />
              </svg>
            </NodeResizeControl>
          ) : null}
        </>
      ) : null}
      {!capabilities.canReceive ? (
        <Handle
          type="target"
          id="t-left"
          position={Position.Left}
          className="canvas-node-handle-passive"
          isConnectableStart={false}
          isValidConnection={() => false}
        />
      ) : (
        <Handle
          type="target"
          id="t-left"
          position={Position.Left}
          className="canvas-node-handle canvas-node-handle-left"
          onPointerMove={updateMagneticHandle}
          onPointerLeave={resetMagneticHandle}
        />
      )}
      <span className="canvas-node-connection-charge" aria-hidden="true" />
      <div className="canvas-node-kind">
        <span className="canvas-node-kind-icon">
          {kind === "text" ? (
            <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 5h10M4 9h7M4 13h9" /></svg>
          ) : <ToolIcon
            type={
              kind === "noteRef" ? "note" :
              kind === "aiPrompt" ? "aiPrompt" :
              kind === "generator" ? "aiPrompt" :
              kind === "aiResult" ? "aiResult" :
              kind === "image" ? "image" :
              kind === "video" ? "video" :
              "text"
            }
          />}
        </span>
        {kind === "text"
          ? "Text"
          : isEmptyMedia && kind === "image"
            ? t("editor.canvas.type.image")
            : isEmptyMedia && kind === "video"
              ? t("editor.canvas.type.video")
          : kind === "aiResult"
            ? t("editor.canvas.node.legacyResult")
            : kind === "generator"
              ? data.generationKind === "video" ? t("editor.canvas.toolbar.videoGenerate") : t("editor.canvas.toolbar.imageGenerate")
            : canvasNodeKindLabel(kind, t)}
      </div>

      {/* 素材引用节点：缩略图 + 名称 */}
      {isEmptyMedia ? (
        <div className={`canvas-empty-media canvas-empty-media-${kind}`}>
          <ToolIcon type={kind === "video" ? "video" : "image"} />
        </div>
      ) : isAsset && hasRefSnapshot ? (
        <>
          {data.refKind === "video" && videoSource ? (
            <CanvasVideoPreview
              source={videoSource}
              poster={videoPoster}
              selected={selected}
            />
          ) : data.refKind === "video" && data.refThumbnailUrl ? (
            <img
              src={data.refThumbnailUrl}
              alt=""
              className="canvas-node-media"
              onError={(e) => {
                e.currentTarget.style.display = "none";
                const fb = e.currentTarget.parentElement?.querySelector(".img-fb") as HTMLElement | null;
                if (fb) fb.style.display = "flex";
              }}
            />
          ) : (data.refMediaUrl || data.refThumbnailUrl) ? (
            <CanvasSharpImage source={resolveCanvasMediaUrl(data.refMediaUrl || data.refThumbnailUrl)} preview={resolveCanvasMediaUrl(data.refThumbnailUrl)} alt="" className="canvas-node-media" selected={selected} fallback={t("editor.canvas.node.noThumbnail")} />
          ) : (
            <div className="canvas-node-media-fallback">
              {t("editor.canvas.node.noThumbnail")}
            </div>
          )}
          <div className="img-fb canvas-node-media-fallback" style={{ display: "none" }}>
            {t("editor.canvas.node.noThumbnail")}
          </div>
          {selected ? (
            <div className="canvas-media-card-actions nodrag nopan">
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  nodeUi.openMediaAssetPicker(id);
                }}
              >{t("editor.canvas.node.replace")}</button>
              <span aria-hidden="true" />
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  nodeUi.clearMediaAsset(id);
                }}
              >{t("editor.canvas.node.clear")}</button>
            </div>
          ) : null}
        </>
      ) : isAsset && !hasRefSnapshot ? (
        /* 旧素材节点（无快照字段）：回退到旧显示 */
        <>
          <div className="canvas-node-title">{data.label || t("editor.canvas.node.noContent")}</div>
          {data.payload ? (
            <div className="canvas-node-payload">
              {data.payload.length > 60 ? data.payload.slice(0, 60) + "…" : data.payload}
            </div>
          ) : null}
        </>
      ) : isNote ? (
        /* 笔记引用节点：标题 + 时间 + 摘要 */
        <>
          <div className="canvas-node-title strong">{data.label || t("editor.canvas.node.untitledNote")}</div>
          {data.refUpdatedAt ? (
            <div className="canvas-node-time">{formatRelativeTime(data.refUpdatedAt, locale)}</div>
          ) : null}
          {data.refSummary ? (
            <div className="canvas-node-summary">
              {data.refSummary}
            </div>
          ) : null}
        </>
      ) : kind === "generator" ? (
        <>
          <div
            className={`canvas-generator-output canvas-node-drag-handle is-${data.generationKind || "image"} ${activeGenerationTask ? "is-generating" : ""}`}
            aria-busy={activeGenerationTask ? "true" : "false"}
          >
            {data.generationKind === "video" && data.resultMediaUrl ? (
              <CanvasVideoPreview
                source={data.resultMediaUrl}
                poster={data.resultThumbnailUrl || undefined}
                selected={selected}
                onAspectRatio={setDetectedGeneratorAspect}
              />
            ) : data.generationKind === "image" && generatedMediaItems.length > 1 ? (
              <div className="canvas-ai-result-gallery">
                {generatedMediaItems.map((item, index) => (
                  <CanvasSharpImage key={`${item.url}-${index}`} source={resolveCanvasMediaUrl(item.url)} preview={resolveCanvasMediaUrl(item.thumbnailUrl)} alt={t("editor.canvas.history.generatedImage", { index: index + 1 })} selected={selected} fallback={t("editor.canvas.node.noThumbnail")} />
                ))}
              </div>
            ) : data.generationKind === "image" && (primaryGeneratedImage?.url || data.resultMediaUrl) ? (
              <CanvasSharpImage source={resolveCanvasMediaUrl(primaryGeneratedImage?.url || data.resultMediaUrl)} preview={resolveCanvasMediaUrl(primaryGeneratedImage?.thumbnailUrl || data.resultThumbnailUrl)} alt={t("editor.canvas.generation.generateImage")} className="canvas-ai-result-media" selected={selected} fallback={t("editor.canvas.node.noThumbnail")} onDimensions={(width,height)=>{if(width>0&&height>0)setDetectedGeneratorAspect(width/height);}} />
            ) : !activeGenerationTask ? (
              <div className="canvas-generator-output-empty" aria-label={data.generationKind === "video" ? t("editor.canvas.node.waitingVideo") : t("editor.canvas.node.waitingImage")}>
                <ToolIcon type={data.generationKind === "video" ? "video" : "image"} />
              </div>
            ) : null}
            {activeGenerationTask ? (
              <div className="canvas-generator-process" aria-live="polite">
                <div className="canvas-generator-process-core" aria-hidden="true">
                  <i /><i /><i />
                </div>
                <span>{generationMotionLabel(activeGenerationTask, t)}</span>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        /* 文本节点：原有显示 */
        <>
          {isInlineEditing ? (
            <textarea
              autoFocus
              className="canvas-node-inline-editor nodrag nopan"
              value={isTextPlaceholder ? "" : data.label}
              placeholder={t("editor.canvas.node.textPlaceholder")}
              aria-label={t("editor.canvas.node.editText")}
              onChange={(event) => nodeUi.updateInlineLabel(id, event.target.value)}
              onBlur={nodeUi.finishInlineEdit}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
                  event.currentTarget.blur();
                }
              }}
            />
          ) : (
            <div className="canvas-node-title">{data.label || t("editor.canvas.node.noContent")}</div>
          )}
          {!isInlineEditing && data.payload ? (
            <div className="canvas-node-payload">
              {data.payload.length > 60 ? data.payload.slice(0, 60) + "…" : data.payload}
            </div>
          ) : null}
        </>
      )}

      {capabilities.canOutput ? (
        <Handle
          type="source"
          id="s-right"
          position={Position.Right}
          className="canvas-node-handle canvas-node-handle-right"
          onPointerMove={updateMagneticHandle}
          onPointerLeave={resetMagneticHandle}
        />
      ) : null}
    </div>
  );
});

const CanvasGroupNodeView = memo(function CanvasGroupNodeView({ data, selected }: NodeProps<SpikeNode>) {
  const { t } = useI18n();
  return (
    <div className={`canvas-node-group${selected ? " selected" : ""}`}>
      <div className="canvas-group-drag-handle">
        <ToolIcon type="group" />
        <strong>{data.label || t("editor.canvas.node.group")}</strong>
        <span>{t("editor.canvas.node.cards", { count: data.groupMemberCount || 0 })}</span>
      </div>
    </div>
  );
});

const nodeTypes = { spike: SpikeNodeView, group: CanvasGroupNodeView };

// ========== 工具函数 ==========

function genId() {
  return "n" + Math.random().toString(36).slice(2, 9);
}
function genEdgeId() {
  return "e" + Math.random().toString(36).slice(2, 9);
}

function pendingConnectionPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  handleType: "source" | "target",
) {
  const bend = Math.max(72, Math.abs(endX - startX) * .42);
  const direction = handleType === "source" ? 1 : -1;
  return `M ${startX} ${startY} C ${startX + bend * direction} ${startY}, ${endX - bend * direction} ${endY}, ${endX} ${endY}`;
}

// 从 localStorage v2 读 spike 数据（仅在迁移用，不用于画布主链路）
// 已迁移过则返回 null，避免每次打开重复创建"从 spike 导入"画布
function loadLegacyFromLocalStorage(): { nodes: SpikeNode[]; edges: SpikeEdge[] } | null {
  try {
    // 迁移标记位：已迁移过直接跳过
    if (localStorage.getItem(STORAGE_KEY_MIGRATED) === "1") return null;
    const raw = localStorage.getItem(STORAGE_KEY_V2);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.nodes) && Array.isArray(obj.edges)) return obj;
    }
    const v1raw = localStorage.getItem(STORAGE_KEY_V1);
    if (v1raw) {
      const obj = JSON.parse(v1raw);
      if (obj && Array.isArray(obj.nodes) && Array.isArray(obj.edges)) {
        return {
          nodes: obj.nodes.map((n: any) => ({
            ...n,
            data: { ...n.data, kind: (n.data?.kind || "text") as NodeKind },
          })),
          edges: obj.edges,
        };
      }
    }
  } catch {}
  return null;
}

function formatRelativeTime(value: string, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 0) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return locale === "en-US" ? "Just now" : "刚刚";
  if (mins < 60) return locale === "en-US" ? `${mins}m ago` : `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return locale === "en-US" ? `${hours}h ago` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return locale === "en-US" ? `${days}d ago` : `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return locale === "en-US" ? `${months}mo ago` : `${months} 个月前`;
  return locale === "en-US" ? `${Math.floor(months / 12)}y ago` : `${Math.floor(months / 12)} 年前`;
}

// ========== 缩略图生成（Canvas 2D 简化版） ==========

const THUMB_W = 200;
const THUMB_H = 120;
const THUMB_SCALE = 2; // retina 2x
const CANVAS_SNAP_GRID: [number, number] = [28, 28];

const NODE_FILL_THUMB: Record<NodeKind, string> = {
  text: "rgba(124,138,255,.45)",
  image: "rgba(74,222,128,.45)",
  video: "rgba(167,139,250,.45)",
  noteRef: "rgba(251,191,36,.45)",
  aiPrompt: "rgba(244,114,182,.45)",
  aiResult: "rgba(56,189,248,.45)",
  generator: "rgba(255,255,255,.50)",
  group: "rgba(255,255,255,.24)",
};

function generateThumbnail(nodes: SpikeNode[], edges: SpikeEdge[]): Uint8Array | null {
  if (typeof document === "undefined") return null;
  if (nodes.length === 0) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_W * THUMB_SCALE;
    canvas.height = THUMB_H * THUMB_SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(THUMB_SCALE, THUMB_SCALE);
    ctx.fillStyle = "#12121a";
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    const NODE_W = 80;
    const NODE_H = 28;
    const positions = nodes.map((n) => ({
      x: n.position.x,
      y: n.position.y,
      cx: n.position.x + NODE_W / 2,
      cy: n.position.y + NODE_H / 2,
    }));
    const allX = positions.flatMap((p) => [p.x, p.x + NODE_W]);
    const allY = positions.flatMap((p) => [p.y, p.y + NODE_H]);
    let minX = Math.min(...allX), maxX = Math.max(...allX);
    let minY = Math.min(...allY), maxY = Math.max(...allY);
    const pad = 20;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scale = Math.min((THUMB_W - 16) / rangeX, (THUMB_H - 16) / rangeY);
    const offsetX = (THUMB_W - rangeX * scale) / 2;
    const offsetY = (THUMB_H - rangeY * scale) / 2;
    const mapX = (x: number) => (x - minX) * scale + offsetX;
    const mapY = (y: number) => (y - minY) * scale + offsetY;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.lineWidth = 1;
    for (const edge of edges) {
      const s = nodeMap.get(edge.source);
      const t = nodeMap.get(edge.target);
      if (!s || !t) continue;
      ctx.beginPath();
      ctx.moveTo(mapX(s.position.x + NODE_W / 2), mapY(s.position.y + NODE_H / 2));
      ctx.lineTo(mapX(t.position.x + NODE_W / 2), mapY(t.position.y + NODE_H / 2));
      ctx.stroke();
    }
    for (const node of nodes) {
      const x = mapX(node.position.x);
      const y = mapY(node.position.y);
      const w = NODE_W * scale;
      const h = NODE_H * scale;
      const kind = (node.type as NodeKind) || "text";
      ctx.fillStyle = NODE_FILL_THUMB[kind] || NODE_FILL_THUMB.text;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(255,255,255,.2)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, w, h);
      if (w > 20 && h > 8) {
        ctx.fillStyle = "rgba(255,255,255,.7)";
        ctx.font = `${Math.max(6, Math.min(9, w / 8))}px sans-serif`;
        ctx.textBaseline = "middle";
        const label = node.data.label || "";
        const maxChars = Math.floor(w / (w / 8));
        const text = label.length > maxChars ? label.slice(0, maxChars) + "…" : label;
        ctx.fillText(text, x + 3, y + h / 2, w - 6);
      }
    }
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  } catch (e) {
    console.warn("[canvas-d69] generateThumbnail failed", e);
    return null;
  }
}

// ========== 主组件 ==========

function CanvasInner() {
  const { t, locale } = useI18n();
  const bridge: BridgeApi | null = useMemo(() => {
    return getLuckyRayBridgeSync() as BridgeApi | null;
  }, []);
  const reactFlowInstance = useReactFlow();
  const [aiRuntimeConfig, setAiRuntimeConfig] = useState<CanvasAiRuntimeConfig>({
    ready: false,
    providerLabel: "",
    model: "",
    models: [],
    imageModel: "agnes-image-2.1-flash",
    imageModels: [],
    imageApiKeyConfigured: false,
    imageApiKey: "",
    imageBaseURL: "https://apihub.agnes-ai.com/v1",
    videoModel: "agnes-video-v2.0",
    videoModels: ["agnes-video-v2.0"],
    error: null,
  });
  const [mediaProfiles, setMediaProfiles] = useState<CanvasMediaProfilesSnapshot | null>(null);
  const activeMediaProfile = mediaProfiles?.profiles.find((entry) => entry.id === mediaProfiles.activeProfileId) ?? null;
  const legacyTextConfigRef = useRef({model:"",models:[] as string[],providerLabel:""});
  const mediaLoadEpochRef = useRef(0);
  const refreshAiRuntimeConfig = useCallback(async () => {
    const epoch = ++mediaLoadEpochRef.current;
    try {
      const mediaSnapshot = await canvasMediaProfilesClient.list();
      if (epoch !== mediaLoadEpochRef.current) return;
      setMediaProfiles(mediaSnapshot);
      const mediaProfile = mediaSnapshot.profiles.find((entry) => entry.id === mediaSnapshot.activeProfileId)!;
      // Only legacy text connections depend on app settings. Explicit canvas
      // text and image/video connections remain usable when that bridge fails.
      const settings = (mediaProfile.textProtocol ?? "legacy") === "legacy"
        ? await bridge?.getSettings?.().catch(() => null) : null;
      if (epoch !== mediaLoadEpochRef.current) return;
      const provider = settings?.aiProvider?.trim() || "deepseek";
      const providerMeta = getAiProviderMeta(provider);
      const model = settings ? settings.aiModel?.trim() || providerMeta.models[0] || "" : "";
      const models = settings ? Array.from(new Set([model, ...providerMeta.models].filter(Boolean))) : [];
      if (settings) legacyTextConfigRef.current={model,models,providerLabel:providerMeta.label};
      const textSelection = resolveCanvasTextSelection(mediaProfile,{model,models,providerLabel:providerMeta.label});
      const imageModel = mediaProfile.imageModel;
      const imageModels = mediaProfile.imageProtocol === "disabled" ? [] : Array.from(new Set([
        imageModel, ...(mediaProfile.imageModels ?? []),
      ].filter(Boolean)));
      const videoModel = mediaProfile.videoModel;
      const videoModels = mediaProfile.videoProtocol === "disabled" ? [] : Array.from(new Set([
        videoModel, ...(mediaProfile.videoModels ?? []),
      ].filter(Boolean)));
      setAiRuntimeConfig({
        ready: true,
        ...textSelection,
        imageModel,
        imageModels,
        imageApiKeyConfigured: mediaProfile.apiKeyConfigured,
        imageApiKey: "",
        imageBaseURL: mediaProfile.baseUrl,
        videoModel,
        videoModels,
        error: null,
      });
    } catch (error) {
      if (epoch !== mediaLoadEpochRef.current) return;
      setAiRuntimeConfig({
        ready: true,
        providerLabel: "",
        model: "",
        models: [],
        imageModel: "agnes-image-2.1-flash",
        imageModels: ["agnes-image-2.1-flash", "agnes-image-2.0-flash"],
        imageApiKeyConfigured: false,
        imageApiKey: "",
        imageBaseURL: "https://apihub.agnes-ai.com/v1",
        videoModel: "agnes-video-v2.0",
        videoModels: ["agnes-video-v2.0"],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [bridge, t]);
  useEffect(() => {
    void refreshAiRuntimeConfig();
    const refresh = () => { void refreshAiRuntimeConfig(); };
    window.addEventListener("luckyray:settings-change", refresh);
    return () => window.removeEventListener("luckyray:settings-change", refresh);
  }, [refreshAiRuntimeConfig]);

  // ========== 画布列表状态 ==========
  const [canvases, setCanvases] = useState<CanvasListEntry[]>([]);
  const [currentCanvasId, setCurrentCanvasId] = useState<string | null>(null);
  const [currentCanvasName, setCurrentCanvasName] = useState<string>("");
  const [currentCanvasCreatedAt, setCurrentCanvasCreatedAt] = useState<string>("");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingCanvas, setLoadingCanvas] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [, setLastSavedAt] = useState<string>("");
  const [migratedFromLocalStorage, setMigratedFromLocalStorage] = useState(false);
  const [thumbnailVersions, setThumbnailVersions] = useState<Record<string, number>>({});

  // ========== 画布内容状态 ==========
  const [nodes, setNodes] = useState<SpikeNode[]>([]);
  const [edges, setEdges] = useState<SpikeEdge[]>([]);
  const [generationHistory, setGenerationHistory] = useState<CanvasGenerationHistoryEntry[]>([]);
  const [canvasViewport, setCanvasViewport] = useState<CanvasViewport>(DEFAULT_CANVAS_VIEWPORT);
  // 多选真源：selectedNodeIds。selectedNodeId 为派生值，仅当单选时指向唯一节点，
  // 供 NodeInspector / AI 运行 / 引用打开等"单选语义"操作使用；多选或无选时为 null。
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const selectedNodeId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null;
  const [composerNodeId, setComposerNodeId] = useState<string | null>(null);
  const [inspectorNodeId, setInspectorNodeId] = useState<string | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{
    nodeId: string;
    screenX: number;
    screenY: number;
  } | null>(null);
  const [inlineEditingNodeId, setInlineEditingNodeId] = useState<string | null>(null);
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const [materialInspectorPortal, setMaterialInspectorPortal] = useState<{
    nodeId: string;
    element: HTMLElement;
  } | null>(null);

  // ========== 撤销/重做历史栈 ==========
  // nodesRef/edgesRef 镜像最新值，供回调在 setNodes 之前拿到"变更前"状态入栈。
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;
  const generationHistoryRef = useRef(generationHistory); generationHistoryRef.current = generationHistory;
  const currentCanvasIdRef = useRef(currentCanvasId); currentCanvasIdRef.current = currentCanvasId;
  const viewportRef = useRef<CanvasViewport>(canvasViewport); viewportRef.current = canvasViewport;
  const pastRef = useRef<CanvasHistorySnapshot[]>([]);
  const futureRef = useRef<CanvasHistorySnapshot[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  // 内容编辑（label/payload）debounce 入栈：首次编辑记快照，停止 800ms 后入栈
  const editSnapshotRef = useRef<CanvasHistorySnapshot | null>(null);
  const editTimerRef = useRef<number | null>(null);
  // 位置拖动：dragStart 记快照，dragStop 若有位移则入栈
  const dragSnapshotRef = useRef<CanvasHistorySnapshot | null>(null);
  const canvasIdentityRef = useRef<CanvasIdentity | null>(null);
  const canvasLoadEpochRef = useRef(0);
  // 新建节点蓝色脉冲定时器
  const newHighlightTimerRef = useRef<number | null>(null);
  const runningGenerationTaskIdsRef = useRef(new Set<string>());
  const cancelledGenerationTaskIdsRef = useRef(new Set<string>());
  const reconciledGenerationTaskIdsRef = useRef(new Set<string>());
  const generationSessionStartedAtRef = useRef(Date.now());
  const generationTaskCanvasIdsRef = useRef(new Map<string, string | null>());
  const generationTaskSnapshotsRef = useRef(new Map<string, CanvasGenerationTask>());
  const canvasTaskSaveQueuesRef = useRef(new Map<string, Promise<void>>());

  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [assetPickerTargetNodeId, setAssetPickerTargetNodeId] = useState<string | null>(null);
  const [assetPickerTargetRole, setAssetPickerTargetRole] = useState<CanvasEdgeRole | null>(null);
  const [assetPickerReplaceNodeId, setAssetPickerReplaceNodeId] = useState<string | null>(null);
  const [assetPickerMediaKind, setAssetPickerMediaKind] = useState<"image" | "video" | null>(null);
  const [mediaImportingNodeId, setMediaImportingNodeId] = useState<string | null>(null);
  const [pickerCreatePosition, setPickerCreatePosition] = useState<{ x: number; y: number } | null>(null);
  const [showNotePicker, setShowNotePicker] = useState(false);
  const [assets, setAssets] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [storageDir, setStorageDir] = useState<string>("");
  const [storageCheck, setStorageCheck] = useState<CanvasStorageCheck | null>(null);
  const [storageChecking, setStorageChecking] = useState(false);
  const [storageCheckError, setStorageCheckError] = useState<string | null>(null);

  // ========== 重命名/删除 UI 状态 ==========
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingDraft, setRenamingDraft] = useState<string>("");
  const renameSessionRef = useRef<string | null>(null);
  const renamePendingRef = useRef(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [createCanvasOpen, setCreateCanvasOpen] = useState(false);
  const [createCanvasName, setCreateCanvasName] = useState(() => t("editor.canvas.untitled"));
  const [returnConfirmMessage, setReturnConfirmMessage] = useState<string | null>(null);
  const [runningAiNodeId, setRunningAiNodeId] = useState<string | null>(null);
  const [nodeSearchOpen, setNodeSearchOpen] = useState(false);
  const [nodeSearchQuery, setNodeSearchQuery] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [canvasSettingsOpen, setCanvasSettingsOpen] = useState(false);
  const [canvasSettingsTab, setCanvasSettingsTab] = useState<"generation" | "appearance">("generation");
  const canvasSettingsAnchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canvasSettingsOpen) return;
    // Dismiss only when a gesture STARTS outside. A selection drag that starts
    // in an input and releases outside must keep the panel and draft alive.
    const onOutsidePointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      const anchor = canvasSettingsAnchorRef.current;
      if (anchor && !event.composedPath().includes(anchor)) setCanvasSettingsOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) setCanvasSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onOutsidePointerDown, true);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onOutsidePointerDown, true);
      document.removeEventListener("keydown", onEscape);
    };
  }, [canvasSettingsOpen]);
  const [creativePanel, setCreativePanel] = useState<{ canvasId:string; kind:'review'|'packs'|'workflows'|'editImage'|'export'; initialId?:string }|null>(null);
  const [generationHistoryOpen, setGenerationHistoryOpen] = useState(false);
  const [generationHistoryNotice, setGenerationHistoryNotice] = useState("");
  const [generationHistoryQuery, setGenerationHistoryQuery] = useState("");
  const [generationHistoryStatusFilter, setGenerationHistoryStatusFilter] = useState<"all" | "active" | "succeeded" | "failed">("all");
  const [generationHistoryKindFilter, setGenerationHistoryKindFilter] = useState<"all" | "text" | "image" | "video">("all");
  const [generationHistoryPreviewId, setGenerationHistoryPreviewId] = useState<string | null>(null);
  const [generationHistoryDeleteConfirmId, setGenerationHistoryDeleteConfirmId] = useState<string | null>(null);
  const [generationHistoryClearConfirm, setGenerationHistoryClearConfirm] = useState(false);
  const generationHistoryAnchorRef = useCanvasHistoryPopover(generationHistoryOpen, generationHistoryNotice,
    () => {setGenerationHistoryOpen(false);setGenerationHistoryDeleteConfirmId(null);setGenerationHistoryClearConfirm(false);},
    () => setGenerationHistoryNotice(""));
  const [uiSettings, setUiSettings] = useState<CanvasUiSettings>(() => loadCanvasUiSettings());
  const [quickAddMenu, setQuickAddMenu] = useState<{
    screenX: number;
    screenY: number;
    flowPosition: { x: number; y: number };
  } | null>(null);
  const [connectDropMenu, setConnectDropMenu] = useState<{
    screenX: number;
    screenY: number;
    flowPosition: { x: number; y: number };
    dropPoint: { x: number; y: number };
    origin: {
      nodeId: string;
      handleId: string | null;
      handleType: "source" | "target";
      startX: number;
      startY: number;
    };
  } | null>(null);
  const connectionStartRef = useRef<{
    nodeId: string;
    handleId: string | null;
    handleType: "source" | "target";
    startX: number;
    startY: number;
  } | null>(null);
  const connectionCompletedRef = useRef(false);
  const suppressNextPaneClickRef = useRef(false);
  // 小地图显示控制：默认 false，由控件栏 ⊟ 按钮切换
  const [minimapVisible, setMinimapVisible] = useState(() => loadCanvasUiSettings().minimap);

  useEffect(() => {
    try {
      window.localStorage.setItem(CANVAS_UI_SETTINGS_KEY, JSON.stringify({ ...uiSettings, minimap: minimapVisible }));
    } catch {}
  }, [uiSettings, minimapVisible]);

  const updateUiSetting = useCallback(<K extends keyof CanvasUiSettings,>(key: K, value: CanvasUiSettings[K]) => {
    setUiSettings((current) => ({ ...current, [key]: value }));
    if (key === "minimap") setMinimapVisible(Boolean(value));
  }, []);

  const applyMediaProfilesSnapshot = useCallback((snapshot: CanvasMediaProfilesSnapshot) => {
    mediaLoadEpochRef.current += 1;
    setMediaProfiles(snapshot);
    const active = snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId)!;
    setAiRuntimeConfig((current) => ({ ...current, ...resolveCanvasTextSelection(active,legacyTextConfigRef.current), ready:true, imageApiKey: "", imageApiKeyConfigured: active.apiKeyConfigured,
      imageBaseURL: active.baseUrl, imageModel: active.imageModel, videoModel: active.videoModel,
      imageModels: active.imageProtocol === "disabled" ? [] : Array.from(new Set([active.imageModel, ...(active.imageModels ?? [])].filter(Boolean))),
      videoModels: active.videoProtocol === "disabled" ? [] : Array.from(new Set([active.videoModel, ...(active.videoModels ?? [])].filter(Boolean))),
      error: null }));
    if ((active.textProtocol ?? "legacy") === "legacy") void refreshAiRuntimeConfig();
  }, [refreshAiRuntimeConfig]);

  // ========== 初次加载：拉画布列表，处理 localStorage 迁移 ==========
  useEffect(() => {
    if (!bridge) {
      setErrorMsg(t("editor.canvas.error.bridgeUnavailable"));
      return;
    }
    void refreshList();
  }, [bridge, t]);

  const refreshList = useCallback(async () => {
    if (!bridge) return;
    setLoadingList(true);
    setErrorMsg(null);
    try {
      const list = await bridge.listCanvases();
      // localStorage 一次性迁移：靠 STORAGE_KEY_MIGRATED 标记位保证只迁移一次。
      // 之前用 id==="default" 判断会失效（createCanvas 生成 c-{ts}-{hex} 格式 id，
      // 永远不会有 id="default"），导致每次打开都重复创建"从 spike 导入"画布。
      let workingList = list;
      const legacy = loadLegacyFromLocalStorage();
      if (legacy && legacy.nodes.length > 0) {
        // 创建画布并导入旧 spike 数据
        const now = new Date().toISOString();
        try {
          const created = await bridge.createCanvas(t("editor.canvas.importedFromSpike"));
          const migratedNodes = legacy.nodes.map((node) => ({
            ...node,
            data: normalizeCanvasNodeCapabilityData(node.data),
          }));
          await bridge.saveCanvas({
            schemaVersion: CANVAS_SCHEMA_VERSION,
            canvasId: created.id,
            name: created.name,
            createdAt: now,
            updatedAt: now,
            nodes: migratedNodes,
            edges: normalizeCanvasEdgeSemantics(migratedNodes, legacy.edges),
            viewport: viewportRef.current,
            generationHistory: [],
            revision: created.revision,
            contentDigest: created.contentDigest,
          });
          // 备份原 localStorage 到 -archive，再设迁移标记位
          try {
            const v2 = localStorage.getItem(STORAGE_KEY_V2) || "";
            if (v2) localStorage.setItem(STORAGE_KEY_V2_ARCHIVE, v2);
            localStorage.setItem(STORAGE_KEY_MIGRATED, "1");
          } catch {}
          setMigratedFromLocalStorage(true);
          workingList = await bridge.listCanvases();
        } catch (migErr) {
          console.warn("[canvas-d65] 迁移失败，保留原 localStorage", migErr);
          setErrorMsg(t("editor.canvas.error.localMigrationFailed"));
        }
      }
      setCanvases(workingList);
      // 如果当前没选，自动选第一个或创建 default
      if (!currentCanvasId && workingList.length > 0) {
        let pendingCanvasId = "";
        try {
          pendingCanvasId = window.sessionStorage.getItem(PENDING_CANVAS_OPEN_KEY) || "";
          window.sessionStorage.removeItem(PENDING_CANVAS_OPEN_KEY);
        } catch {}
        const targetCanvasId = resolveCanvasOpenTarget(
          workingList.map((canvas) => canvas.id),
          window.location.hash,
          pendingCanvasId,
        );
        await loadAndApplyCanvas(targetCanvasId);
      } else if (!currentCanvasId && workingList.length === 0) {
        // 首次进入，自动建一个 default
        const created = await bridge.createCanvas(t("editor.canvas.defaultName"));
        setCanvases([created]);
        await loadAndApplyCanvas(created.id);
      }
    } catch (e) {
      setErrorMsg(t("editor.canvas.error.listLoadFailed"));
      console.warn("[canvas-d65] listCanvases failed", e);
    } finally {
      setLoadingList(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, currentCanvasId, t]);

  const resetCanvasHistory = useCallback(() => {
    if (editTimerRef.current) {
      clearTimeout(editTimerRef.current);
      editTimerRef.current = null;
    }
    pastRef.current = [];
    futureRef.current = [];
    editSnapshotRef.current = null;
    dragSnapshotRef.current = null;
    resizeSnapshotRef.current = null;
    setHistoryVersion((version) => version + 1);
  }, []);

  const loadAndApplyCanvas = useCallback(async (
    canvasId: string,
    reason: "switch" | "reload" | "agent-commit" = "switch",
  ) => {
    if (!bridge) return;
    const loadEpoch = canvasLoadEpochRef.current + 1;
    canvasLoadEpochRef.current = loadEpoch;
    setLoadingCanvas(true);
    setSaveError(null);
    try {
      const c = await bridge.loadCanvas(canvasId);
      if (canvasLoadEpochRef.current !== loadEpoch) return;
      const rawNodes = Array.isArray(c.nodes) ? c.nodes as SpikeNode[] : [];
      const legacyResultNodeIds = new Set(rawNodes
        .filter((node) => node.data.kind === "aiResult")
        .map((node) => node.id));
      const loadedNodes = rawNodes.map(withInitialSquareSize);
      const loadedEdges = Array.isArray(c.edges)
        ? (c.edges as SpikeEdge[]).map((edge) => ({
            ...edge,
            sourceHandle: edge.sourceHandle || "s-right",
            targetHandle: edge.targetHandle || "t-left",
          })).filter((edge) => !legacyResultNodeIds.has(edge.target))
        : [];
      let loadedHistory = normalizeGenerationHistory(c.generationHistory);
      if (loadedHistory.length === 0) {
        loadedHistory = loadedNodes.reduce<CanvasGenerationHistoryEntry[]>((entries, node) => {
          const task = node.data.generationTask;
          if (!task) return entries;
          return upsertGenerationHistory(entries, task, {
            text: node.data.result,
            mediaUrl: node.data.resultMediaUrl || undefined,
            thumbnailUrl: node.data.resultThumbnailUrl || undefined,
            mediaItems: node.data.resultMediaItems,
          });
        }, []);
      }
      const currentIdentity = canvasIdentityRef.current;
      const canUndoAgentCommit = reason === "agent-commit"
        && currentIdentity?.canvasId === c.canvasId
        && currentCanvasIdRef.current === c.canvasId
        && Number(c.revision) === currentIdentity.revision + 1
        && typeof c.contentDigest === "string"
        && c.contentDigest.length === 64
        && c.contentDigest !== currentIdentity.contentDigest;
      if (canUndoAgentCommit) {
        pastRef.current = appendCanvasHistoryEntry(pastRef.current, createCanvasHistorySnapshot({
          canvasId: c.canvasId,
          nodes: nodesRef.current,
          edges: edgesRef.current,
          generationHistory: generationHistoryRef.current,
        }));
        futureRef.current = [];
        editSnapshotRef.current = null;
        dragSnapshotRef.current = null;
        setHistoryVersion((version) => version + 1);
      } else {
        resetCanvasHistory();
      }
      canvasIdentityRef.current = {
        canvasId: c.canvasId,
        revision: Number.isSafeInteger(c.revision) ? Number(c.revision) : 0,
        contentDigest: typeof c.contentDigest === "string" ? c.contentDigest : "",
        loadEpoch,
      };
      setCreativePanel(null);
      setCurrentCanvasId(c.canvasId);
      setCurrentCanvasName(c.name);
      setCurrentCanvasCreatedAt(c.createdAt);
      setNodes(loadedNodes);
      setEdges(normalizeCanvasEdgeSemantics(loadedNodes, loadedEdges));
      setGenerationHistory(loadedHistory);
      const loadedViewport = normalizeCanvasViewport(c.viewport);
      viewportRef.current = loadedViewport;
      setCanvasViewport(loadedViewport);
      setSelectedNodeIds([]);
      setSaveStatus("saved");
      // 新画布加载后重置编辑代，避免旧画布的未保存代污染新画布。
      saveGenerationRef.current = 0;
      lastSavedGenerationRef.current = 0;
      setLastSavedAt(c.updatedAt || "");
    } catch (e) {
      if (canvasLoadEpochRef.current !== loadEpoch) return;
      setErrorMsg(t("editor.canvas.error.canvasLoadFailed"));
      console.warn("[canvas-d65] loadCanvas failed", canvasId, e);
    } finally {
      if (canvasLoadEpochRef.current === loadEpoch) setLoadingCanvas(false);
    }
  }, [bridge, resetCanvasHistory, t]);

  // ========== 缩略图辅助 ==========
  const thumbnailDir = useMemo(() => storageDir ? storageDir + "\\.thumbnails" : "", [storageDir]);

  const saveThumbnailToDisk = useCallback(async (canvasId: string, thumbNodes: SpikeNode[], thumbEdges: SpikeEdge[]) => {
    if (!bridge) return;
    try {
      const png = generateThumbnail(thumbNodes, thumbEdges);
      if (!png) return;
      await bridge.saveCanvasThumbnail(canvasId, png);
      setThumbnailVersions((prev) => ({ ...prev, [canvasId]: (prev[canvasId] || 0) + 1 }));
    } catch (e) {
      console.warn("[canvas-d69] saveThumbnailToDisk failed", e);
    }
  }, [bridge]);

  const deleteThumbnailFromDisk = useCallback(async (canvasId: string) => {
    if (!bridge) return;
    try {
      await bridge.deleteCanvasThumbnail(canvasId);
    } catch {
      // 缩略图不存在也正常
    }
  }, [bridge]);

  const getThumbnailUrl = useCallback((canvasId: string) => {
    if (!thumbnailDir) return "";
    const path = (thumbnailDir + "\\" + canvasId + ".png").replace(/\\/g, "/");
    const ver = thumbnailVersions[canvasId];
    return convertFileSrc(path) + (ver ? "?v=" + ver : "");
  }, [thumbnailDir, thumbnailVersions]);

  // ========== 自动保存执行（由编辑代门控） ==========
  // 自动保存由编辑代（saveGenerationRef）门控：只有存在未持久化的新编辑代才
  // 写盘。保存捕获开始时的代；完成时仅当期间没有新编辑才标记 clean，否则
  // 保持 dirty 并串行跟进下一次保存（不依赖可能已触发的 debounce timer）。
  // 保存负载一律从 refs 读最新状态；显式保存与自动保存共享同一保存槽，
  // 同一时刻至多一个 durable 写入在飞。
  const flushPendingAutosave = useCallback(async () => {
    if (!bridge || !currentCanvasId || loadingCanvas) return;
    if (!tryAcquireCanvasSaveSlot(saveSlotRef.current)) return;
    const generation = saveGenerationRef.current;
    if (generation === lastSavedGenerationRef.current) {
      releaseCanvasSaveSlot(saveSlotRef.current);
      return;
    }
    setSaveStatus("saving");
    const now = new Date().toISOString();
    // 持久化边界：写盘前剥离 UI 瞬态字段，冲突/兜底归档使用同一净化负载。
    const durableNodes = sanitizeCanvasNodesForPersistence(nodesRef.current);
    const durableEdges = normalizeCanvasEdgeSemantics(durableNodes, sanitizeCanvasEdgesForPersistence(edgesRef.current));
    let savedOk = false;
    try {
      const identity = canvasIdentityRef.current;
      if (!canvasSaveIdentityMatchesCanvas(identity, currentCanvasId)) {
        throw new Error("canvas-revision-conflict");
      }
      const saved = await bridge.saveCanvas({
        schemaVersion: CANVAS_SCHEMA_VERSION,
        canvasId: currentCanvasId,
        name: currentCanvasName || t("editor.canvas.untitled"),
        createdAt: currentCanvasCreatedAt || now,
        updatedAt: now,
        nodes: durableNodes,
        edges: durableEdges,
        viewport: viewportRef.current,
        generationHistory: generationHistoryRef.current,
        revision: identity.revision,
        contentDigest: identity.contentDigest,
      });
      if (currentCanvasIdRef.current !== currentCanvasId) return;
      canvasIdentityRef.current = {
        canvasId: saved.id,
        revision: saved.revision,
        contentDigest: saved.contentDigest,
        loadEpoch: identity.loadEpoch,
      };
      setSaveError(null);
      // 同步刷新列表的 updatedAt
      const updated = await bridge.listCanvases();
      setCanvases(updated);
      setLastSavedAt(saved.updatedAt || now);
      lastSavedGenerationRef.current = generation;
      savedOk = true;
      if (canvasSaveCompletionMayMarkClean(saveGenerationRef.current, generation)) {
        setSaveStatus("saved");
        void saveThumbnailToDisk(currentCanvasId, nodesRef.current, edgesRef.current);
      } else {
        // 保存期间出现了新编辑：不得清除脏状态，由下方串行跟进保存。
        setSaveStatus("dirty");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("canvas-revision-conflict")) {
        try {
          localStorage.setItem(STORAGE_KEY_V2_ARCHIVE, JSON.stringify({
            nodes: durableNodes,
            edges: durableEdges,
            generationHistory: generationHistoryRef.current,
            updatedAt: new Date().toISOString(),
            conflict: true,
          }));
        } catch {}
        await loadAndApplyCanvas(currentCanvasId, "reload");
        setSaveError(t("editor.canvas.error.revisionConflict"));
        setSaveStatus("error");
        return;
      }
      setSaveError(t("editor.canvas.error.saveFailed", { error: msg }));
      setSaveStatus("error");
      console.warn("[canvas-d65] saveCanvas failed", e);
      // 兜底：写入 localStorage 防止数据丢失
      try {
        localStorage.setItem(STORAGE_KEY_V2_ARCHIVE, JSON.stringify({
          nodes: durableNodes,
          edges: durableEdges,
          generationHistory: generationHistoryRef.current,
          updatedAt: new Date().toISOString(),
        }));
      } catch {}
    } finally {
      releaseCanvasSaveSlot(saveSlotRef.current);
    }
    // 仅成功的旧保存发现新编辑时才串行跟进；失败保持 dirty/error，不立即重试。
    if (canvasStaleSaveShouldFollowUp(savedOk, saveGenerationRef.current, lastSavedGenerationRef.current)) {
      void flushPendingAutosave();
    }
  }, [bridge, currentCanvasId, currentCanvasName, currentCanvasCreatedAt, loadAndApplyCanvas, loadingCanvas, t]);

  const persistCurrentCanvas = useCallback(async () => {
    if (!bridge || !currentCanvasId) return;
    const now = new Date().toISOString();
    setSaveStatus("saving");
    // 等待在飞的保存 settle；等待期间 autosave 可能已推进 revision/digest，
    // 因此 identity 必须在等待之后重新读取并验证，绝不跨等待携带旧期望值。
    while (saveSlotRef.current.occupied) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (!tryAcquireCanvasSaveSlot(saveSlotRef.current)) return;
    let savedOk = false;
    try {
      const identity = canvasIdentityRef.current;
      if (!canvasSaveIdentityMatchesCanvas(identity, currentCanvasId)) {
        throw new Error("canvas-revision-conflict");
      }
      const generation = saveGenerationRef.current;
      // 持久化边界：写盘前剥离 UI 瞬态字段，冲突归档使用同一净化后的文档负载。
      const durableNodes = sanitizeCanvasNodesForPersistence(nodesRef.current);
      const durableEdges = normalizeCanvasEdgeSemantics(durableNodes, sanitizeCanvasEdgesForPersistence(edgesRef.current));
      let saved: CanvasListEntry;
      try {
        saved = await bridge.saveCanvas({
          schemaVersion: CANVAS_SCHEMA_VERSION,
          canvasId: currentCanvasId,
        name: currentCanvasName || t("editor.canvas.untitled"),
          createdAt: currentCanvasCreatedAt || now,
          updatedAt: now,
          nodes: durableNodes,
          edges: durableEdges,
          viewport: viewportRef.current,
          generationHistory: generationHistoryRef.current,
          revision: identity.revision,
          contentDigest: identity.contentDigest,
        });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (message.includes("canvas-revision-conflict")) {
          try {
            localStorage.setItem(STORAGE_KEY_V2_ARCHIVE, JSON.stringify({
              nodes: durableNodes,
              edges: durableEdges,
              generationHistory: generationHistoryRef.current,
              updatedAt: now,
              conflict: true,
            }));
          } catch {}
          await loadAndApplyCanvas(currentCanvasId, "reload");
        }
        throw reason;
      }
      if (currentCanvasIdRef.current !== currentCanvasId) return;
      canvasIdentityRef.current = {
        canvasId: saved.id,
        revision: saved.revision,
        contentDigest: saved.contentDigest,
        loadEpoch: identity.loadEpoch,
      };
      const updated = await bridge.listCanvases();
      setCanvases(updated);
      setLastSavedAt(saved.updatedAt || now);
      setSaveError(null);
      lastSavedGenerationRef.current = generation;
      savedOk = true;
      if (canvasSaveCompletionMayMarkClean(saveGenerationRef.current, generation)) {
        setSaveStatus("saved");
        void saveThumbnailToDisk(currentCanvasId, nodesRef.current, edgesRef.current);
      } else {
        // 显式保存期间出现了新编辑：不得清除脏状态，由后续自动保存跟进。
        setSaveStatus("dirty");
      }
    } finally {
      releaseCanvasSaveSlot(saveSlotRef.current);
    }
    if (canvasStaleSaveShouldFollowUp(savedOk, saveGenerationRef.current, lastSavedGenerationRef.current)) {
      void flushPendingAutosave();
    }
  }, [bridge, currentCanvasId, currentCanvasName, currentCanvasCreatedAt, flushPendingAutosave, loadAndApplyCanvas, t]);

  useEffect(() => {
    if (!bridge?.getCanvasStorageDir) return;
    void bridge.getCanvasStorageDir()
      .then((dir) => setStorageDir(dir || ""))
      .catch((e) => console.warn("[canvas-d65] getCanvasStorageDir failed", e));
  }, [bridge]);

  const handleCheckStorage = useCallback(async () => {
    if (!bridge?.checkCanvasFiles) {
      setStorageCheckError(t("editor.canvas.storage.unsupported"));
      return;
    }
    setStorageChecking(true);
    setStorageCheckError(null);
    try {
      const result = await bridge.checkCanvasFiles();
      setStorageCheck(result);
      if (result.storageDir) setStorageDir(result.storageDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStorageCheckError(t("editor.canvas.storage.checkFailed", { error: msg }));
    } finally {
      setStorageChecking(false);
    }
  }, [bridge, t]);

  // ========== 自动保存（debounce 500ms，写文件） ==========
  useEffect(() => {
    if (!bridge || !currentCanvasId) return;
    if (loadingCanvas) return; // 加载中的空状态不回写；用户主动清空画布仍会保存历史。
    const t = setTimeout(() => {
      void flushPendingAutosave();
    }, 500);
    return () => clearTimeout(t);
  }, [nodes, edges, generationHistory, canvasViewport, currentCanvasId, bridge, loadingCanvas, flushPendingAutosave]);

  // ========== 节点编辑回调（保留 D47） ==========
  // 持久化边界状态：编辑代（每次真实文档编辑递增）、已保存代（上次成功保存
  // 捕获的代）、保存槽（显式保存与自动保存共享，同一时刻至多一个 durable
  // 写入在飞，避免针对同一 expected revision 的重叠写入）。UI-only 交互
  // （选择/测量/高亮）即使引起 nodes/edges 引用变化也不会推进编辑代。
  const saveGenerationRef = useRef(0);
  const lastSavedGenerationRef = useRef(0);
  const saveSlotRef = useRef<CanvasSaveSlot>({ occupied: false });
  // This retained page participates even when Settings/LSH is visible. Use
  // the existing writer and generation/identity refs; never regard a queued
  // autosave or a local recovery archive as a durable save acknowledgement.
  const quitFlushRef = useRef<() => Promise<boolean>>(async () => false);
  quitFlushRef.current = () => flushCanvasBeforeQuit(() => ({
    canvasId: currentCanvasIdRef.current,
    loadEpoch: canvasLoadEpochRef.current,
    editing: saveGenerationRef.current,
    saved: lastSavedGenerationRef.current,
    writing: saveSlotRef.current.occupied,
    blocked: loadingCanvas || runningAiNodeId !== null || mediaImportingNodeId !== null
      || renamePendingRef.current || canvasTaskSaveQueuesRef.current.size > 0
      || runningGenerationTaskIdsRef.current.size > 0
      || nodesRef.current.some(node => ['queued', 'running'].includes(node.data.generationTask?.status ?? ''))
      || Array.from(generationTaskSnapshotsRef.current.values()).some(task => ['queued', 'running'].includes(task.status)),
  }), persistCurrentCanvas);
  useEffect(() => registerWorkspaceFlush(() => quitFlushRef.current()), []);
  const markDirty = useCallback(() => {
    saveGenerationRef.current = advanceCanvasEditGeneration(saveGenerationRef.current);
    setSaveStatus("dirty");
    setSaveError(null);
  }, []);

  // 把未提交的内容编辑快照入栈（停止输入 800ms 后触发）
  const flushEditHistory = useCallback(() => {
    if (editTimerRef.current) {
      clearTimeout(editTimerRef.current);
      editTimerRef.current = null;
    }
    if (editSnapshotRef.current) {
      if (editSnapshotRef.current.canvasId === currentCanvasIdRef.current) {
        pastRef.current = appendCanvasHistoryEntry(pastRef.current, editSnapshotRef.current);
      }
      futureRef.current = [];
      editSnapshotRef.current = null;
      setHistoryVersion((v) => v + 1);
    }
  }, []);

  // 入栈当前（变更前）快照，清空 future。语义变更前调用。
  // 必须先 flush 未提交的内容编辑，保证历史时间顺序 A → B（问题 A）。
  const commitHistory = useCallback(() => {
    flushEditHistory();
    const canvasId = currentCanvasIdRef.current;
    if (!canvasId) return;
    const snapshot = createCanvasHistorySnapshot({
      canvasId,
      nodes: nodesRef.current,
      edges: edgesRef.current,
      generationHistory: generationHistoryRef.current,
    });
    // 避免 flush 后立即命令产生与刚入栈编辑快照相同的重复快照。
    const last = pastRef.current[pastRef.current.length - 1];
    if (!(last && canvasHistorySnapshotsEqual(last, snapshot))) {
      pastRef.current = appendCanvasHistoryEntry(pastRef.current, snapshot);
    }
    futureRef.current = [];
    setHistoryVersion((v) => v + 1);
  }, [flushEditHistory]);

  // 开始一次新的内容编辑事务：捕获编辑前快照（仅一次），立即失效 stale redo
  // （不等 800ms，问题 C），并重置 800ms 合并计时器。所有 label/payload/data
  // 更新器（含主文字编辑路径 updateNodeLabel）共用。
  const beginPendingEdit = useCallback(() => {
    const canvasId = currentCanvasIdRef.current;
    if (!canvasId) return;
    const result = canvasBeginPendingEdit(editSnapshotRef.current, futureRef.current, {
      canvasId,
      nodes: nodesRef.current,
      edges: edgesRef.current,
      generationHistory: generationHistoryRef.current,
    });
    editSnapshotRef.current = result.snapshot;
    futureRef.current = result.future;
    if (editTimerRef.current) clearTimeout(editTimerRef.current);
    editTimerRef.current = window.setTimeout(() => { flushEditHistory(); }, 800);
  }, [flushEditHistory]);

  // ========== 节点 resize 历史事务（问题 D） ==========
  // 开始捕获一个 pre-resize 快照；结束按真实尺寸变化入栈一次并清空 redo。
  // 移动过程保持实时渲染状态（C2 继续标记尺寸变化可自动保存）。
  const resizeSnapshotRef = useRef<CanvasHistorySnapshot | null>(null);

  const undo = useCallback(() => {
    flushEditHistory(); // 先把进行中的编辑入栈，保证撤销链完整
    if (pastRef.current.length === 0) return;
    const prev = pastRef.current.pop()!;
    if (!currentCanvasIdRef.current || prev.canvasId !== currentCanvasIdRef.current) {
      resetCanvasHistory();
      setSaveError(t("editor.canvas.error.undoCleared"));
      return;
    }
    futureRef.current = appendCanvasHistoryEntry(futureRef.current, createCanvasHistorySnapshot({
      canvasId: prev.canvasId,
      nodes: nodesRef.current,
      edges: edgesRef.current,
      generationHistory: generationHistoryRef.current,
    }));
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setGenerationHistory(prev.generationHistory);
    setSelectedNodeIds([]);
    markDirty();
    setHistoryVersion((v) => v + 1);
  }, [flushEditHistory, markDirty, resetCanvasHistory, t]);

  const redo = useCallback(() => {
    if (editSnapshotRef.current) return; // 新编辑已开始：stale redo 已失效，不得消费（问题 C）
    if (futureRef.current.length === 0) return;
    const next = futureRef.current.pop()!;
    if (!currentCanvasIdRef.current || next.canvasId !== currentCanvasIdRef.current) {
      resetCanvasHistory();
      setSaveError(t("editor.canvas.error.redoCleared"));
      return;
    }
    pastRef.current = appendCanvasHistoryEntry(pastRef.current, createCanvasHistorySnapshot({
      canvasId: next.canvasId,
      nodes: nodesRef.current,
      edges: edgesRef.current,
      generationHistory: generationHistoryRef.current,
    }));
    setNodes(next.nodes);
    setEdges(next.edges);
    setGenerationHistory(next.generationHistory);
    setSelectedNodeIds([]);
    markDirty();
    setHistoryVersion((v) => v + 1);
  }, [markDirty, t]);

  // historyVersion 触发重渲染，使 canUndo/canRedo 在历史栈变化后重算
  const canUndo = historyVersion >= 0 && (pastRef.current.length > 0 || editSnapshotRef.current !== null);
  const canRedo = historyVersion >= 0 && futureRef.current.length > 0;

  const onNodesChange = useCallback((changes: NodeChange<SpikeNode>[]) => {
    // 仅当变更批包含真正的文档编辑时才标记脏；选择/测量等 UI 态变化不进自动保存。
    if (nodeChangesContainDurableEdit(changes)) markDirty();
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, [markDirty]);
  const onEdgesChange = useCallback((changes: EdgeChange<SpikeEdge>[]) => {
    if (edgeChangesContainDurableEdit(changes)) markDirty();
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, [markDirty, resetCanvasHistory]);
  const isValidCanvasConnection = useCallback((connection: Connection | SpikeEdge) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    const sourceNode = nodesRef.current.find((node) => node.id === connection.source);
    const targetNode = nodesRef.current.find((node) => node.id === connection.target);
    if (!sourceNode || !targetNode) return false;
    return canConnectCanvasNodes(sourceNode.data, targetNode.data);
  }, []);
  const onConnect = useCallback(
    (c: Connection) => {
      commitHistory();
      markDirty();
      setEdges((current) => {
        const source = nodesRef.current.find((node) => node.id === c.source);
        const target = nodesRef.current.find((node) => node.id === c.target);
        if (!source || !target || !c.target) return current;
        const data = resolveCanvasEdgeSemanticData(source.data, target.data, c.target, current);
        return addEdge({ ...c, animated: false, id: genEdgeId(), data }, current);
      });
    },
    [commitHistory, markDirty]
  );

  const getViewportCreatePosition = useCallback((kind: NodeKind) => {
    const stage = editorBodyRef.current?.querySelector<HTMLElement>(".canvas-editor-stage");
    const rect = stage?.getBoundingClientRect();
    const screenCenter = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const flowCenter = reactFlowInstance.screenToFlowPosition(screenCenter);
    const size = kind === "generator"
      ? { width: 620, height: 430 }
      : kind === "noteRef"
        ? { width: 260, height: 260 }
        : kind === "text" || kind === "aiPrompt"
          ? { width: 320, height: 220 }
          : { width: 300, height: 240 };
    return {
      x: Math.round((flowCenter.x - size.width / 2) / CANVAS_SNAP_GRID[0]) * CANVAS_SNAP_GRID[0],
      y: Math.round((flowCenter.y - size.height / 2) / CANVAS_SNAP_GRID[1]) * CANVAS_SNAP_GRID[1],
    };
  }, [reactFlowInstance]);

  const addNode = useCallback((kind: NodeKind, preset?: Partial<SpikeNodeData>, position?: { x: number; y: number }) => {
    commitHistory();
    markDirty();
    const id = genId();
    const label = preset?.label ?? (
      kind === "text" ? t("editor.canvas.node.doubleClickEdit") :
      kind === "image" ? t("editor.canvas.node.newImage") :
      kind === "video" ? t("editor.canvas.node.newVideo") :
      kind === "noteRef" ? t("editor.canvas.node.newNote") :
      kind === "aiPrompt" ? t("editor.canvas.node.newPrompt") :
      kind === "generator" ? t("editor.canvas.node.newGeneration") :
      t("editor.canvas.node.legacyResult")
    );
    const nodeData: SpikeNodeData = normalizeCanvasNodeCapabilityData({
      label,
      kind,
      payload: preset?.payload,
      refThumbnailUrl: preset?.refThumbnailUrl,
      refMediaUrl: preset?.refMediaUrl,
      refKind: preset?.refKind,
      refSummary: preset?.refSummary,
      refContextText: preset?.refContextText,
      derivedFromNodeId: preset?.derivedFromNodeId,
      imageEdit: preset?.imageEdit,
      refUpdatedAt: preset?.refUpdatedAt,
      generationKind: preset?.generationKind,
      generationPrompt: preset?.generationPrompt,
      generationModel: preset?.generationModel,
      generationAspect: preset?.generationAspect,
      generationDuration: preset?.generationDuration,
      generationSound: preset?.generationSound,
      generationQuality: preset?.generationQuality,
      generationResolution: preset?.generationResolution,
      generationCount: preset?.generationCount,
      generationCameraStrength: preset?.generationCameraStrength,
      generationReferences: preset?.generationReferences,
      _emptyMedia: preset?._emptyMedia,
      _manualSize: false,
      _newHighlight: true,
    });
    const initialNodeSize = kind === "text"
      ? textNodeSize(nodeData)
      : kind === "noteRef"
        ? { width: squareNodeSize(nodeData), height: squareNodeSize(nodeData) }
        : null;
    setNodes((nds) =>
      nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat([
        {
          id,
          type: "spike",
          position: position || { x: 100 + Math.random() * 400, y: 100 + Math.random() * 200 },
          data: nodeData,
          dragHandle: kind === "generator" ? ".canvas-node-drag-handle" : undefined,
          style: initialNodeSize || undefined,
          selected: true,
        },
      ]),
    );
    setSelectedNodeIds([id]);
    // 新建节点只做一次短暂淡入提示，避免持续动效干扰创作。
    if (newHighlightTimerRef.current) window.clearTimeout(newHighlightTimerRef.current);
    newHighlightTimerRef.current = window.setTimeout(() => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id && n.data && (n.data as SpikeNodeData)._newHighlight
            ? { ...n, data: { ...n.data, _newHighlight: false } }
            : n,
        ),
      );
      newHighlightTimerRef.current = null;
    }, 900);
    return id;
  }, [commitHistory, markDirty, t]);

  const addGeneratorNode = useCallback((
    generationKind: GenerationKind,
    source?: SpikeNode,
    position?: { x: number; y: number },
    connectSource = true,
    mode: "generate" | "edit" = "generate",
  ) => {
    const sourceWidth = Number(source?.measured?.width || source?.style?.width || 300);
    const id = addNode("generator", {
      label: mode === "edit"
        ? generationKind === "video" ? t("editor.canvas.node.videoEdit") : t("editor.canvas.node.imageEdit")
        : generationKind === "video" ? t("editor.canvas.node.videoGenerate") : t("editor.canvas.node.imageGenerate"),
      generationKind,
      generationPrompt: mode === "edit"
        ? generationKind === "video"
          ? t("editor.canvas.generation.defaultEditVideoPrompt")
          : t("editor.canvas.generation.defaultEditImagePrompt")
        : undefined,
      generationAspect: generationKind === "video" ? "16:9" : "1:1",
      generationDuration: generationKind === "video" ? 5 : undefined,
      generationQuality: generationKind === "video" ? "1080p" : "高清",
      generationCount: generationKind === "image" ? 1 : undefined,
      generationCameraStrength: generationKind === "video" ? 50 : undefined,
    }, position || (source ? { x: source.position.x + sourceWidth + 120, y: source.position.y } : undefined));
    if (source && connectSource) {
      const targetData = normalizeCanvasNodeCapabilityData<SpikeNodeData>({
        label: generationKind === "video" ? t("editor.canvas.node.videoGenerate") : t("editor.canvas.node.imageGenerate"),
        kind: "generator",
        generationKind,
      });
      setEdges((current) => addEdge({
        id: genEdgeId(),
        source: source.id,
        target: id,
        sourceHandle: "s-right",
        targetHandle: "t-left",
        animated: false,
        data: resolveCanvasEdgeSemanticData(source.data, targetData, id, current),
      }, current));
    }
    setCreateMenuOpen(false);
    return id;
  }, [addNode, t]);

  const createConnectedNode = useCallback((kind: "text" | "script" | "imageGenerator" | "videoGenerator" | "imageEditor" | "videoEditor") => {
    if (!connectDropMenu) return;
    const sourceNode = nodesRef.current.find((node) => node.id === connectDropMenu.origin.nodeId);
    let nodeId: string;
    if (kind === "imageGenerator" || kind === "imageEditor") {
      nodeId = addGeneratorNode("image", sourceNode, connectDropMenu.flowPosition, false, kind === "imageEditor" ? "edit" : "generate");
    } else if (kind === "videoGenerator" || kind === "videoEditor") {
      nodeId = addGeneratorNode("video", sourceNode, connectDropMenu.flowPosition, false, kind === "videoEditor" ? "edit" : "generate");
    } else {
      nodeId = addNode("text", {
        label: t("editor.canvas.node.doubleClickEdit"),
        generationPrompt: kind === "script" ? t("editor.canvas.generation.defaultScriptPrompt") : undefined,
      }, connectDropMenu.flowPosition);
    }

    const startsFromSource = connectDropMenu.origin.handleType === "source";
    const createdNodeData = normalizeCanvasNodeCapabilityData<SpikeNodeData>({
      label: kind === "text" || kind === "script" ? t("editor.canvas.node.doubleClickEdit") : kind.includes("video") ? t("editor.canvas.node.videoGenerate") : t("editor.canvas.node.imageGenerate"),
      kind: kind.includes("Generator") || kind.includes("Editor")
        ? "generator"
        : "text",
      generationKind: kind === "imageGenerator" || kind === "imageEditor"
        ? "image"
        : kind === "videoGenerator" || kind === "videoEditor" ? "video" : undefined,
    });
    setEdges((current) => {
      const sourceId = startsFromSource ? connectDropMenu.origin.nodeId : nodeId;
      const targetId = startsFromSource ? nodeId : connectDropMenu.origin.nodeId;
      const sourceData = startsFromSource ? sourceNode?.data : createdNodeData;
      const targetData = startsFromSource ? createdNodeData : sourceNode?.data;
      const data = sourceData && targetData
        ? resolveCanvasEdgeSemanticData(sourceData, targetData, targetId, current)
        : undefined;
      return addEdge({
        id: genEdgeId(),
        source: sourceId,
        target: targetId,
        sourceHandle: startsFromSource ? (connectDropMenu.origin.handleId || "s-right") : "s-right",
        targetHandle: startsFromSource ? "t-left" : (connectDropMenu.origin.handleId || "t-left"),
        animated: false,
        data,
      }, current);
    });
    if (kind === "text" || kind === "script") {
      setComposerNodeId(nodeId);
    }
    setConnectDropMenu(null);
    connectionStartRef.current = null;
  }, [addGeneratorNode, addNode, connectDropMenu, t]);

  const loadAssetPicker = useCallback(async (
    targetNodeId: string | null,
    targetRole: CanvasEdgeRole | null = null,
    createPosition: { x: number; y: number } | null = null,
  ) => {
    if (!bridge) return;
    setAssetPickerReplaceNodeId(null);
    setAssetPickerMediaKind(null);
    setAssetPickerTargetNodeId(targetNodeId);
    setAssetPickerTargetRole(targetRole);
    setPickerCreatePosition(targetNodeId ? null : createPosition);
    setShowAssetPicker(true);
    setPickerLoading(true);
    try {
      const list = await bridge.listAssets();
      setAssets(Array.isArray(list) ? list : []);
    } catch (e) {
      console.warn("[canvas-d65] listAssets failed", e);
      setAssets([]);
    } finally {
      setPickerLoading(false);
    }
  }, [bridge, reactFlowInstance]);

  const openAssetPicker = useCallback(() => {
    void loadAssetPicker(null, null, getViewportCreatePosition("image"));
  }, [getViewportCreatePosition, loadAssetPicker]);

  const openAssetPickerAtPosition = useCallback((position: { x: number; y: number }) => {
    void loadAssetPicker(null, null, position);
  }, [loadAssetPicker]);

  const openGeneratorAssetPicker = useCallback((nodeId: string, role?: CanvasEdgeRole) => {
    void loadAssetPicker(nodeId, role || null);
  }, [loadAssetPicker]);

  const openMediaAssetPicker = useCallback(async (nodeId: string) => {
    if (!bridge) return;
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    if (!node || (node.data.kind !== "image" && node.data.kind !== "video")) return;
    const mediaKind = node.data.kind;
    setAssetPickerTargetNodeId(null);
    setAssetPickerTargetRole(null);
    setAssetPickerReplaceNodeId(nodeId);
    setAssetPickerMediaKind(mediaKind);
    setPickerCreatePosition(null);
    setShowAssetPicker(true);
    setPickerLoading(true);
    try {
      const list = await bridge.listAssets();
      setAssets(Array.isArray(list) ? list.filter((asset) => asset?.kind === mediaKind) : []);
    } catch (error) {
      console.warn("[canvas-media] listAssets failed", error);
      setAssets([]);
    } finally {
      setPickerLoading(false);
    }
  }, [bridge]);

  const loadNotePicker = useCallback(async (createPosition: { x: number; y: number } | null) => {
    if (!bridge) return;
    setPickerCreatePosition(createPosition);
    setShowNotePicker(true);
    setPickerLoading(true);
    try {
      const list = await bridge.listNotes();
      setNotes(Array.isArray(list) ? list : []);
    } catch (e) {
      console.warn("[canvas-d65] listNotes failed", e);
      setNotes([]);
    } finally {
      setPickerLoading(false);
    }
  }, [bridge]);

  const openNotePicker = useCallback(() => {
    void loadNotePicker(getViewportCreatePosition("noteRef"));
  }, [getViewportCreatePosition, loadNotePicker]);

  const openNotePickerAtPosition = useCallback((position: { x: number; y: number }) => {
    void loadNotePicker(position);
  }, [loadNotePicker]);

  const applyAssetToMediaNode = useCallback((nodeId: string, asset: any) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    if (!node || (node.data.kind !== "image" && node.data.kind !== "video")) return false;
    if (asset?.kind !== node.data.kind) return false;
    const toWebUrl = (value: unknown): string | null => {
      if (typeof value !== "string" || !value) return null;
      if (/^(https?:|asset:|blob:|data:)/i.test(value)) return value;
      return convertFileSrc(value);
    };
    const mediaUrl = toWebUrl(asset.libraryPath || asset.originalPath);
    const thumbUrl = toWebUrl(asset.thumbnailUrl) || (node.data.kind === "image" ? mediaUrl : null);
    commitHistory();
    markDirty();
    setNodes((current) => current.map((candidate) => candidate.id === nodeId
      ? {
          ...candidate,
          data: normalizeCanvasNodeCapabilityData({
            ...candidate.data,
            sourceGenerationTaskId:undefined,sourceGenerationHistoryId:undefined,sourceGenerationMediaUrl:undefined,
            generationTask:undefined,resultMediaUrl:undefined,resultMediaItems:undefined,resultThumbnailUrl:undefined,
            label: asset.name || (node.data.kind === "video" ? t("editor.canvas.node.untitledVideo") : t("editor.canvas.node.untitledImage")),
            payload: `asset:${asset.id}`,
            refThumbnailUrl: thumbUrl,
            refMediaUrl: mediaUrl,
            refKind: node.data.kind,
            refUpdatedAt: asset.updatedAt || null,
            _emptyMedia: false,
            role: "resource",
          }),
        }
      : candidate));
    return true;
  }, [commitHistory, markDirty, t]);

  const clearMediaAsset = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    if (!node || (node.data.kind !== "image" && node.data.kind !== "video")) return;
    const mediaKind: GenerationKind = node.data.kind === "video" ? "video" : "image";
    commitHistory();
    markDirty();
    setNodes((current) => current.map((candidate) => candidate.id === nodeId
      ? {
          ...candidate,
          dragHandle: ".canvas-node-drag-handle",
          style: undefined,
          data: normalizeCanvasNodeCapabilityData<SpikeNodeData>({
            ...candidate.data,
            sourceGenerationTaskId:undefined,sourceGenerationHistoryId:undefined,sourceGenerationMediaUrl:undefined,
            generationTask:undefined,resultMediaUrl:undefined,resultMediaItems:undefined,resultThumbnailUrl:undefined,
            label: mediaKind === "video" ? t("editor.canvas.node.videoGenerate") : t("editor.canvas.node.imageGenerate"),
            kind: "generator",
            payload: undefined,
            refThumbnailUrl: null,
            refMediaUrl: null,
            refKind: undefined,
            refUpdatedAt: null,
            generationReferences: [],
            generationKind: mediaKind,
            generationAspect: mediaKind === "video" ? "16:9" : "1:1",
            generationDuration: mediaKind === "video" ? 5 : undefined,
            generationQuality: mediaKind === "video" ? "1080p" : "高清",
            generationCount: mediaKind === "image" ? 1 : undefined,
            _emptyMedia: undefined,
          }),
        }
      : candidate));
  }, [commitHistory, markDirty, t]);

  const pickAsset = useCallback((asset: any) => {
    const kind: NodeKind = asset.kind === "video" ? "video" : "image";
    const toWebUrl = (value: unknown): string | null => {
      if (typeof value !== "string" || !value) return null;
      if (/^(https?:|asset:|blob:|data:)/i.test(value)) return value;
      return convertFileSrc(value);
    };
    const mediaUrl = toWebUrl(asset.libraryPath || asset.originalPath);
    const thumbUrl = toWebUrl(asset.thumbnailUrl) || (kind === "image" ? mediaUrl : null);
    if (assetPickerReplaceNodeId) {
      if (!applyAssetToMediaNode(assetPickerReplaceNodeId, asset)) return;
      setShowAssetPicker(false);
      setAssetPickerReplaceNodeId(null);
      setAssetPickerMediaKind(null);
      setPickerCreatePosition(null);
      return;
    }
    if (assetPickerTargetNodeId) {
      const reference: GenerationReference = {
        id: `asset:${asset.id}:${assetPickerTargetRole || "reference"}`,
        label: asset.name || t("editor.canvas.picker.untitledMaterial"),
        kind: asset.kind || "image",
        role: assetPickerTargetRole || "reference",
        thumbnailUrl: thumbUrl,
        mediaUrl,
      };
      commitHistory();
      markDirty();
      setNodes((nds) => nds.map((node) => {
        if (node.id !== assetPickerTargetNodeId) return node;
        const current = Array.isArray(node.data.generationReferences)
          ? node.data.generationReferences
          : node.data.payload ? [{
            id: node.data.payload,
            label: node.data.label,
            kind: node.data.refKind || "image",
            thumbnailUrl: node.data.refThumbnailUrl,
            mediaUrl: node.data.refMediaUrl,
          }] : [];
        const replaceableRoles: CanvasEdgeRole[] = ["firstFrame", "lastFrame"];
        const withoutReplacedSlot = replaceableRoles.includes(reference.role || "reference")
          ? current.filter((item) => item.role !== reference.role)
          : current;
        const next = withoutReplacedSlot.some((item) => item.id === reference.id)
          ? withoutReplacedSlot
          : withoutReplacedSlot.concat(reference).slice(0, 4);
        return { ...node, data: { ...node.data, generationReferences: next } };
      }));
      setShowAssetPicker(false);
      setAssetPickerTargetNodeId(null);
      setAssetPickerTargetRole(null);
      setPickerCreatePosition(null);
      return;
    }
    addNode(kind, {
      label: asset.name || t("editor.canvas.picker.untitledMaterial"),
      payload: `asset:${asset.id}`,
      refThumbnailUrl: thumbUrl,
      refMediaUrl: mediaUrl,
      refKind: asset.kind || "image",
      refUpdatedAt: asset.updatedAt || null,
    }, pickerCreatePosition || getViewportCreatePosition(kind));
    setShowAssetPicker(false);
    setPickerCreatePosition(null);
  }, [addNode, applyAssetToMediaNode, assetPickerReplaceNodeId, assetPickerTargetNodeId, assetPickerTargetRole, commitHistory, getViewportCreatePosition, markDirty, pickerCreatePosition, t]);

  const importAssetFromPicker = useCallback(async () => {
    if (!bridge?.importAssets) return;
    setPickerLoading(true);
    setMediaImportingNodeId(assetPickerReplaceNodeId);
    try {
      const result = await bridge.importAssets();
      const imported = Array.isArray(result?.assets) ? result.assets : [];
      const compatible = assetPickerMediaKind
        ? imported.filter((asset) => asset?.kind === assetPickerMediaKind)
        : imported;
      if (assetPickerReplaceNodeId && compatible[0]) {
        pickAsset(compatible[0]);
        return;
      }
      if (assetPickerTargetNodeId && compatible[0]) {
        pickAsset(compatible[0]);
        return;
      }
      const refreshed = await bridge.listAssets();
      setAssets(Array.isArray(refreshed)
        ? (assetPickerMediaKind ? refreshed.filter((asset) => asset?.kind === assetPickerMediaKind) : refreshed)
        : []);
    } catch (error) {
      console.warn("[canvas-media] importAssets failed", error);
    } finally {
      setPickerLoading(false);
      setMediaImportingNodeId(null);
    }
  }, [assetPickerMediaKind, assetPickerReplaceNodeId, assetPickerTargetNodeId, bridge, pickAsset]);

  const pickNote = useCallback((note: any) => {
    addNode("noteRef", {
      label: note.title || t("editor.canvas.node.untitledNote"),
      payload: `note:${note.id}`,
      refSummary: notePreviewText(note),
      refUpdatedAt: note.updatedAt || null,
    }, pickerCreatePosition || getViewportCreatePosition("noteRef"));
    setShowNotePicker(false);
    setPickerCreatePosition(null);
  }, [addNode, getViewportCreatePosition, pickerCreatePosition, t]);

  const noteReferenceKey=useMemo(()=>JSON.stringify(nodes.filter(n=>n.data.kind==='noteRef').map(n=>({nodeId:n.id,reference:parseCanvasReference(n.data.payload)})).filter(r=>r.reference?.kind==='note').map(r=>[r.nodeId,r.reference!.id]).sort()),[nodes]);
  const [noteRefreshEpoch,setNoteRefreshEpoch]=useState(0);
  useEffect(()=>{const refresh=()=>setNoteRefreshEpoch(v=>v+1);window.addEventListener('luckyray:note-external-updated',refresh);window.addEventListener('focus',refresh);return()=>{window.removeEventListener('luckyray:note-external-updated',refresh);window.removeEventListener('focus',refresh);};},[]);
  useEffect(()=>{
    if(!currentCanvasId||loadingCanvas||!bridge?.getNote)return;
    const canvasId=currentCanvasId,loadEpoch=canvasLoadEpochRef.current;
    const ids=[...new Set<string>((JSON.parse(noteReferenceKey) as string[][]).map(pair=>pair[1]))];
    return hydrateNotePreviews(ids,id=>bridge.getNote!(id),(id,note)=>{
      if(currentCanvasIdRef.current!==canvasId||canvasLoadEpochRef.current!==loadEpoch)return;
      const summary=notePreviewText(note),contextText=noteBodyText(note);let changed=false;
      const next=nodesRef.current.map(node=>{
        if(node.data.kind!=='noteRef'||parseCanvasReference(node.data.payload)?.id!==id)return node;
        const title=note.title||node.data.label,updated=note.updatedAt||node.data.refUpdatedAt;
        if(node.data.refSummary===summary&&node.data.refContextText===contextText&&node.data.label===title&&node.data.refUpdatedAt===updated)return node;
        changed=true;return {...node,data:{...node.data,label:title,refSummary:summary,refContextText:contextText,refUpdatedAt:updated}};
      });
      if(changed){nodesRef.current=next;setNodes(next);markDirty();}
    });
  },[bridge,currentCanvasId,loadingCanvas,noteReferenceKey,noteRefreshEpoch,markDirty]);

  const updateNodeLabel = useCallback((nodeId: string, text: string) => {
    // 主文字编辑路径：统一走 pending-edit 事务（canonical 快照 + 立即失效 redo + 800ms 合并）
    beginPendingEdit();
    markDirty();
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      const nextData = { ...n.data, label: text };
      if (!isSquareNodeKind(n.data.kind) || n.data._manualSize) {
        return { ...n, data: nextData };
      }
      if (n.data.kind === "text") {
        return { ...n, data: nextData, style: { ...n.style, ...textNodeSize(nextData) } };
      }
      const size = squareNodeSize(nextData);
      return { ...n, data: nextData, style: { ...n.style, width: size, height: size } };
    }));
  }, [beginPendingEdit, markDirty]);

  const updateSelectedLabel = useCallback((text: string) => {
    if (!selectedNodeId) return;
    updateNodeLabel(selectedNodeId, text);
  }, [selectedNodeId, updateNodeLabel]);

  const updateSelectedPayload = useCallback((text: string) => {
    if (!selectedNodeId) return;
    beginPendingEdit();
    markDirty();
    setNodes((nds) => nds.map((n) => n.id === selectedNodeId ? { ...n, data: { ...n.data, payload: text } } : n));
  }, [selectedNodeId, beginPendingEdit, markDirty]);

  const updateSelectedData = useCallback((patch: Partial<SpikeNodeData>) => {
    if (!selectedNodeId) return;
    beginPendingEdit();
    markDirty();
    setNodes((nds) => nds.map((n) => n.id === selectedNodeId
      ? { ...n, data: { ...n.data, ...patch } }
      : n));
  }, [selectedNodeId, beginPendingEdit, markDirty]);

  const updateNodeData = useCallback((nodeId: string, patch: Partial<SpikeNodeData>) => {
    beginPendingEdit();
    markDirty();
    setNodes((nds) => nds.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n));
  }, [beginPendingEdit, markDirty]);

  const runNodeAI = useCallback(async (nodeId: string) => {
    const selected = nodes.find((node) => node.id === nodeId);
    if (!selected) return;
    commitHistory();
    markDirty();
    setRunningAiNodeId(nodeId);
    setSaveError(null);
    const runAI = async (prompt: string, incomingLabels: string[]) => {
      const independent = activeMediaProfile?.textProtocol === "openai-chat";
      if (activeMediaProfile?.textProtocol === "disabled" || !aiRuntimeConfig.model) return t("editor.canvas.error.noTextModel");
      if (!independent && !bridge?.aiChatComplete) return t("editor.canvas.error.aiUnavailable");
      const complete = independent
        ? (messages: Array<{role:string;content:string}>,options: Parameters<typeof completeCanvasProfileText>[3]) => completeCanvasProfileText(activeMediaProfile!.id,activeMediaProfile!.revision,messages,options)
        : bridge!.aiChatComplete!;
      const context = incomingLabels.length
        ? `参考画布节点：\n${incomingLabels.map((label, index) => `${index + 1}. ${label}`).join("\n")}\n\n`
        : "";
      try {
        const response = await complete(
          [{ role: "user", content: `${context}${prompt || "请根据当前画布上下文生成简短建议。"}` }],
          {
            systemPrompt: "你是 LuckyRay 画布里的 AI 节点。请根据画布节点上下文给出可直接放回画布的简洁结果。",
            temperature: 0.4,
            maxTokens: 800,
            model:aiRuntimeConfig.model,
          },
        );
        if (!response.success) {
          return t("editor.canvas.error.aiRequestFailed", {
            error: response.error_message || response.error_detail || t("editor.canvas.error.unknownError"),
          });
        }
        return response.content?.trim() || t("editor.canvas.error.aiEmptyResult");
      } catch (error) {
        return t("editor.canvas.error.aiRequestFailed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (selected.data.kind === "aiPrompt") {
      const inEdges = edges.filter((edge) => edge.target === nodeId);
      const incomingLabels = inEdges
        .map((edge) => nodes.find((node) => node.id === edge.source)?.data.label || "")
        .filter(Boolean);
      const resultText = await runAI(selected.data.label || "", incomingLabels);
      setNodes((current) => current.map((node) => node.id === nodeId
        ? { ...node, data: normalizeCanvasNodeCapabilityData({ ...node.data, kind: "text", label: resultText }) }
        : node));
    }
    setRunningAiNodeId(null);
  }, [activeMediaProfile, aiRuntimeConfig.model, bridge, commitHistory, edges, markDirty, nodes, t]);

  const runSelectedAI = useCallback(() => {
    if (selectedNodeId) void runNodeAI(selectedNodeId);
  }, [selectedNodeId, runNodeAI]);

  const selectSingleNode = useCallback((nodeId: string) => {
    setNodes((current) => synchronizeCanvasNodeSelection(current, [nodeId]));
    setSelectedNodeIds([nodeId]);
  }, []);

  const startInlineEdit = useCallback((nodeId: string) => {
    setComposerNodeId(null);
    setInspectorNodeId(null);
    setNodeContextMenu(null);
    selectSingleNode(nodeId);
    setInlineEditingNodeId(nodeId);
  }, [selectSingleNode]);

  const finishInlineEdit = useCallback(() => {
    setInlineEditingNodeId(null);
  }, []);

  const centerNodeByAbsoluteBounds = useCallback((nodeId: string, duration: number, zoom: number) => {
    const bounds = reactFlowInstance.getNodesBounds([nodeId]);
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return;
    reactFlowInstance.setCenter(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      { duration, zoom },
    );
  }, [reactFlowInstance]);

  const openNodeComposer = useCallback((nodeId: string) => {
    setInspectorNodeId(null);
    setNodeContextMenu(null);
    setConnectDropMenu(null);
    selectSingleNode(nodeId);
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const previousPrompt = node?.data.generationTask?.request.prompt?.trim() || "";
    const shouldClearLegacyPrompt = node?.data.kind === "aiResult"
      && !!node.data.generationPrompt
      && node.data.generationPrompt.trim() === previousPrompt;
    if (shouldClearLegacyPrompt) {
      setNodes((current) => current.map((candidate) => candidate.id === nodeId
        ? { ...candidate, data: { ...candidate.data, generationPrompt: "" } }
        : candidate));
      markDirty();
    }
    setComposerNodeId(nodeId);
  }, [markDirty, selectSingleNode]);

  const getIncomingGenerationInputs = useCallback((nodeId: string): ConnectedGenerationInput[] => {
    return edgesRef.current
      .filter((edge) => edge.target === nodeId)
      .slice()
      .sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
      .reduce<ConnectedGenerationInput[]>((inputs, edge) => {
        const source = nodesRef.current.find((node) => node.id === edge.source);
        if (!source) return inputs;
        const sourceCapabilities = getCanvasNodeCapabilities(source.data);
        const referenceText = sourceCapabilities.contentKind === "note"
          ? source.data.refContextText ?? source.data.refSummary ?? ""
          : sourceCapabilities.contentKind === "text"
            ? (source.data.kind === "aiResult" ? source.data.result || "" : TEXT_NODE_PLACEHOLDER_LABELS.has(source.data.label.trim()) ? "" : source.data.label)
            : undefined;
        inputs.push({
          edgeId: edge.id,
          sourceNodeId: source.id,
          role: edge.data?.role || "generic",
          reference: {
            id: source.data.payload || `node:${source.id}`,
            label: source.data.label || t("editor.canvas.node.untitled"),
            kind: sourceCapabilities.contentKind === "note" ? "note" : source.data.refKind || sourceCapabilities.contentKind,
            thumbnailUrl: source.data.refThumbnailUrl || source.data.resultThumbnailUrl,
            mediaUrl: source.data.refMediaUrl || source.data.resultMediaUrl,
            text: referenceText,
          },
        });
        return inputs;
      }, []);
  }, [t]);

  const updateIncomingEdgeRole = useCallback((edgeId: string, role: CanvasEdgeRole) => {
    commitHistory();
    markDirty();
    setEdges((current) => current.map((edge) => edge.id === edgeId
      ? { ...edge, data: { ...edge.data, role } }
      : edge));
  }, [commitHistory, markDirty, t]);

  const moveIncomingEdge = useCallback((edgeId: string, delta: number) => {
    const edge = edgesRef.current.find(item => item.id === edgeId);
    if (!edge) return;
    const peers = edgesRef.current.filter(item => item.target === edge.target && item.data?.role === edge.data?.role).slice().sort((a,b)=>(a.data?.order??0)-(b.data?.order??0));
    const index = peers.findIndex(item => item.id === edgeId), other = index + delta;
    if (index < 0 || other < 0 || other >= peers.length) return;
    [peers[index], peers[other]] = [peers[other], peers[index]];
    commitHistory(); markDirty();
    setEdges(current => current.map(item => {const order = peers.findIndex(peer => peer.id === item.id);return order < 0 ? item : {...item, data: {...item.data, order}};}));
  }, [commitHistory, markDirty]);

  const removeIncomingEdge = useCallback((edgeId: string) => {
    commitHistory();
    markDirty();
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
  }, [commitHistory, markDirty]);

  const getCanvasReferenceCandidates = useCallback((nodeId: string): CanvasReferenceCandidate[] => {
    return nodesRef.current.reduce<CanvasReferenceCandidate[]>((candidates, node) => {
      if (node.id === nodeId) return candidates;
      const capabilities = getCanvasNodeCapabilities(node.data);
      if (capabilities.contentKind !== "image" && capabilities.contentKind !== "video") return candidates;
      candidates.push({
        nodeId: node.id,
        label: node.data.label || (capabilities.contentKind === "video" ? t("editor.canvas.node.untitledVideo") : t("editor.canvas.node.untitledImage")),
        kind: capabilities.contentKind,
        thumbnailUrl: node.data.refThumbnailUrl || node.data.resultThumbnailUrl,
        mediaUrl: node.data.refMediaUrl || node.data.resultMediaUrl,
      });
      return candidates;
    }, []);
  }, [t]);

  const addCanvasReference = useCallback((nodeId: string, candidate: CanvasReferenceCandidate, role: CanvasEdgeRole) => {
    const target = nodesRef.current.find((node) => node.id === nodeId);
    if (!target) return;
    const current = Array.isArray(target.data.generationReferences)
      ? target.data.generationReferences
      : target.data.payload ? [{
          id: target.data.payload,
          label: target.data.label,
          kind: target.data.refKind || target.data.kind,
          thumbnailUrl: target.data.refThumbnailUrl,
          mediaUrl: target.data.refMediaUrl,
        }] : [];
    const reference: GenerationReference = {
      id: `node:${candidate.nodeId}:${role}`,
      label: candidate.label,
      kind: candidate.kind,
      role,
      thumbnailUrl: candidate.thumbnailUrl,
      mediaUrl: candidate.mediaUrl,
    };
    const replaceableRoles: CanvasEdgeRole[] = ["firstFrame", "lastFrame"];
    const nextBase = replaceableRoles.includes(role)
      ? current.filter((item) => item.role !== role)
      : current;
    const next = nextBase.some((item) => item.id === reference.id)
      ? nextBase
      : nextBase.concat(reference).slice(0, 4);
    updateNodeData(nodeId, { generationReferences: next });
  }, [updateNodeData]);

  const recordGenerationTask = useCallback((
    task: CanvasGenerationTask,
    output?: { text?: string; mediaUrl?: string; thumbnailUrl?: string; mediaItems?: Array<{ url: string; thumbnailUrl?: string | null }> },
  ) => {
    setGenerationHistory((current) => upsertGenerationHistory(current, task, output));
  }, []);

  const persistGenerationTaskToCanvas = useCallback((
    canvasId: string,
    task: CanvasGenerationTask,
    output?: CanvasGenerationOutput,
  ): Promise<void> => {
    if (!bridge) return Promise.resolve();
    const previous = canvasTaskSaveQueuesRef.current.get(canvasId) || Promise.resolve();
    const queued = previous.catch(() => {}).then(async () => {
      if (canvasId === currentCanvasIdRef.current) {
        generationTaskSnapshotsRef.current.set(task.id, task);
        setNodes((current) => applyGenerationTaskToNodes(current, task, output));
        setGenerationHistory((current) => upsertGenerationHistory(current, task, output));
        markDirty();
        return;
      }
      const canvas = await bridge.loadCanvas(canvasId);
      if (!Number.isInteger(canvas.revision) || typeof canvas.contentDigest !== "string" || canvas.contentDigest.length !== 64) {
        throw new Error("canvas-revision-conflict");
      }
      const storedNodes = Array.isArray(canvas.nodes) ? canvas.nodes as SpikeNode[] : [];
      const storedHistory = normalizeGenerationHistory(canvas.generationHistory);
      const saved = await bridge.saveCanvas({
        schemaVersion: CANVAS_SCHEMA_VERSION,
        canvasId: canvas.canvasId,
        name: canvas.name,
        createdAt: canvas.createdAt,
        updatedAt: new Date().toISOString(),
        nodes: applyGenerationTaskToNodes(storedNodes, task, output),
        edges: canvas.edges,
        viewport: normalizeCanvasViewport(canvas.viewport),
        generationHistory: upsertGenerationHistory(storedHistory, task, output),
        revision: canvas.revision,
        contentDigest: canvas.contentDigest,
      });
      setCanvases((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
    });
    canvasTaskSaveQueuesRef.current.set(canvasId, queued);
    const clearQueue = () => {
      if (canvasTaskSaveQueuesRef.current.get(canvasId) === queued) {
        canvasTaskSaveQueuesRef.current.delete(canvasId);
      }
    };
    void queued.then(clearQueue, clearQueue);
    return queued;
  }, [bridge, markDirty]);

  const applyGenerationTaskUpdate = useCallback((
    task: CanvasGenerationTask,
    output?: CanvasGenerationOutput,
  ): Promise<void> => {
    generationTaskSnapshotsRef.current.set(task.id, task);
    const canvasId = generationTaskCanvasIdsRef.current.get(task.id);
    if (!canvasId) return Promise.resolve();
    if (canvasId === currentCanvasIdRef.current) {
      setNodes((current) => applyGenerationTaskToNodes(current, task, output));
      setGenerationHistory((current) => upsertGenerationHistory(current, task, output));
      markDirty();
      return Promise.resolve();
    }
    return persistGenerationTaskToCanvas(canvasId, task, output);
  }, [markDirty, persistGenerationTaskToCanvas]);

  const executeGenerationTask = useCallback(async (task: CanvasGenerationTask) => {
    if (runningGenerationTaskIdsRef.current.has(task.id)) return;
    runningGenerationTaskIdsRef.current.add(task.id);
    generationTaskSnapshotsRef.current.set(task.id, task);
    const adapters: CanvasGenerationAdapter[] = [];
    adapters.push(createCanvasTextGenerationAdapter((messages, options) => {
      if (options?.textProfileId) {
        if (!Number.isSafeInteger(options.textProfileRevision)) return Promise.resolve({success:false,error_kind:"profile_changed"});
        return completeCanvasProfileText(options.textProfileId,options.textProfileRevision!,messages,options);
      }
      return bridge?.aiChatComplete ? bridge.aiChatComplete(messages,options)
        : Promise.resolve({success:false,error_kind:"no_api_key"});
    }));
    if (bridge?.aiImageGenerate) {
      adapters.push(createCanvasImageGenerationAdapter((request) => bridge.aiImageGenerate!(request)));
    }
    if (bridge?.aiVideoGenerate) {
      adapters.push(createCanvasVideoGenerationAdapter(
        (request, onProgress) => bridge.aiVideoGenerate!(request, onProgress, task.providerTaskId),
        (progress) => {
          const currentTask = generationTaskSnapshotsRef.current.get(task.id) || task;
          const nextTask: CanvasGenerationTask = {
            ...currentTask,
            status: "running",
            providerTaskId: progress.providerTaskId || currentTask.providerTaskId || task.providerTaskId,
            providerStage: progress.stage,
            progress: typeof progress.progress === "number" ? progress.progress : currentTask.progress,
            updatedAt: new Date().toISOString(),
          };
          void applyGenerationTaskUpdate(nextTask).catch((error) => {
            console.warn("[canvas-generation] failed to persist progress", error);
          });
        },
      ));
    }

    try {
      const result = await executeCanvasGenerationTask({
        task,
        adapters,
        now: () => new Date().toISOString(),
        isCancelled: () => cancelledGenerationTaskIdsRef.current.has(task.id)
          || nodesRef.current.some((node) => node.data.generationTask?.id === task.id
            && node.data.generationTask.status === "cancelled"),
        onTransition: (nextTask) => {
          const persistedTask = generationTaskSnapshotsRef.current.get(nextTask.id);
          const nextTaskWithProvider: CanvasGenerationTask = {
            ...nextTask,
            providerTaskId: nextTask.providerTaskId || persistedTask?.providerTaskId,
            providerStage: nextTask.providerStage || persistedTask?.providerStage,
            progress: nextTask.progress ?? persistedTask?.progress,
          };
          void applyGenerationTaskUpdate(nextTaskWithProvider).catch((error) => {
            console.warn("[canvas-generation] failed to persist transition", error);
          });
        },
      });

      if (result.outcome !== "succeeded") return;
      const persistedTask = generationTaskSnapshotsRef.current.get(result.task.id);
      const completedTask: CanvasGenerationTask = {
        ...result.task,
        providerTaskId: result.task.providerTaskId || persistedTask?.providerTaskId,
      };
      await applyGenerationTaskUpdate(completedTask, result.output);
    } finally {
      runningGenerationTaskIdsRef.current.delete(task.id);
      generationTaskCanvasIdsRef.current.delete(task.id);
      generationTaskSnapshotsRef.current.delete(task.id);
    }
  }, [applyGenerationTaskUpdate, bridge]);

  const submitGenerationFromNode = useCallback((
    nodeId: string,
    retry?: { request: CanvasGenerationRequestSnapshot; attempt: number; parentTaskId?: string },
  ) => {
    const source = nodesRef.current.find((node) => node.id === nodeId);
    if (!source) return;

    if (!retry && inferGenerationKind(source) === "text" && !aiRuntimeConfig.ready) {
      setSaveError(t("editor.canvas.error.aiConfigLoading"));
      setSaveStatus("error");
      return;
    }
    if (!retry && inferGenerationKind(source) === "text" && !aiRuntimeConfig.model) {
      setSaveError(aiRuntimeConfig.error || t("editor.canvas.error.noTextModel"));
      setSaveStatus("error");
      return;
    }

    // Historical retries retain immutable inputs. Refuse a title-bearing replay when
    // the user has since selected body-only rather than silently sending old titles.
    if (retry && !uiSettings.noteReferenceIncludeTitle && retry.request.references.some(reference => reference.kind === "note" && reference.label !== "笔记正文")) {
      setSaveError(locale === "en-US" ? "This historical task includes note titles. Generate again from the card to use the current body-only setting." : "这条历史任务包含笔记标题。请在生成卡中重新生成，以使用当前的仅正文设置。");
      setSaveStatus("error");
      return;
    }
    const request = retry?.request || createGenerationRequestSnapshot(
      source,
      getIncomingGenerationInputs(nodeId),
      aiRuntimeConfig.models,
      aiRuntimeConfig.model,
      aiRuntimeConfig.imageModels,
      aiRuntimeConfig.imageModel,
      aiRuntimeConfig.videoModels,
      aiRuntimeConfig.videoModel,
      activeMediaProfile,
      uiSettings.noteReferenceIncludeTitle,
    );
    if (!retry && request.kind === "text" && activeMediaProfile?.textProtocol === "openai-chat") {
      if (!activeMediaProfile.apiKeyConfigured) {
        setSaveError(locale === "en-US" ? "Configure this connection's key first." : "请先配置这套画布连接的 Key。");setSaveStatus("error");return;
      }
      request.textProfileId=activeMediaProfile.id;
      request.textProfileRevision=activeMediaProfile.revision;
    }
    if (!retry && request.kind !== "text") {
      const profile = mediaProfiles?.profiles.find((entry) => entry.id === mediaProfiles.activeProfileId);
      if (!profile || !profile.apiKeyConfigured || !request.model || (request.kind === "image" ? profile.imageProtocol : profile.videoProtocol) === "disabled") {
        setSaveError(t("editor.canvas.error.aiConfigUnavailable")); setSaveStatus("error"); return;
      }
      request.mediaProfileId = profile.id;
      request.mediaProfileRevision = profile.revision;
    }
    if (!request.prompt.trim() && !request.references.some(ref => ref.kind === "image" && !!ref.mediaUrl)) {
      setSaveError(t("editor.canvas.generation.enterContent")); setSaveStatus("error"); return;
    }
    const activeTask = source.data.generationTask;
    if ([...generationTaskSnapshotsRef.current.values()].some(task => task.sourceNodeId === nodeId && canCancelCanvasGenerationTask(task)) || (activeTask && canCancelCanvasGenerationTask(activeTask))) {
      setSaveError(t("editor.canvas.error.generationBusy"));
      setSaveStatus("error");
      return;
    }
    const now = new Date().toISOString();
    const task = createCanvasGenerationTask({
      id: `task-${genId()}`,
      sourceNodeId: source.id,
      resultNodeId: source.id,
      request,
      createdAt: now,
      attempt: retry?.attempt || 1,
      adapter: null,
      parentTaskId: retry?.parentTaskId || activeTask?.id,
    });
    const generationData: Partial<SpikeNodeData> = {
      generationTask: task,
      generationKind: request.kind === "image" || request.kind === "video" ? request.kind : undefined,
      generationModel: request.model,
      generationAspect: request.aspect,
      generationDuration: request.duration,
      generationSound: request.sound,
      generationQuality: request.quality,
      generationResolution: request.resolution,
      generationCount: request.count,
      generationCameraStrength: request.cameraStrength,
      generationReferences: request.references.filter(reference => !getIncomingGenerationInputs(nodeId).some(input => input.reference.id === reference.id)).map((reference) => ({
        id: reference.id,
        label: reference.label,
        kind: reference.kind,
        role: reference.role,
        thumbnailUrl: reference.thumbnailUrl,
        mediaUrl: reference.mediaUrl,
        text: reference.text,
      })),
    };

    commitHistory();
    markDirty();
    recordGenerationTask(task);
    setNodes((current) => current.map((node) => node.id === source.id
      ? { ...node, data: { ...node.data, ...generationData }, selected: true }
      : node.selected ? { ...node, selected: false } : node));
    setSelectedNodeIds([source.id]);
    setInspectorNodeId(null);
    setNodeContextMenu(null);
    setConnectDropMenu(null);
    cancelledGenerationTaskIdsRef.current.delete(task.id);
    generationTaskCanvasIdsRef.current.set(task.id, currentCanvasIdRef.current);
    generationTaskSnapshotsRef.current.set(task.id, task);
  }, [activeMediaProfile, mediaProfiles, aiRuntimeConfig, commitHistory, getIncomingGenerationInputs, markDirty, recordGenerationTask, t, uiSettings.noteReferenceIncludeTitle, locale]);

  const cancelGenerationTask = useCallback((task: CanvasGenerationTask, nodeId?: string) => {
    if (!task || !canCancelCanvasGenerationTask(task)) return;
    cancelledGenerationTaskIdsRef.current.add(task.id);
    const transition = transitionCanvasGenerationTask(task, "cancelled", new Date().toISOString());
    if (!transition.ok) {
      setSaveError(transition.error.message);
      setSaveStatus("error");
      return;
    }
    commitHistory();
    markDirty();
    recordGenerationTask(transition.task);
    setNodes((current) => current.map((candidate) => candidate.id === nodeId
      ? { ...candidate, data: { ...candidate.data, generationTask: transition.task } }
      : candidate));
  }, [commitHistory, markDirty, recordGenerationTask]);

  const cancelGeneration = useCallback((nodeId: string) => {
    const task = nodesRef.current.find((candidate) => candidate.id === nodeId)?.data.generationTask;
    if (task) cancelGenerationTask(task, nodeId);
  }, [cancelGenerationTask]);

  const retryGeneration = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const task = node?.data.generationTask;
    if (!task || !canRetryCanvasGenerationTask(task)) return;
    submitGenerationFromNode(nodeId, { request: task.request, attempt: task.attempt + 1, parentTaskId: task.id });
  }, [submitGenerationFromNode]);

  const rerunGeneration = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const task = node?.data.generationTask;
    if (!task || task.status !== "succeeded") return;
    submitGenerationFromNode(nodeId, { request: task.request, attempt: task.attempt + 1, parentTaskId: task.id });
  }, [submitGenerationFromNode]);

  useEffect(() => {
    if (!currentCanvasId || loadingCanvas) return;
    const recoveredTasks = new Map<string, CanvasGenerationTask>();
    const interruptedTasks = new Map<string, CanvasGenerationTask>();
    for (const node of nodes) {
      const task = node.data.generationTask;
      if (!task || task.status !== "running") continue;
      if (runningGenerationTaskIdsRef.current.has(task.id) || reconciledGenerationTaskIdsRef.current.has(task.id)) continue;
      const taskUpdatedAt = Date.parse(task.updatedAt || task.createdAt);
      const belongsToCurrentSession = generationTaskCanvasIdsRef.current.has(task.id)
        || (Number.isFinite(taskUpdatedAt) && taskUpdatedAt >= generationSessionStartedAtRef.current - 1000);
      if (belongsToCurrentSession) continue;
      reconciledGenerationTaskIdsRef.current.add(task.id);
      if (task.request.kind === "video" && task.providerTaskId && bridge?.aiVideoGenerate) {
        recoveredTasks.set(task.id, {
          ...task,
          status: "queued",
          providerStage: "queued",
          resumedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      const failed = transitionCanvasGenerationTask(task, "failed", new Date().toISOString(), {
        error: {
          code: "GENERATION_INTERRUPTED",
          message: t("editor.canvas.error.generationInterrupted"),
          retryable: true,
        },
      });
      if (failed.ok) interruptedTasks.set(task.id, failed.task);
    }

    if (recoveredTasks.size || interruptedTasks.size) {
      markDirty();
      for (const recovered of recoveredTasks.values()) recordGenerationTask(recovered);
      for (const interrupted of interruptedTasks.values()) recordGenerationTask(interrupted);
      setNodes((current) => current.map((node) => {
        const task = node.data.generationTask;
        if (!task) return node;
        const nextTask = recoveredTasks.get(task.id) || interruptedTasks.get(task.id);
        return nextTask
          ? { ...node, data: { ...node.data, generationTask: nextTask } }
          : node;
      }));
    }

    const runningByKind: Record<CanvasGenerationKind, number> = { text: 0, image: 0, video: 0 };
    for (const taskId of runningGenerationTaskIdsRef.current) {
      const runningTask = nodesRef.current.find((node) => node.data.generationTask?.id === taskId)?.data.generationTask;
      const kind = runningTask?.request.kind
        || generationHistoryRef.current.find((entry) => entry.taskId === taskId)?.kind;
      if (kind) runningByKind[kind] += 1;
    }

    const queuedTasks = nodes
      .map((node) => node.data.generationTask)
      .filter((task): task is CanvasGenerationTask => !!task && task.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    for (const task of queuedTasks) {
      const adapterReady = task.request.kind === "text"
        ? !!bridge?.aiChatComplete
        : task.request.kind === "image" ? !!bridge?.aiImageGenerate : !!bridge?.aiVideoGenerate;
      if (!adapterReady) continue;
      if (runningGenerationTaskIdsRef.current.has(task.id)) continue;
      if (runningByKind[task.request.kind] >= CANVAS_GENERATION_CONCURRENCY[task.request.kind]) continue;
      runningByKind[task.request.kind] += 1;
      generationTaskCanvasIdsRef.current.set(task.id, currentCanvasIdRef.current);
      void executeGenerationTask(task);
    }
  }, [bridge, currentCanvasId, executeGenerationTask, loadingCanvas, markDirty, nodes, recordGenerationTask, t, uiSettings.noteReferenceIncludeTitle, locale]);

  const openNodeReference = useCallback((nodeId: string) => {
    const selected = nodesRef.current.find((node) => node.id === nodeId);
    const payload = selected?.data.payload || "";
    const reference = parseCanvasReference(payload);
    if (!reference) {
      setSaveError(t("editor.canvas.error.missingReferenceId"));
      setSaveStatus("error");
      return;
    }
    const {kind,id}=reference;
    if (kind === "asset") {
      focusEntity("asset", id);
      window.location.hash = "#materials";
      return;
    }
    if (kind === "note") {
      focusEntity("note", id);
      window.location.hash = "#notes";
      return;
    }
    setSaveError(t("editor.canvas.error.unsupportedReference"));
    setSaveStatus("error");
  }, [t]);

  const openSelectedReference = useCallback(() => {
    if (selectedNodeId) openNodeReference(selectedNodeId);
  }, [openNodeReference, selectedNodeId]);

  const deleteNodeById = useCallback((nodeId: string) => {
    commitHistory();
    markDirty();
    const node = nodesRef.current.find((item) => item.id === nodeId);
    const idSet = new Set([nodeId]);
    if (node?.data.kind === "group") {
      nodesRef.current.forEach((item) => {
        if (item.parentId === nodeId) idSet.add(item.id);
      });
    }
    setNodes((current) => current
      .filter((item) => !idSet.has(item.id))
      .map((item) => item.id === node?.parentId
        ? { ...item, data: { ...item.data, groupMemberCount: Math.max(0, (item.data.groupMemberCount || 1) - 1) } }
        : item));
    setEdges((current) => current.filter((edge) => !idSet.has(edge.source) && !idSet.has(edge.target)));
    setSelectedNodeIds((current) => current.filter((id) => !idSet.has(id)));
    setComposerNodeId((current) => current === nodeId ? null : current);
    setInspectorNodeId((current) => current === nodeId ? null : current);
    setNodeContextMenu(null);
  }, [commitHistory, markDirty]);

  const nodeUiActions = useMemo<CanvasNodeUiActions>(() => ({
    inlineEditingNodeId,
    openNodeComposer,
    startInlineEdit,
    updateInlineLabel: updateNodeLabel,
    updateNodeData,
    openMediaAssetPicker,
    clearMediaAsset,
    openGeneratorAssetPicker,
    getCanvasReferenceCandidates,
    addCanvasReference,
    getIncomingGenerationInputs,
    updateIncomingEdgeRole,
    removeIncomingEdge,
    submitGeneration: (nodeId) => submitGenerationFromNode(nodeId),
    cancelGeneration,
    retryGeneration,
    rerunGeneration,
    deleteNode: deleteNodeById,
    finishInlineEdit,
    resizeNodeStart: () => {
      flushEditHistory(); // resize 开始前先入栈 pending 编辑，保证时间顺序
      const canvasId = currentCanvasIdRef.current;
      resizeSnapshotRef.current = canvasId ? createCanvasHistorySnapshot({
        canvasId,
        nodes: nodesRef.current,
        edges: edgesRef.current,
        generationHistory: generationHistoryRef.current,
      }) : null;
    },
    resizeNodeEnd: (nodeId) => {
      const snap = resizeSnapshotRef.current;
      resizeSnapshotRef.current = null;
      if (!snap) return;
      const beforeNode = snap.nodes.find((node) => node.id === nodeId);
      const afterNode = nodesRef.current.find((node) => node.id === nodeId);
      if (!beforeNode || !afterNode) return;
      const decision = canvasResizeEndDecision(beforeNode, afterNode);
      if (decision.commitTransaction) {
        // 真实最终尺寸变化：不可变设置手动尺寸语义（替代原先直接突变），
        // 恰好一个 pre-resize Undo 事务并清空 redo。
        setNodes((nds) => nds.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, _manualSize: true } } : n));
        markDirty();
        if (snap.canvasId === currentCanvasIdRef.current) {
          pastRef.current = appendCanvasHistoryEntry(pastRef.current, snap);
          futureRef.current = [];
          setHistoryVersion((v) => v + 1);
        }
        return;
      }
      if (decision.needsCorrectiveSave) {
        // final-size no-op：恢复 pre-resize 的顶层尺寸表示（React Flow 可能已
        // materialize width/height），并用现有 C2 dirty 权威触发 corrective
        // save，确保恢复后的表示成为最终 durable 真值。
        setNodes((nds) => nds.map((n) => n.id === nodeId
          ? restoreCanvasNodeDimensionRepresentation(n, beforeNode) as SpikeNode
          : n));
        markDirty();
      }
    },
    runAI: (nodeId) => { void runNodeAI(nodeId); },
    runningAiNodeId,
    mediaImportingNodeId,
    imageModels: aiRuntimeConfig.imageModels,
    defaultImageModel: aiRuntimeConfig.imageModel,
    videoModels: aiRuntimeConfig.videoModels,
    defaultVideoModel: aiRuntimeConfig.videoModel,
  }), [inlineEditingNodeId, openNodeComposer, startInlineEdit, updateNodeLabel, updateNodeData, openMediaAssetPicker, clearMediaAsset, openGeneratorAssetPicker, getCanvasReferenceCandidates, addCanvasReference, getIncomingGenerationInputs, updateIncomingEdgeRole, removeIncomingEdge, submitGenerationFromNode, cancelGeneration, retryGeneration, rerunGeneration, deleteNodeById, finishInlineEdit, flushEditHistory, markDirty, runNodeAI, runningAiNodeId, mediaImportingNodeId, aiRuntimeConfig.imageModels, aiRuntimeConfig.imageModel, aiRuntimeConfig.videoModels, aiRuntimeConfig.videoModel]);

  const duplicateNodeById = useCallback((nodeId: string) => {
    const source = nodesRef.current.find((node) => node.id === nodeId);
    if (!source) return;
    commitHistory();
    markDirty();
    const nextId = genId();
    const duplicate: SpikeNode = {
      ...source,
      id: nextId,
      position: { x: source.position.x + 32, y: source.position.y + 32 },
      selected: true,
      data: { ...source.data, _newHighlight: false },
    };
    setNodes((current) => current
      .map((node) => node.selected ? { ...node, selected: false } : node)
      .concat(duplicate));
    setSelectedNodeIds([nextId]);
    setComposerNodeId(null);
    setInspectorNodeId(null);
    setNodeContextMenu(null);
  }, [commitHistory, markDirty]);

  const nodeSaveGate = useRef(createCanvasSaveGate());
  const [nodeSaveNotice,setNodeSaveNotice] = useState("");
  useEffect(()=>{if(!nodeSaveNotice)return;const timer=setTimeout(()=>setNodeSaveNotice(""),4500);return()=>clearTimeout(timer);},[nodeSaveNotice]);
  useEffect(()=>setNodeSaveNotice(""),[currentCanvasId]);
  const saveNodeContent = useCallback(async (nodeId:string,asNote:boolean)=>{
    const node=nodesRef.current.find(item=>item.id===nodeId);if(!node)return;
    const canvasId=currentCanvasIdRef.current,epoch=canvasLoadEpochRef.current;
    const knowledgeSource=asNote?readActiveKnowledgeWriteSource():null;
    const notify=(message:string)=>{if(currentCanvasIdRef.current===canvasId&&canvasLoadEpochRef.current===epoch&&(!asNote||readActiveKnowledgeWriteSource()===knowledgeSource))setNodeSaveNotice(message);};
    try {
      if(asNote){
        const body=canvasNoteBody(node.data);if(!body)throw Error("empty-note");
        if(!bridge?.createNote || !knowledgeSource?.vaultId)throw Error("note-channel-unavailable");
        const result=await nodeSaveGate.current.run(JSON.stringify(['note',knowledgeSource.vaultId,canvasId,nodeId,body]),async()=>{
          const note=await bridge.createNote!({title:canvasNoteTitle(body),contentText:body});return note.id;
        });
        notify(result.state==='pending'?'正在保存…':result.state==='already-saved'?'这份内容已保存为新笔记':'已保存为新笔记（当前知识库根目录）');
      }else{
        const candidates=canvasNodeLibraryCandidates(node.data,generationHistory,resolveCanvasMediaUrl);
        if(!candidates.length)throw Error("no-generated-media");
        if(!bridge?.saveCanvasGenerationToLibrary)throw Error("material-channel-unavailable");
        let pending=false;
        for(const candidate of candidates){
          const result=await nodeSaveGate.current.run(JSON.stringify(['media',candidate.kind,candidate.mediaUrl]),async()=>{
            const saved=await bridge.saveCanvasGenerationToLibrary!(candidate);
            if(!saved.success||!saved.assetId)throw Error('material-save-failed');return saved.assetId;
          });pending ||= result.state==='pending';
        }
        notify(pending?'正在保存…':`已保存到默认素材库（${candidates.length} 项）`);
      }
    }catch{notify(asNote?'未能新建笔记，请确认已打开可写的知识库后重试。':'未能保存生成结果，请确认原文件仍可读取后重试。');}
  },[bridge,generationHistory]);

  const runNodeCommand = useCallback((commandId: CanvasNodeCommandId, nodeId: string) => {
    setNodeContextMenu(null);
    switch (commandId) {
      case CANVAS_NODE_COMMAND_IDS.detail:
        selectSingleNode(nodeId);
        setComposerNodeId(null);
        setInspectorNodeId(nodeId);
        return;
      case CANVAS_NODE_COMMAND_IDS.edit:
        startInlineEdit(nodeId);
        return;
      case CANVAS_NODE_COMMAND_IDS.openSource:
        openNodeReference(nodeId);
        return;
      case CANVAS_NODE_COMMAND_IDS.replaceMedia:
        openMediaAssetPicker(nodeId);
        return;
      case CANVAS_NODE_COMMAND_IDS.clearMedia:
        clearMediaAsset(nodeId);
        setComposerNodeId(null);
        return;
      case CANVAS_NODE_COMMAND_IDS.derive:
        openNodeComposer(nodeId);
        return;
      case CANVAS_NODE_COMMAND_IDS.clearGenerator:
        updateNodeData(nodeId, {
          generationPrompt: "",
          generationReferences: [],
        });
        return;
      case CANVAS_NODE_COMMAND_IDS.duplicate:
        duplicateNodeById(nodeId);
        return;
      case CANVAS_NODE_COMMAND_IDS.delete:
        deleteNodeById(nodeId);
        return;
      case CANVAS_NODE_COMMAND_IDS.saveResult:
        void saveNodeContent(nodeId,false);return;
      case CANVAS_NODE_COMMAND_IDS.saveNote:
        void saveNodeContent(nodeId,true);return;
    }
  }, [saveNodeContent, clearMediaAsset, deleteNodeById, duplicateNodeById, openMediaAssetPicker, openNodeComposer, openNodeReference, selectSingleNode, startInlineEdit, updateNodeData]);

  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [nodes, selectedNodeIds],
  );
  const selectedGroupIds = useMemo(
    () => selectedCanvasGroupContainerIds(nodes, selectedNodeIds),
    [nodes, selectedNodeIds],
  );
  const canGroupSelectedNodes = selectedNodes.length >= 2
    && selectedNodes.every((node) => !node.parentId && node.data.kind !== "group");
  const canUngroupSelectedNodes = useMemo(
    () => canUngroupCanvasSelection(nodes, selectedNodeIds),
    [nodes, selectedNodeIds],
  );
  const canTransformSelectedNodes = useMemo(
    () => isSafeCanvasTransformSelection(nodes, selectedNodeIds),
    [nodes, selectedNodeIds],
  );

  const deleteSelectedNode = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    commitHistory();
    markDirty();
    const idSet = new Set(selectedNodeIds);
    nodesRef.current.forEach((node) => {
      if (node.parentId && idSet.has(node.parentId)) idSet.add(node.id);
    });
    const removedByParent = new Map<string, number>();
    nodesRef.current.forEach((node) => {
      if (node.parentId && idSet.has(node.id) && !idSet.has(node.parentId)) {
        removedByParent.set(node.parentId, (removedByParent.get(node.parentId) || 0) + 1);
      }
    });
    setNodes((nds) => nds
      .filter((node) => !idSet.has(node.id))
      .map((node) => removedByParent.has(node.id)
        ? { ...node, data: { ...node.data, groupMemberCount: Math.max(0, (node.data.groupMemberCount || 0) - removedByParent.get(node.id)!) } }
        : node));
    setEdges((eds) => eds.filter((edge) => !idSet.has(edge.source) && !idSet.has(edge.target)));
    setSelectedNodeIds([]);
  }, [commitHistory, markDirty, selectedNodeIds]);

  useEffect(() => {
    const onDeleteKey = (event: KeyboardEvent) => {
      if (selectedNodeIds.length === 0) return;
      const command = resolveScopedShortcut(event, "canvas", undefined, { ids: ["canvasDeleteSelection", "canvasDeleteSelectionAlternate"] });
      if (command !== "canvasDeleteSelection" && command !== "canvasDeleteSelectionAlternate") return;
      event.preventDefault();
      deleteSelectedNode();
    };
    window.addEventListener("keydown", onDeleteKey);
    return () => window.removeEventListener("keydown", onDeleteKey);
  }, [deleteSelectedNode, selectedNodeIds]);

  // ========== 复制 / 粘贴（内部剪贴板，保留引用 assetId/noteId，只换节点 id） ==========
  const clipboardRef = useRef<{ nodes: SpikeNode[]; edges: SpikeEdge[] } | null>(null);

  const copySelected = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    const idSet = new Set(selectedNodeIds);
    nodes.forEach((node) => {
      if (node.parentId && idSet.has(node.parentId)) idSet.add(node.id);
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const copiedNodes = nodes.filter((node) => idSet.has(node.id)).map((node) => {
      if (!node.parentId || idSet.has(node.parentId)) return { ...node, selected: false };
      const parent = byId.get(node.parentId);
      const { parentId: _parentId, extent: _extent, ...rest } = node;
      return {
        ...rest,
        position: parent
          ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y }
          : node.position,
        selected: false,
      } as SpikeNode;
    });
    // 只复制选中节点之间的内部连线，跨选区外的连线不复制
    const copiedEdges = edges
      .filter((e) => idSet.has(e.source) && idSet.has(e.target))
      .map((e) => ({ ...e }));
    clipboardRef.current = { nodes: copiedNodes, edges: copiedEdges };
  }, [nodes, edges, selectedNodeIds]);

  const pasteFromClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) return;
    commitHistory();
    markDirty();
    const idMap = new Map<string, string>(clip.nodes.map((node) => [node.id, genId()]));
    const newNodes: SpikeNode[] = clip.nodes.map((n) => {
      const newId = idMap.get(n.id)!;
      const mappedParentId = n.parentId ? idMap.get(n.parentId) : undefined;
      return {
        ...n,
        id: newId,
        parentId: mappedParentId,
        position: mappedParentId ? { ...n.position } : { x: n.position.x + 32, y: n.position.y + 32 },
        selected: true,
        data: { ...n.data },
      };
    });
    const newEdges: SpikeEdge[] = clip.edges
      .map((e) => {
        const source = idMap.get(e.source);
        const target = idMap.get(e.target);
        if (!source || !target) return null;
        return { ...e, id: genEdgeId(), source, target } as SpikeEdge;
      })
      .filter((e): e is SpikeEdge => e !== null);
    // 清掉当前选中，加入粘贴节点并选中
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(newNodes));
    setEdges((eds) => eds.concat(newEdges));
    setSelectedNodeIds(newNodes.map((n) => n.id));
  }, [commitHistory, markDirty]);

  const duplicateSelected = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    copySelected();
    pasteFromClipboard();
  }, [selectedNodeIds, copySelected, pasteFromClipboard]);

  const alignSelectedLeft = useCallback(() => {
    const plan = planCanvasLeftAlignment(nodesRef.current, selectedNodeIds);
    if (!plan?.changed) return;
    commitHistory();
    markDirty();
    setNodes((nds) => nds.map((node) => plan.positions.has(node.id)
      ? { ...node, position: { ...node.position, x: plan.positions.get(node.id)! } }
      : node));
  }, [selectedNodeIds, commitHistory, markDirty]);

  const distributeSelectedHorizontal = useCallback(() => {
    const plan = planCanvasHorizontalDistribution(nodesRef.current, selectedNodeIds);
    if (!plan?.changed) return;
    commitHistory();
    markDirty();
    setNodes((nds) => nds.map((node) => plan.positions.has(node.id)
      ? { ...node, position: { ...node.position, x: plan.positions.get(node.id)! } }
      : node));
  }, [selectedNodeIds, commitHistory, markDirty]);

  const groupSelectedNodes = useCallback(() => {
    if (!canGroupSelectedNodes) return;
    const groupId = `group-${genId()}`;
    const groupNumber = nodesRef.current.filter((node) => node.data.kind === "group").length + 1;
    const label = t("editor.canvas.node.groupNumber", { count: groupNumber });
    const draft = createCanvasGroupDraft(nodesRef.current, selectedNodeIds, groupId, label);
    if (!draft) return;
    commitHistory();
    markDirty();
    const groupNode: SpikeNode = {
      id: groupId,
      type: "group",
      position: draft.position,
      style: { width: draft.width, height: draft.height },
      dragHandle: ".canvas-group-drag-handle",
      selected: true,
      data: normalizeCanvasNodeCapabilityData({
        kind: "group",
        role: "container",
        label,
        groupMemberCount: draft.memberIds.length,
      }),
    };
    const nextNodes = attachCanvasNodesToGroup(nodesRef.current, draft, groupNode)
      .map((node) => ({ ...node, selected: node.id === groupId }));
    setNodes(nextNodes);
    setSelectedNodeIds([groupId]);
    setComposerNodeId(null);
  }, [canGroupSelectedNodes, commitHistory, markDirty, selectedNodeIds, t]);

  const ungroupSelectedNodes = useCallback(() => {
    if (!canUngroupSelectedNodes) return;
    const groupIds = selectedGroupIds;
    const memberIds = nodesRef.current
      .filter((node) => node.parentId && groupIds.includes(node.parentId))
      .map((node) => node.id);
    commitHistory();
    markDirty();
    const nextNodes = ungroupCanvasNodes(nodesRef.current, groupIds)
      .map((node) => ({ ...node, selected: memberIds.includes(node.id) }));
    setNodes(nextNodes);
    setSelectedNodeIds(memberIds);
    setComposerNodeId(null);
  }, [canUngroupSelectedNodes, commitHistory, markDirty, selectedGroupIds]);

  const arrangeCanvas = useCallback(() => {
    if (nodesRef.current.length < 2) return;
    commitHistory();
    markDirty();
    setNodes((current) => synchronizeCanvasNodeSelection(
      arrangeCanvasNodes(current, edgesRef.current),
      [],
    ));
    setSelectedNodeIds([]);
    setComposerNodeId(null);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void reactFlowInstance.fitView({ padding: .18, duration: uiSettings.reduceMotion ? 0 : 520 });
      });
    });
  }, [commitHistory, markDirty, reactFlowInstance, uiSettings.reduceMotion]);

  useEffect(() => {
    const onCopyPasteKey = (event: KeyboardEvent) => {
      const command = resolveScopedShortcut(event, "canvas", undefined, { ids: ["canvasCopy", "canvasPaste"] });
      if (command === "canvasCopy") {
          if (selectedNodeIds.length === 0) return;
          event.preventDefault();
          copySelected();
        } else if (command === "canvasPaste") {
          if (!clipboardRef.current || clipboardRef.current.nodes.length === 0) return;
          event.preventDefault();
          pasteFromClipboard();
      }
    };
    window.addEventListener("keydown", onCopyPasteKey);
    return () => window.removeEventListener("keydown", onCopyPasteKey);
  }, [copySelected, pasteFromClipboard, selectedNodeIds]);

  // Ctrl+Z 撤销 / Ctrl+Y 或 Ctrl+Shift+Z 重做
  useEffect(() => {
    const onUndoRedoKey = (event: KeyboardEvent) => {
      const command = resolveScopedShortcut(event, "canvas", undefined, { ids: ["canvasUndo", "canvasRedo", "canvasRedoAlternate", "canvasSave"] });
      if (!command) return;
      event.preventDefault();
      if (command === "canvasUndo") undo();
      if (command === "canvasRedo" || command === "canvasRedoAlternate") redo();
      if (command === "canvasSave") void persistCurrentCanvas();
    };
    window.addEventListener("keydown", onUndoRedoKey);
    return () => window.removeEventListener("keydown", onUndoRedoKey);
  }, [undo, redo, persistCurrentCanvas]);

  // ========== 多画布列表操作 ==========
  const handleReturn = useCallback(async () => {
    try {
      await persistCurrentCanvas();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(t("editor.canvas.error.returnSaveFailed", { error: msg }));
      setSaveStatus("error");
      // 保存失败不应把用户卡死在画布页：
      // 自动保存兜底已把内容写入 localStorage archive，用户可确认后返回。
      setReturnConfirmMessage(msg);
      return;
    }
    returnToLuckyRay();
  }, [persistCurrentCanvas, t]);

  useEffect(() => {
    const onCanvasHomeRequest = () => {
      void handleReturn();
    };
    window.addEventListener("luckyray:canvas-home-request", onCanvasHomeRequest);
    return () => window.removeEventListener("luckyray:canvas-home-request", onCanvasHomeRequest);
  }, [handleReturn]);

  const handleCreateCanvas = useCallback(async () => {
    if (!bridge) return;
    setCreateCanvasName(t("editor.canvas.untitled"));
    setCreateCanvasOpen(true);
  }, [bridge, t]);

  const handleConfirmCreateCanvas = useCallback(async () => {
    if (!bridge) return;
    try {
      await persistCurrentCanvas();
      const created = await bridge.createCanvas(createCanvasName.trim() || undefined);
      const updated = await bridge.listCanvases();
      setCanvases(updated);
      setCreateCanvasOpen(false);
      await loadAndApplyCanvas(created.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(t("editor.canvas.error.createFailed", { error: msg }));
      setSaveStatus("error");
    }
  }, [bridge, createCanvasName, loadAndApplyCanvas, persistCurrentCanvas, t]);

  const handleOpenCanvas = useCallback((canvasId: string) => {
    if (canvasId === currentCanvasId) return;
    void (async () => {
      try {
        await persistCurrentCanvas();
        await loadAndApplyCanvas(canvasId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSaveError(t("editor.canvas.error.switchSaveFailed", { error: msg }));
        setSaveStatus("error");
      }
    })();
  }, [currentCanvasId, loadAndApplyCanvas, persistCurrentCanvas, t]);

  const handleStartRename = useCallback((entry: CanvasListEntry) => {
    if (renamePendingRef.current) return;
    renameSessionRef.current = entry.id;
    setRenamingId(entry.id);
    setRenamingDraft(entry.name);
  }, []);

  const handleCancelRename = useCallback(() => {
    if (renamePendingRef.current) return;
    renameSessionRef.current = null;
    setRenamingId(null);
    setRenamingDraft("");
  }, []);

  const handleCommitRename = useCallback(async () => {
    if (!bridge || !renamingId || renamePendingRef.current || renameSessionRef.current !== renamingId) return;
    const newName = renamingDraft.trim();
    const previousName = canvases.find((entry) => entry.id === renamingId)?.name;
    if (!newName || newName === previousName) {
      handleCancelRename();
      return;
    }
    renamePendingRef.current = true;
    try {
      if (renamingId === currentCanvasId) await persistCurrentCanvas();
      const updated = await bridge.renameCanvas(renamingId, newName);
      if (updated) {
        const list = await bridge.listCanvases();
        setCanvases(list);
        if (renamingId === currentCanvasIdRef.current) {
          setCurrentCanvasName(updated.name);
          const identity = canvasIdentityRef.current;
          canvasIdentityRef.current = {
            canvasId: updated.id,
            revision: updated.revision,
            contentDigest: updated.contentDigest,
            loadEpoch: identity?.loadEpoch ?? canvasLoadEpochRef.current,
          };
          setLastSavedAt(updated.updatedAt);
          setSaveStatus("saved");
          setSaveError(null);
          void saveThumbnailToDisk(renamingId, nodes, edges);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("canvas-revision-conflict")) {
        if (renamingId === currentCanvasIdRef.current) {
          await loadAndApplyCanvas(renamingId, "reload");
        } else {
          setCanvases(await bridge.listCanvases());
        }
      }
      setErrorMsg(t("editor.canvas.error.renameFailed", { error: msg }));
      setSaveStatus("error");
    } finally {
      renamePendingRef.current = false;
      renameSessionRef.current = null;
      setRenamingId(null);
      setRenamingDraft("");
    }
  }, [bridge, renamingId, renamingDraft, currentCanvasId, canvases, handleCancelRename, nodes, edges, loadAndApplyCanvas, persistCurrentCanvas, saveThumbnailToDisk, t]);

  const handleRequestDelete = useCallback((canvasId: string) => {
    setConfirmDeleteId(canvasId);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!bridge || !confirmDeleteId) return;
    const targetId = confirmDeleteId;
    setConfirmDeleteId(null);
    try {
      if (targetId !== currentCanvasId) {
        await persistCurrentCanvas();
      }
      await bridge.deleteCanvas(targetId);
      void deleteThumbnailFromDisk(targetId);
      const list = await bridge.listCanvases();
      setCanvases(list);
      // 如果删的是当前画布，切到第一个或建默认
      if (targetId === currentCanvasId) {
        if (list.length > 0) {
          await loadAndApplyCanvas(list[0].id);
        } else {
          const created = await bridge.createCanvas(t("editor.canvas.defaultName"));
          setCanvases([created]);
          await loadAndApplyCanvas(created.id);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("canvas-revision-conflict")) {
        if (targetId === currentCanvasId) {
          await loadAndApplyCanvas(targetId, "reload");
        } else {
          setCanvases(await bridge.listCanvases());
        }
      }
      setErrorMsg(t("editor.canvas.error.deleteFailed", { error: msg }));
      setSaveStatus("error");
    }
  }, [bridge, confirmDeleteId, currentCanvasId, loadAndApplyCanvas, persistCurrentCanvas, t]);

  const handleCancelDelete = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  const handleExportCanvas = useCallback(async (canvasId: string, canvasName: string) => {
    if (!bridge) return;
    try {
      const data = await bridge.loadCanvas(canvasId);
      const exportNodes = Array.isArray(data.nodes)
        ? (data.nodes as SpikeNode[]).map((node) => ({
            ...node,
            data: normalizeCanvasNodeCapabilityData(node.data),
          }))
        : [];
      const exportData = {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        canvasId: data.canvasId,
        name: data.name,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        nodes: exportNodes,
        edges: normalizeCanvasEdgeSemantics(
          exportNodes,
          Array.isArray(data.edges) ? data.edges as SpikeEdge[] : [],
        ),
        viewport: data.viewport,
      };
      const json = JSON.stringify(exportData, null, 2);
      const defaultName = `canvas-${canvasName || data.name || canvasId}.json`;
      const filePath = await save({
        defaultPath: defaultName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return; // 用户取消
      await writeTextFile(filePath, json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(t("editor.canvas.error.exportFailed", { error: msg }));
    }
  }, [bridge, t]);

  // ========== 渲染 ==========
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const inspectorNode = nodes.find((n) => n.id === inspectorNodeId);
  const contextMenuNode = nodeContextMenu ? nodes.find((node) => node.id === nodeContextMenu.nodeId) : null;
  const connectMenuOriginNode = connectDropMenu
    ? nodes.find((node) => node.id === connectDropMenu.origin.nodeId) || null
    : null;
  const connectMenuOriginCapabilities = connectMenuOriginNode
    ? getCanvasNodeCapabilities(connectMenuOriginNode.data)
    : null;
  const connectMenuAddsContext = connectDropMenu?.origin.handleType === "target";
  const connectMenuContentKind = connectMenuOriginCapabilities?.contentKind || "text";
  const contextMenuCommands = contextMenuNode ? getCanvasNodeCommands(contextMenuNode.data).map(command=>
    command.id===CANVAS_NODE_COMMAND_IDS.saveNote ? {...command,enabled:!!canvasNoteBody(contextMenuNode.data)} :
    command.id===CANVAS_NODE_COMMAND_IDS.saveResult ? {...command,enabled:canvasNodeLibraryCandidates(contextMenuNode.data,generationHistory,resolveCanvasMediaUrl).length>0} : command
  ) : [];
  const selectedNodeCapabilities = selectedNode ? getCanvasNodeCapabilities(selectedNode.data) : null;
  const selectedNodeHasComposer = !!selectedNode
    && selectedNode.id === composerNodeId
    && selectedNodeCapabilities?.composerMode === "contextual";
  useEffect(() => {
    if (!selectedNodeHasComposer || !selectedNodeId) {
      setMaterialInspectorPortal(null);
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      const body = editorBodyRef.current;
      const element = body
        ? Array.from(body.querySelectorAll<HTMLElement>(".react-flow__node[data-id]"))
          .find((candidate) => candidate.dataset.id === selectedNodeId)
        : null;
      setMaterialInspectorPortal(element ? { nodeId: selectedNodeId, element } : null);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [selectedNodeHasComposer, selectedNodeId]);
  useEffect(() => {
    const isAssetNode = selectedNode?.data.kind === "image" || selectedNode?.data.kind === "video";
    const isNoteNode = selectedNode?.data.kind === "noteRef";
    publishCurrentCanvasContext({
      id: currentCanvasId,
      title: currentCanvasName || null,
      selectionId: selectedNodeId,
      asset: isAssetNode && selectedNode?.data.payload ? {
        id: selectedNode.data.payload,
        name: selectedNode.data.label || t("editor.canvas.toolbar.referenceMaterial"),
        kind: selectedNode.data.refKind || selectedNode.data.kind,
        libraryPath: null,
        folderId: null,
        description: selectedNode.data.refSummary || null,
        updatedAt: selectedNode.data.refUpdatedAt || null,
      } : null,
      note: isNoteNode && selectedNode?.data.payload ? {
        id: selectedNode.data.payload,
        title: selectedNode.data.label || t("editor.canvas.toolbar.referenceKnowledge"),
        contentText: selectedNode.data.refSummary || "",
        updatedAt: selectedNode.data.refUpdatedAt || null,
      } : null,
    });
  }, [currentCanvasId, currentCanvasName, selectedNode, selectedNodeId, t]);

  const saveStatusText =
    saveStatus === "saving" ? t("editor.canvas.save.saving") :
    saveStatus === "saved" ? t("editor.canvas.save.saved") :
    saveStatus === "dirty" ? t("editor.canvas.save.dirty") :
    saveStatus === "error" ? t("editor.canvas.save.failed") :
    t("editor.canvas.save.idle");
  const saveStatusColor =
    saveStatus === "error" ? "#fb7185" :
    saveStatus === "saving" || saveStatus === "dirty" ? "#fbbf24" :
    saveStatus === "saved" ? "#4ade80" :
    "#8e8e96";

  const nodeSearchResults = useMemo(() => {
    const query = nodeSearchQuery.trim().toLocaleLowerCase("zh-CN");
    return nodes
      .map((node, index) => {
        const label = node.data.label || canvasNodeKindLabel(node.data.kind, t) || t("editor.canvas.node.untitled");
        const searchable = [label, node.data.result, node.data.refSummary]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase("zh-CN");
        const labelKey = label.toLocaleLowerCase("zh-CN");
        const rank = !query ? 3 : labelKey === query ? 0 : labelKey.startsWith(query) ? 1 : searchable.includes(query) ? 2 : 99;
        return { node, index, label, rank };
      })
      .filter((item) => item.rank < 99)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, 10);
  }, [nodes, nodeSearchQuery, t]);

  const activeGenerationCount = useMemo(
    () => generationHistory.filter((entry) => entry.status === "queued" || entry.status === "running").length,
    [generationHistory],
  );
  const generationHistorySignal = activeGenerationCount > 0
    ? String(activeGenerationCount)
    : generationHistory[0]?.status === "succeeded" ? "✓"
    : generationHistory[0]?.status === "failed" ? "!" : "";
  const generationQueuePositions = useMemo(() => {
    const positions = new Map<string, number>();
    const nextByKind: Record<CanvasGenerationKind, number> = { text: 0, image: 0, video: 0 };
    generationHistory
      .filter((entry) => entry.status === "queued")
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .forEach((entry) => {
        nextByKind[entry.kind] += 1;
        positions.set(entry.taskId, nextByKind[entry.kind]);
      });
    return positions;
  }, [generationHistory]);

  const filteredGenerationHistory = useMemo(() => generationHistory.filter((entry) => {
    const statusMatches = generationHistoryStatusFilter === "all"
      || (generationHistoryStatusFilter === "active" && (entry.status === "queued" || entry.status === "running"))
      || (generationHistoryStatusFilter === "succeeded" && entry.status === "succeeded")
      || (generationHistoryStatusFilter === "failed" && (entry.status === "failed" || entry.status === "cancelled"));
    const kindMatches = generationHistoryKindFilter === "all" || entry.kind === generationHistoryKindFilter;
    return statusMatches && kindMatches && matchesGenerationHistory(entry, generationHistoryQuery);
  }), [generationHistory, generationHistoryKindFilter, generationHistoryStatusFilter, generationHistoryQuery]);

  const generationHistoryPreviewEntry = useMemo(
    () => generationHistory.find((entry) => entry.id === generationHistoryPreviewId) || null,
    [generationHistory, generationHistoryPreviewId],
  );

  const deliveryItems=useMemo(()=>selectedCanvasMedia(nodes,selectedNodeIds,resolveCanvasMediaUrl),[nodes,selectedNodeIds]);
  const saveEditedImage=useCallback(async(item:DeliveryItem,blob:Blob,edit:ImageEdit)=>{
    const expectedCanvas=currentCanvasId,expectedEpoch=canvasLoadEpochRef.current;
    if(!expectedCanvas||(currentCanvasIdRef.current!==expectedCanvas||canvasLoadEpochRef.current!==expectedEpoch||loadingCanvas)||!bridge?.importAssets)throw new Error('canvas-unavailable');
    const path=await save({defaultPath:safeDeliveryName(item.label+'-edited',0,'png'),filters:[{name:'PNG',extensions:['png']}]});
    if(!path)return locale==='en-US'?'Save cancelled.':'已取消保存。';
    if((currentCanvasIdRef.current!==expectedCanvas||canvasLoadEpochRef.current!==expectedEpoch||loadingCanvas))throw new Error('canvas-changed');
    await writeFile(path,new Uint8Array(await blob.arrayBuffer()));
    let asset:any;
    try{const imported=await bridge.importAssets({paths:[path]});asset=imported.assets.find(a=>a.kind==='image');}
    catch{return locale==='en-US'?'PNG saved, but the material library import failed. Canvas unchanged.':'PNG 已保存，但素材库导入失败；画布未改变。';}
    if(!asset)return locale==='en-US'?'PNG saved. No imported asset was returned; canvas unchanged.':'PNG 已保存，素材库未返回可用素材；画布未改变。';
    if((currentCanvasIdRef.current!==expectedCanvas||canvasLoadEpochRef.current!==expectedEpoch||loadingCanvas))return locale==='en-US'?'Copy saved to the library. Canvas changed; no card inserted.':'副本已保存到素材库。画布已切换，未插入卡片。';
    const original=nodesRef.current.find(n=>n.id===(item.nodeId||item.id));
    const bounds=original?reactFlowInstance.getNodesBounds([original.id]):null;
    addNode('image',{label:asset.name||item.label,payload:`asset:${asset.id}`,refMediaUrl:resolveCanvasMediaUrl(asset.libraryPath||asset.originalPath||path),refThumbnailUrl:resolveCanvasMediaUrl(asset.thumbnailUrl||asset.libraryPath||path),refKind:'image',refUpdatedAt:asset.updatedAt||null,derivedFromNodeId:original?.id,imageEdit:structuredClone(edit)},bounds&&Number.isFinite(bounds.x)&&Number.isFinite(bounds.y)?{x:bounds.x+bounds.width+80,y:bounds.y}:getViewportCreatePosition('image'));
    return locale==='en-US'?'New copy added to the canvas. Original unchanged.':'新副本已加入画布，原图保持不变。';
  },[currentCanvasId,loadingCanvas,bridge,locale,addNode,getViewportCreatePosition,reactFlowInstance]);
  const saveMediaArchive=useCallback(async(bytes:Uint8Array)=>{
    const expectedCanvas=currentCanvasId,expectedEpoch=canvasLoadEpochRef.current;
    if(!expectedCanvas||(currentCanvasIdRef.current!==expectedCanvas||canvasLoadEpochRef.current!==expectedEpoch||loadingCanvas))throw new Error('canvas-changed');
    const path=await save({defaultPath:'canvas-results.zip',filters:[{name:'ZIP',extensions:['zip']}]});
    if(!path)return false;
    if((currentCanvasIdRef.current!==expectedCanvas||canvasLoadEpochRef.current!==expectedEpoch||loadingCanvas))throw new Error('canvas-changed');
    await writeFile(path,bytes);return true;
  },[currentCanvasId,loadingCanvas]);

  const insertWorkflow = useCallback((template:WorkflowTemplate) => {
    if(loadingCanvas || !currentCanvasId || currentCanvasIdRef.current!==currentCanvasId) throw new WorkflowError('canvas-changed');
    const draft=instantiateWorkflow(template,getViewportCreatePosition('image'),genId,[...nodesRef.current.map(n=>n.id),...edgesRef.current.map(e=>e.id)]);
    const nextNodes:SpikeNode[]=[...nodesRef.current.map(n=>({...n,selected:false})),...draft.nodes];
    const nextEdges:Edge<CanvasEdgeSemanticData>[]=[...edgesRef.current,...draft.edges];
    commitHistory();markDirty();
    nodesRef.current=nextNodes;edgesRef.current=nextEdges;setNodes(nextNodes);setEdges(nextEdges);
    setSelectedNodeIds(draft.nodes.filter(n=>n.selected).map(n=>n.id));
  },[loadingCanvas,currentCanvasId,getViewportCreatePosition,commitHistory,markDirty]);
  const exportWorkflow = useCallback(async(name:string) => {
    if(loadingCanvas || !currentCanvasId || currentCanvasIdRef.current!==currentCanvasId) throw new WorkflowError('canvas-changed');
    const canvasId=currentCanvasId;
    const captured=captureWorkflow(nodesRef.current,edgesRef.current,selectedNodeIds,name);
    const path=await save({defaultPath:'canvas-workflow.json',filters:[{name:'LuckyRay workflow',extensions:['json']}]});
    if(!path)return {cancelled:true,placeholders:captured.placeholders,omittedEdges:captured.omittedEdges};
    if(currentCanvasIdRef.current!==canvasId)throw new WorkflowError('canvas-changed');
    await writeTextFile(path,JSON.stringify(captured.template,null,2));
    return {cancelled:false,placeholders:captured.placeholders,omittedEdges:captured.omittedEdges};
  },[loadingCanvas,currentCanvasId,selectedNodeIds]);

  const createReferencePack = useCallback((name:string,kind:ReferencePackKind):string|null => {
    if (loadingCanvas || !currentCanvasIdRef.current) return "invalid-selection";
    const label=name.trim();
    if(!label || label.length>60)return "invalid-name";
    const source=nodesRef.current;
    const selected=source.filter(node=>selectedNodeIds.includes(node.id));
    const existing=selected.length===1 && selected[0].data.kind==="group" ? selected[0] : null;
    const members=existing?packMembers(source,existing.id):selected;
    if(!members.length || members.some(node=>!usablePackMember(node)))return "missing-content";
    if(existing){
      commitHistory();markDirty();
      const next=source.map(node=>node.id===existing.id?{...node,data:{...node.data,label,referencePack:{version:1 as const,kind}}}:node);
      nodesRef.current=next;setNodes(next);return null;
    }
    const id=`group-${genId()}`,draft=createCanvasGroupDraft(source,selectedNodeIds,id,label);
    if(!draft)return "invalid-selection";
    const group:SpikeNode={id,type:"group",position:draft.position,style:{width:draft.width,height:draft.height},dragHandle:".canvas-group-drag-handle",data:normalizeCanvasNodeCapabilityData<SpikeNodeData>({kind:"group",label,referencePack:{version:1,kind},groupMemberCount:draft.memberIds.length})};
    commitHistory();markDirty();
    const next=attachCanvasNodesToGroup(source,draft,group).map(node=>({...node,selected:node.id===id}));
    nodesRef.current=next;setNodes(next);setSelectedNodeIds([id]);return null;
  },[commitHistory,markDirty,selectedNodeIds,loadingCanvas]);
  const editReferencePack = useCallback((id:string,name?:string)=>{
    const node=nodesRef.current.find(item=>item.id===id);if(!node||!isReferencePack(node)||loadingCanvas)return;
    if(name!==undefined && (!name.trim()||name.trim().length>60))return;
    commitHistory();markDirty();
    const next=nodesRef.current.map(item=>item.id===id?{...item,data:name===undefined?{...item.data,referencePack:undefined}:{...item.data,label:name.trim()}}:item);
    nodesRef.current=next;setNodes(next);
  },[commitHistory,markDirty,loadingCanvas]);
  const applyReferencePack = useCallback((id:string,target:string):string|null=>{
    if(loadingCanvas)return "invalid-target";
    const plan=planReferencePack(nodesRef.current,edgesRef.current,id,target);
    if(!plan.ok)return plan.error;
    if(!plan.edges.length)return null;
    commitHistory();markDirty();
    const next=edgesRef.current.concat(plan.edges.map(edge=>({...edge,id:genEdgeId(),animated:false})));
    edgesRef.current=next;setEdges(next);return null;
  },[commitHistory,markDirty,loadingCanvas]);
  const pickReviewImage = useCallback((entryId:string,index:number)=>{
    const entry=generationHistoryRef.current.find(item=>item.id===entryId);
    const count=entry?.outputMediaItems?.length || (entry?.outputMediaUrl?1:0);
    if(loadingCanvas || !entry || entry.kind!=="image" || entry.status!=="succeeded" || !Number.isInteger(index)||index<0||index>=count)return;
    commitHistory();markDirty();
    const selected=new Set(entry.preferredImageIndexes||[]);
    if(selected.has(index))selected.delete(index);else selected.add(index);
    const next=generationHistoryRef.current.map(item=>item.id===entryId?{...item,preferredImageIndexes:[...selected]}:item);
    generationHistoryRef.current=next;setGenerationHistory(next);
  },[commitHistory,markDirty,loadingCanvas]);

  const focusSearchResult = useCallback((node: SpikeNode) => {
    selectSingleNode(node.id);
    setInlineEditingNodeId(null);
    setNodeSearchOpen(false);
    centerNodeByAbsoluteBounds(node.id, 360, Math.max(reactFlowInstance.getZoom(), .9));
  }, [centerNodeByAbsoluteBounds, reactFlowInstance, selectSingleNode]);

  const ensureGenerationHistoryResultNode = useCallback((entry: CanvasGenerationHistoryEntry): SpikeNode => {
    const existing = nodesRef.current.find((node) => node.id === entry.resultNodeId);
    if (existing && getCanvasNodeCapabilities(existing.data).composerMode !== "none") return existing;
    const task = generationTaskFromHistory(entry);
    const kind: NodeKind = entry.kind === "text" ? "text" : "generator";
    const label = entry.kind === "text"
      ? sanitizeCanvasTextGenerationOutput(entry.outputText || "").trim() || t("editor.canvas.node.doubleClickEdit")
      : entry.kind === "video" ? t("editor.canvas.toolbar.videoGenerate") : t("editor.canvas.toolbar.imageGenerate");
    const data = normalizeCanvasNodeCapabilityData<SpikeNodeData>({
      label,
      kind,
      result: entry.kind === "text" ? entry.outputText || "" : "",
      resultMediaUrl: entry.outputMediaUrl,
      resultThumbnailUrl: entry.outputThumbnailUrl,
      resultMediaItems: entry.outputMediaItems,
      generationTask: task,
      generationPrompt: entry.request.prompt,
      generationKind: entry.kind === "image" || entry.kind === "video" ? entry.kind : undefined,
      generationModel: entry.request.model,
      generationAspect: entry.request.aspect,
      generationDuration: entry.request.duration,
      generationSound: entry.request.sound,
      generationQuality: entry.request.quality,
      generationResolution: entry.request.resolution,
      generationCount: entry.request.count,
      generationCameraStrength: entry.request.cameraStrength,
      generationReferences: entry.request.references.map((reference) => ({
        id: reference.id,
        label: reference.label,
        kind: reference.kind,
        role: reference.role,
        thumbnailUrl: reference.thumbnailUrl,
        mediaUrl: reference.mediaUrl,
        text: reference.text,
      })),
    });
    const restoredNode: SpikeNode = {
      id: existing ? genId() : entry.resultNodeId,
      type: "spike",
      position: getViewportCreatePosition(kind),
      selected: true,
      data,
      dragHandle: kind === "generator" ? ".canvas-node-drag-handle" : undefined,
      style: kind === "text" ? textNodeSize(data) : undefined,
    };
    commitHistory();
    markDirty();
    const nextNodes = nodesRef.current
      .map((node) => node.selected ? { ...node, selected: false } : node)
      .concat(restoredNode);
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    setSelectedNodeIds([restoredNode.id]);
    return restoredNode;
  }, [commitHistory, getViewportCreatePosition, markDirty, t]);

  const restoreGenerationHistoryResult = useCallback((entry: CanvasGenerationHistoryEntry) => {
    const mediaItems = entry.kind === "image"
      ? entry.outputMediaItems?.length
        ? entry.outputMediaItems
        : entry.outputMediaUrl ? [{ url: entry.outputMediaUrl, thumbnailUrl: entry.outputThumbnailUrl }] : []
      : [];
    const cardKind: NodeKind = entry.kind === "text" ? "text" : entry.kind;
    const basePosition = getViewportCreatePosition(cardKind);
    const commonProvenance = {
      sourceGenerationTaskId: entry.taskId,
      sourceGenerationHistoryId: entry.id,
      refUpdatedAt: entry.updatedAt,
    };
    const restoredNodes: SpikeNode[] = entry.kind === "text" && entry.outputText
      ? [(() => {
          const data = normalizeCanvasNodeCapabilityData<SpikeNodeData>({
            label: sanitizeCanvasTextGenerationOutput(entry.outputText || ""),
            kind: "text",
            ...commonProvenance,
          });
          return {
            id: genId(),
            type: "spike",
            position: basePosition,
            data,
            style: textNodeSize(data),
            selected: true,
          };
        })()]
      : entry.kind === "video" && entry.outputMediaUrl
        ? [{
            id: genId(),
            type: "spike",
            position: basePosition,
            data: normalizeCanvasNodeCapabilityData<SpikeNodeData>({
              label: t("editor.canvas.history.restoredVideo"),
              kind: "video",
              refKind: "video",
              sourceGenerationMediaUrl: entry.outputMediaUrl,
              refMediaUrl: resolveCanvasMediaUrl(entry.outputMediaUrl),
              refThumbnailUrl: resolveCanvasMediaUrl(entry.outputThumbnailUrl),
              _emptyMedia: false,
              ...commonProvenance,
            }),
            selected: true,
          }]
        : entry.kind === "image"
          ? mediaItems.map((item, index) => ({
              id: genId(),
              type: "spike" as const,
              position: {
                x: Math.round((basePosition.x + index * 340) / CANVAS_SNAP_GRID[0]) * CANVAS_SNAP_GRID[0],
                y: basePosition.y,
              },
              data: normalizeCanvasNodeCapabilityData<SpikeNodeData>({
                label: t("editor.canvas.history.restoredImage"),
                kind: "image",
                refKind: "image",
                sourceGenerationMediaUrl: item.url,
                refMediaUrl: resolveCanvasMediaUrl(item.url),
                refThumbnailUrl: resolveCanvasMediaUrl(item.thumbnailUrl || item.url),
                _emptyMedia: false,
                ...commonProvenance,
              }),
              selected: true,
            }))
          : [];
    if (!restoredNodes.length) {
      setGenerationHistoryNotice(t("editor.canvas.history.noRestoreResult"));
      return;
    }
    commitHistory();
    markDirty();
    const restoredIds = new Set(restoredNodes.map((node) => node.id));
    setNodes((current) => current
      .map((node) => node.selected ? { ...node, selected: false } : node)
      .concat(restoredNodes));
    setSelectedNodeIds([...restoredIds]);
    setGenerationHistoryNotice(restoredNodes.length > 1
      ? t("editor.canvas.history.restoredMany", { count: restoredNodes.length })
      : t("editor.canvas.history.restoredOne"));
    setGenerationHistoryOpen(false);
    window.requestAnimationFrame(() => focusSearchResult(restoredNodes[0]));
  }, [commitHistory, focusSearchResult, getViewportCreatePosition, markDirty, t]);

  const rerunGenerationHistoryEntry = useCallback((entry: CanvasGenerationHistoryEntry) => {
    if (entry.status === "queued" || entry.status === "running") {
      setGenerationHistoryNotice(t("editor.canvas.history.taskActive"));
      return;
    }
    if (!uiSettings.noteReferenceIncludeTitle && entry.request.references.some(reference => reference.kind === "note" && reference.label !== "笔记正文")) {
      setGenerationHistoryNotice(locale === "en-US" ? "This history includes note titles. Use a new generation card with a fresh prompt and reconnect the note for body-only generation." : "这条历史包含笔记标题。请新建生成卡、填写需求并重新连接笔记，以仅引用正文生成。");
      return;
    }
    const existingSource = nodesRef.current.find((node) => node.id === entry.sourceNodeId);
    const source = existingSource && getCanvasNodeCapabilities(existingSource.data).composerMode !== "none"
      ? existingSource
      : ensureGenerationHistoryResultNode(entry);
    submitGenerationFromNode(source.id, {
      request: {
        ...entry.request,
        references: entry.request.references.map((reference) => ({ ...reference })),
      },
      attempt: entry.attempt + 1,
      parentTaskId: entry.taskId,
    });
    setGenerationHistoryOpen(false);
  }, [ensureGenerationHistoryResultNode, submitGenerationFromNode, t, locale, uiSettings.noteReferenceIncludeTitle]);

  const cancelGenerationHistoryEntry = useCallback((entry: CanvasGenerationHistoryEntry) => {
    if (entry.status !== "queued" && entry.status !== "running") return;
    const node = nodesRef.current.find((candidate) => candidate.data.generationTask?.id === entry.taskId);
    const task = node?.data.generationTask || generationTaskFromHistory(entry);
    cancelGenerationTask(task, node?.id);
    setGenerationHistoryNotice(entry.status === "queued" ? t("editor.canvas.history.queuedCancelled") : t("editor.canvas.history.cancelRequested"));
  }, [cancelGenerationTask, t]);

  const deleteGenerationHistoryEntry = useCallback((entry: CanvasGenerationHistoryEntry) => {
    if (entry.status === "queued" || entry.status === "running") {
      setGenerationHistoryNotice(t("editor.canvas.history.deleteActive"));
      return;
    }
    if (generationHistoryDeleteConfirmId !== entry.id) {
      setGenerationHistoryDeleteConfirmId(entry.id);
      setGenerationHistoryNotice(t("editor.canvas.history.confirmDeleteHint"));
      return;
    }
    setGenerationHistory((current) => current.filter((candidate) => candidate.id !== entry.id));
    setGenerationHistoryDeleteConfirmId(null);
    if (generationHistoryPreviewId === entry.id) setGenerationHistoryPreviewId(null);
    setGenerationHistoryNotice(t("editor.canvas.history.deleted"));
    markDirty();
  }, [generationHistoryDeleteConfirmId, generationHistoryPreviewId, markDirty, t]);

  const clearFailedGenerationHistory = useCallback(() => {
    if (!generationHistoryClearConfirm) {
      setGenerationHistoryClearConfirm(true);
      setGenerationHistoryNotice(t("editor.canvas.history.confirmClearHint"));
      return;
    }
    setGenerationHistory((current) => current.filter((entry) => entry.status !== "failed" && entry.status !== "cancelled"));
    setGenerationHistoryClearConfirm(false);
    setGenerationHistoryDeleteConfirmId(null);
    setGenerationHistoryNotice(t("editor.canvas.history.failedCleared"));
    markDirty();
  }, [generationHistoryClearConfirm, markDirty, t]);

  const saveHistoryEntryToLibrary = useCallback(async (entry: CanvasGenerationHistoryEntry) => {
    const candidate = toGenerationLibraryCandidate(entry);
    if (!candidate) {
      setGenerationHistoryNotice(t("editor.canvas.history.noLibraryMedia"));
      return;
    }
    if (!bridge?.saveCanvasGenerationToLibrary) {
      setGenerationHistoryNotice(t("editor.canvas.history.libraryChannelReady"));
      return;
    }
    try {
      const result = await bridge.saveCanvasGenerationToLibrary(candidate);
      setGenerationHistoryNotice(result.success ? (result.message || t("editor.canvas.history.savedLibrary")) : (result.message || t("editor.canvas.history.saveLibraryFailed")));
    } catch (error) {
      setGenerationHistoryNotice(t("editor.canvas.history.saveLibraryError", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [bridge, t]);

  const createQuickNode = useCallback((kind: "text") => {
    if (!quickAddMenu) return;
    addNode(kind, undefined, quickAddMenu.flowPosition);
    setQuickAddMenu(null);
  }, [addNode, quickAddMenu]);

  useEffect(() => {
    if (!quickAddMenu && !connectDropMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setQuickAddMenu(null);
        setConnectDropMenu(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [quickAddMenu, connectDropMenu]);

  return (
    <div className={`canvas-editor-root is-${uiSettings.density} ${uiSettings.showHandles ? "show-handles" : "hide-handles"} ${uiSettings.reduceMotion ? "reduce-motion" : ""}`}>
      <div ref={editorBodyRef} className="canvas-editor-body">
        <div className="canvas-editor-floating-toolbar" data-tauri-no-drag="true">
          <div className="canvas-editor-title-slot">
          {currentCanvasId && renamingId === currentCanvasId ? (
            <>
            <span className="canvas-editor-current canvas-editor-title-measure" aria-hidden="true">{currentCanvasName || t("editor.canvas.untitled")}</span>
            <input
              className="canvas-editor-title-input nodrag nowheel"
              aria-label={t("editor.canvas.action.rename")}
              value={renamingDraft}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRenamingDraft(event.target.value)}
              onBlur={() => { void handleCommitRename(); }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") { event.preventDefault(); void handleCommitRename(); }
                if (event.key === "Escape") { event.preventDefault(); handleCancelRename(); }
              }}
            />
            </>
          ) : (
            <span
              className="canvas-editor-current"
              title={currentCanvasName || t("editor.canvas.untitled")}
              role="button"
              tabIndex={0}
              onDoubleClick={() => {
                const entry = canvases.find((item) => item.id === currentCanvasId);
                if (entry) handleStartRename(entry);
              }}
              onKeyDown={(event) => {
                if (event.key !== "F2" && event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                const entry = canvases.find((item) => item.id === currentCanvasId);
                if (entry) handleStartRename(entry);
              }}
            >
              {currentCanvasName || t("editor.canvas.untitled")}
            </span>
          )}
          </div>
          <span className="canvas-editor-divider" />
          <div
            className="canvas-create-anchor"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) setCreateMenuOpen(false);
            }}
          >
            <CanvasToolButton label={t("editor.canvas.toolbar.addCard")} active={createMenuOpen} onClick={() => setCreateMenuOpen((open) => !open)}>
              <ToolIcon type="plus" />
            </CanvasToolButton>
            {createMenuOpen ? (
              <div className="canvas-create-panel">
                <div className="canvas-create-panel-title">{t("editor.canvas.toolbar.addToCanvas")}</div>
                <div className="canvas-create-panel-section">
                  <button type="button" onClick={() => { addGeneratorNode("image", undefined, getViewportCreatePosition("generator")); setCreateMenuOpen(false); }}><span><ToolIcon type="image" /></span><div><strong>{t("editor.canvas.toolbar.imageGenerate")}</strong><small>{t("editor.canvas.toolbar.imageGenerateHint")}</small></div></button>
                  <button type="button" onClick={() => { addGeneratorNode("video", undefined, getViewportCreatePosition("generator")); setCreateMenuOpen(false); }}><span><ToolIcon type="video" /></span><div><strong>{t("editor.canvas.toolbar.videoGenerate")}</strong><small>{t("editor.canvas.toolbar.videoGenerateHint")}</small></div></button>
                </div>
                <div className="canvas-create-panel-label">{t("editor.canvas.toolbar.contentReferences")}</div>
                <div className="canvas-create-panel-grid">
                  <button type="button" onClick={() => { addNode("text", undefined, getViewportCreatePosition("text")); setCreateMenuOpen(false); }}><ToolIcon type="text" /><span>{t("editor.canvas.type.text")}</span></button>
                  <button type="button" onClick={() => { void openAssetPicker(); setCreateMenuOpen(false); }}><ToolIcon type="asset" /><span>{t("editor.canvas.type.material")}</span></button>
                  <button type="button" onClick={() => { void openNotePicker(); setCreateMenuOpen(false); }}><ToolIcon type="note" /><span>{t("editor.canvas.type.note")}</span></button>
                </div>
              </div>
            ) : null}
          </div>
          <CanvasToolButton label={t("editor.canvas.toolbar.referenceMaterial")} onClick={() => { void openAssetPicker(); }}>
            <ToolIcon type="asset" />
          </CanvasToolButton>
          <CanvasToolButton label={t("editor.canvas.toolbar.referenceKnowledge")} onClick={() => { void openNotePicker(); }}>
            <ToolIcon type="note" />
          </CanvasToolButton>
          <div
            className="canvas-node-search-anchor"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) setNodeSearchOpen(false);
            }}
          >
            <CanvasToolButton
              label={t("editor.canvas.toolbar.search")}
              active={nodeSearchOpen}
              onClick={() => setNodeSearchOpen((open) => !open)}
            >
              <ToolIcon type="search" />
            </CanvasToolButton>
            {nodeSearchOpen ? (
              <div className="canvas-node-search-panel">
                <label className="canvas-node-search-input">
                  <ToolIcon type="search" />
                  <input
                    autoFocus
                    value={nodeSearchQuery}
                    onChange={(event) => setNodeSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setNodeSearchOpen(false);
                      if (event.key === "Enter" && nodeSearchResults[0]) focusSearchResult(nodeSearchResults[0].node);
                    }}
                    placeholder={t("editor.canvas.search.placeholder")}
                    aria-label={t("editor.canvas.toolbar.search")}
                  />
                  <span>{nodeSearchResults.length}</span>
                </label>
                <div className="canvas-node-search-results">
                  {nodeSearchResults.length ? nodeSearchResults.map(({ node, label }) => (
                    <button key={node.id} type="button" onClick={() => focusSearchResult(node)}>
                      <span className="canvas-node-search-kind"><ToolIcon type={node.data.kind === "noteRef" ? "note" : node.data.kind === "aiPrompt" ? "aiPrompt" : node.data.kind === "aiResult" ? "aiResult" : node.data.kind === "image" || node.data.kind === "video" ? "asset" : "text"} /></span>
                      <span className="canvas-node-search-copy">
                        <strong>{label}</strong>
                        <small>{canvasNodeKindLabel(node.data.kind, t)}</small>
                      </span>
                      <svg className="canvas-node-search-arrow" viewBox="0 0 18 18"><path d="M7 4l5 5-5 5" /></svg>
                    </button>
                  )) : (
                    <div className="canvas-node-search-empty">{nodes.length ? t("editor.canvas.search.empty") : t("editor.canvas.search.noNodes")}</div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <div
            className="canvas-generation-history-anchor"
            ref={generationHistoryAnchorRef}
          >
            <CanvasToolButton
              label={t("editor.canvas.history.title")}
              active={generationHistoryOpen}
              onClick={() => {
                setGenerationHistoryNotice("");
                setGenerationHistoryOpen((open) => !open);
              }}
            >
              <ToolIcon type="history" />
              {generationHistorySignal ? (
                <span className={`canvas-generation-history-badge${activeGenerationCount ? " is-active" : " is-complete"}`}>
                  {generationHistorySignal}
                </span>
              ) : null}
            </CanvasToolButton>
            {generationHistoryOpen ? (
              <div className="canvas-generation-history-panel">
                <div className="canvas-generation-history-heading">
                  <span><strong>{t("editor.canvas.history.title")}</strong><small>{t("editor.canvas.history.currentOnly")}</small></span>
                  <div>
                    <button type="button" disabled={!generationHistory.some((entry) => entry.status === "failed" || entry.status === "cancelled")} onClick={clearFailedGenerationHistory}>
                      {generationHistoryClearConfirm ? t("editor.canvas.history.confirmClear") : t("editor.canvas.history.clearFailed")}
                    </button>
                    <button type="button" onClick={()=>{if(currentCanvasId){setCreativePanel({canvasId:currentCanvasId,kind:'review'});setGenerationHistoryOpen(false);}}}>{locale === "en-US" ? "Compare images" : "图片对比"}</button>
                    <b>{filteredGenerationHistory.length}/{generationHistory.length}</b>
                  </div>
                </div>
                <input className="canvas-generation-history-search" type="search" maxLength={200} value={generationHistoryQuery} onChange={event=>setGenerationHistoryQuery(event.target.value)} placeholder={locale === "en-US" ? "Search prompts, models and text results" : "搜索提示词、模型或文字结果"} aria-label={locale === "en-US" ? "Search generation history" : "搜索生成历史"} />
                <div className="canvas-generation-history-filters">
                  <div>
                    {([[
                      "all", t("editor.canvas.history.filter.all"),
                    ], ["active", t("editor.canvas.history.filter.active")], ["succeeded", t("editor.canvas.history.filter.completed")], ["failed", t("editor.canvas.history.filter.failed")]] as const).map(([value, label]) => (
                      <button key={value} type="button" className={generationHistoryStatusFilter === value ? "is-active" : ""} onClick={() => { setGenerationHistoryStatusFilter(value); setGenerationHistoryDeleteConfirmId(null); }}>{label}</button>
                    ))}
                  </div>
                  <div>
                    {([["all", t("editor.canvas.history.filter.allTypes")], ["text", t("editor.canvas.history.filter.text")], ["image", t("editor.canvas.history.filter.image")], ["video", t("editor.canvas.history.filter.video")]] as const).map(([value, label]) => (
                      <button key={value} type="button" className={generationHistoryKindFilter === value ? "is-active" : ""} onClick={() => setGenerationHistoryKindFilter(value)}>{label}</button>
                    ))}
                  </div>
                </div>
                {generationHistoryNotice ? <div className="canvas-generation-history-notice" role="status"><span>{generationHistoryNotice}</span><button type="button" aria-label={locale === "en-US" ? "Dismiss notice" : "关闭提示"} onClick={()=>setGenerationHistoryNotice("")}>×</button></div> : null}
                <div className="canvas-generation-history-list">
                  {filteredGenerationHistory.length ? filteredGenerationHistory.map((entry) => {
                    const libraryCandidate = toGenerationLibraryCandidate(entry);
                    const progress = typeof entry.progress === "number" ? Math.max(0, Math.min(100, Math.round(entry.progress))) : null;
                    const isActive = entry.status === "queued" || entry.status === "running";
                    const hasPreview = !!(entry.outputText || entry.outputMediaUrl || entry.outputMediaItems?.length);
                    const previewImage = entry.outputMediaItems?.[0]?.thumbnailUrl || entry.outputMediaItems?.[0]?.url || entry.outputThumbnailUrl || (entry.kind === "image" ? entry.outputMediaUrl : "");
                    return (
                      <article key={entry.id} className={`is-${entry.status}`}>
                        <button type="button" className="canvas-generation-history-preview" disabled={!hasPreview} onClick={() => setGenerationHistoryPreviewId(entry.id)} title={hasPreview ? t("editor.canvas.history.previewResult") : t("editor.canvas.history.notReady")}>
                          {previewImage ? (
                            <img src={resolveCanvasMediaUrl(previewImage)} alt={t("editor.canvas.history.result")} />
                          ) : <ToolIcon type={entry.kind === "video" ? "video" : entry.kind === "image" ? "image" : "text"} />}
                        </button>
                        <div className="canvas-generation-history-copy">
                          <div><strong>{entry.prompt || t("editor.canvas.history.noPrompt")}</strong><span>{generationHistoryStatusLabel(entry, generationQueuePositions.get(entry.taskId), t)}</span></div>
                          <small>{entry.kind === "video" ? t("editor.canvas.history.filter.video") : entry.kind === "image" ? t("editor.canvas.history.filter.image") : t("editor.canvas.history.filter.text")} · {entry.model || t("editor.canvas.history.defaultModel")} · {new Date(entry.createdAt).toLocaleString(locale, { hour12: false })}</small>
                          {isActive ? <i><b style={{ width: `${progress ?? (entry.status === "running" ? 18 : 5)}%` }} /></i> : null}
                          {entry.errorMessage ? (
                            <em title={[entry.errorCode || t("editor.canvas.history.error"), entry.errorDetail].filter(Boolean).join("\n")}>
                              {entry.errorRetryable === false ? t("editor.canvas.history.configError") : entry.errorRetryable ? t("editor.canvas.history.retryable") : ""}{entry.errorMessage}
                            </em>
                          ) : null}
                        </div>
                        <div className="canvas-generation-history-actions">
                          {entry.kind==='image' && entry.status==='succeeded' && hasPreview ? <button type="button" onClick={()=>{if(currentCanvasId){setCreativePanel({canvasId:currentCanvasId,kind:'review',initialId:entry.id});setGenerationHistoryOpen(false);}}}>{locale === "en-US" ? "Compare / pick" : "对比挑选"}{entry.preferredImageIndexes?.length ? ' · '+entry.preferredImageIndexes.length : ''}</button> : null}
                          <button type="button" disabled={!hasPreview} onClick={() => setGenerationHistoryPreviewId(entry.id)}>{t("editor.canvas.history.preview")}</button>
                          <button type="button" disabled={!hasPreview} onClick={() => restoreGenerationHistoryResult(entry)}>{t("editor.canvas.history.restore")}</button>
                          {isActive ? (
                            <button type="button" className="is-cancel" onClick={() => cancelGenerationHistoryEntry(entry)}>{t("editor.canvas.history.cancelTask")}</button>
                          ) : (
                            <button type="button" disabled={entry.status === "failed" && entry.errorRetryable === false} onClick={() => rerunGenerationHistoryEntry(entry)}>{entry.status === "failed" || entry.status === "cancelled" ? t("common.action.retry") : t("editor.canvas.history.generateAgain")}</button>
                          )}
                          <button type="button" disabled={!libraryCandidate} onClick={() => { void saveHistoryEntryToLibrary(entry); }}>{t("editor.canvas.history.saveLibrary")}</button>
                          <button type="button" className="is-danger" disabled={isActive} onClick={() => deleteGenerationHistoryEntry(entry)}>{generationHistoryDeleteConfirmId === entry.id ? t("editor.canvas.history.confirmDelete") : t("editor.canvas.history.delete")}</button>
                        </div>
                      </article>
                    );
                  }) : <div className="canvas-generation-history-empty">{t("editor.canvas.history.empty")}</div>}
                </div>
                {generationHistoryPreviewEntry ? (
                  <div className="canvas-generation-history-viewer" role="dialog" aria-modal="true" aria-label={t("editor.canvas.history.previewAria")} onPointerDown={(event) => { if (event.target === event.currentTarget) setGenerationHistoryPreviewId(null); }}>
                    <section>
                      <header>
                        <div><strong>{generationHistoryPreviewEntry.kind === "video" ? t("editor.canvas.history.videoResult") : generationHistoryPreviewEntry.kind === "image" ? t("editor.canvas.history.imageResult") : t("editor.canvas.history.textResult")}</strong><small>{generationHistoryPreviewEntry.model || t("editor.canvas.history.defaultModel")}</small></div>
                        <button type="button" onClick={() => setGenerationHistoryPreviewId(null)} aria-label={t("editor.canvas.history.closePreview")}>×</button>
                      </header>
                      <div className={`canvas-generation-history-viewer-content is-${generationHistoryPreviewEntry.kind}`}>
                        {generationHistoryPreviewEntry.kind === "text" ? (
                          <pre>{generationHistoryPreviewEntry.outputText || t("editor.canvas.history.noText")}</pre>
                        ) : generationHistoryPreviewEntry.kind === "video" && generationHistoryPreviewEntry.outputMediaUrl ? (
                          <video controls preload="metadata" src={resolveCanvasMediaUrl(generationHistoryPreviewEntry.outputMediaUrl)} poster={resolveCanvasMediaUrl(generationHistoryPreviewEntry.outputThumbnailUrl)} />
                        ) : (
                          <div className="canvas-generation-history-viewer-gallery">
                            {(generationHistoryPreviewEntry.outputMediaItems?.length
                              ? generationHistoryPreviewEntry.outputMediaItems.map((item) => item.url)
                              : generationHistoryPreviewEntry.outputMediaUrl ? [generationHistoryPreviewEntry.outputMediaUrl] : []
                            ).map((url, index) => <img key={`${url}-${index}`} src={resolveCanvasMediaUrl(url)} alt={t("editor.canvas.history.generatedImage", { index: index + 1 })} />)}
                          </div>
                        )}
                      </div>
                      <footer><span>{generationHistoryPreviewEntry.prompt || t("editor.canvas.history.noPrompt")}</span><button type="button" onClick={() => restoreGenerationHistoryResult(generationHistoryPreviewEntry)}>{t("editor.canvas.history.restoreAsMaterial")}</button></footer>
                    </section>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <span className="canvas-editor-divider" />
          <CanvasToolButton label={t("editor.canvas.toolbar.undo")} onClick={undo} disabled={!canUndo}><span style={{ fontSize: 14, lineHeight: 1 }}>↶</span></CanvasToolButton>
          <CanvasToolButton label={t("editor.canvas.toolbar.redo")} onClick={redo} disabled={!canRedo}><span style={{ fontSize: 14, lineHeight: 1 }}>↷</span></CanvasToolButton>
          <span className="canvas-editor-divider" />
          <CanvasToolButton label={t("editor.canvas.toolbar.deleteSelected")} onClick={deleteSelectedNode} disabled={selectedNodeIds.length === 0}><ToolIcon type="delete" /></CanvasToolButton>
          <span className="canvas-editor-divider" />
          <div
            className="canvas-settings-anchor"
            ref={canvasSettingsAnchorRef}
          >
            <CanvasToolButton label={t("editor.canvas.settings.title")} active={canvasSettingsOpen} onClick={() => setCanvasSettingsOpen((open) => !open)}>
              <ToolIcon type="settings" />
            </CanvasToolButton>
            <div className="canvas-settings-panel" hidden={!canvasSettingsOpen}>
                <div className="canvas-settings-heading"><strong>{t("editor.canvas.settings.title")}</strong><small>{t("editor.canvas.settings.subtitle")}</small></div>
                <div className="canvas-settings-tabs" role="tablist" aria-label={locale === "en-US" ? "Canvas settings" : "画布设置"}>
                  <button type="button" role="tab" aria-selected={canvasSettingsTab === "generation"} onClick={() => setCanvasSettingsTab("generation")}>{locale === "en-US" ? "Generation" : "生成配置"}</button>
                  <button type="button" role="tab" aria-selected={canvasSettingsTab === "appearance"} onClick={() => setCanvasSettingsTab("appearance")}>{locale === "en-US" ? "Appearance" : "画布外观"}</button>
                </div>
                <div hidden={canvasSettingsTab !== "appearance"}>
                <CanvasSettingToggle label={locale === "en-US" ? "Keep creation tools visible" : "始终显示创作工具"} hint={locale === "en-US" ? "Turn off to reveal tools on hover or keyboard focus." : "关闭后，鼠标移到左侧或键盘聚焦时展开。"} checked={uiSettings.creativeRailAlwaysVisible} onChange={(checked)=>updateUiSetting("creativeRailAlwaysVisible",checked)} />
                <CanvasSettingToggle label={t("editor.canvas.settings.grid")} hint={t("editor.canvas.settings.gridHint")} checked={uiSettings.showGrid} onChange={(checked) => updateUiSetting("showGrid", checked)} />
                <CanvasSettingToggle label={t("editor.canvas.settings.snap")} hint={t("editor.canvas.settings.snapHint")} checked={uiSettings.snapToGrid} onChange={(checked) => updateUiSetting("snapToGrid", checked)} />
                <CanvasSettingToggle label={t("editor.canvas.settings.handles")} hint={t("editor.canvas.settings.handlesHint")} checked={uiSettings.showHandles} onChange={(checked) => updateUiSetting("showHandles", checked)} />
                <CanvasSettingToggle label={t("editor.canvas.settings.minimap")} hint={t("editor.canvas.settings.minimapHint")} checked={minimapVisible} onChange={(checked) => updateUiSetting("minimap", checked)} />
                <CanvasSettingToggle label={t("editor.canvas.settings.fan")} hint={t("editor.canvas.settings.fanHint")} checked={uiSettings.fanInspector} onChange={(checked) => updateUiSetting("fanInspector", checked)} experimental />
                <CanvasSettingToggle label={t("editor.canvas.settings.motion")} hint={t("editor.canvas.settings.motionHint")} checked={uiSettings.reduceMotion} onChange={(checked) => updateUiSetting("reduceMotion", checked)} />
                <div className="canvas-settings-density">
                  <span><strong>{t("editor.canvas.settings.density")}</strong><small>{t("editor.canvas.settings.densityHint")}</small></span>
                  <div>
                    {(["compact", "standard"] as CanvasDensity[]).map((density) => (
                      <button key={density} type="button" className={uiSettings.density === density ? "is-active" : ""} onClick={() => updateUiSetting("density", density)}>
                        {density === "compact" ? t("editor.canvas.settings.compact") : t("editor.canvas.settings.standard")}
                      </button>
                    ))}
                  </div>
                </div>
                </div>
                <div hidden={canvasSettingsTab !== "generation"}>
                <CanvasSettingToggle label={locale === "en-US" ? "Include note titles in generation" : "生成时同时引用笔记标题"} hint={locale === "en-US" ? "Off: note body only, up to 8,000 characters. Card timestamps are display-only; dates written in the body remain part of the content." : "默认仅引用正文，最多 8000 字符。卡片时间不参与生成；正文中写入的日期仍保留。"} checked={uiSettings.noteReferenceIncludeTitle} onChange={checked=>updateUiSetting("noteReferenceIncludeTitle",checked)} />
                  <CanvasMediaProfilesPanel snapshot={mediaProfiles} onChange={applyMediaProfilesSnapshot} />
                </div>
              </div>
          </div>
        </div>
        <div
          className={`canvas-editor-save-light is-${saveStatus}`}
          style={{ color: saveStatusColor }}
          data-status={saveError || saveStatusText}
          title={saveError || saveStatusText}
          role="status"
          aria-label={saveError || saveStatusText}
        >
          <span />
        </div>
        <div
          className="canvas-editor-storage-diagnostic"
          data-tauri-no-drag="true"
          style={{
            position: "absolute",
            zIndex: 20,
            left: 16,
            top: 18,
            width: 260,
            padding: 10,
            border: "1px solid rgba(255,255,255,.10)",
            borderRadius: 10,
            background: "rgba(18,18,22,.82)",
            boxShadow: "0 16px 42px rgba(0,0,0,.30)",
            backdropFilter: "blur(14px)",
            color: "#f0f0f2",
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{t("editor.canvas.storage.title")}</div>
              <div style={{ marginTop: 2, color: "#8e8e96" }}>
                {storageCheck
                  ? storageCheck.ok ? t("editor.canvas.storage.consistent") : t("editor.canvas.storage.inconsistent")
                  : t("editor.canvas.storage.unchecked")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleCheckStorage()}
              disabled={storageChecking}
              style={{ ...btnAccent, padding: "5px 9px", fontSize: 11, whiteSpace: "nowrap", opacity: storageChecking ? .62 : 1 }}
            >
              {storageChecking ? t("editor.canvas.storage.checking") : t("editor.canvas.storage.check")}
            </button>
          </div>
          {storageCheckError ? (
            <div style={{ marginTop: 8, color: "#fb7185", wordBreak: "break-word" }}>
              {storageCheckError}
            </div>
          ) : null}
          {storageCheck ? (
            <div style={{ marginTop: 8, color: storageCheck.ok ? "#4ade80" : "#fda4af" }}>
              <div>
                {t("editor.canvas.storage.summary", { canvases: storageCheck.canvasCount, files: storageCheck.checkedFiles, issues: storageCheck.issues.length })}
              </div>
              {storageCheck.storageDir ? (
                <div title={storageCheck.storageDir} style={{ marginTop: 4, color: "#8e8e96", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {storageCheck.storageDir}
                </div>
              ) : null}
              {!storageCheck.ok && storageCheck.issues.length > 0 ? (
                <div style={{ marginTop: 6, color: "#fda4af" }}>
                  {storageCheck.issues.slice(0, 4).map((issue) => (
                    <div key={issue} style={{ wordBreak: "break-word" }}>· {issue}</div>
                  ))}
                  {storageCheck.issues.length > 4 ? (
                    <div style={{ color: "#8e8e96" }}>{t("editor.canvas.storage.moreIssues", { count: storageCheck.issues.length - 4 })}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {/* 左侧：画布列表侧栏 */}
        <div
          style={{
            width: 240,
            background: "rgba(20,20,24,.95)",
            borderRight: "1px solid rgba(255,255,255,.08)",
            display: "none",
            flexDirection: "column",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid rgba(255,255,255,.06)",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "#f0f0f2", flex: 1 }}>{t("editor.canvas.list.title")}</div>
            <button onClick={handleCreateCanvas} style={{ ...btn, padding: "3px 8px", fontSize: 10 }}>+ {t("editor.canvas.action.new")}</button>
          </div>
          <div className="lr-canvas-list-scroll" style={{ flex: 1, overflowY: "auto" }}>
            {loadingList ? (
              <div style={{ padding: 16, fontSize: 11, color: "#8e8e96", textAlign: "center" }}>{t("editor.canvas.status.loadingShort")}</div>
            ) : canvases.length === 0 ? (
              <div style={{ padding: 16, fontSize: 11, color: "#8e8e96", textAlign: "center" }}>
                {t("editor.canvas.list.empty")}
              </div>
            ) : (
              canvases.map((c) => {
                const isCurrent = c.id === currentCanvasId;
                const isRenaming = renamingId === c.id;
                return (
                  <div
                    key={c.id}
                    style={{
                      padding: "8px 10px",
                      borderBottom: "1px solid rgba(255,255,255,.04)",
                      background: isCurrent ? "rgba(124,138,255,.12)" : "transparent",
                      cursor: isRenaming ? "default" : "pointer",
                    }}
                    onClick={() => !isRenaming && handleOpenCanvas(c.id)}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renamingDraft}
                        onChange={(e) => setRenamingDraft(e.target.value)}
                        onBlur={handleCommitRename}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === "Enter") { e.preventDefault(); void handleCommitRename(); }
                          if (e.key === "Escape") { e.preventDefault(); handleCancelRename(); }
                        }}
                        style={{
                          width: "100%",
                          padding: "3px 6px",
                          background: "rgba(255,255,255,.06)",
                          border: "1px solid rgba(124,138,255,.4)",
                          borderRadius: 3,
                          color: "#f0f0f2",
                          fontSize: 11,
                          fontFamily: "inherit",
                          boxSizing: "border-box",
                        }}
                      />
                    ) : (
                      <div style={{ display: "flex", gap: 8 }}>
                        {/* 缩略图 */}
                        <div
                          style={{
                            width: 80,
                            height: 48,
                            borderRadius: 4,
                            overflow: "hidden",
                            flexShrink: 0,
                            background: "rgba(255,255,255,.04)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <img
                            key={c.id + "-" + (thumbnailVersions[c.id] || 0)}
                            src={getThumbnailUrl(c.id)}
                            alt=""
                            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                            onError={(e) => {
                              const el = e.currentTarget;
                              el.style.display = "none";
                              const ph = el.parentElement?.querySelector(".thumb-ph") as HTMLElement | null;
                              if (ph) ph.style.display = "flex";
                            }}
                            onLoad={(e) => {
                              const el = e.currentTarget;
                              el.style.display = "block";
                              const ph = el.parentElement?.querySelector(".thumb-ph") as HTMLElement | null;
                              if (ph) ph.style.display = "none";
                            }}
                          />
                          <div
                            className="thumb-ph"
                            style={{
                              display: "none",
                              width: "100%",
                              height: "100%",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 9,
                              color: "#5a5a62",
                            }}
                          >
                            {t("editor.canvas.list.noPreview")}
                          </div>
                        </div>
                        {/* 信息列 */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 12,
                              color: isCurrent ? "#9aa4ff" : "#f0f0f2",
                              fontWeight: isCurrent ? 600 : 400,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {c.name}
                          </div>
                          <div style={{ fontSize: 10, color: "#5a5a62", marginTop: 2 }}>
                            {t("editor.canvas.list.counts", { nodes: c.nodeCount, edges: c.edgeCount })}
                          </div>
                          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleStartRename(c); }}
                              style={{ ...btn, padding: "2px 6px", fontSize: 10 }}
                            >
                              {t("editor.canvas.action.rename")}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleExportCanvas(c.id, c.name); }}
                              style={{ ...btn, padding: "2px 6px", fontSize: 10 }}
                            >
                              {t("editor.canvas.action.export")}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRequestDelete(c.id); }}
                              style={{ ...btnDanger, padding: "2px 6px", fontSize: 10 }}
                            >
                              {t("editor.canvas.action.delete")}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          {migratedFromLocalStorage ? (
            <div style={{ padding: 8, fontSize: 10, color: "#4ade80", borderTop: "1px solid rgba(255,255,255,.06)" }}>
              {t("editor.canvas.storage.migrated")}
            </div>
          ) : null}
          {storageCheck ? (
            <div
              style={{
                padding: 8,
                fontSize: 10,
                color: storageCheck.ok ? "#4ade80" : "#fb7185",
                borderTop: "1px solid rgba(255,255,255,.06)",
                lineHeight: 1.5,
                wordBreak: "break-all",
              }}
            >
              <div>
                {storageCheck.ok
                  ? t("editor.canvas.storage.passedFiles", { checked: storageCheck.checkedFiles, total: storageCheck.canvasCount })
                  : t("editor.canvas.storage.failedFiles", { issues: storageCheck.issues.length, checked: storageCheck.checkedFiles, total: storageCheck.canvasCount })}
              </div>
              {!storageCheck.ok && storageCheck.issues.length > 0 ? (
                <div style={{ marginTop: 4, color: "#fda4af" }}>
                  {storageCheck.issues.slice(0, 2).join("；")}
                </div>
              ) : null}
            </div>
          ) : null}
          {errorMsg ? (
            <div style={{ padding: 8, fontSize: 10, color: "#fb7185", borderTop: "1px solid rgba(255,255,255,.06)" }}>
              {errorMsg}
            </div>
          ) : null}
        </div>

        {/* 中间：画布 */}
        <div
          className="canvas-editor-stage"
          onDoubleClickCapture={(event) => {
            const target = event.target as HTMLElement;
            const pane = target.closest(".react-flow__pane");
            const interactiveTarget = target.closest(
              ".react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, .canvas-empty-guide, button, input, textarea",
            );
            if (!pane || interactiveTarget) return;
            event.preventDefault();
            event.stopPropagation();
            const rawPosition = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            const flowPosition = {
              x: Math.round(rawPosition.x / CANVAS_SNAP_GRID[0]) * CANVAS_SNAP_GRID[0],
              y: Math.round(rawPosition.y / CANVAS_SNAP_GRID[1]) * CANVAS_SNAP_GRID[1],
            };
            setNodeSearchOpen(false);
            setConnectDropMenu(null);
            setQuickAddMenu({
              screenX: Math.max(12, Math.min(event.clientX, window.innerWidth - 252)),
              screenY: Math.max(12, Math.min(event.clientY, window.innerHeight - 224)),
              flowPosition,
            });
            window.getSelection()?.removeAllRanges();
            window.requestAnimationFrame(() => window.getSelection()?.removeAllRanges());
          }}
        >
          {errorMsg && currentCanvasId ? (
            <div className="canvas-stage-alert" role="status">
              <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" /><path d="M9 6v4M9 12.5v.1" /></svg>
              <span>{errorMsg}</span>
              <button type="button" onClick={() => setErrorMsg(null)} aria-label={t("editor.canvas.action.closeNotice")}>{t("editor.canvas.action.close")}</button>
            </div>
          ) : null}
          {loadingList || loadingCanvas ? (
            <div className="canvas-stage-state is-loading">
              <div className="canvas-stage-state-graphic" aria-hidden="true">
                <span className="canvas-stage-state-node one" />
                <span className="canvas-stage-state-node two" />
                <span className="canvas-stage-state-node three" />
                <i className="canvas-stage-state-line first" />
                <i className="canvas-stage-state-line second" />
              </div>
              <strong>{loadingCanvas ? t("editor.canvas.status.loading") : t("editor.canvas.status.preparing")}</strong>
              <p>{t("editor.canvas.status.readyHint")}</p>
            </div>
          ) : currentCanvasId ? (
            <CanvasNodeUiContext.Provider value={nodeUiActions}>
            <CanvasCreativeRail alwaysVisible={uiSettings.creativeRailAlwaysVisible} active={creativePanel?.kind as CreativeAction|undefined} english={locale==="en-US"} onAction={kind=>{if(currentCanvasId)setCreativePanel({canvasId:currentCanvasId,kind});}} />
          <ReactFlow
              key={currentCanvasId}
              nodes={nodes}
              edges={edges}
              defaultViewport={canvasViewport}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnectStart={(event, params) => {
                connectionCompletedRef.current = false;
                const eventPoint = "touches" in event ? event.touches[0] : event;
                const handleElement = event.target instanceof Element
                  ? event.target.closest<HTMLElement>(".react-flow__handle")
                  : null;
                const handleRect = handleElement?.getBoundingClientRect();
                connectionStartRef.current = params.nodeId && params.handleType ? {
                  nodeId: params.nodeId,
                  handleId: params.handleId || null,
                  handleType: params.handleType,
                  startX: handleRect ? handleRect.left + handleRect.width / 2 : eventPoint?.clientX || 0,
                  startY: handleRect ? handleRect.top + handleRect.height / 2 : eventPoint?.clientY || 0,
                } : null;
                setConnectDropMenu(null);
              }}
              onConnect={(connection) => {
                connectionCompletedRef.current = true;
                onConnect(connection);
              }}
              onConnectEnd={(event) => {
                const origin = connectionStartRef.current;
                const completed = connectionCompletedRef.current;
                connectionStartRef.current = null;
                connectionCompletedRef.current = false;
                if (!origin || completed) return;
                const point = "changedTouches" in event ? event.changedTouches[0] : event;
                if (!point) return;
                const elementAtDrop = document.elementFromPoint(point.clientX, point.clientY);
                if (elementAtDrop?.closest(".react-flow__node")) return;
                const flowPosition = reactFlowInstance.screenToFlowPosition({ x: point.clientX, y: point.clientY });
                suppressNextPaneClickRef.current = true;
                window.setTimeout(() => { suppressNextPaneClickRef.current = false; }, 0);
                setQuickAddMenu(null);
                setNodeContextMenu(null);
                setComposerNodeId(null);
                setConnectDropMenu({
                  screenX: Math.max(12, Math.min(point.clientX + 12, window.innerWidth - 258)),
                  screenY: Math.max(12, Math.min(point.clientY + 12, window.innerHeight - 390)),
                  flowPosition,
                  dropPoint: { x: point.clientX, y: point.clientY },
                  origin,
                });
              }}
              isValidConnection={isValidCanvasConnection}
              onPaneClick={() => {
                if (suppressNextPaneClickRef.current) return;
                setQuickAddMenu(null);
                setConnectDropMenu(null);
                setNodeContextMenu(null);
                setComposerNodeId(null);
                setInspectorNodeId(null);
              }}
              onNodeClick={(event, node) => {
                if (event.shiftKey) return;
                const capabilities = getCanvasNodeCapabilities(node.data);
                if (capabilities.composerMode === "contextual") openNodeComposer(node.id);
                else {
                  selectSingleNode(node.id);
                  setComposerNodeId(null);
                }
              }}
              onNodeContextMenu={(event, node) => {
                event.preventDefault();
                setQuickAddMenu(null);
                setConnectDropMenu(null);
                setComposerNodeId(null);
                selectSingleNode(node.id);
                setNodeContextMenu({
                  nodeId: node.id,
                  screenX: Math.max(12, Math.min(event.clientX, window.innerWidth - 276)),
                  screenY: Math.max(12, Math.min(event.clientY, window.innerHeight - 420)),
                });
              }}
              onSelectionChange={({ nodes: selNodes }) => {
                const newIds = selNodes.map((n) => n.id);
                // 相等性检查：内容相同返回 prev（相同引用），避免每次回调都创建新数组
                // 触发无限重渲染循环（→ 黑屏）
                setSelectedNodeIds((prev) => {
                  if (selectedCanvasIdsEqual(prev, newIds)) {
                    return prev;
                  }
                  return newIds;
                });
              }}
              onNodeDragStart={() => {
                flushEditHistory(); // 拖拽前先入栈 pending 编辑，保证时间顺序（问题 B）
                const canvasId = currentCanvasIdRef.current;
                dragSnapshotRef.current = canvasId ? createCanvasHistorySnapshot({
                  canvasId,
                  nodes: nodesRef.current,
                  edges: edgesRef.current,
                  generationHistory: generationHistoryRef.current,
                }) : null;
              }}
              onNodeDragStop={() => {
                if (!dragSnapshotRef.current) return;
                const snap = dragSnapshotRef.current;
                const moved = snap.nodes.some((sn) => {
                  const cur = nodesRef.current.find((n) => n.id === sn.id);
                  return cur && (cur.position.x !== sn.position.x || cur.position.y !== sn.position.y);
                });
                if (moved && snap.canvasId === currentCanvasIdRef.current) {
                  pastRef.current = appendCanvasHistoryEntry(pastRef.current, snap);
                  futureRef.current = [];
                  setHistoryVersion((v) => v + 1);
                }
                dragSnapshotRef.current = null;
              }}
              onMoveEnd={(_, viewport) => {
                const nextViewport = normalizeCanvasViewport(viewport);
                const previous = canvasViewport;
                if (previous.x === nextViewport.x && previous.y === nextViewport.y && previous.zoom === nextViewport.zoom) return;
                viewportRef.current = nextViewport;
                setCanvasViewport(nextViewport);
                markDirty();
              }}
              onViewportChange={(viewport) => {
                viewportRef.current = normalizeCanvasViewport(viewport);
              }}
              nodeTypes={nodeTypes}
              minZoom={0.08}
              maxZoom={2.4}
              snapToGrid={uiSettings.snapToGrid}
              snapGrid={CANVAS_SNAP_GRID}
              zoomOnScroll
              zoomOnPinch
              zoomOnDoubleClick={false}
              connectionRadius={56}
              panOnDrag={[1]}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              proOptions={{ hideAttribution: true }}
              onlyRenderVisibleElements={nodes.length > 100}
            >
              {uiSettings.showGrid ? (
                <Background
                  gap={CANVAS_SNAP_GRID}
                  size={1.55}
                  color="var(--theme-canvas-grid)"
                  variant={BackgroundVariant.Dots}
                />
              ) : null}
              {nodes.length === 0 ? (
                <Panel position="top-center" className="canvas-empty-guide">
                  <div className="canvas-empty-guide-copy">
                    <span className="canvas-empty-guide-trigger">
                      <svg viewBox="0 0 18 18"><path d="M4 3l10 6-4.2 1.2L7.5 15Z" /></svg>
                      {t("editor.canvas.empty.click")}
                    </span>
                    <strong>{t("editor.canvas.empty.title")}</strong>
                  </div>
                  <div className="canvas-empty-guide-actions">
                    <button type="button" onClick={() => addNode("text", undefined, getViewportCreatePosition("text"))}>
                      <ToolIcon type="text" />
                      <span>{t("editor.canvas.type.text")}</span>
                    </button>
                    <button type="button" onClick={openAssetPicker}>
                      <ToolIcon type="asset" />
                      <span>{t("editor.canvas.type.material")}</span>
                    </button>
                    <button type="button" onClick={openNotePicker}>
                      <ToolIcon type="note" />
                      <span>{t("editor.canvas.type.note")}</span>
                    </button>
                    <button type="button" onClick={() => addGeneratorNode("image", undefined, getViewportCreatePosition("generator"))}>
                      <ToolIcon type="image" />
                      <span>{t("editor.canvas.toolbar.imageGenerate")}</span>
                    </button>
                    <button type="button" onClick={() => addGeneratorNode("video", undefined, getViewportCreatePosition("generator"))}>
                      <ToolIcon type="video" />
                      <span>{t("editor.canvas.toolbar.videoGenerate")}</span>
                    </button>
                  </div>
                </Panel>
              ) : null}
              <Panel position="bottom-left" className="canvas-controls">
                <button
                  type="button"
                  title={minimapVisible ? t("editor.canvas.controls.mapCollapse") : t("editor.canvas.controls.mapExpand")}
                  aria-label={t("editor.canvas.controls.map")}
                  data-tooltip={minimapVisible ? t("editor.canvas.controls.mapCollapse") : t("editor.canvas.controls.mapExpand")}
                  onClick={() => setMinimapVisible((v) => !v)}
                >
                  <ToolIcon type={minimapVisible ? "minimapOff" : "minimap"} />
                </button>
                <button
                  type="button"
                  title={t("editor.canvas.controls.fit")}
                  aria-label={t("editor.canvas.controls.fit")}
                  data-tooltip={t("editor.canvas.controls.fit")}
                  onClick={() => reactFlowInstance?.fitView({ padding: 0.2, duration: 400 })}
                >
                  <ToolIcon type="fitView" />
                </button>
                <button
                  type="button"
                  title={t("editor.canvas.controls.arrange")}
                  aria-label={t("editor.canvas.controls.arrange")}
                  data-tooltip={t("editor.canvas.controls.arrange")}
                  disabled={nodes.length < 2}
                  onClick={arrangeCanvas}
                >
                  <ToolIcon type="arrange" />
                </button>
                <button
                  type="button"
                  title={t("editor.canvas.controls.zoomOut")}
                  aria-label={t("editor.canvas.controls.zoomOut")}
                  data-tooltip={t("editor.canvas.controls.zoomOut")}
                  onClick={() => reactFlowInstance?.zoomOut({ duration: 200 })}
                >
                  <ToolIcon type="zoomOut" />
                </button>
                <button
                  type="button"
                  title={t("editor.canvas.controls.center")}
                  aria-label={t("editor.canvas.controls.center")}
                  data-tooltip={t("editor.canvas.controls.center")}
                  disabled={!selectedNodeId}
                  onClick={() => {
                    if (!selectedNodeId || !reactFlowInstance) return;
                    centerNodeByAbsoluteBounds(selectedNodeId, 400, reactFlowInstance.getZoom());
                  }}
                >
                  <ToolIcon type="center" />
                </button>
                <button
                  type="button"
                  title={t("editor.canvas.controls.zoomIn")}
                  aria-label={t("editor.canvas.controls.zoomIn")}
                  data-tooltip={t("editor.canvas.controls.zoomIn")}
                  onClick={() => reactFlowInstance?.zoomIn({ duration: 200 })}
                >
                  <ToolIcon type="zoomIn" />
                </button>
              </Panel>
              {minimapVisible && nodes.length < 500 && (
                <MiniMap
                  pannable
                  zoomable
                  position="bottom-left"
                  maskColor="var(--theme-canvas-mask)"
                  nodeColor={(node) => NODE_STROKE[((node.data as SpikeNodeData | undefined)?.kind || "text") as NodeKind] || "rgba(124,138,255,.7)"}
                  nodeStrokeColor="var(--theme-border-strong)"
                  style={{
                    width: 200,
                    height: 149,
                    marginLeft: 28,
                    marginBottom: 58,
                    borderRadius: 12,
                    border: "1px solid var(--theme-border-strong)",
                    background: "var(--theme-glass-bg)",
                    boxShadow: "var(--theme-shadow-md)",
                  }}
                />
              )}
            </ReactFlow>
            </CanvasNodeUiContext.Provider>
          ) : (
            <div
              className={`canvas-stage-state ${errorMsg ? "is-error" : ""}`}
              role={errorMsg ? "alert" : "status"}
              aria-live={errorMsg ? "assertive" : "polite"}
              aria-atomic="true"
            >
              <div className="canvas-stage-state-icon" aria-hidden="true">
                {errorMsg ? (
                  <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" /><path d="M9 6v4M9 12.5v.1" /></svg>
                ) : (
                  <svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="2" /><path d="M6 7h2v2H6zM10 9h2v2h-2zM8 8l2 2" /></svg>
                )}
              </div>
              <strong>{errorMsg ? t("editor.canvas.status.unavailable") : t("editor.canvas.status.preparingCanvas")}</strong>
              <p>{errorMsg || t("editor.canvas.status.autoOpen")}</p>
            </div>
          )}
          {quickAddMenu ? (
            <div
              className="canvas-quick-add-menu"
              style={{ left: quickAddMenu.screenX, top: quickAddMenu.screenY }}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <div className="canvas-quick-add-title">{t("editor.canvas.quickAdd.title")}</div>
              <button type="button" onClick={() => { addGeneratorNode("image", undefined, quickAddMenu.flowPosition); setQuickAddMenu(null); }}>
                <span><ToolIcon type="image" /></span>
                <div><strong>{t("editor.canvas.toolbar.imageGenerate")}</strong><small>{t("editor.canvas.quickAdd.imageHint")}</small></div>
              </button>
              <button type="button" onClick={() => { addGeneratorNode("video", undefined, quickAddMenu.flowPosition); setQuickAddMenu(null); }}>
                <span><ToolIcon type="video" /></span>
                <div><strong>{t("editor.canvas.toolbar.videoGenerate")}</strong><small>{t("editor.canvas.quickAdd.videoHint")}</small></div>
              </button>
              <button type="button" onClick={() => createQuickNode("text")}>
                <span><ToolIcon type="text" /></span>
                <div><strong>{t("editor.canvas.type.text")}</strong><small>{t("editor.canvas.quickAdd.textHint")}</small></div>
              </button>
              <button type="button" onClick={() => { openAssetPickerAtPosition(quickAddMenu.flowPosition); setQuickAddMenu(null); }}>
                <span><ToolIcon type="asset" /></span>
                <div><strong>{t("editor.canvas.toolbar.referenceMaterial")}</strong><small>{t("editor.canvas.quickAdd.materialHint")}</small></div>
              </button>
              <button type="button" onClick={() => { openNotePickerAtPosition(quickAddMenu.flowPosition); setQuickAddMenu(null); }}>
                <span><ToolIcon type="note" /></span>
                <div><strong>{t("editor.canvas.toolbar.referenceKnowledge")}</strong><small>{t("editor.canvas.quickAdd.noteHint")}</small></div>
              </button>
            </div>
          ) : null}
          {connectDropMenu ? (
            <>
              <svg className="canvas-pending-connection" aria-hidden="true">
                <path d={pendingConnectionPath(
                  connectDropMenu.origin.startX,
                  connectDropMenu.origin.startY,
                  connectDropMenu.dropPoint.x,
                  connectDropMenu.dropPoint.y,
                  connectDropMenu.origin.handleType,
                )} />
              </svg>
              <div
                className="canvas-quick-add-menu canvas-connect-drop-menu"
                style={{ left: connectDropMenu.screenX, top: connectDropMenu.screenY }}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
              >
              <div className="canvas-quick-add-title">{connectMenuAddsContext ? t("editor.canvas.connect.addContext") : t("editor.canvas.connect.generateFromNode")}</div>
              <button type="button" onClick={() => createConnectedNode("text")}>
                <span><ToolIcon type="text" /></span>
                <div><strong>{t("editor.canvas.connect.textGenerate")}</strong><small>{connectMenuAddsContext ? t("editor.canvas.connect.textContextHint") : t("editor.canvas.connect.textGenerateHint")}</small></div>
              </button>
              {connectMenuAddsContext ? (
                <>
                  {connectMenuContentKind !== "text" ? (
                    <button type="button" onClick={() => createConnectedNode("imageGenerator")}>
                      <span><ToolIcon type="image" /></span>
                      <div><strong>{t("editor.canvas.connect.imageProcess")}</strong><small>{t("editor.canvas.connect.imageProcessHint")}</small></div>
                    </button>
                  ) : null}
                  {connectMenuContentKind === "video" ? (
                    <button type="button" disabled title={t("editor.canvas.connect.audioUnavailable")}>
                      <span><ToolIcon type="audio" /></span>
                      <div><strong>{t("editor.canvas.connect.audioGenerate")}</strong><small>{t("editor.canvas.connect.comingSoon")}</small></div>
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  {connectMenuContentKind !== "video" ? (
                    <button type="button" onClick={() => createConnectedNode("imageGenerator")}>
                      <span><ToolIcon type="image" /></span>
                      <div><strong>{t("editor.canvas.toolbar.imageGenerate")}</strong><small>{t("editor.canvas.connect.imageReferenceHint")}</small></div>
                    </button>
                  ) : null}
                  <button type="button" onClick={() => createConnectedNode("videoGenerator")}>
                    <span><ToolIcon type="video" /></span>
                    <div><strong>{t("editor.canvas.toolbar.videoGenerate")}</strong><small>{t("editor.canvas.connect.videoReferenceHint")}</small></div>
                  </button>
                  {connectMenuContentKind === "image" ? (
                    <>
                      <button type="button" onClick={() => createConnectedNode("imageEditor")}>
                        <span><ToolIcon type="image" /></span>
                        <div><strong>{t("editor.canvas.connect.imageEdit")}</strong><small>{t("editor.canvas.connect.imageEditHint")}</small></div>
                      </button>
                      <button type="button" onClick={() => createConnectedNode("script")}>
                        <span><ToolIcon type="text" /></span>
                        <div><strong>{t("editor.canvas.connect.script")}</strong><small>{t("editor.canvas.connect.scriptHint")}</small></div>
                      </button>
                    </>
                  ) : null}
                  {connectMenuContentKind === "video" ? (
                    <button type="button" onClick={() => createConnectedNode("videoEditor")}>
                      <span><ToolIcon type="video" /></span>
                      <div><strong>{t("editor.canvas.connect.videoEdit")}</strong><small>{t("editor.canvas.connect.videoEditHint")}</small></div>
                    </button>
                  ) : null}
                  {connectMenuContentKind === "text" ? (
                    <button type="button" disabled title={t("editor.canvas.connect.audioUnavailable")}>
                      <span><ToolIcon type="audio" /></span>
                      <div><strong>{t("editor.canvas.connect.audio")}</strong><small>{t("editor.canvas.connect.comingSoon")}</small></div>
                    </button>
                  ) : null}
                </>
              )}
              </div>
            </>
          ) : null}
          {nodeSaveNotice ? <div className="canvas-node-save-notice" role="status">{nodeSaveNotice}<button type="button" aria-label="关闭" onClick={()=>setNodeSaveNotice("")}>×</button></div> : null}
          {nodeContextMenu && contextMenuNode ? (
            <div
              className="canvas-quick-add-menu canvas-node-context-menu"
              style={{ left: nodeContextMenu.screenX, top: nodeContextMenu.screenY }}
              onPointerDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className="canvas-quick-add-title canvas-node-context-title">{t("editor.canvas.context.title")}</div>
              {(["primary", "manage"] as const).map((group, groupIndex) => {
                const groupCommands = contextMenuCommands.filter((command) => command.group === group);
                if (groupCommands.length === 0) return null;
                return (
                  <div className={`canvas-node-context-group is-${group}`} key={group}>
                    {groupIndex > 0 ? <div className="canvas-node-context-divider" /> : null}
                    {groupCommands.map((command) => (
                      <button
                        type="button"
                        key={command.id}
                        data-command-id={command.id}
                        className={command.tone === "danger" ? "danger" : undefined}
                        disabled={!command.enabled}
                        onClick={() => runNodeCommand(command.id, nodeContextMenu.nodeId)}
                      >
                        <span><CanvasNodeCommandIcon command={command} /></span>
                        <div><strong>{command.label}</strong><small>{command.hint}</small></div>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* 右侧：节点属性（单选显示详情；多选显示批量操作） */}
        {selectedNodeHasComposer && selectedNode && materialInspectorPortal?.nodeId === selectedNode.id
          ? createPortal(
            <div
              className="canvas-material-composer-dock nodrag nopan nowheel"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <MaterialCompactComposer
                node={selectedNode}
                onDataChange={updateSelectedData}
                onAddReference={(role) => openGeneratorAssetPicker(selectedNode.id, role)}
                connectedInputs={getIncomingGenerationInputs(selectedNode.id)}
                canvasReferenceCandidates={getCanvasReferenceCandidates(selectedNode.id)}
                onSelectCanvasReference={(candidate, role) => addCanvasReference(selectedNode.id, candidate, role)}
                onConnectedRoleChange={updateIncomingEdgeRole}
                onRemoveConnectedInput={removeIncomingEdge}
                onMoveConnectedInput={moveIncomingEdge}
                onSubmit={() => submitGenerationFromNode(selectedNode.id)}
                textModels={aiRuntimeConfig.models}
                textModelsReady={aiRuntimeConfig.ready}
                textProviderLabel={aiRuntimeConfig.providerLabel}
                imageModels={aiRuntimeConfig.imageModels}
                defaultImageModel={aiRuntimeConfig.imageModel}
                videoModels={aiRuntimeConfig.videoModels}
                defaultVideoModel={aiRuntimeConfig.videoModel}
                mediaProfile={activeMediaProfile}
              />
            </div>,
            materialInspectorPortal.element,
          )
          : null}

        {/* 详情不再跟随普通左键选择，只从节点右键菜单显式打开。 */}
        {inspectorNode ? (
          (inspectorNode.data.kind === "image" || inspectorNode.data.kind === "video") && uiSettings.fanInspector ? (
            <MaterialGenerationInspector
              mediaProfile={activeMediaProfile}
              node={inspectorNode}
              onDataChange={updateSelectedData}
              onOpenReference={openSelectedReference}
            />
          ) : (
            <NodeInspector
              node={inspectorNode}
              onLabelChange={updateSelectedLabel}
              onPayloadChange={updateSelectedPayload}
              onOpenReference={openSelectedReference}
              onCreateGenerator={addGeneratorNode}
              onRunAI={runSelectedAI}
              aiRunning={runningAiNodeId === inspectorNode.id}
            />
          )
        ) : null}

        {creativePanel && creativePanel.canvasId===currentCanvasId && !loadingCanvas ? (
          creativePanel.kind==='review' ? <CanvasVersionReview key={currentCanvasId+'review'} history={generationHistory} initialId={creativePanel.initialId} resolveUrl={url=>resolveCanvasMediaUrl(url)||''} onPick={pickReviewImage} onRestore={restoreGenerationHistoryResult} onClose={()=>setCreativePanel(null)} english={locale==='en-US'} />
          : creativePanel.kind==='editImage' ? <CanvasImageTools key={currentCanvasId+'image-tools'} item={deliveryItems.length===1&&deliveryItems[0].kind==='image'?deliveryItems[0]:undefined} onSave={saveEditedImage} onClose={()=>setCreativePanel(null)} english={locale==='en-US'} />
          : creativePanel.kind==='export' ? <CanvasDeliveryPanel key={currentCanvasId+'delivery'} items={deliveryItems} onSave={saveMediaArchive} onClose={()=>setCreativePanel(null)} english={locale==='en-US'} />
          : creativePanel.kind==='workflows' ? <CanvasWorkflowLibrary key={currentCanvasId+'workflows'} selectionCount={selectedNodeIds.length} onInsert={insertWorkflow} onExport={exportWorkflow} onClose={()=>setCreativePanel(null)} english={locale==='en-US'} />
          : <CanvasReferencePacks key={currentCanvasId+'packs'} nodes={nodes} edges={edges} selectedIds={selectedNodeIds} resolveUrl={url=>resolveCanvasMediaUrl(url)||''} onCreate={createReferencePack} onRename={editReferencePack} onUnmark={id=>editReferencePack(id)} onApply={applyReferencePack} onLocate={id=>centerNodeByAbsoluteBounds(id,360,Math.max(reactFlowInstance.getZoom(),.9))} onClose={()=>setCreativePanel(null)} english={locale==='en-US'} />
        ) : null}

        {/* 素材/笔记选择器 */}
        {showAssetPicker ? (
          <Picker
            title={assetPickerMediaKind === "video" ? t("editor.canvas.picker.selectVideo") : assetPickerMediaKind === "image" ? t("editor.canvas.picker.selectImage") : t("editor.canvas.picker.selectMaterial")}
            variant="asset"
            items={assets}
            loading={pickerLoading}
            onPick={pickAsset}
            onImport={bridge?.importAssets ? importAssetFromPicker : undefined}
            onClose={() => {
              setShowAssetPicker(false);
              setAssetPickerTargetNodeId(null);
              setAssetPickerTargetRole(null);
              setAssetPickerReplaceNodeId(null);
              setAssetPickerMediaKind(null);
              setPickerCreatePosition(null);
            }}
            renderItem={(it: any) => it.name || t("editor.canvas.picker.untitledMaterial")}
            emptyText={t("editor.canvas.picker.emptyMaterials")}
          />
        ) : null}
        {showNotePicker ? (
          <Picker
            title={t("editor.canvas.picker.selectNote")}
            variant="note"
            items={notes}
            loading={pickerLoading}
            onPick={pickNote}
            onClose={() => { setShowNotePicker(false); setPickerCreatePosition(null); }}
            renderItem={(it: any) => it.title || t("editor.canvas.picker.untitled")}
            emptyText={t("editor.canvas.picker.emptyKnowledge")}
          />
        ) : null}

        {createCanvasOpen ? (
          <div
            className="canvas-modal-backdrop"
            onClick={() => setCreateCanvasOpen(false)}
            role="presentation"
          >
            <div
              className="canvas-modal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={t("editor.canvas.dialog.new")}
            >
              <div className="canvas-modal-header">
                <span className="canvas-modal-icon">
                  <svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="2" /><path d="M9 6v6M6 9h6" /></svg>
                </span>
                <div>
                  <div className="canvas-modal-kicker">{t("editor.canvas.dialog.canvas")}</div>
                  <div className="canvas-modal-title">{t("editor.canvas.dialog.new")}</div>
                </div>
              </div>
              <div className="canvas-modal-body">
                <label className="canvas-modal-field">
                  <span>{t("editor.canvas.dialog.name")}</span>
                  <input
                    autoFocus
                    value={createCanvasName}
                    onChange={(event) => setCreateCanvasName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleConfirmCreateCanvas();
                      if (event.key === "Escape") setCreateCanvasOpen(false);
                    }}
                    placeholder={t("editor.canvas.dialog.namePlaceholder")}
                  />
                </label>
                <p className="canvas-modal-note">{t("editor.canvas.dialog.createHint")}</p>
              </div>
              <div className="canvas-modal-actions">
                <button className="canvas-modal-button" onClick={() => setCreateCanvasOpen(false)}>{t("common.action.cancel")}</button>
                <button className="canvas-modal-button primary" onClick={() => void handleConfirmCreateCanvas()}>{t("editor.canvas.dialog.create")}</button>
              </div>
            </div>
          </div>
        ) : null}

        {returnConfirmMessage ? (
          <div
            className="canvas-modal-backdrop"
            onClick={() => setReturnConfirmMessage(null)}
            role="presentation"
          >
            <div
              className="canvas-modal wide"
              onClick={(e) => e.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
              aria-label={t("editor.canvas.dialog.returnFailed")}
            >
              <div className="canvas-modal-header">
                <span className="canvas-modal-icon warning">
                  <svg viewBox="0 0 18 18"><path d="M9 3l6 11H3Z" /><path d="M9 7v3M9 12.5v.1" /></svg>
                </span>
                <div>
                  <div className="canvas-modal-kicker">{t("editor.canvas.dialog.saveReminder")}</div>
                  <div className="canvas-modal-title">{t("editor.canvas.dialog.returnFailed")}</div>
                </div>
              </div>
              <div className="canvas-modal-body">
                <p className="canvas-modal-message">{returnConfirmMessage}</p>
                <p className="canvas-modal-note">{t("editor.canvas.dialog.returnBackup")}</p>
              </div>
              <div className="canvas-modal-actions">
                <button className="canvas-modal-button" onClick={() => setReturnConfirmMessage(null)}>{t("editor.canvas.dialog.stay")}</button>
                <button className="canvas-modal-button danger" onClick={returnToLuckyRay}>{t("editor.canvas.dialog.returnAnyway")}</button>
              </div>
            </div>
          </div>
        ) : null}

        {/* 删除确认 */}
        {confirmDeleteId ? (
          <div
            className="canvas-modal-backdrop"
            onClick={handleCancelDelete}
            role="presentation"
          >
            <div
              className="canvas-modal"
              onClick={(e) => e.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
              aria-label={t("editor.canvas.dialog.deleteAria")}
            >
              <div className="canvas-modal-header">
                <span className="canvas-modal-icon danger"><ToolIcon type="delete" /></span>
                <div>
                  <div className="canvas-modal-kicker">{t("editor.canvas.dialog.danger")}</div>
                  <div className="canvas-modal-title">{t("editor.canvas.dialog.deleteTitle")}</div>
                </div>
              </div>
              <div className="canvas-modal-body">
                <p className="canvas-modal-message">{t("editor.canvas.dialog.deleteMessage")}</p>
                <p className="canvas-modal-note">{t("editor.canvas.dialog.deleteHint")}</p>
              </div>
              <div className="canvas-modal-actions">
                <button className="canvas-modal-button" onClick={handleCancelDelete}>{t("common.action.cancel")}</button>
                <button className="canvas-modal-button danger" onClick={handleConfirmDelete}>{t("editor.canvas.dialog.delete")}</button>
              </div>
            </div>
          </div>
        ) : null}
        {selectedNodeIds.length > 1 || canUngroupSelectedNodes ? (
          <div className="canvas-multi-selection-bar nodrag nopan" data-tauri-no-drag="true">
            <span>{canUngroupSelectedNodes && selectedNodeIds.length === 1 ? t("editor.canvas.selection.groupSelected") : t("editor.canvas.selection.nodes", { count: selectedNodeIds.length })}</span>
            <i />
            {canGroupSelectedNodes ? <button type="button" onClick={groupSelectedNodes}><ToolIcon type="group" />{t("editor.canvas.selection.group")}</button> : null}
            {canUngroupSelectedNodes ? <button type="button" onClick={ungroupSelectedNodes}><ToolIcon type="ungroup" />{t("editor.canvas.selection.ungroup")}</button> : null}
            {!canUngroupSelectedNodes ? <button type="button" onClick={alignSelectedLeft} disabled={!canTransformSelectedNodes || selectedNodeIds.length < 2} title={!canTransformSelectedNodes ? t("editor.canvas.selection.sameSpace") : undefined}>{t("editor.canvas.selection.alignLeft")}</button> : null}
            {!canUngroupSelectedNodes ? <button type="button" onClick={distributeSelectedHorizontal} disabled={!canTransformSelectedNodes || selectedNodeIds.length < 3} title={!canTransformSelectedNodes ? t("editor.canvas.selection.sameSpace") : undefined}>{t("editor.canvas.selection.distribute")}</button> : null}
            <button type="button" onClick={duplicateSelected}><ToolIcon type="duplicate" />{t("editor.canvas.selection.copy")}</button>
            <button type="button" className="danger" onClick={deleteSelectedNode}><ToolIcon type="delete" />{t("editor.canvas.selection.delete")}</button>
          </div>
        ) : null}
      </div>

      {/* 轻量画布状态 HUD：不再占用整条底部空间 */}
      <div className="canvas-editor-status" aria-label={t("editor.canvas.status.aria")}>
        <span><strong>{nodes.length}</strong> {t("editor.canvas.status.nodes")}</span>
        <i />
        <span><strong>{edges.length}</strong> {t("editor.canvas.status.edges")}</span>
        {selectedNodeIds.length > 0 ? (
          <>
            <i />
            <span className="is-selected">
              {selectedNodeIds.length === 1
                ? canvasNodeKindLabel((nodes.find((node) => node.id === selectedNodeIds[0])?.data.kind) || "text", t)
                : t("editor.canvas.selection.nodes", { count: selectedNodeIds.length })}
              <em>{t("editor.canvas.status.selected")}</em>
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

const IMAGE_GENERATION_MODELS = ["agnes-image-2.1-flash", "agnes-image-2.0-flash", "gpt-image-1"];
const VIDEO_GENERATION_MODELS = ["agnes-video-v2.0", "Kling O3", "Seedance 2"];


function inferGenerationKind(node: SpikeNode): CanvasGenerationKind {
  if (node.data.kind === "aiResult") return node.data.resultKind || "text";
  if (node.data.kind === "image" || node.data.kind === "video") return node.data.kind;
  if (node.data.generationKind) return node.data.generationKind;
  return "text";
}

function resolveTextGenerationPrompt(node: SpikeNode): string {
  const composerPrompt = node.data.generationPrompt?.trim() || "";
  if (node.data.kind === "aiResult" && node.data.resultKind === "text") {
    const currentResult = sanitizeCanvasTextGenerationOutput(node.data.result || "").trim();
    if (!currentResult) return composerPrompt;
    if (!composerPrompt) return `请基于以下当前结果继续创作：\n${currentResult}`;
    return `当前结果：\n${currentResult}\n\n继续创作要求：\n${composerPrompt}`;
  }
  if (node.data.kind !== "text") return composerPrompt;

  const cardText = TEXT_NODE_PLACEHOLDER_LABELS.has(node.data.label.trim())
    ? ""
    : node.data.label.trim();
  if (!cardText) return composerPrompt;
  if (!composerPrompt || composerPrompt === cardText) return cardText;

  return `待处理文本：\n${cardText}\n\n生成要求：\n${composerPrompt}`;
}

function createGenerationRequestSnapshot(
  node: SpikeNode,
  connectedInputs: ConnectedGenerationInput[],
  textModels: readonly string[] = [],
  defaultTextModel = "",
  imageModels: readonly string[] = [],
  defaultImageModel = "",
  videoModels: readonly string[] = [],
  defaultVideoModel = "",
  mediaProfile: CanvasMediaProfile | null = null,
  includeNoteTitles = false,
): CanvasGenerationRequestSnapshot {
  const kind = inferGenerationKind(node);
  const models = kind === "text" ? [...textModels] : kind === "video" ? [...videoModels] : [...imageModels];
  const storedReferences: GenerationReference[] = Array.isArray(node.data.generationReferences)
    ? node.data.generationReferences
    : (node.data.kind === "image" || node.data.kind === "video") && node.data.payload ? [{
        id: node.data.payload,
        label: node.data.label,
        kind: node.data.refKind || node.data.kind,
        thumbnailUrl: node.data.refThumbnailUrl,
        mediaUrl: node.data.refMediaUrl,
      }] : [];
  const occupiedRoles = new Set(connectedInputs.map((input) => input.role));
  const connectedIds = new Set(connectedInputs.map((input) => input.reference.id));
  const references: CanvasGenerationRequestSnapshot["references"] = connectedInputs.map((input) => ({
    ...input.reference,
    sourceNodeId: input.sourceNodeId,
    role: input.role,
  }));

  for (const reference of storedReferences) {
    if (connectedIds.has(reference.id)) continue;
    let role: CanvasEdgeRole = isCanvasEdgeRole(reference.role) ? reference.role : "reference";
    if (!isCanvasEdgeRole(reference.role)) {
      if (reference.kind === "text" || reference.kind === "note") role = "promptContext";
      else if (kind === "video" && reference.kind === "video") role = "videoReference";
      else if (kind === "video" && !occupiedRoles.has("firstFrame")) role = "firstFrame";
      else if (kind === "video" && !occupiedRoles.has("lastFrame")) role = "lastFrame";
    }
    occupiedRoles.add(role);
    references.push({
      ...reference,
      sourceNodeId: /^node:([^:]+)/.exec(reference.id)?.[1],
      role,
    });
  }

  const model = models.includes(node.data.generationModel || "")
    ? node.data.generationModel!
    : kind === "text" ? defaultTextModel || models[0] || ""
      : kind === "image" ? defaultImageModel || models[0] || ""
        : defaultVideoModel || models[0] || "";
  if (kind === "text") {
    const compiled = compileCanvasGenerationInputs({
      kind,
      prompt: resolveTextGenerationPrompt(node),
      references,
      includeNoteTitles,
    });
    return {
      kind,
      prompt: compiled.prompt,
      model,
      references: compiled.references,
    };
  }

  const capabilities = mediaCapabilities(kind, mediaProfile, model);
  const aspect = mediaOption(capabilities.aspects, node.data.generationAspect);
  const quality = mediaQualityOption(capabilities.qualities, node.data.generationQuality);

  const compiled = compileCanvasGenerationInputs({
    kind,
    prompt: node.data.generationPrompt?.trim() || "",
    references,
    includeNoteTitles,
  });
  return {
    kind,
    prompt: compiled.prompt,
    model,
    aspect,
    quality,
    resolution: kind === "image" && aspect !== "auto" ? mediaOption(capabilities.resolutions || [], node.data.generationResolution) : undefined,
    duration: kind === "video" ? mediaOption(capabilities.durations, node.data.generationDuration) : undefined,
    sound: kind === "video" && capabilities.sound ? !!node.data.generationSound : undefined,
    count: kind === "image" ? mediaOption(capabilities.counts, node.data.generationCount) : undefined,
    cameraStrength: kind === "video" && capabilities.camera ? Math.max(0, Math.min(100, node.data.generationCameraStrength ?? 50)) : undefined,
    references: compiled.references,
  };
}

function MaterialCompactComposer({
  node,
  onDataChange,
  onAddReference,
  connectedInputs = [],
  canvasReferenceCandidates = [],
  onSelectCanvasReference,
  onConnectedRoleChange,
  onRemoveConnectedInput,
  onMoveConnectedInput,
  onSubmit,
  textModels = [],
  textModelsReady = true,
  textProviderLabel = "",
  imageModels = IMAGE_GENERATION_MODELS,
  defaultImageModel = "",
  videoModels = VIDEO_GENERATION_MODELS,
  defaultVideoModel = "",
  mediaProfile = null,
  embedded = false,
}: {
  node: SpikeNode;
  onDataChange: (patch: Partial<SpikeNodeData>) => void;
  onAddReference: (role?: CanvasEdgeRole) => void;
  connectedInputs?: ConnectedGenerationInput[];
  canvasReferenceCandidates?: CanvasReferenceCandidate[];
  onSelectCanvasReference?: (candidate: CanvasReferenceCandidate, role: CanvasEdgeRole) => void;
  onConnectedRoleChange?: (edgeId: string, role: CanvasEdgeRole) => void;
  onRemoveConnectedInput?: (edgeId: string) => void;
  onMoveConnectedInput?: (edgeId: string, delta: number) => void;
  onSubmit?: () => void;
  textModels?: readonly string[];
  textModelsReady?: boolean;
  textProviderLabel?: string;
  imageModels?: readonly string[];
  defaultImageModel?: string;
  videoModels?: readonly string[];
  defaultVideoModel?: string;
  mediaProfile?: CanvasMediaProfile | null;
  embedded?: boolean;
}) {
  const { t, locale } = useI18n();
  const { zoom } = useViewport();
  const viewScale = embedded ? 1 : Math.min(2.25, Math.max(1, Math.pow(1 / Math.max(zoom, .1), .95)));
  const isVideo = node.data.kind === "video"
    || node.data.generationKind === "video"
    || (node.data.kind === "aiResult" && node.data.resultKind === "video");
  const isImage = node.data.kind === "image"
    || node.data.generationKind === "image"
    || (node.data.kind === "aiResult" && node.data.resultKind === "image");
  const isText = !isVideo && !isImage;
  const models = isText ? [...textModels] : isVideo ? [...videoModels] : [...imageModels];
  const model = models.includes(node.data.generationModel || "")
    ? node.data.generationModel!
    : isImage ? defaultImageModel || models[0] || node.data.generationModel || t("editor.canvas.generation.modelUnavailable")
      : isVideo ? defaultVideoModel || models[0] || node.data.generationModel || t("editor.canvas.generation.modelUnavailable")
        : models[0] || node.data.generationModel || t("editor.canvas.generation.modelUnavailable");
  const capabilities = mediaCapabilities(isVideo ? "video" : "image", mediaProfile, model);
  const qualities = capabilities.qualities;
  const resolutions = capabilities.resolutions || [];
  const resolution = mediaOption(resolutions, node.data.generationResolution);
  const parameterKind = mediaParameterKind(isVideo ? "video" : "image", mediaProfile, model);
  const imageGenerationCounts = capabilities.counts;
  const supportsSoundControl = capabilities.sound;
  const aspect = mediaOption(capabilities.aspects, node.data.generationAspect) || "";
  const quality = mediaQualityOption(qualities, node.data.generationQuality) || "";
  const duration = mediaOption(capabilities.durations, node.data.generationDuration);
  const count = mediaOption(imageGenerationCounts, node.data.generationCount) || 1;
  const cameraStrength = Math.max(0, Math.min(100, node.data.generationCameraStrength ?? 50));
  const canUsePrimaryReference = (node.data.kind === "image" || node.data.kind === "video") && !!node.data.payload;
  const storedReferences: GenerationReference[] = Array.isArray(node.data.generationReferences)
    ? node.data.generationReferences
    : canUsePrimaryReference ? [{
      id: node.data.payload!,
      label: node.data.label,
      kind: node.data.refKind || node.data.kind,
      thumbnailUrl: node.data.refThumbnailUrl,
      mediaUrl: node.data.refMediaUrl,
    }] : [];
  const connectedReferenceIds = new Set(connectedInputs.map((input) => input.reference.id));
  const references = storedReferences.filter((reference) => !connectedReferenceIds.has(reference.id));
  const inputCount = connectedInputs.length + references.length;
  const inferredStoredRoles = (() => {
    const occupied = new Set(connectedInputs.map((input) => input.role));
    return references.map((reference): CanvasEdgeRole => {
      if (isCanvasEdgeRole(reference.role)) {
        occupied.add(reference.role);
        return reference.role;
      }
      if (!isVideo) return reference.kind === "text" || reference.kind === "note" ? "promptContext" : "reference";
      if (reference.kind === "video") return "videoReference";
      if (reference.kind === "text" || reference.kind === "note") return "promptContext";
      if (!occupied.has("firstFrame")) {
        occupied.add("firstFrame");
        return "firstFrame";
      }
      if (!occupied.has("lastFrame")) {
        occupied.add("lastFrame");
        return "lastFrame";
      }
      return "reference";
    });
  })();
  const [openPanel, setOpenPanel] = useState<"model" | "settings" | null>(null);
  const [popoverDirection, setPopoverDirection] = useState<"up" | "down">("up");
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(520);
  const [focusEditorOpen, setFocusEditorOpen] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openPanel && !focusEditorOpen) return;
    const closeOverlays = (event: globalThis.PointerEvent) => {
      if (composerRef.current?.contains(event.target as globalThis.Node)) return;
      setOpenPanel(null);
      setFocusEditorOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenPanel(null);
      setFocusEditorOpen(false);
    };
    document.addEventListener("pointerdown", closeOverlays, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOverlays, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [focusEditorOpen, openPanel]);
  useEffect(() => {
    setOpenPanel(null);
    setFocusEditorOpen(false);
  }, [node.id]);
  const togglePanel = (event: ReactMouseEvent<HTMLButtonElement>, panel: "model" | "settings") => {
    setFocusEditorOpen(false);
    if (openPanel === panel) {
      setOpenPanel(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const estimatedHeight = (panel === "model" ? Math.min(420, 64 + models.length * 50) : 520) * viewScale;
    const roomAbove = Math.max(0, rect.top - 16);
    const roomBelow = Math.max(0, window.innerHeight - rect.bottom - 16);
    const direction = roomAbove >= estimatedHeight || roomAbove >= roomBelow ? "up" : "down";
    setPopoverDirection(direction);
    setPopoverMaxHeight(Math.max(80, Math.min(520, (direction === "up" ? roomAbove : roomBelow) / viewScale)));
    setOpenPanel(panel);
  };
  const commit = (patch: Partial<SpikeNodeData>) => {
    setShowHint(false);
    onDataChange(patch);
  };
  const removeReference = (index: number) => {
    commit({ generationReferences: references.filter((_, itemIndex) => itemIndex !== index) });
  };
  const roleLabel = (role: CanvasEdgeRole) => role === "firstFrame" ? t("editor.canvas.generation.firstFrame")
    : role === "lastFrame" ? t("editor.canvas.generation.lastFrame")
    : role === "videoReference" ? t("editor.canvas.type.video")
    : role === "promptContext" ? t("editor.canvas.generation.context")
    : t("editor.canvas.generation.reference");
  const unsortedReferenceEntries: ComposerReferenceEntry[] = [
    ...connectedInputs.map((input) => ({
      key: input.edgeId,
      source: "connected" as const,
      role: input.role,
      reference: input.reference,
      edgeId: input.edgeId,
    })),
    ...references.map((reference, index) => ({
      key: `stored:${reference.id}:${index}`,
      source: "stored" as const,
      role: inferredStoredRoles[index],
      reference,
      storedIndex: index,
    })),
  ];
  const referenceOrder = orderCanvasGenerationReferences(unsortedReferenceEntries.map(entry => ({...entry.reference, id: entry.key, role: entry.role}))).map(ref => ref.id);
  const referenceEntries = referenceOrder.map(key => unsortedReferenceEntries.find(entry => entry.key === key)!);
  const imageEntries = referenceEntries.filter(entry => entry.reference.kind === "image");
  const selectedCanvasReferenceNodeIds = new Set([
    ...connectedInputs.map((input) => input.sourceNodeId),
    ...references.map((reference) => /^node:([^:]+):/.exec(reference.id)?.[1]).filter((id): id is string => !!id),
  ]);
  const firstFrameEntry = referenceEntries.find((entry) => entry.role === "firstFrame");
  const lastFrameEntry = referenceEntries.find((entry) => entry.role === "lastFrame");
  const otherReferenceEntries = isVideo
    ? referenceEntries.filter((entry) => entry !== firstFrameEntry && entry !== lastFrameEntry)
    : referenceEntries;
  const renderReferenceEntry = (entry: ComposerReferenceEntry) => {
    const { reference } = entry;

    const canCycleRole = entry.source === "connected" && isVideo && reference.kind === "image" && !!onConnectedRoleChange;
    const peers = referenceEntries.filter(item => item.source === entry.source && item.role === entry.role);
    const peerIndex = peers.indexOf(entry);
    const move = (delta: number) => {
      if (entry.source === "connected") { if (entry.edgeId) onMoveConnectedInput?.(entry.edgeId, delta); return; }
      const other = peers[peerIndex + delta];
      if (!other || entry.storedIndex === undefined || other.storedIndex === undefined) return;
      const next = references.map((ref,index) => ({...ref,role: inferredStoredRoles[index]}));
      [next[entry.storedIndex], next[other.storedIndex]] = [next[other.storedIndex], next[entry.storedIndex]];
      commit({generationReferences: next});
    };
    const connectedInput = entry.source === "connected"
      ? connectedInputs.find((input) => input.edgeId === entry.edgeId)
      : null;
    return (
      <span
        className={`canvas-composer-reference-item ${entry.source === "connected" ? "is-connected" : ""}`}
        key={entry.key}
        data-reference-label={roleLabel(entry.role)}
      >
        {reference.kind === "image" || reference.kind === "video" ? <CanvasReferencePreview thumbnail={reference.thumbnailUrl} original={reference.kind === "image" ? reference.mediaUrl : undefined} label={reference.label} unavailable={locale === "en-US" ? "Unavailable" : "图片失效"} /> : <ToolIcon type="text" />}
        {reference.kind === "image" ? <b className="canvas-reference-number">{imageEntries.indexOf(entry) + 1}</b> : null}
        {peers.length > 1 && (entry.source === "stored" || onMoveConnectedInput) ? <span className="canvas-reference-order">
          <button type="button" disabled={peerIndex === 0} onClick={() => move(-1)} aria-label={t("editor.canvas.generation.moveForward")}>‹</button>
          <button type="button" disabled={peerIndex === peers.length - 1} onClick={() => move(1)} aria-label={t("editor.canvas.generation.moveBack")}>›</button>
        </span> : null}
        {entry.source === "connected" && canCycleRole ? (
          <button
            type="button"
            className="canvas-composer-reference-role is-switchable"
            onClick={() => connectedInput && cycleConnectedRole(connectedInput)}
            aria-label={t("editor.canvas.generation.switchRole", { label: reference.label, role: roleLabel(entry.role) })}
          />
        ) : null}
        <button
          type="button"
          className="canvas-composer-reference-remove"
          onClick={() => entry.source === "connected"
            ? entry.edgeId && onRemoveConnectedInput?.(entry.edgeId)
            : typeof entry.storedIndex === "number" && removeReference(entry.storedIndex)}
          aria-label={entry.source === "connected" ? t("editor.canvas.generation.disconnectReference") : t("editor.canvas.generation.removeReference")}
        >×</button>
      </span>
    );
  };
  const cycleConnectedRole = (input: ConnectedGenerationInput) => {
    if (!isVideo || input.reference.kind !== "image" || !onConnectedRoleChange) return;
    const nextRole: CanvasEdgeRole = input.role === "firstFrame"
      ? "lastFrame"
      : input.role === "lastFrame" ? "reference" : "firstFrame";
    onConnectedRoleChange(input.edgeId, nextRole);
  };
  const summary = !isText && capabilities.promptOnly ? "模型默认参数" : isVideo
    ? `${aspect} · ${mediaParameterLabel(quality, parameterKind)} · ${duration}s${supportsSoundControl && node.data.generationSound ? ` · ${t("editor.canvas.generation.sound")}` : ""}`
    : isText ? "1×" : t("editor.canvas.generation.imageSummary", { aspect, quality: [aspect !== "auto" ? resolution : undefined, mediaParameterLabel(quality, parameterKind)].filter(Boolean).join(" · "), count });
  const compiledRequest = createGenerationRequestSnapshot(node, connectedInputs, textModels, textModels[0] || "", imageModels, defaultImageModel, videoModels, defaultVideoModel, mediaProfile);
  const busy = !!node.data.generationTask && canCancelCanvasGenerationTask(node.data.generationTask);
  const configured = isText ? textModelsReady && models.length > 0
    : models.length > 0 && !!mediaProfile?.apiKeyConfigured && (isVideo ? mediaProfile.videoProtocol : mediaProfile.imageProtocol) !== "disabled";
  const hasContent = !!compiledRequest.prompt.trim() || (!isText && compiledRequest.references.some(ref => ref.kind === "image" && !!ref.mediaUrl));
  const canSubmit = configured && hasContent && !busy;

  return (
    <div
      ref={composerRef}
      className={`canvas-generation-composer ${embedded ? "is-embedded" : "is-contextual"}`}
      style={{ "--composer-view-scale": viewScale } as React.CSSProperties}
    >
      <div className={`canvas-composer-reference-row ${embedded ? "canvas-node-drag-handle" : ""}`}>
        <div className="canvas-composer-reference-strip nodrag nopan">
          <div className="canvas-composer-focus-anchor">
            <button
              type="button"
              className={`canvas-composer-assist ${focusEditorOpen ? "is-active" : ""}`}
              onClick={() => { setOpenPanel(null); setFocusEditorOpen((open) => !open); }}
              title={t("editor.canvas.generation.focusEdit")}
              aria-label={t("editor.canvas.generation.focusEditAria")}
            ><ToolIcon type="focusEdit" /></button>
            {focusEditorOpen ? (
              <div className="canvas-composer-focus-popover">
                <div><strong>{t("editor.canvas.generation.focusEdit")}</strong><small>{t("editor.canvas.generation.focusEditHint")}</small></div>
                <section>
                  {canvasReferenceCandidates.length ? canvasReferenceCandidates.map((candidate) => {

                    const alreadySelected = selectedCanvasReferenceNodeIds.has(candidate.nodeId);
                    return (
                      <button
                        type="button"
                        key={candidate.nodeId}
                        className={alreadySelected ? "is-selected" : ""}
                        disabled={inputCount >= 4 && !alreadySelected}
                        onClick={() => {
                          const role: CanvasEdgeRole = isVideo
                            ? !firstFrameEntry ? "firstFrame" : !lastFrameEntry ? "lastFrame" : "reference"
                            : "reference";
                          onSelectCanvasReference?.(candidate, role);
                          setFocusEditorOpen(false);
                        }}
                      >
                        <span><CanvasReferencePreview thumbnail={candidate.thumbnailUrl} original={candidate.kind === "image" ? candidate.mediaUrl : undefined} label={candidate.label} unavailable={locale === "en-US" ? "Unavailable" : "图片失效"} /></span>
                        <em><strong>{candidate.label}</strong><small>{alreadySelected ? t("editor.canvas.generation.referenced") : candidate.kind === "video" ? t("editor.canvas.type.video") : t("editor.canvas.type.image")}</small></em>
                      </button>
                    );
                  }) : <p>{t("editor.canvas.generation.noCanvasMedia")}</p>}
                </section>
              </div>
            ) : null}
          </div>
          <span className="canvas-composer-vertical-divider" aria-hidden="true" />
          {isVideo ? (
            <>
              {firstFrameEntry ? renderReferenceEntry(firstFrameEntry) : (
                <button type="button" className="canvas-composer-add-reference is-slot" data-slot-label={t("editor.canvas.generation.firstFrame")} onClick={() => onAddReference("firstFrame")} disabled={inputCount >= 4} aria-label={t("editor.canvas.generation.addFirstFrame")}><ToolIcon type="plus" /></button>
              )}
              <svg className="canvas-composer-frame-swap" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7h12l-2.7-2.7M17 13H5l2.7 2.7" /></svg>
              {lastFrameEntry ? renderReferenceEntry(lastFrameEntry) : (
                <button type="button" className="canvas-composer-add-reference is-slot" data-slot-label={t("editor.canvas.generation.lastFrame")} onClick={() => onAddReference("lastFrame")} disabled={inputCount >= 4} aria-label={t("editor.canvas.generation.addLastFrame")}><ToolIcon type="plus" /></button>
              )}
            </>
          ) : (
            <button type="button" className="canvas-composer-add-reference is-slot" data-slot-label={t("editor.canvas.generation.reference")} onClick={() => onAddReference("reference")} disabled={inputCount >= 4} aria-label={t("editor.canvas.generation.addReference")}>
              <ToolIcon type="plus" />
            </button>
          )}
          {otherReferenceEntries.map(renderReferenceEntry)}
        </div>
      </div>

      {!isText ? <PromptStarterSelect kind={isVideo ? "video" : "image"} prompt={node.data.generationPrompt || ""} english={locale === "en-US"} onInsert={value => commit({ generationPrompt: value })} /> : null}

      <textarea
        className="canvas-composer-prompt nodrag nopan nowheel"
        value={node.data.generationPrompt || ""}
        onFocus={() => { setOpenPanel(null); setFocusEditorOpen(false); }}
        onPointerDown={() => { setOpenPanel(null); setFocusEditorOpen(false); }}
        onChange={(event) => commit({ generationPrompt: event.target.value })}
        placeholder={node.data.kind === "text"
          ? t("editor.canvas.generation.extraPrompt")
          : isText ? t("editor.canvas.generation.textPrompt")
            : isVideo ? t("editor.canvas.generation.videoPrompt")
              : t("editor.canvas.generation.imagePrompt")}
        rows={3}
      />

      <div className="canvas-composer-footer nodrag nopan">
        <div className="canvas-composer-options">
          <div className="canvas-composer-anchor">
            <button type="button" className={openPanel === "model" ? "is-active" : ""} onClick={(event) => togglePanel(event, "model")}>
              <ToolIcon type="aiPrompt" /><strong>{model}</strong>
            </button>
            {openPanel === "model" ? (
              <div className={`canvas-composer-popover canvas-composer-model-popover ${popoverDirection === "down" ? "opens-down" : ""}`}>
                <small>{isText && textProviderLabel ? `${textProviderLabel} · ${t("editor.canvas.generation.selectModel")}` : t("editor.canvas.generation.selectModel")}</small>
                {models.map((item) => (
                  <button type="button" key={item} className={model === item ? "is-selected" : ""} onClick={() => { commit({ generationModel: item }); setOpenPanel(null); }}>
                    <span><ToolIcon type={isText ? "text" : isVideo ? "video" : "image"} /><strong>{item}</strong></span>
                    <em>{isText ? t("editor.canvas.connect.textGenerate") : isVideo ? t("editor.canvas.toolbar.videoGenerate") : t("editor.canvas.toolbar.imageGenerate")}</em>
                    {model === item ? <b>✓</b> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {!isText && !capabilities.promptOnly ? <div className="canvas-composer-anchor">
            <button type="button" className={openPanel === "settings" ? "is-active" : ""} onClick={(event) => togglePanel(event, "settings")}>
              <span>{summary}</span><svg viewBox="0 0 18 18"><path d="m6 7 3 3 3-3" /></svg>
            </button>
            {openPanel === "settings" ? (
              <div style={{maxHeight:popoverMaxHeight}} className={`canvas-composer-popover canvas-composer-settings-popover ${popoverDirection === "down" ? "opens-down" : ""}`}>
                <div className="canvas-composer-setting"><small>{t("editor.canvas.generation.aspect")}</small><CanvasAspectOptions options={capabilities.aspects} value={aspect} label={t("editor.canvas.generation.aspect")} onChange={(item) => commit({ generationAspect: item })} /></div>
                {resolutions.length > 0 && aspect !== "auto" ? <div className="canvas-composer-setting"><small>分辨率</small><div>{resolutions.map((item) => <button type="button" key={item} className={resolution === item ? "is-selected" : ""} aria-pressed={resolution === item} onClick={() => commit({ generationResolution: item })}>{item}</button>)}</div></div> : null}
                {mediaPixelSize(isVideo ? "video" : "image", mediaProfile, model, aspect || "", resolution) ? <div className="canvas-media-pixel-readout"><span>输出尺寸</span><strong>{mediaPixelSize(isVideo ? "video" : "image", mediaProfile, model, aspect || "", resolution)}</strong></div> : null}
                {qualities.length > 0 ? <div className="canvas-composer-setting"><small>{parameterKind === "resolution" ? "分辨率" : "画质"}</small><div>{qualities.map((item) => <button type="button" key={item} className={quality === item ? "is-selected" : ""} onClick={() => commit({ generationQuality: item })}>{mediaParameterLabel(item, parameterKind)}</button>)}</div></div> : null}
                {isVideo ? (
                  <>
                    <div className="canvas-composer-setting"><small>{t("editor.canvas.generation.duration")}</small><div>{capabilities.durations.map((item) => <button type="button" key={item} className={duration === item ? "is-selected" : ""} onClick={() => commit({ generationDuration: item })}>{item}s</button>)}</div></div>
                    <button type="button" className={`canvas-composer-sound ${supportsSoundControl && node.data.generationSound ? "is-selected" : ""}`} disabled={!supportsSoundControl} title={!supportsSoundControl ? t("editor.canvas.generation.soundUnavailable") : undefined} onClick={() => commit({ generationSound: !node.data.generationSound })}><span>{t("editor.canvas.generation.generateSound")}</span><b>{supportsSoundControl ? (node.data.generationSound ? t("editor.canvas.generation.on") : t("editor.canvas.generation.off")) : t("editor.canvas.generation.unsupported")}</b></button>
                    {capabilities.camera ? <label className="canvas-composer-camera"><span>{t("editor.canvas.generation.cameraStrength")} <b>{cameraStrength}%</b></span><input type="range" min="0" max="100" step="10" value={cameraStrength} style={{ "--camera-strength": `${cameraStrength}%` } as React.CSSProperties} onChange={(event) => commit({ generationCameraStrength: Number(event.target.value) })} /></label> : null}
                  </>
                ) : (
                  <div className="canvas-composer-setting"><small>{t("editor.canvas.generation.count")}</small><div>{imageGenerationCounts.map((item) => <button type="button" key={item} className={count === item ? "is-selected" : ""} onClick={() => commit({ generationCount: item })}>{t("editor.canvas.generation.images", { count: item })}</button>)}</div></div>
                )}
              </div>
            ) : null}
          </div> : <span className="canvas-composer-text-count">{summary}</span>}
        </div>
        {compiledRequest.references.some(ref => (ref.kind === "text" || ref.kind === "note") && ref.text?.trim()) ? <details className="canvas-prompt-context"><summary>{locale === "en-US" ? "Combined prompt · local instructions, then connected text" : "合并提示词 · 本节点要求在前，上游文本按连线顺序追加"}</summary><pre>{compiledRequest.prompt}</pre></details> : null}
        <div className="canvas-composer-submit-wrap">
          {showHint ? <span>{t("editor.canvas.generation.taskCreated")}</span> : null}
          <button
            type="button"
            className="canvas-composer-submit"
            disabled={!canSubmit}
            title={!canSubmit
              ? busy ? t("editor.canvas.error.generationBusy") : !textModelsReady ? t("editor.canvas.generation.loadingModels")
                : !configured ? t("editor.canvas.generation.configureModel")
                  : t("editor.canvas.generation.enterContent")
              : undefined}
            onClick={() => { setOpenPanel(null); setShowHint(true); onSubmit?.(); }}
            aria-label={isText ? t("editor.canvas.generation.generateText") : isVideo ? t("editor.canvas.generation.generateVideo") : t("editor.canvas.generation.generateImage")}
          >
            <svg viewBox="0 0 18 18"><path d="M9 14V4M5 8l4-4 4 4" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function MaterialGenerationInspector({
  node,
  onDataChange,
  onOpenReference,
  onAddReference,
  mediaProfile = null,
  embedded = false,
}: {
  node: SpikeNode;
  onDataChange: (patch: Partial<SpikeNodeData>) => void;
  onOpenReference: () => void;
  onAddReference?: () => void;
  mediaProfile?: CanvasMediaProfile | null;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const isVideo = node.data.kind === "video" || node.data.generationKind === "video";
  const models = mediaProfile ? [isVideo ? mediaProfile.videoModel : mediaProfile.imageModel].filter(Boolean) : [];
  const selectedModel = models.includes(node.data.generationModel || "") ? node.data.generationModel! : models[0] || "";
  const capabilities = mediaCapabilities(isVideo ? "video" : "image", mediaProfile, selectedModel);
  const imageGenerationCounts = capabilities.counts;
  const supportsSoundControl = capabilities.sound;
  const selectedAspect = mediaOption(capabilities.aspects, node.data.generationAspect);
  const selectedDuration = mediaOption(capabilities.durations, node.data.generationDuration);
  const qualities = capabilities.qualities;
  const resolutions = capabilities.resolutions || [];
  const resolution = mediaOption(resolutions, node.data.generationResolution);
  const parameterKind = mediaParameterKind(isVideo ? "video" : "image", mediaProfile, selectedModel);
  const selectedQuality = mediaQualityOption(qualities, node.data.generationQuality);
  const selectedCount = mediaOption(imageGenerationCounts, node.data.generationCount) || 1;
  const cameraStrength = Math.max(0, Math.min(100, node.data.generationCameraStrength ?? 50));
  const references: GenerationReference[] = Array.isArray(node.data.generationReferences)
    ? node.data.generationReferences
    : node.data.payload ? [{
      id: node.data.payload,
      label: node.data.label,
      kind: node.data.refKind || "image",
      thumbnailUrl: node.data.refThumbnailUrl,
      mediaUrl: node.data.refMediaUrl,
    }] : [];
  const [showConnectionHint, setShowConnectionHint] = useState(false);
  const commit = (patch: Partial<SpikeNodeData>) => {
    setShowConnectionHint(false);
    onDataChange(patch);
  };
  const moveReference = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= references.length) return;
    const next = references.slice();
    [next[index], next[target]] = [next[target], next[index]];
    commit({ generationReferences: next });
  };
  const removeReference = (index: number) => {
    commit({ generationReferences: references.filter((_, itemIndex) => itemIndex !== index) });
  };

  return (
    <div className={`${embedded ? "canvas-generation-node-editor" : "canvas-node-inspector"} canvas-generation-inspector is-${isVideo ? "video" : "image"}`}>
      <div className={embedded ? "canvas-generation-header canvas-node-drag-handle" : "canvas-generation-header"}>
        <span className="canvas-generation-mark">
          <ToolIcon type={isVideo ? "video" : "image"} />
        </span>
        <div>
          <div className="canvas-inspector-kicker">{isVideo ? t("editor.canvas.generation.imageToVideo") : t("editor.canvas.generation.referenceImage")}</div>
          <div className="canvas-inspector-title">{t("editor.canvas.generation.creationSettings")}</div>
        </div>
        <span className="canvas-generation-state">{t("editor.canvas.generation.draft")}</span>
      </div>

      <label className="canvas-generation-prompt">
        <textarea
          value={node.data.generationPrompt || ""}
          onChange={(event) => commit({ generationPrompt: event.target.value })}
          placeholder={isVideo ? t("editor.canvas.generation.videoPrompt") : t("editor.canvas.generation.imagePrompt")}
          rows={4}
        />
        <span>{(node.data.generationPrompt || "").length}/800</span>
      </label>

      <div className="canvas-generation-block">
        <div className="canvas-generation-label">
          <span>{t("editor.canvas.generation.referenceMaterials")}</span>
          <small>{t("editor.canvas.generation.referenceOrder", { count: references.length })}</small>
        </div>
        <div className="canvas-generation-references">
          <div className="canvas-generation-reference-list">
            {references.length ? references.map((reference, index) => {

              return (
                <div className="canvas-generation-reference-chip" key={reference.id}>
                  <span className="canvas-generation-reference-thumb">
                    <CanvasReferencePreview thumbnail={reference.thumbnailUrl} original={reference.kind === "image" ? reference.mediaUrl : undefined} label={reference.label} unavailable={t("editor.canvas.node.noThumbnail")} />
                    <b>{index + 1}</b>
                  </span>
                  <span className="canvas-generation-reference-copy">
                    <strong>{reference.label}</strong>
                    <small>{reference.kind === "video" ? t("editor.canvas.generation.videoReference") : index === 0 && isVideo ? t("editor.canvas.generation.firstFrameReference") : t("editor.canvas.generation.visualReference")}</small>
                  </span>
                  <span className="canvas-generation-reference-actions nodrag nopan">
                    <button type="button" onClick={() => moveReference(index, -1)} disabled={index === 0} aria-label={t("editor.canvas.generation.moveForward")}>‹</button>
                    <button type="button" onClick={() => moveReference(index, 1)} disabled={index === references.length - 1} aria-label={t("editor.canvas.generation.moveBack")}>›</button>
                    <button type="button" className="danger" onClick={() => removeReference(index)} aria-label={t("editor.canvas.generation.removeReference")}>×</button>
                  </span>
                </div>
              );
            }) : (
              <button type="button" className="canvas-generation-reference is-empty" onClick={onOpenReference} disabled>
                <span className="canvas-generation-reference-thumb"><ToolIcon type={isVideo ? "video" : "image"} /></span>
                <span className="canvas-generation-reference-copy"><strong>{t("editor.canvas.generation.noReferences")}</strong><small>{t("editor.canvas.generation.addReferenceHint")}</small></span>
              </button>
            )}
          </div>
          <button
            type="button"
            className="canvas-generation-add-reference"
            disabled={!onAddReference || references.length >= 4}
            onClick={onAddReference}
            title={references.length >= 4 ? t("editor.canvas.generation.maxReferences") : t("editor.canvas.generation.addFromMaterials")}
          >
            <span>＋</span>
            {t("editor.canvas.generation.reference")}
          </button>
        </div>
      </div>

      <div className="canvas-generation-block">
        <div className="canvas-generation-label"><span>{t("editor.canvas.generation.model")}</span></div>
        <div className="canvas-generation-models" role="group" aria-label={t("editor.canvas.generation.model")}>
          {models.map((model) => (
            <button
              type="button"
              key={model}
              className={selectedModel === model ? "is-active" : ""}
              aria-pressed={selectedModel === model}
              onClick={() => commit({ generationModel: model })}
            >
              {model}
            </button>
          ))}
        </div>
      </div>

      <div className="canvas-generation-settings">
        {capabilities.promptOnly ? <small>该协议当前使用模型默认参数</small> : null}
        <div className="canvas-generation-setting">
          <div className="canvas-generation-label"><span>{t("editor.canvas.generation.outputAspect")}</span></div>
          <CanvasAspectOptions options={capabilities.aspects} value={selectedAspect} label={t("editor.canvas.generation.outputAspect")} onChange={(aspect) => commit({ generationAspect: aspect })} />
        </div>

        {resolutions.length > 0 && selectedAspect !== "auto" ? <div className="canvas-generation-setting"><div className="canvas-generation-label"><span>分辨率</span></div><div className="canvas-generation-segments" role="group" aria-label="分辨率">{resolutions.map((item) => <button type="button" key={item} className={resolution === item ? "is-active" : ""} aria-pressed={resolution === item} onClick={() => commit({ generationResolution: item })}>{item}</button>)}</div></div> : null}
        {mediaPixelSize(isVideo ? "video" : "image", mediaProfile, selectedModel, selectedAspect || "", resolution) ? <div className="canvas-media-pixel-readout"><span>输出尺寸</span><strong>{mediaPixelSize(isVideo ? "video" : "image", mediaProfile, selectedModel, selectedAspect || "", resolution)}</strong></div> : null}
        {qualities.length > 0 ? <div className="canvas-generation-setting">
          <div className="canvas-generation-label"><span>{parameterKind === "resolution" ? "分辨率" : "画质"}</span></div>
          <div className="canvas-generation-segments" role="group" aria-label={t("editor.canvas.generation.outputQuality")}>
            {qualities.map((quality) => (
              <button type="button" key={quality} className={selectedQuality === quality ? "is-active" : ""} aria-pressed={selectedQuality === quality} onClick={() => commit({ generationQuality: quality })}>
                {mediaParameterLabel(quality, parameterKind)}
              </button>
            ))}
          </div>
        </div> : null}

        {isVideo ? (
          <>
            <div className="canvas-generation-setting">
              <div className="canvas-generation-label"><span>{t("editor.canvas.generation.duration")}</span></div>
              <div className="canvas-generation-segments" role="group" aria-label={t("editor.canvas.generation.videoDuration")}>
                {capabilities.durations.map((duration) => (
                  <button
                    type="button"
                    key={duration}
                    className={selectedDuration === duration ? "is-active" : ""}
                    aria-pressed={selectedDuration === duration}
                    onClick={() => commit({ generationDuration: duration })}
                  >
                    {duration}s
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className={`canvas-generation-sound ${supportsSoundControl && node.data.generationSound ? "is-active" : ""}`}
              aria-pressed={supportsSoundControl && node.data.generationSound === true}
              disabled={!supportsSoundControl}
              title={!supportsSoundControl ? t("editor.canvas.generation.soundUnavailable") : undefined}
              onClick={() => commit({ generationSound: !node.data.generationSound })}
            >
              <span>{supportsSoundControl ? t("editor.canvas.generation.sound") : t("editor.canvas.generation.noSoundOption")}</span>
              <i><b /></i>
            </button>
            {capabilities.camera ? <label className="canvas-generation-camera nodrag nopan">
              <span><strong>{t("editor.canvas.generation.cameraStrength")}</strong><small>{cameraStrength}%</small></span>
              <input
                type="range"
                min="0"
                max="100"
                step="10"
                value={cameraStrength}
                style={{ "--camera-strength": `${cameraStrength}%` } as React.CSSProperties}
                onChange={(event) => commit({ generationCameraStrength: Number(event.target.value) })}
              />
            </label> : null}
          </>
        ) : (
          <div className="canvas-generation-setting">
            <div className="canvas-generation-label"><span>{t("editor.canvas.generation.count")}</span></div>
            <div className="canvas-generation-segments" role="group" aria-label={t("editor.canvas.generation.count")}>
              {imageGenerationCounts.map((count) => (
                <button type="button" key={count} className={selectedCount === count ? "is-active" : ""} aria-pressed={selectedCount === count} onClick={() => commit({ generationCount: count })}>
                  {t("editor.canvas.generation.images", { count })}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="canvas-generation-footer">
        {showConnectionHint ? (
          <div className="canvas-generation-connection-hint">{t("editor.canvas.generation.settingsSaved")}</div>
        ) : null}
        <button type="button" className="canvas-generation-submit" onClick={() => setShowConnectionHint(true)}>
          <span aria-hidden="true">✦</span>
          {isVideo ? t("editor.canvas.generation.generateVideo") : t("editor.canvas.generation.generateImage")}
          <small>{t("editor.canvas.generation.servicePending")}</small>
        </button>
      </div>
    </div>
  );
}

function MaterialQuickInspector({
  node,
  onOpenReference,
  onCreateGenerator,
}: {
  node: SpikeNode;
  onOpenReference: () => void;
  onCreateGenerator: (kind: GenerationKind, source: SpikeNode) => void;
}) {
  const { t } = useI18n();
  const isVideo = node.data.kind === "video";
  const preview = node.data.refThumbnailUrl || (!isVideo ? node.data.refMediaUrl : null);
  return (
    <div className="canvas-node-inspector canvas-material-quick-inspector">
      <div className="canvas-inspector-header">
        <span className="canvas-inspector-icon"><ToolIcon type={isVideo ? "video" : "image"} /></span>
        <div className="canvas-inspector-heading">
          <div className="canvas-inspector-kicker">{isVideo ? t("editor.canvas.inspector.videoMaterial") : t("editor.canvas.inspector.imageMaterial")}</div>
          <div className="canvas-inspector-title">{t("editor.canvas.inspector.materialActions")}</div>
        </div>
      </div>
      <div className="canvas-material-quick-preview">
        {preview ? <img src={preview} alt="" /> : <ToolIcon type={isVideo ? "video" : "image"} />}
      </div>
      <div className="canvas-material-quick-name">{node.data.label || t("editor.canvas.inspector.untitledMaterial")}</div>
      <div className="canvas-material-quick-actions">
        <button type="button" onClick={onOpenReference}>{t("editor.canvas.inspector.openMaterial")}</button>
        <button type="button" className="primary" onClick={() => onCreateGenerator(isVideo ? "video" : "image", node)}>
          <ToolIcon type="aiPrompt" />
          {t("editor.canvas.inspector.useForGeneration")}
        </button>
      </div>
      <div className="canvas-material-quick-hint">{t("editor.canvas.inspector.materialHint")}</div>
    </div>
  );
}

// ========== 节点属性面板 ==========
function NodeInspector({
  node,
  onLabelChange,
  onPayloadChange,
  onOpenReference,
  onCreateGenerator,
  onRunAI,
  aiRunning,
}: {
  node: SpikeNode;
  onLabelChange: (s: string) => void;
  onPayloadChange: (s: string) => void;
  onOpenReference: () => void;
  onCreateGenerator: (kind: GenerationKind, source: SpikeNode) => void;
  onRunAI: () => void;
  aiRunning: boolean;
}) {
  const { t } = useI18n();
  const kind = node.data.kind;
  const isAiPrompt = kind === "aiPrompt";
  const isMaterial = kind === "image" || kind === "video";
  if (isMaterial) {
    return <MaterialQuickInspector node={node} onOpenReference={onOpenReference} onCreateGenerator={onCreateGenerator} />;
  }
  const isReference = kind === "noteRef";
  const fieldLabel = kind === "aiPrompt" ? t("editor.canvas.inspector.prompt") : kind === "aiResult" ? t("editor.canvas.inspector.resultTitle") : kind === "text" ? t("editor.canvas.inspector.content") : t("editor.canvas.inspector.displayName");
  return (
    <div className={`canvas-node-inspector canvas-node-inspector-${kind}`}>
      <div className="canvas-inspector-header">
        <span className="canvas-inspector-icon">
          <ToolIcon
            type={
              kind === "noteRef" ? "note" :
              kind === "aiPrompt" ? "aiPrompt" :
              kind === "aiResult" ? "aiResult" :
              "text"
            }
          />
        </span>
        <div className="canvas-inspector-heading">
          <div className="canvas-inspector-kicker">{canvasNodeKindLabel(kind, t)}</div>
          <div className="canvas-inspector-title">{t("editor.canvas.inspector.editNode")}</div>
        </div>
        <span className="canvas-inspector-id" title={node.id}>{node.id.slice(-6)}</span>
      </div>

      <label className="canvas-inspector-field">
        <span>{fieldLabel}</span>
      <textarea
        value={node.data.label}
        onChange={(e) => onLabelChange(e.target.value)}
          rows={kind === "text" || kind === "aiPrompt" ? 5 : 2}
          className="canvas-inspector-textarea"
      />
      </label>

      {isReference ? (
        <div className="canvas-inspector-section">
          <label className="canvas-inspector-field">
            <span>{t("editor.canvas.inspector.referenceId")}</span>
          <input
            value={node.data.payload || ""}
            onChange={(e) => onPayloadChange(e.target.value)}
            placeholder={t("editor.canvas.inspector.referencePlaceholder")}
              className="canvas-inspector-input"
          />
          </label>
          <button
            onClick={onOpenReference}
            disabled={!/^asset:|^note:/.test(node.data.payload || "")}
            className="canvas-inspector-button"
          >
            {t("editor.canvas.inspector.openReference")}
          </button>
        </div>
      ) : null}
      {isAiPrompt ? (
        <button
          onClick={onRunAI}
          disabled={aiRunning}
          className="canvas-inspector-button primary"
        >
          {aiRunning ? t("editor.canvas.inspector.running") : kind === "aiPrompt" ? t("editor.canvas.inspector.runAi") : t("editor.canvas.inspector.rerunAi")}
        </button>
      ) : null}
      {kind === "aiResult" && node.data.result ? (
        <div className="canvas-inspector-result">
          <div className="canvas-inspector-kicker">{t("editor.canvas.inspector.latestResult")}</div>
          <div className="canvas-inspector-result-body">
            {node.data.result}
          </div>
        </div>
      ) : null}
      <div className="canvas-inspector-shortcut">
        <span>Backspace</span>
        {t("editor.canvas.inspector.deleteNode")}
      </div>
    </div>
  );
}

// ========== 素材 / 笔记选择器 ==========
function Picker<T>({
  title,
  variant,
  items,
  loading,
  onPick,
  onImport,
  onClose,
  renderItem,
  emptyText,
}: {
  title: string;
  variant: "asset" | "note";
  items: T[];
  loading: boolean;
  onPick: (it: T) => void;
  onImport?: () => void;
  onClose: () => void;
  renderItem: (it: T) => string;
  emptyText: string;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return items;
    return items.filter((item) => renderItem(item).toLocaleLowerCase().includes(normalized));
  }, [items, query, renderItem]);

  return (
    <div
      className="canvas-picker-backdrop"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div
        className="canvas-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="canvas-picker-header">
          <span className="canvas-picker-header-icon">
            <ToolIcon type={variant === "asset" ? "asset" : "note"} />
          </span>
          <div className="canvas-picker-heading">
            <div className="canvas-picker-kicker">{variant === "asset" ? t("editor.canvas.picker.materials") : t("editor.canvas.picker.knowledge")}</div>
            <div className="canvas-picker-title">{title}</div>
          </div>
          <span className="canvas-picker-count">{items.length}</span>
          <button type="button" className="canvas-picker-close" onClick={onClose} aria-label={t("editor.canvas.action.close")}>
            <svg viewBox="0 0 18 18"><path d="M5 5l8 8M13 5l-8 8" /></svg>
          </button>
        </div>

        <label className="canvas-picker-search">
          <svg viewBox="0 0 18 18"><circle cx="8" cy="8" r="4.5" /><path d="M11.5 11.5L15 15" /></svg>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={variant === "asset" ? t("editor.canvas.picker.searchMaterials") : t("editor.canvas.picker.searchNotes")}
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label={t("editor.canvas.picker.clearSearch")}>{t("editor.canvas.picker.clear")}</button>
          ) : null}
        </label>

        <div className="canvas-picker-list">
          {loading ? (
            <div className="canvas-picker-empty">
              <span className="canvas-picker-loading-dot" />
              {t("editor.canvas.status.loadingShort")}
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="canvas-picker-empty">
              <span>{query ? t("editor.canvas.picker.noMatches") : emptyText}</span>
              {query ? <small>{t("editor.canvas.picker.tryAnother")}</small> : null}
            </div>
          ) : (
            visibleItems.map((it: any, i) => {
              const label = renderItem(it);
              const thumbnail = variant === "asset" && typeof it.thumbnailUrl === "string" ? it.thumbnailUrl : "";
              const meta = variant === "asset"
                ? (it.kind === "video" ? t("editor.canvas.type.video") : it.kind === "audio" ? t("editor.canvas.type.audio") : t("editor.canvas.type.image"))
                : (it.updatedAt ? formatRelativeTime(it.updatedAt, locale) : t("editor.canvas.type.note"));
              return (
              <button
                type="button"
                key={it.id || i}
                onClick={() => onPick(it)}
                className="canvas-picker-item"
              >
                <span className={`canvas-picker-preview ${thumbnail ? "has-image" : ""}`}>
                  {thumbnail ? (
                    <img src={thumbnail} alt="" />
                  ) : (
                    <ToolIcon type={variant === "asset" ? "asset" : "note"} />
                  )}
                </span>
                <span className="canvas-picker-item-copy">
                  <strong>{label}</strong>
                  <small>{meta}</small>
                </span>
                <svg className="canvas-picker-item-arrow" viewBox="0 0 18 18"><path d="M6 4l5 5-5 5" /></svg>
              </button>
              );
            })
          )}
        </div>
        <div className="canvas-picker-footer">
          {variant === "asset" && onImport ? (
            <button type="button" className="canvas-picker-import" onClick={onImport} disabled={loading}>
              <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 12V3M5.5 6.5 9 3l3.5 3.5M3 11v3.5h12V11" /></svg>
              {t("editor.canvas.picker.importLocal")}
            </button>
          ) : <span>{t("editor.canvas.picker.clickToSelect")}</span>}
          <span><kbd>Esc</kbd> {t("editor.canvas.action.close")}</span>
        </div>
      </div>
    </div>
  );
}

// ========== 样式常量 ==========
const btn: React.CSSProperties = {
  padding: "5px 10px",
  background: "rgba(255,255,255,.05)",
  border: "1px solid rgba(255,255,255,.08)",
  borderRadius: 5,
  color: "#f0f0f2",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "inherit",
};
const btnAccent: React.CSSProperties = { ...btn, background: "rgba(124,138,255,.18)", borderColor: "rgba(124,138,255,.4)", color: "#9aa4ff" };
const btnDanger: React.CSSProperties = { ...btn, color: "#fb7185", borderColor: "rgba(251,113,133,.3)" };

export default function CanvasSpike() {
  const locale = useSavedLocale();
  return (
    <I18nProvider locale={locale}>
      <ReactFlowProvider>
        <CanvasInner />
      </ReactFlowProvider>
    </I18nProvider>
  );
}

