import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { materialStore } from "../../core/services/materialStore";
import {
  MATERIAL_CHANGE_EVENT,
  MATERIAL_CHANGE_LOCAL_EVENT,
} from "../../core/services/materialChangeProtocol";
import {
  getMaterialAttachmentDetails,
  listFilteredMaterialAssets,
  type MaterialAsset,
  type MaterialAttachmentDetails,
} from "../../core/services/materials";
import { resolveMaterialPreviewTarget } from "../../core/services/materialCatalog";
import { readDecodedMediaGeometry, rememberDecodedMediaGeometry } from "./media/noteMediaReadyCache";
import "./noteAttachmentSidebar.css";
import { AttachmentProblem } from "./AttachmentProblem";

type Attachment = {
  asset: MaterialAsset;
  references: MaterialAttachmentDetails["references"];
};
type Props = {
  vaultId: string;
  currentPath: string | null;
  editable: boolean;
  onClose: () => void;
  onInsert: (asset: MaterialAsset) => Promise<void>;
  onOpenAsset: (id: string) => void;
  resolutionError?: string;
  onRetryResolution?: () => void;
};
const subscribeMaterials = (listener: () => void) =>
  materialStore.subscribe(listener);
const readMaterials = () => materialStore.getSnapshot();

export function groupNoteAttachments(
  items: Attachment[],
  vaultId: string,
  currentPath: string | null,
) {
  const groups = new Map<string, MaterialAsset[]>();
  for (const item of items)
    for (const reference of item.references) {
      if (reference.vaultId !== vaultId) continue;
      const group = groups.get(reference.notePath) || [];
      if (!group.some((asset) => asset.id === item.asset.id))
        group.push(item.asset);
      groups.set(reference.notePath, group);
    }
  return [...groups].sort(([a], [b]) =>
    a === currentPath ? -1 : b === currentPath ? 1 : a.localeCompare(b),
  );
}

function Thumbnail({ asset }: { asset: MaterialAsset }) {
  const [failed, setFailed] = useState(false);
  const target = resolveMaterialPreviewTarget(asset);
  useEffect(() => setFailed(false), [target?.url]);
  // The real measured aspect (when this source was decoded before) reserves
  // the exact shape instead of a fixed 4/3 dark box, so opening a note shows
  // media in place rather than a black card that later reflows.
  const remembered = target?.url ? readDecodedMediaGeometry(target.url) : null;
  const aspect = remembered ? `${remembered.width} / ${remembered.height}` : undefined;
  const geometry = remembered
    ? { width: remembered.width, height: remembered.height }
    : undefined;
  if (!target || failed)
    return (
      <span className="note-attachment-file" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" />
        </svg>
      </span>
    );
  return target.kind === "image" ? (
    <img
      src={target.url}
      alt=""
      loading="lazy"
      decoding="async"
      {...geometry}
      style={aspect ? { aspectRatio: aspect } : undefined}
      onLoad={(event) => rememberDecodedMediaGeometry(
        target.url,
        event.currentTarget.naturalWidth,
        event.currentTarget.naturalHeight,
      )}
      onError={() => setFailed(true)}
    />
  ) : (
    <video
      src={target.url}
      muted
      playsInline
      preload="metadata"
      style={aspect ? { aspectRatio: aspect } : undefined}
      onError={() => setFailed(true)}
      onMouseEnter={(event) => {
        void event.currentTarget.play().catch(() => {});
      }}
      onMouseLeave={(event) => event.currentTarget.pause()}
    />
  );
}

export function NoteAttachmentSidebar({
  vaultId,
  currentPath,
  editable,
  onClose,
  onInsert,
  onOpenAsset,
  resolutionError,
  onRetryResolution,
}: Props) {
  const materials = useSyncExternalStore(
    subscribeMaterials,
    readMaterials,
    readMaterials,
  );
  const [tab, setTab] = useState<"attachments" | "materials">("attachments");
  const [view, setView] = useState<"groups" | "grid">("groups");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(48);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => setVisibleCount(48), [tab, view, query, kind]);
  useEffect(() => {
    if (currentPath) setExpanded((paths) => new Set([...paths, currentPath]));
  }, [currentPath]);
  const requestRunning = useRef(false);
  const refreshPending = useRef(false);
  const discovered = useRef(false);
  useEffect(() => {
    void materialStore.ensureSnapshot({ reason: "notes-attachment-sidebar" });
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = (event: Event) => {
      if (event.type === "luckyray:notes-vault-index-changed" && (event as CustomEvent).detail?.attachmentsChanged === false) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (requestRunning.current) refreshPending.current = true;
        else setRetry((value) => value + 1);
      }, 300);
    };
    window.addEventListener("luckyray:notes-vault-index-changed", refresh);
    window.addEventListener(MATERIAL_CHANGE_EVENT, refresh);
    window.addEventListener(MATERIAL_CHANGE_LOCAL_EVENT, refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("luckyray:notes-vault-index-changed", refresh);
      window.removeEventListener(MATERIAL_CHANGE_EVENT, refresh);
      window.removeEventListener(MATERIAL_CHANGE_LOCAL_EVENT, refresh);
    };
  }, []);
  useEffect(() => {
    let current = true;
    requestRunning.current = true;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const readSnapshot = async (refreshAttachmentIndex: boolean) => {
          const assets = await listFilteredMaterialAssets(
            { scope: "note-attachments", vaultId },
            { refreshAttachmentIndex },
          );
          if (!current) return;
          const results: Attachment[] = [];
          // Read the existing catalog's relation authority, with bounded IPC work.
          for (let offset = 0; current && offset < assets.length; offset += 4) {
            results.push(
              ...(await Promise.all(
                assets.slice(offset, offset + 4).map(async (asset) => ({
                  asset,
                  references: (await getMaterialAttachmentDetails(asset.id))
                    .references,
                })),
              )),
            );
          }
          if (current) {
            setItems(results);
            setLoading(false);
          }
        };
        // Show the existing authoritative catalog immediately. Discovery of old
        // Vault files may be slow; it must not hide already indexed attachments.
        await readSnapshot(false);
        if (current && !discovered.current) {
          discovered.current = true;
          await readSnapshot(true);
        }
      } catch (cause) {
        if (current)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (current) {
          requestRunning.current = false;
          setLoading(false);
          if (refreshPending.current) {
            refreshPending.current = false;
            setRetry((value) => value + 1);
          }
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [vaultId, retry]);
  const filtered = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    const match = (asset: MaterialAsset) =>
      (!kind || asset.kind === kind) &&
      (!text ||
        `${asset.name} ${asset.description || ""}`
          .toLocaleLowerCase()
          .includes(text));
    return {
      materials: materials.allAssets.filter(match),
      attachments: items.filter((item) => match(item.asset)),
    };
  }, [query, kind, materials.allAssets, items]);
  const groups = useMemo(
    () => groupNoteAttachments(filtered.attachments, vaultId, currentPath),
    [filtered.attachments, vaultId, currentPath],
  );
  const insert = async (asset: MaterialAsset) => {
    if (busy || !editable) return;
    setBusy(asset.id);
    setError("");
    try {
      await onInsert(asset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const card = (asset: MaterialAsset) => (
    <div className="note-attachment-card" key={asset.id}>
      <button
        type="button"
        className="note-attachment-thumb"
        title={`预览 ${asset.name}`}
        onClick={() => onOpenAsset(asset.id)}
      >
        <Thumbnail asset={asset} />
        <span className="note-attachment-kind">
          {asset.kind === "video"
            ? "视频"
            : asset.kind === "image"
              ? "图片"
              : "文件"}
        </span>
      </button>
      <div className="note-attachment-caption">
        <span title={asset.name}>{asset.name}</span>
        <button
          type="button"
          disabled={!editable || Boolean(busy)}
          aria-label={`插入 ${asset.name}`}
          title={editable ? "插入到光标位置" : "请先打开可编辑笔记"}
          onClick={() => void insert(asset)}
        >
          {busy === asset.id ? "…" : "+"}
        </button>
      </div>
    </div>
  );
  const collection =
    tab === "materials"
      ? filtered.materials
      : filtered.attachments.map((item) => item.asset);
  return (
    <aside className="note-attachment-sidebar" aria-label="笔记附件侧栏">
      <header>
        <div
          className="note-attachment-tabs"
          role="tablist"
          aria-label="附件来源"
        >
          {(["attachments", "materials"] as const).map((value, index) => (
            <button
              type="button"
              id={`note-attachment-tab-${value}`}
              key={value}
              role="tab"
              aria-controls="note-attachment-panel"
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "attachments"
                      : event.key === "End"
                        ? "materials"
                        : index
                          ? "attachments"
                          : "materials";
                  setTab(next);
                  document
                    .getElementById(`note-attachment-tab-${next}`)
                    ?.focus();
                }
              }}
            >
              {value === "attachments" ? "笔记附件" : "素材库"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="note-attachment-close"
          aria-label="关闭附件侧栏"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="note-attachment-tools">
        <label>
          <svg viewBox="0 0 16 16">
            <circle cx="7" cy="7" r="4" />
            <path d="m10 10 3.5 3.5" />
          </svg>
          <input
            type="search"
            aria-label="搜索侧栏素材"
            placeholder="搜索名称或描述"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="素材类型"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="">全部类型</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="document">文档</option>
          <option value="audio">音频</option>
        </select>
      </div>
      {tab === "attachments" && (
        <div className="note-attachment-view">
          <div role="group" aria-label="附件视图">
            <button
              type="button"
              aria-pressed={view === "groups"}
              onClick={() => setView("groups")}
            >
              按笔记分组
            </button>
            <button
              type="button"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              素材视图
            </button>
          </div>
          <span>{collection.length} 项</span>
        </div>
      )}
      <div
        id="note-attachment-panel"
        role="tabpanel"
        aria-labelledby={`note-attachment-tab-${tab}`}
        className="note-attachment-scroll"
      >
        <AttachmentProblem error={resolutionError} onRetry={onRetryResolution} />
        {(error || (tab === "materials" && materials.error)) && (
          <div className="note-attachment-message" role="alert">
            {error || materials.error}
            <button
              type="button"
              onClick={() => {
                setRetry((value) => value + 1);
                void materialStore.ensureSnapshot({
                  reason: "notes-attachment-retry",
                });
              }}
            >
              重试
            </button>
          </div>
        )}
        {(
          tab === "attachments"
            ? loading && items.length === 0
            : !materials.loaded && !materials.error
        ) ? (
          <div className="note-attachment-message" role="status">
            正在读取附件…
          </div>
        ) : !collection.length ? (
          <div className="note-attachment-empty">
            <svg viewBox="0 0 24 24">
              <path d="m8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3" />
            </svg>
            <strong>
              {query || kind
                ? "没有匹配的素材"
                : tab === "attachments"
                  ? "这里还没有笔记附件"
                  : "素材库暂时为空"}
            </strong>
            <span>
              {query || kind
                ? "试试其他关键词或类型"
                : "插入到笔记的附件会显示在这里"}
            </span>
          </div>
        ) : tab === "attachments" && view === "groups" ? (
          groups.map(([notePath, assets]) => (
            <details
              className="note-attachment-group"
              key={notePath}
              open={expanded.has(notePath)}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpanded((paths) => {
                  if (paths.has(notePath) === open) return paths;
                  const next = new Set(paths);
                  if (open) next.add(notePath);
                  else next.delete(notePath);
                  return next;
                });
              }}
            >
              <summary title={notePath}>
                <span>
                  {notePath.split(/[\\/]/).pop()?.replace(/\.md$/i, "")}
                </span>
                {notePath === currentPath && <small>当前</small>}
                <b>{assets.length}</b>
              </summary>
              {expanded.has(notePath) && (
                <div className="note-attachment-grid">{assets.map(card)}</div>
              )}
            </details>
          ))
        ) : (
          <>
            <div className="note-attachment-grid">
              {collection.slice(0, visibleCount).map(card)}
            </div>
            {visibleCount < collection.length && (
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + 48)}
              >
                加载更多（{collection.length - visibleCount}）
              </button>
            )}
          </>
        )}
      </div>
      <footer>
        {editable ? "点击 + 插入光标位置" : "打开可编辑笔记后即可插入"}
      </footer>
    </aside>
  );
}
