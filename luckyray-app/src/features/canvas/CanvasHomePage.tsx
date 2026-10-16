import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { getLuckyRayBridgeSync } from "../../core/bridge/luckyRayBridge";
import { smartFolderDraftHash } from "../../core/services/smartFolders";
import { serializeCanvasPortableExport } from "./canvasExport";
import { PENDING_CANVAS_OPEN_KEY } from "./canvasNavigation";
import { useFavoriteItems } from "../favorites/useFavoriteItems";
import { FavoriteGlyph } from "../../components/FavoriteGlyph";
import { defineMessages, useMessages } from "../../core/i18n/index";
import "../../components/editorialContentChrome.css";
import "./canvasHome.css";

type CanvasEntry = {
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
};

type CanvasStorageCheck = {
  ok: boolean;
  storageDir: string;
  canvasCount: number;
  checkedFiles: number;
  issues: string[];
};

type CanvasBridge = {
  listCanvases: () => Promise<CanvasEntry[]>;
  loadCanvas: (canvasId: string) => Promise<{
    canvasId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    nodes: unknown;
    edges: unknown;
    viewport: { x: number; y: number; zoom: number };
    generationHistory: unknown;
  }>;
  createCanvas: (name?: string) => Promise<CanvasEntry>;
  renameCanvas: (canvasId: string, name: string) => Promise<CanvasEntry | null>;
  deleteCanvas: (canvasId: string) => Promise<void>;
  checkCanvasFiles?: () => Promise<CanvasStorageCheck>;
  openDirectory?: (path: string) => Promise<void>;
  getCanvasStorageDir?: () => Promise<string>;
};

type CanvasHomePageProps = {
  onOpenCanvas: (canvasId?: string) => void;
};

type CanvasCover = {
  kind: "image" | "video";
  url: string;
  poster?: string;
};

type CanvasSortMode = "recent" | "oldest" | "name";

const COPY = defineMessages({
  "sort.recent": { "zh-CN": "最近编辑", "en-US": "Recently edited" }, "sort.oldest": { "zh-CN": "最早编辑", "en-US": "Oldest edited" }, "sort.name": { "zh-CN": "按名称", "en-US": "By name" },
  "template.blank.name": { "zh-CN": "空白创作板", "en-US": "Blank Board" }, "template.blank.desc": { "zh-CN": "从一块干净画布开始", "en-US": "Start with a clean canvas" },
  "template.material.name": { "zh-CN": "素材灵感板", "en-US": "Material Moodboard" }, "template.material.desc": { "zh-CN": "收集图片与视频参考", "en-US": "Collect image and video references" },
  "template.note.name": { "zh-CN": "笔记关系板", "en-US": "Note Map" }, "template.note.desc": { "zh-CN": "整理笔记与内容脉络", "en-US": "Organize notes and content connections" },
  "template.ai.name": { "zh-CN": "AI 分镜板", "en-US": "AI Storyboard" }, "template.ai.desc": { "zh-CN": "组织提示词与生成结果", "en-US": "Organize prompts and generated results" },
  "time.now": { "zh-CN": "刚刚", "en-US": "Just now" }, "time.minutes.one": { "zh-CN": "{count} 分钟前", "en-US": "{count} min ago" }, "time.minutes.other": { "zh-CN": "{count} 分钟前", "en-US": "{count} mins ago" }, "time.hours.one": { "zh-CN": "{count} 小时前", "en-US": "{count} hr ago" }, "time.hours.other": { "zh-CN": "{count} 小时前", "en-US": "{count} hrs ago" }, "time.days.one": { "zh-CN": "{count} 天前", "en-US": "{count} day ago" }, "time.days.other": { "zh-CN": "{count} 天前", "en-US": "{count} days ago" },
  "untitled": { "zh-CN": "未命名画布", "en-US": "Untitled Canvas" }, "error.bridge": { "zh-CN": "画布桥未就绪，请在桌面应用中使用。", "en-US": "Canvas is unavailable. Use the desktop app." },
  "error.load": { "zh-CN": "加载画布列表失败，请稍后重试。", "en-US": "Could not load canvases. Try again later." }, "error.create": { "zh-CN": "新建画布失败，请稍后重试。", "en-US": "Could not create a canvas. Try again later." },
  "error.rename": { "zh-CN": "重命名失败，请稍后重试。", "en-US": "Could not rename the canvas. Try again later." }, "error.delete": { "zh-CN": "删除画布失败，请稍后重试。", "en-US": "Could not delete the canvas. Try again later." }, "error.export": { "zh-CN": "导出画布失败，请稍后重试。", "en-US": "Could not export the canvas. Try again later." },
  "error.openUnsupported": { "zh-CN": "当前环境不支持打开画布数据目录。", "en-US": "Opening the canvas data folder is not supported here." }, "error.storageUnavailable": { "zh-CN": "画布数据目录未就绪。", "en-US": "The canvas data folder is not ready." }, "error.openStorage": { "zh-CN": "打开画布数据目录失败，请稍后重试。", "en-US": "Could not open the canvas data folder. Try again later." },
  "error.checkUnsupported": { "zh-CN": "当前环境不支持画布存储检查。", "en-US": "Canvas storage checks are not supported here." }, "error.checkIssues.one": { "zh-CN": "画布存储检查发现 {count} 个问题。", "en-US": "Canvas storage check found {count} issue." }, "error.checkIssues.other": { "zh-CN": "画布存储检查发现 {count} 个问题。", "en-US": "Canvas storage check found {count} issues." }, "error.check": { "zh-CN": "画布存储检查失败，请稍后重试。", "en-US": "Canvas storage check failed. Try again later." },
  "header.title": { "zh-CN": "画布", "en-US": "Canvas" }, "action.creating": { "zh-CN": "创建中", "en-US": "Creating" }, "action.new": { "zh-CN": "新建画布", "en-US": "New Canvas" }, "action.enter": { "zh-CN": "进入编辑器", "en-US": "Open Editor" },
  "summary.count.one": { "zh-CN": "{count} 个画布", "en-US": "{count} canvas" }, "summary.count.other": { "zh-CN": "{count} 个画布", "en-US": "{count} canvases" }, "summary.compose": { "zh-CN": "素材与笔记自由编排", "en-US": "Arrange materials and notes freely" }, "summary.autosave": { "zh-CN": "自动保存", "en-US": "Auto-save" },
  "recent.title": { "zh-CN": "最近画布", "en-US": "Recent Canvases" }, "recent.loading": { "zh-CN": "正在读取画布", "en-US": "Loading canvases" }, "action.saveSmart": { "zh-CN": "保存为智能文件夹", "en-US": "Save as Smart Folder" }, "action.refreshing": { "zh-CN": "刷新中", "en-US": "Refreshing" }, "action.refresh": { "zh-CN": "刷新", "en-US": "Refresh" },
  "message.close": { "zh-CN": "关闭提示", "en-US": "Dismiss message" }, "search.placeholder": { "zh-CN": "搜索画布", "en-US": "Search canvases" }, "sort.aria": { "zh-CN": "画布排序", "en-US": "Canvas sort" }, "sort.menu": { "zh-CN": "画布排序方式", "en-US": "Canvas sort order" },
  "blank.creating": { "zh-CN": "正在创建", "en-US": "Creating" }, "blank.title": { "zh-CN": "新建空白画布", "en-US": "New blank canvas" }, "blank.desc": { "zh-CN": "从空白节点开始创作", "en-US": "Start creating from an empty node" },
  "empty.query": { "zh-CN": "没有找到“{query}”", "en-US": "No results for “{query}”" }, "empty.default": { "zh-CN": "还没有画布，从左侧新建一个", "en-US": "No canvases yet. Create one from the left." }, "action.openNamed": { "zh-CN": "打开 {name}", "en-US": "Open {name}" }, "cover.empty": { "zh-CN": "暂无图片或视频素材", "en-US": "No image or video material" },
  "action.saving": { "zh-CN": "保存中", "en-US": "Saving" }, "action.save": { "zh-CN": "保存", "en-US": "Save" }, "action.cancel": { "zh-CN": "取消", "en-US": "Cancel" }, "edited": { "zh-CN": "编辑于 {time}", "en-US": "Edited {time}" }, "exporting": { "zh-CN": "正在导出 JSON", "en-US": "Exporting JSON" }, "menu.aria": { "zh-CN": "{name}操作", "en-US": "Actions for {name}" },
  "action.open": { "zh-CN": "打开", "en-US": "Open" }, "favorite.added": { "zh-CN": "已收藏画布", "en-US": "Canvas added to favorites" }, "favorite.removed": { "zh-CN": "已取消收藏", "en-US": "Removed from favorites" }, "favorite.error": { "zh-CN": "收藏操作失败", "en-US": "Favorite action failed" }, "favorite.add": { "zh-CN": "收藏画布", "en-US": "Add to favorites" }, "favorite.remove": { "zh-CN": "取消收藏", "en-US": "Remove from favorites" }, "action.rename": { "zh-CN": "重命名", "en-US": "Rename" }, "action.export": { "zh-CN": "导出 JSON", "en-US": "Export JSON" }, "action.delete": { "zh-CN": "删除", "en-US": "Delete" },
  "storage.title": { "zh-CN": "画布数据", "en-US": "Canvas Data" }, "storage.desc": { "zh-CN": "本地文件与缩略图", "en-US": "Local files and thumbnails" }, "storage.ok": { "zh-CN": "存储检查通过", "en-US": "Storage check passed" }, "storage.issues.one": { "zh-CN": "发现 {count} 个问题", "en-US": "{count} issue found" }, "storage.issues.other": { "zh-CN": "发现 {count} 个问题", "en-US": "{count} issues found" }, "storage.unchecked": { "zh-CN": "尚未检查", "en-US": "Not checked" }, "storage.files.one": { "zh-CN": "{checked}/{total} 文件", "en-US": "{checked}/{total} file" }, "storage.files.other": { "zh-CN": "{checked}/{total} 文件", "en-US": "{checked}/{total} files" }, "storage.open": { "zh-CN": "打开数据目录", "en-US": "Open Data Folder" }, "storage.checking": { "zh-CN": "检查中", "en-US": "Checking" }, "storage.check": { "zh-CN": "检查存储", "en-US": "Check Storage" },
  "quick.title": { "zh-CN": "快速开始", "en-US": "Quick Start" }, "quick.desc": { "zh-CN": "从常用结构开始创作", "en-US": "Start from a familiar structure" },
  "delete.title": { "zh-CN": "删除画布", "en-US": "Delete Canvas" }, "delete.copy": { "zh-CN": "确定删除「{name}」吗？该画布文件会从画布存储中移除。", "en-US": "Delete “{name}”? Its file will be removed from canvas storage." }, "delete.deleting": { "zh-CN": "删除中", "en-US": "Deleting" },
});

type CanvasT = ReturnType<typeof useMessages<typeof COPY>>["t"];
type CanvasPlural = ReturnType<typeof useMessages<typeof COPY>>["plural"];
const sortOptions = (t: CanvasT): { value: CanvasSortMode; label: string }[] => [{ value: "recent", label: t("sort.recent") }, { value: "oldest", label: t("sort.oldest") }, { value: "name", label: t("sort.name") }];
const templates = (t: CanvasT) => (["blank", "material", "note", "ai"] as const).map((icon) => ({ icon, name: t(`template.${icon}.name`), description: t(`template.${icon}.desc`) }));

function formatRelativeTime(value: string, t: CanvasT, plural: CanvasPlural) {
  if (!value) return t("time.now");
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return t("time.now");
  const diff = Date.now() - then;
  if (diff < 60_000) return t("time.now");
  if (diff < 3_600_000) return plural(Math.max(1, Math.round(diff / 60_000)), { one: "time.minutes.one", other: "time.minutes.other" });
  if (diff < 86_400_000) return plural(Math.max(1, Math.round(diff / 3_600_000)), { one: "time.hours.one", other: "time.hours.other" });
  return plural(Math.max(1, Math.round(diff / 86_400_000)), { one: "time.days.one", other: "time.days.other" });
}

function resolveCanvasCoverUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const source = value.trim();
  if (/^(https?:|asset:|blob:|data:)/i.test(source)) return source;
  return convertFileSrc(source);
}

function findCanvasMaterialCover(nodes: unknown): CanvasCover | null {
  if (!Array.isArray(nodes)) return null;
  let selectedCover: CanvasCover | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;
  const consider = (cover: CanvasCover | null, score: number) => {
    if (!cover?.url || selectedScore >= score) return;
    selectedCover = cover;
    selectedScore = score;
  };

  nodes.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return;
    const data = (candidate as { data?: unknown }).data;
    if (!data || typeof data !== "object") return;
    const node = data as Record<string, unknown>;
    const kind = typeof node.kind === "string" ? node.kind : "";
    const generationKind = typeof node.generationKind === "string" ? node.generationKind : "";
    const resultItems = Array.isArray(node.resultMediaItems) ? node.resultMediaItems : [];
    const firstResult = resultItems[0] && typeof resultItems[0] === "object"
      ? resultItems[0] as Record<string, unknown>
      : null;
    const resultUrl = resolveCanvasCoverUrl(firstResult?.url || node.resultMediaUrl);
    const resultThumbnail = resolveCanvasCoverUrl(firstResult?.thumbnailUrl || node.resultThumbnailUrl);
    const referenceUrl = resolveCanvasCoverUrl(node.refMediaUrl);
    const referenceThumbnail = resolveCanvasCoverUrl(node.refThumbnailUrl);
    const orderBoost = index / Math.max(1, nodes.length);

    if (kind === "image" && (referenceThumbnail || referenceUrl)) {
      consider({ kind: "image", url: referenceThumbnail || referenceUrl }, 400 + orderBoost);
      return;
    }
    if (kind === "generator" && generationKind === "image" && (resultThumbnail || resultUrl)) {
      consider({ kind: "image", url: resultThumbnail || resultUrl }, 360 + orderBoost);
      return;
    }
    if (kind === "video" && (referenceUrl || referenceThumbnail)) {
      if (referenceThumbnail && referenceThumbnail !== referenceUrl) {
        consider({ kind: "image", url: referenceThumbnail }, 320 + orderBoost);
      } else if (referenceUrl) {
        consider({ kind: "video", url: referenceUrl }, 280 + orderBoost);
      }
      return;
    }
    if (kind === "generator" && generationKind === "video" && (resultUrl || resultThumbnail)) {
      if (resultThumbnail && resultThumbnail !== resultUrl) {
        consider({ kind: "image", url: resultThumbnail }, 300 + orderBoost);
      } else if (resultUrl) {
        consider({ kind: "video", url: resultUrl, poster: resultThumbnail || undefined }, 260 + orderBoost);
      }
    }
  });

  return selectedCover;
}

function CanvasMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.5" y="3" width="13" height="11.5" rx="2" />
      <path d="M5 11.8 7.6 9.1l2.1 2 1.7-1.7 2.3 2.4" />
      <circle cx="6.6" cy="6.8" r="1.1" />
    </svg>
  );
}

function HomeIcon({ type }: { type: "search" | "more" | "plus" | "chevron" | "blank" | "material" | "note" | "ai" }) {
  if (type === "search") return <svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="7.5" cy="7.5" r="4.5" /><path d="m11 11 4 4" /></svg>;
  if (type === "more") return <svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="4" cy="9" r="1" /><circle cx="9" cy="9" r="1" /><circle cx="14" cy="9" r="1" /></svg>;
  if (type === "plus") return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 3v12M3 9h12" /></svg>;
  if (type === "chevron") return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="m5 7 4 4 4-4" /></svg>;
  if (type === "material") return <svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="2" /><circle cx="6.5" cy="7" r="1.2" /><path d="m4 13 3.2-3.2 2.2 2 1.7-1.7 2.9 2.9" /></svg>;
  if (type === "note") return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 2.5h7l3 3V15H4Z" /><path d="M11 2.5V6h3M6.5 9h5M6.5 12h4" /></svg>;
  if (type === "ai") return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="m9 2 1.3 3.7L14 7l-3.7 1.3L9 12l-1.3-3.7L4 7l3.7-1.3Z" /><path d="m14 11 .6 1.7 1.7.6-1.7.6L14 15.6l-.6-1.7-1.7-.6 1.7-.6Z" /></svg>;
  return <svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2.5" y="2.5" width="13" height="13" rx="2" /><path d="M9 5v8M5 9h8" /></svg>;
}

export default function CanvasHomePage({ onOpenCanvas }: CanvasHomePageProps) {
  const { locale, plural, t } = useMessages(COPY);
  const [canvases, setCanvases] = useState<CanvasEntry[]>([]);
  const [storageDir, setStorageDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingDraft, setRenamingDraft] = useState("");
  const [renamingSaving, setRenamingSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CanvasEntry | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [storageCheck, setStorageCheck] = useState<CanvasStorageCheck | null>(null);
  const [storageChecking, setStorageChecking] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<CanvasSortMode>("recent");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [canvasCovers, setCanvasCovers] = useState<Record<string, CanvasCover | null>>({});
  const [failedCovers, setFailedCovers] = useState<Set<string>>(() => new Set());

  const bridge = useMemo(() => getLuckyRayBridgeSync() as CanvasBridge | null, []);
  const canvasFavorites = useFavoriteItems("canvas");
  const visibleCanvases = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filtered = normalizedQuery
      ? canvases.filter((canvas) => (canvas.name || t("untitled")).toLocaleLowerCase().includes(normalizedQuery))
      : canvases;
    return [...filtered].sort((a, b) => {
      if (sortMode === "name") return (a.name || t("untitled")).localeCompare(b.name || t("untitled"), locale);
      if (sortMode === "oldest") return String(a.updatedAt).localeCompare(String(b.updatedAt));
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
  }, [canvases, locale, query, sortMode, t]);

  const refreshCanvases = useCallback(async () => {
    if (!bridge) {
      setLoading(false);
      setMessage(t("error.bridge"));
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const [list, dir] = await Promise.all([
        bridge.listCanvases(),
        bridge.getCanvasStorageDir ? bridge.getCanvasStorageDir().catch(() => "") : Promise.resolve(""),
      ]);
      setCanvases(Array.isArray(list) ? list : []);
      setStorageDir(dir || "");
    } catch {
      setCanvases([]);
      setMessage(t("error.load"));
    } finally {
      setLoading(false);
    }
  }, [bridge, t]);

  useEffect(() => {
    void refreshCanvases();
  }, [refreshCanvases]);

  useEffect(() => {
    if (!bridge || canvases.length === 0) {
      setCanvasCovers({});
      return;
    }
    let cancelled = false;
    const currentIds = new Set(canvases.map((canvas) => canvas.id));
    const cachedEntries = canvases
      .filter((canvas) => canvas.coverVersion >= 1)
      .map((canvas) => [
        canvas.id,
        canvas.coverKind && canvas.coverUrl
          ? {
              kind: canvas.coverKind,
              url: resolveCanvasCoverUrl(canvas.coverUrl),
              poster: resolveCanvasCoverUrl(canvas.coverPoster) || undefined,
            } satisfies CanvasCover
          : null,
      ] as const);
    setCanvasCovers((current) => ({
      ...Object.fromEntries(Object.entries(current).filter(([canvasId]) => currentIds.has(canvasId))),
      ...Object.fromEntries(cachedEntries),
    }));
    const legacyCanvases = canvases.filter((canvas) => canvas.coverVersion < 1);
    if (legacyCanvases.length === 0) return;
    void Promise.all(legacyCanvases.map(async (canvas) => {
      try {
        const detail = await bridge.loadCanvas(canvas.id);
        return [canvas.id, findCanvasMaterialCover(detail.nodes)] as const;
      } catch {
        return [canvas.id, null] as const;
      }
    })).then((entries) => {
      if (!cancelled) setCanvasCovers((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, canvases]);

  useEffect(() => {
    if (!openMenuId && !sortMenuOpen) return;
    const closeMenu = () => {
      setOpenMenuId(null);
      setSortMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [openMenuId, sortMenuOpen]);

  const openCanvas = useCallback((canvasId?: string) => {
    if (canvasId) {
      try {
        window.sessionStorage.setItem(PENDING_CANVAS_OPEN_KEY, canvasId);
      } catch {}
    }
    onOpenCanvas(canvasId);
  }, [onOpenCanvas]);

  const createCanvas = useCallback(async (name: string) => {
    if (!bridge) {
      openCanvas();
      return;
    }
    setCreatingName(name);
    setMessage("");
    try {
      const created = await bridge.createCanvas(name);
      openCanvas(created.id);
    } catch {
      setMessage(t("error.create"));
    } finally {
      setCreatingName(null);
    }
  }, [bridge, openCanvas, t]);

  const startRename = useCallback((canvas: CanvasEntry) => {
    setOpenMenuId(null);
    setRenamingId(canvas.id);
    setRenamingDraft(canvas.name || t("untitled"));
  }, [t]);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenamingDraft("");
  }, []);

  const commitRename = useCallback(async () => {
    if (!bridge || !renamingId || renamingSaving) return;
    const name = renamingDraft.trim();
    if (!name) {
      cancelRename();
      return;
    }
    setMessage("");
    setRenamingSaving(true);
    try {
      const updated = await bridge.renameCanvas(renamingId, name);
      if (updated) {
        setCanvases((items) => items.map((item) => item.id === updated.id ? updated : item));
      } else {
        await refreshCanvases();
      }
      cancelRename();
    } catch {
      setMessage(t("error.rename"));
    } finally {
      setRenamingSaving(false);
    }
  }, [bridge, cancelRename, refreshCanvases, renamingDraft, renamingId, renamingSaving, t]);

  const confirmDelete = useCallback(async () => {
    if (!bridge || !deleteTarget || deletingId) return;
    const target = deleteTarget;
    setMessage("");
    setDeletingId(target.id);
    try {
      await bridge.deleteCanvas(target.id);
      setCanvases((items) => items.filter((item) => item.id !== target.id));
      setDeleteTarget(null);
    } catch {
      setMessage(t("error.delete"));
    } finally {
      setDeletingId(null);
    }
  }, [bridge, deleteTarget, deletingId, t]);

  const exportCanvas = useCallback(async (canvas: CanvasEntry) => {
    if (!bridge || exportingId) return;
    setMessage("");
    setExportingId(canvas.id);
    try {
      const data = await bridge.loadCanvas(canvas.id);
      const filePath = await save({
        defaultPath: `canvas-${canvas.name || data.name || canvas.id}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, JSON.stringify(serializeCanvasPortableExport(data), null, 2));
    } catch {
      setMessage(t("error.export"));
    } finally {
      setExportingId(null);
    }
  }, [bridge, exportingId, t]);

  const openStorageDir = useCallback(async () => {
    if (!bridge?.openDirectory) {
      setMessage(t("error.openUnsupported"));
      return;
    }
    setMessage("");
    try {
      const dir = storageDir || (bridge.getCanvasStorageDir ? await bridge.getCanvasStorageDir() : "");
      if (!dir) {
        setMessage(t("error.storageUnavailable"));
        return;
      }
      setStorageDir(dir);
      await bridge.openDirectory(dir);
    } catch {
      setMessage(t("error.openStorage"));
    }
  }, [bridge, storageDir, t]);

  const checkStorage = useCallback(async () => {
    if (!bridge?.checkCanvasFiles) {
      setMessage(t("error.checkUnsupported"));
      return;
    }
    setStorageChecking(true);
    setMessage("");
    try {
      const result = await bridge.checkCanvasFiles();
      setStorageCheck(result);
      if (result.storageDir) setStorageDir(result.storageDir);
      if (!result.ok) setMessage(plural(result.issues.length, { one: "error.checkIssues.one", other: "error.checkIssues.other" }));
    } catch {
      setMessage(t("error.check"));
    } finally {
      setStorageChecking(false);
    }
  }, [bridge, plural, t]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteTarget) {
        if (!deletingId) setDeleteTarget(null);
        return;
      }
      if (openMenuId || sortMenuOpen) {
        setOpenMenuId(null);
        setSortMenuOpen(false);
        return;
      }
      if (renamingId && !renamingSaving) cancelRename();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [cancelRename, deleteTarget, deletingId, openMenuId, renamingId, renamingSaving, sortMenuOpen]);

  return (
    <section id="page-canvas" className="canvas-home-page">
      <div className="canvas-home-inner">
        <div className="canvas-home-hero">
          <div className="canvas-home-copy">
            <div className="canvas-home-kicker">LUCKYRAY / CANVAS</div>
            <h1>{t("header.title")}</h1>
            <div className="canvas-home-actions">
              <button className="canvas-home-primary editorial-primary-action" onClick={() => void createCanvas(t("untitled"))} disabled={creatingName !== null}>
                {creatingName ? t("action.creating") : t("action.new")}
              </button>
              <button className="canvas-home-secondary" onClick={() => openCanvas()}>
                {t("action.enter")}
              </button>
            </div>
            <div className="canvas-home-stats">
              <span>{plural(canvases.length, { one: "summary.count.one", other: "summary.count.other" })}</span>
              <span>{t("summary.compose")}</span>
              <span>{t("summary.autosave")}</span>
            </div>
          </div>
        </div>

        <div className="canvas-home-main manager-layout">
          <section className="canvas-home-panel canvas-list-panel">
            <div className="canvas-home-panel-head">
              <div>
                <h2>{t("recent.title")}</h2>
                <p>{loading ? t("recent.loading") : plural(canvases.length, { one: "summary.count.one", other: "summary.count.other" })}</p>
              </div>
              <div className="canvas-home-head-actions">
                <button onClick={() => void createCanvas(t("untitled"))} disabled={creatingName !== null}>{creatingName ? t("action.creating") : t("action.new")}</button>
                <button
                  type="button"
                  className="canvas-home-save-smart"
                  onClick={() => {
                    window.location.hash = smartFolderDraftHash({
                      name: query.trim() ? `${t("header.title")} · ${query.trim().slice(0, 24)}` : t("header.title"),
                      criteria: { source: "canvas", query: query.trim(), favorite: null, modified: { after: null, before: null } },
                      sort: sortMode === "name" ? "name-asc" : sortMode === "oldest" ? "modified-asc" : "modified-desc",
                    });
                  }}
                >{t("action.saveSmart")}</button>
                <button onClick={() => void refreshCanvases()} disabled={loading}>{loading ? t("action.refreshing") : t("action.refresh")}</button>
              </div>
            </div>
            {message ? (
              <div className="canvas-home-message" role="status">
                <span>{message}</span>
                <button type="button" onClick={() => setMessage("")} aria-label={t("message.close")}>×</button>
              </div>
            ) : null}
            <div className="canvas-home-library-toolbar">
              <label className="canvas-home-search">
                <HomeIcon type="search" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("search.placeholder")}
                  aria-label={t("search.placeholder")}
                />
              </label>
              <div className="canvas-home-sort-wrap" onPointerDown={(event) => event.stopPropagation()}>
                <button
                  className="canvas-home-sort"
                  type="button"
                  onClick={() => setSortMenuOpen((open) => !open)}
                  aria-label={t("sort.aria")}
                  aria-haspopup="listbox"
                  aria-expanded={sortMenuOpen}
                >
                  <span>{sortOptions(t).find((option) => option.value === sortMode)?.label}</span>
                  <HomeIcon type="chevron" />
                </button>
                {sortMenuOpen ? (
                  <div className="canvas-home-sort-menu" role="listbox" aria-label={t("sort.menu")}>
                    {sortOptions(t).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={sortMode === option.value}
                        onClick={() => {
                          setSortMode(option.value);
                          setSortMenuOpen(false);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="canvas-home-list">
              <button
                className="canvas-home-new-card"
                onClick={() => void createCanvas(t("untitled"))}
                disabled={creatingName !== null}
              >
                <span className="canvas-home-new-preview"><HomeIcon type="plus" /></span>
                <span className="canvas-home-new-copy">
                  <strong>{creatingName === t("untitled") ? t("blank.creating") : t("blank.title")}</strong>
                  <small>{t("blank.desc")}</small>
                </span>
              </button>
              {loading ? (
                Array.from({ length: 2 }, (_, index) => (
                  <div key={index} className="canvas-home-list-card canvas-home-skeleton" aria-hidden="true">
                    <span className="canvas-home-skeleton-preview" />
                    <span className="canvas-home-skeleton-line wide" />
                    <span className="canvas-home-skeleton-line" />
                  </div>
                ))
              ) : visibleCanvases.length === 0 ? (
                <div className="canvas-home-empty">
                  {query.trim() ? t("empty.query", { query: query.trim() }) : t("empty.default")}
                </div>
              ) : (
                visibleCanvases.map((canvas) => {
                  const cover = canvasCovers[canvas.id] || null;
                  const coverKey = cover ? `${canvas.id}:${cover.kind}:${cover.url}` : "";
                  const isRenaming = renamingId === canvas.id;
                  const showCover = !!cover && !failedCovers.has(coverKey);
                  return (
                    <article key={canvas.id} className="canvas-home-list-card">
                      <button className="canvas-home-list-open" onClick={() => openCanvas(canvas.id)} aria-label={t("action.openNamed", { name: canvas.name || t("untitled") })}>
                        <span className={`canvas-home-thumb${showCover ? " has-media" : ""}`}>
                          {showCover && cover?.kind === "image" ? (
                            <img
                              src={cover.url}
                              alt=""
                              onError={() => setFailedCovers((current) => new Set(current).add(coverKey))}
                            />
                          ) : showCover && cover?.kind === "video" ? (
                            <video
                              src={cover.url}
                              poster={cover.poster}
                              muted
                              playsInline
                              preload="metadata"
                              onLoadedMetadata={(event) => {
                                event.currentTarget.currentTime = Math.min(.1, event.currentTarget.duration || .1);
                              }}
                              onError={() => setFailedCovers((current) => new Set(current).add(coverKey))}
                            />
                          ) : (
                            <>
                              <CanvasMark />
                              <small>{t("cover.empty")}</small>
                            </>
                          )}
                        </span>
                      </button>
                      <div className="canvas-home-list-body">
                        {isRenaming ? (
                          <div className="canvas-home-rename-row">
                            <input
                              autoFocus
                              value={renamingDraft}
                              disabled={renamingSaving}
                              onChange={(event) => setRenamingDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void commitRename();
                                if (event.key === "Escape") cancelRename();
                              }}
                            />
                            <button onClick={() => void commitRename()} disabled={renamingSaving}>{renamingSaving ? t("action.saving") : t("action.save")}</button>
                            <button onClick={cancelRename} disabled={renamingSaving}>{t("action.cancel")}</button>
                          </div>
                        ) : (
                          <div className="canvas-home-card-heading">
                            <div className="canvas-home-card-copy">
                              <button className="canvas-home-list-title" onClick={() => openCanvas(canvas.id)} title={canvas.name}>
                                {canvas.name || t("untitled")}
                              </button>
                              <div className="canvas-home-list-meta">
                                {t("edited", { time: formatRelativeTime(canvas.updatedAt, t, plural) })}
                              </div>
                              {exportingId === canvas.id ? <div className="canvas-home-card-busy">{t("exporting")}</div> : null}
                            </div>
                            <div
                              className="canvas-home-card-menu-wrap"
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <button
                                className="canvas-home-card-menu-trigger"
                                onClick={() => setOpenMenuId((current) => current === canvas.id ? null : canvas.id)}
                                aria-label={t("menu.aria", { name: canvas.name || t("untitled") })}
                                aria-expanded={openMenuId === canvas.id}
                              >
                                <HomeIcon type="more" />
                              </button>
                              {openMenuId === canvas.id ? (
                                <div className="canvas-home-card-menu">
                                  <button onClick={() => { setOpenMenuId(null); openCanvas(canvas.id); }}>{t("action.open")}</button>
                                  <button onClick={() => {
                                    setOpenMenuId(null);
                                    void canvasFavorites.toggle(canvas.id, canvas.name || t("untitled"))
                                      .then((result) => {
                                        if (!result.cancelled) setMessage(result.favorited ? t("favorite.added") : t("favorite.removed"));
                                      })
                                      .catch(() => setMessage(t("favorite.error")));
                                  }} aria-pressed={canvasFavorites.byId.has(canvas.id)}>
                                    <FavoriteGlyph filled={canvasFavorites.byId.has(canvas.id)} />
                                    {canvasFavorites.byId.has(canvas.id) ? t("favorite.remove") : t("favorite.add")}
                                  </button>
                                  <button onClick={() => { setOpenMenuId(null); startRename(canvas); }}>{t("action.rename")}</button>
                                  <button disabled={exportingId !== null} onClick={() => { setOpenMenuId(null); void exportCanvas(canvas); }}>{t("action.export")}</button>
                                  <button className="danger" onClick={() => { setOpenMenuId(null); setDeleteTarget(canvas); }}>{t("action.delete")}</button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>

          <aside className="canvas-home-side">
            <section className="canvas-home-panel storage-panel">
              <div className="canvas-home-panel-head">
                <div>
                  <h2>{t("storage.title")}</h2>
                  <p>{t("storage.desc")}</p>
                </div>
              </div>
              <div className="canvas-home-storage-body">
                <div className={`canvas-home-storage-state ${storageCheck && !storageCheck.ok ? "bad" : "ok"}`}>
                  {storageCheck
                    ? storageCheck.ok
                      ? t("storage.ok")
                      : plural(storageCheck.issues.length, { one: "storage.issues.one", other: "storage.issues.other" })
                    : t("storage.unchecked")}
                </div>
                {storageCheck ? (
                  <div className="canvas-home-storage-meta">
                    {plural(storageCheck.canvasCount, { one: "storage.files.one", other: "storage.files.other" }, { checked: storageCheck.checkedFiles, total: storageCheck.canvasCount })}
                  </div>
                ) : null}
                {storageCheck && !storageCheck.ok && storageCheck.issues.length ? (
                  <div className="canvas-home-storage-issues">
                    {storageCheck.issues.slice(0, 3).map((issue) => <p key={issue}>{issue}</p>)}
                  </div>
                ) : null}
                <button onClick={openStorageDir}>{t("storage.open")}</button>
                <button onClick={() => void checkStorage()} disabled={storageChecking}>
                  {storageChecking ? t("storage.checking") : t("storage.check")}
                </button>
              </div>
            </section>

            <section className="canvas-home-panel template-panel">
              <div className="canvas-home-panel-head">
                <div>
                  <h2>{t("quick.title")}</h2>
                  <p>{t("quick.desc")}</p>
                </div>
              </div>
              <div className="canvas-home-template-grid">
                {templates(t).map((template, index) => (
                  <button
                    key={template.name}
                    className={`canvas-home-template-card tone-${index + 1}`}
                    onClick={() => void createCanvas(template.name)}
                    disabled={creatingName !== null}
                  >
                    <span className="canvas-home-template-icon">
                      <HomeIcon type={template.icon} />
                    </span>
                    <span className="canvas-home-template-copy">
                      <strong>{template.name}</strong>
                      <small>{creatingName === template.name ? t("action.creating") : template.description}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>

      {deleteTarget ? (
        <div className="canvas-home-dialog-backdrop" onClick={() => { if (!deletingId) setDeleteTarget(null); }}>
          <div className="canvas-home-dialog" onClick={(event) => event.stopPropagation()} aria-busy={deletingId === deleteTarget.id}>
            <h3>{t("delete.title")}</h3>
            <p>{t("delete.copy", { name: deleteTarget.name || t("untitled") })}</p>
            {message ? <div className="canvas-home-dialog-error">{message}</div> : null}
            <div className="canvas-home-dialog-actions">
              <button onClick={() => setDeleteTarget(null)} disabled={deletingId !== null}>{t("action.cancel")}</button>
              <button className="danger" onClick={() => void confirmDelete()} disabled={deletingId !== null}>
                {deletingId ? t("delete.deleting") : t("action.delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
