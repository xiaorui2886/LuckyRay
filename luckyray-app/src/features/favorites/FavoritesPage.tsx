import { useSyncExternalStore } from "react";
import { materialLibrarySession } from "../../core/services/materialLibraryContext";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FavoriteGlyph } from "../../components/FavoriteGlyph";
import "../../components/contentBrowserControls.css";
import "../../components/editorialContentChrome.css";
import {
  FAVORITE_CHANGE_EVENT,
  favoriteHasNotes,
  getFavoriteItemCounts,
  listFavoriteItems,
  removeFavoriteItem,
  updateFavoriteItem,
  type FavoriteItemCounts,
  type FavoriteItemType,
} from "../../core/services/favorites";
import { materialStore } from "../../core/services/materialStore";
import { hydrateFavoriteSources, openFavoriteSource } from "./favoriteSources";
import {
  FAVORITE_TYPES,
  createFavoriteShelfLoader,
  defaultFavoriteViewState,
  filterAndSortFavorites,
  type FavoriteShelfEntry,
  type FavoriteShelfViewState,
  type FavoriteSort,
} from "./favoriteShelfModel";
import "./favorites.css";
import { defineMessages, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "type.material": { "zh-CN": "素材", "en-US": "Materials" },
  "type.note": { "zh-CN": "笔记", "en-US": "Notes" },
  "type.canvas": { "zh-CN": "画布", "en-US": "Canvases" },
  "sort.favorited": { "zh-CN": "最近收藏", "en-US": "Recently favorited" },
  "sort.modified": { "zh-CN": "最近修改", "en-US": "Recently modified" },
  "sort.name": { "zh-CN": "名称", "en-US": "Name" },
  "error.refresh": { "zh-CN": "收藏刷新失败（{reason}）", "en-US": "Could not refresh Favorites ({reason})" },
  "error.remove": { "zh-CN": "取消收藏失败", "en-US": "Could not remove Favorite" },
  "header.title": { "zh-CN": "收藏", "en-US": "Favorites" },
  "header.subtitle": { "zh-CN": "把值得回看的素材、笔记与画布，留在一处慢慢生长。", "en-US": "Keep worthwhile materials, notes, and canvases together as your ideas grow." },
  "toolbar.aria": { "zh-CN": "收藏浏览工具", "en-US": "Favorites browser tools" },
  "tabs.aria": { "zh-CN": "收藏分类", "en-US": "Favorite categories" },
  "search.aria": { "zh-CN": "搜索当前收藏", "en-US": "Search current Favorites" },
  "search.placeholder": { "zh-CN": "搜索{type}、主题或备注", "en-US": "Search {type}, themes, or notes" },
  "sort.label": { "zh-CN": "排序", "en-US": "Sort" },
  "status.refreshing": { "zh-CN": "正在更新", "en-US": "Updating" },
  "dialog.close": { "zh-CN": "关闭", "en-US": "Close" },
  "dialog.eyebrow": { "zh-CN": "取消收藏", "en-US": "Remove favorite" },
  "dialog.title": { "zh-CN": "移除“{name}”的收藏？", "en-US": "Remove “{name}” from Favorites?" },
  "dialog.notesWarning": { "zh-CN": "收藏主题和备注会一并删除，原内容不会受到影响。", "en-US": "Its favorite theme and note will be deleted; the original content stays untouched." },
  "dialog.referenceWarning": { "zh-CN": "这只会移除收藏引用，不会删除或移动原内容。", "en-US": "This removes only the Favorite reference and does not delete or move the original." },
  "dialog.keep": { "zh-CN": "保留收藏", "en-US": "Keep favorite" },
  "dialog.removing": { "zh-CN": "正在移除", "en-US": "Removing" },
  "dialog.remove": { "zh-CN": "取消收藏", "en-US": "Remove favorite" },
  "grid.aria": { "zh-CN": "{type}收藏", "en-US": "Favorite {type}" },
  "open.missing": { "zh-CN": "{name}，原内容不可用", "en-US": "{name}, original unavailable" },
  "open.confirm": { "zh-CN": "确认知识库后打开 {name}", "en-US": "Confirm the knowledge vault before opening {name}" },
  "open.item": { "zh-CN": "打开 {name}", "en-US": "Open {name}" },
  "note.meta": { "zh-CN": "笔记 · {date}", "en-US": "Note · {date}" },
  "source.confirm": { "zh-CN": "旧版收藏 · 打开前确认知识库", "en-US": "Legacy favorite · confirm the vault before opening" },
  "remove.named": { "zh-CN": "取消收藏 {name}", "en-US": "Remove {name} from Favorites" },
  "tags.aria": { "zh-CN": "{name} 的标签", "en-US": "Tags for {name}" },
  "preview.canvas": { "zh-CN": "画布预览", "en-US": "Canvas preview" },
  "preview.material": { "zh-CN": "素材", "en-US": "Material" },
  "editor.error": { "zh-CN": "收藏备注保存失败", "en-US": "Could not save the Favorite note" },
  "editor.theme": { "zh-CN": "收藏主题", "en-US": "Favorite theme" },
  "editor.copy": { "zh-CN": "写点备注", "en-US": "Write a note" },
  "editor.copyAria": { "zh-CN": "收藏文案", "en-US": "Favorite note" },
  "editor.saving": { "zh-CN": "保存中", "en-US": "Saving" },
  "editor.shortcut": { "zh-CN": "Ctrl + Enter 保存", "en-US": "Ctrl + Enter to save" },
  "editor.save": { "zh-CN": "保存", "en-US": "Save" },
  "editor.addTheme": { "zh-CN": "添加主题", "en-US": "Add theme" },
  "empty.material": { "zh-CN": "从素材卡片或详情中点亮收藏，灵感会出现在这里。", "en-US": "Favorite an asset card or detail to add inspiration here." },
  "empty.note": { "zh-CN": "在知识库中收藏值得回看的笔记。", "en-US": "Favorite notes worth revisiting from Knowledge." },
  "empty.canvas": { "zh-CN": "从画布首页收藏正在发展的想法。", "en-US": "Favorite developing ideas from Canvas Home." },
  "empty.noMatch": { "zh-CN": "没有匹配的收藏", "en-US": "No matching favorites" },
  "empty.none": { "zh-CN": "还没有{type}收藏", "en-US": "No favorite {type} yet" },
  "empty.queryHint": { "zh-CN": "换个关键词，或清空当前搜索。", "en-US": "Try another keyword or clear the search." },
  "loading.aria": { "zh-CN": "正在加载收藏", "en-US": "Loading Favorites" },
  "date.unknown": { "zh-CN": "更新时间未知", "en-US": "Update time unknown" },
  "kind.video": { "zh-CN": "视频", "en-US": "Video" },
  "kind.audio": { "zh-CN": "音频", "en-US": "Audio" },
  "kind.file": { "zh-CN": "文件", "en-US": "File" },
  "source.untitledNote": { "zh-CN": "未命名笔记", "en-US": "Untitled note" },
  "source.untitledMaterial": { "zh-CN": "未命名素材", "en-US": "Untitled material" },
  "source.untitledCanvas": { "zh-CN": "未命名画布", "en-US": "Untitled canvas" },
  "source.canvasNodes.one": { "zh-CN": "{count} 个节点", "en-US": "{count} node" },
  "source.canvasNodes.other": { "zh-CN": "{count} 个节点", "en-US": "{count} nodes" },
  "source.canvasEdges.one": { "zh-CN": "{count} 条连线", "en-US": "{count} connection" },
  "source.canvasEdges.other": { "zh-CN": "{count} 条连线", "en-US": "{count} connections" },
  "source.missingName": { "zh-CN": "原内容不可用", "en-US": "Original unavailable" },
  "source.missingSummary": { "zh-CN": "原内容可能已移动或删除，收藏备注仍保留。", "en-US": "The original may have moved or been deleted. Your Favorite note is preserved." },
  "source.legacyConfirm": { "zh-CN": "这条旧版收藏没有保存知识库身份。仅当当前知识库就是原收藏所在知识库时，才打开其中的同路径笔记。是否继续？", "en-US": "This legacy Favorite did not save its Knowledge vault identity. Continue only if the current vault is the original vault?" },
});

const FAVORITE_VIEW_STATE_KEY = "luckyray:favorite-shelf-view-v1";

type FavoriteT = ReturnType<typeof useMessages<typeof COPY>>["t"];
const typeLabel = (type: FavoriteItemType, t: FavoriteT) => t(`type.${type}` as "type.material" | "type.note" | "type.canvas");
const sortLabel = (sort: FavoriteSort, t: FavoriteT) => t(`sort.${sort}` as "sort.favorited" | "sort.modified" | "sort.name");

type PersistedFavoriteView = {
  activeType: FavoriteItemType;
  states: Record<FavoriteItemType, FavoriteShelfViewState>;
};

function readPersistedView(): PersistedFavoriteView {
  const defaults = { activeType: "material" as const, states: defaultFavoriteViewState() };
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITE_VIEW_STATE_KEY) || "{}") as Partial<PersistedFavoriteView>;
    const activeType = FAVORITE_TYPES.includes(parsed.activeType as FavoriteItemType)
      ? parsed.activeType as FavoriteItemType
      : defaults.activeType;
    const states = defaultFavoriteViewState();
    for (const type of FAVORITE_TYPES) {
      const candidate = parsed.states?.[type];
      if (!candidate) continue;
      states[type] = {
        query: typeof candidate.query === "string" ? candidate.query : "",
        sort: ["favorited", "modified", "name"].includes(candidate.sort) ? candidate.sort : "favorited",
        scrollTop: Number.isFinite(candidate.scrollTop) ? Math.max(0, candidate.scrollTop) : 0,
      };
    }
    return { activeType, states };
  } catch {
    return defaults;
  }
}

function writePersistedView(value: PersistedFavoriteView) {
  try {
    localStorage.setItem(FAVORITE_VIEW_STATE_KEY, JSON.stringify(value));
  } catch {}
}

export default function FavoritesPage() {
  const context = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  return <FavoritesContents key={`${context.libraryId}:${context.generation}`} />;
}
function FavoritesContents() {
  const { plural, t } = useMessages(COPY);
  const messagesRef = useRef(t);
  const pluralRef = useRef(plural);
  messagesRef.current = t;
  pluralRef.current = plural;
  const initial = useMemo(readPersistedView, []);
  const [activeType, setActiveType] = useState<FavoriteItemType>(initial.activeType);
  const [viewStates, setViewStates] = useState(initial.states);
  const [entriesByType, setEntriesByType] = useState<Partial<Record<FavoriteItemType, FavoriteShelfEntry[]>>>({});
  const [counts, setCounts] = useState<FavoriteItemCounts>({ material: 0, note: 0, canvas: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<FavoriteShelfEntry | null>(null);
  const [removing, setRemoving] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewStateRef = useRef(viewStates);
  const activeTypeRef = useRef(activeType);
  const entriesByTypeRef = useRef(entriesByType);

  viewStateRef.current = viewStates;
  activeTypeRef.current = activeType;
  entriesByTypeRef.current = entriesByType;

  const loaderRef = useRef<ReturnType<typeof createFavoriteShelfLoader> | null>(null);
  if (!loaderRef.current) {
    loaderRef.current = createFavoriteShelfLoader(
      async (itemType, publishCore) => hydrateFavoriteSources(
        itemType,
        await listFavoriteItems(itemType),
        publishCore,
        {
          untitledNote: messagesRef.current("source.untitledNote"),
          untitledMaterial: messagesRef.current("source.untitledMaterial"),
          untitledCanvas: messagesRef.current("source.untitledCanvas"),
          canvasSummary: (nodes, edges) => [
            pluralRef.current(nodes, { one: "source.canvasNodes.one", other: "source.canvasNodes.other" }),
            pluralRef.current(edges, { one: "source.canvasEdges.one", other: "source.canvasEdges.other" }),
          ].join(" · "),
          missingName: messagesRef.current("source.missingName"),
          missingSummary: messagesRef.current("source.missingSummary"),
        },
      ),
      (itemType, entries) => {
        setEntriesByType((current) => ({ ...current, [itemType]: entries }));
        setError("");
      },
    );
    loaderRef.current.activate(activeType);
  }

  const persist = useCallback((nextType = activeTypeRef.current, nextStates = viewStateRef.current) => {
    writePersistedView({ activeType: nextType, states: nextStates });
  }, []);

  const refreshCounts = useCallback(async () => {
    try {
      setCounts(await getFavoriteItemCounts());
    } catch {}
  }, []);

  const refresh = useCallback(async (itemType: FavoriteItemType, reason: string) => {
    const hasStale = Boolean(entriesByTypeRef.current[itemType]);
    if (hasStale) setRefreshing(true);
    else setLoading(true);
    try {
      await loaderRef.current!.refresh(itemType, { invalidate: true });
    } catch {
      setError(t("error.refresh", { reason }));
    } finally {
      if (activeTypeRef.current === itemType) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [t]);

  useEffect(() => {
    void refreshCounts();
    void refresh(activeType, "activate");
  }, [activeType, refresh, refreshCounts]);

  useEffect(() => {
    const refreshCurrent = () => {
      const type = activeTypeRef.current;
      void refresh(type, "source-change");
      void refreshCounts();
    };
    const refreshNotes = () => {
      if (activeTypeRef.current === "note") refreshCurrent();
    };
    window.addEventListener(FAVORITE_CHANGE_EVENT, refreshCurrent);
    window.addEventListener("luckyray:notes-vault-index-changed", refreshNotes);
    window.addEventListener("luckyray:note-external-updated", refreshNotes);
    return () => {
      window.removeEventListener(FAVORITE_CHANGE_EVENT, refreshCurrent);
      window.removeEventListener("luckyray:notes-vault-index-changed", refreshNotes);
      window.removeEventListener("luckyray:note-external-updated", refreshNotes);
    };
  }, [refresh, refreshCounts]);

  useEffect(() => {
    let observedVersion = materialStore.getSnapshot().version;
    const releaseProtocol = materialStore.retainChangeProtocol();
    const unsubscribe = materialStore.subscribe(() => {
      const nextVersion = materialStore.getSnapshot().version;
      if (nextVersion <= observedVersion) return;
      observedVersion = nextVersion;
      const type = activeTypeRef.current;
      if (type === "material" || type === "note") void refresh(type, "material-store-change");
    });
    return () => {
      unsubscribe();
      releaseProtocol();
    };
  }, [refresh]);

  useEffect(() => () => {
    const type = activeTypeRef.current;
    const scrollTop = viewportRef.current?.scrollTop || viewStateRef.current[type].scrollTop;
    const states = { ...viewStateRef.current, [type]: { ...viewStateRef.current[type], scrollTop } };
    writePersistedView({ activeType: type, states });
  }, []);

  useLayoutEffect(() => {
    if (!entriesByType[activeType] || !viewportRef.current) return;
    viewportRef.current.scrollTop = viewStates[activeType].scrollTop;
  }, [activeType, entriesByType, viewStates]);

  const setType = (nextType: FavoriteItemType) => {
    if (nextType === activeType) return;
    const nextStates = {
      ...viewStateRef.current,
      [activeType]: {
        ...viewStateRef.current[activeType],
        scrollTop: viewportRef.current?.scrollTop || 0,
      },
    };
    viewStateRef.current = nextStates;
    loaderRef.current!.activate(nextType);
    setViewStates(nextStates);
    setActiveType(nextType);
    activeTypeRef.current = nextType;
    persist(nextType, nextStates);
  };

  const patchCurrentView = (patch: Partial<FavoriteShelfViewState>) => {
    setViewStates((current) => {
      const next = { ...current, [activeType]: { ...current[activeType], ...patch } };
      viewStateRef.current = next;
      persist(activeType, next);
      return next;
    });
  };

  const currentView = viewStates[activeType];
  const entries = entriesByType[activeType] || [];
  const visibleEntries = useMemo(
    () => filterAndSortFavorites(entries, currentView),
    [entries, currentView],
  );

  const saveNotes = async (entry: FavoriteShelfEntry, theme: string, copy: string) => {
    const updated = await updateFavoriteItem(entry.favorite.itemType, entry.favorite.itemId, theme, copy);
    setEntriesByType((current) => ({
      ...current,
      [entry.favorite.itemType]: (current[entry.favorite.itemType] || []).map((candidate) => (
        candidate.favorite.itemId === updated.itemId ? { ...candidate, favorite: updated } : candidate
      )),
    }));
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await removeFavoriteItem(removeTarget.favorite.itemType, removeTarget.favorite.itemId);
      setRemoveTarget(null);
    } catch {
      setError(t("error.remove"));
    } finally {
      setRemoving(false);
    }
  };

  const requestRemove = async (entry: FavoriteShelfEntry) => {
    if (favoriteHasNotes(entry.favorite)) {
      setRemoveTarget(entry);
      return;
    }
    try {
      await removeFavoriteItem(entry.favorite.itemType, entry.favorite.itemId);
    } catch {
      setError(t("error.remove"));
    }
  };

  return (
    <main className="favorites-page editorial-page-surface">
      <header className="favorites-header editorial-page-heading">
        <div>
          <h1>{t("header.title")}</h1>
          <p className="favorites-subtitle">{t("header.subtitle")}</p>
        </div>
      </header>

      <section className="favorites-toolbar" aria-label={t("toolbar.aria")}>
        <div className="favorites-tabs" role="tablist" aria-label={t("tabs.aria")}>
          {FAVORITE_TYPES.map((type) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeType === type}
              className={activeType === type ? "active" : ""}
              key={type}
              onClick={() => setType(type)}
            >
              {typeLabel(type, t)} <span>{counts[type]}</span>
            </button>
          ))}
        </div>
        <div className="favorites-controls">
          <label className="favorites-search content-browser-control">
            <SearchIcon />
            <span className="sr-only">{t("search.aria")}</span>
            <input
              value={currentView.query}
              onChange={(event) => patchCurrentView({ query: event.target.value })}
              placeholder={t("search.placeholder", { type: typeLabel(activeType, t) })}
            />
          </label>
          <label className="favorites-sort">
            <span>{t("sort.label")}</span>
            <select className="content-browser-control"
              value={currentView.sort}
              onChange={(event) => patchCurrentView({ sort: event.target.value as FavoriteSort })}
            >
              {(["favorited", "modified", "name"] as FavoriteSort[]).map((value) => <option key={value} value={value}>{sortLabel(value, t)}</option>)}
            </select>
          </label>
        </div>
      </section>

      <div
        ref={viewportRef}
        className="favorites-viewport"
        onScroll={(event) => {
          viewStateRef.current[activeType].scrollTop = event.currentTarget.scrollTop;
        }}
      >
        {refreshing ? <div className="favorites-refreshing" role="status">{t("status.refreshing")}</div> : null}
        {error ? <div className="favorites-error" role="status">{error}</div> : null}
        {loading && !entriesByType[activeType] ? (
          <FavoriteSkeleton type={activeType} />
        ) : visibleEntries.length ? (
          <FavoriteGrid
            type={activeType}
            entries={visibleEntries}
            onSaveNotes={saveNotes}
            onRemove={(entry) => void requestRemove(entry)}
          />
        ) : (
          <FavoriteEmpty type={activeType} hasQuery={Boolean(currentView.query.trim())} />
        )}
      </div>

      {removeTarget ? (
        <div className="favorites-dialog-backdrop experience-dialog-backdrop" role="presentation" onPointerDown={(event) => {
          if (event.target === event.currentTarget && !removing) setRemoveTarget(null);
        }}>
          <section
            className="favorites-dialog experience-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="favorite-remove-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !removing) setRemoveTarget(null);
            }}
          >
            <button type="button" className="favorites-dialog-close" onClick={() => setRemoveTarget(null)} disabled={removing} aria-label={t("dialog.close")}>×</button>
            <p className="favorites-dialog-eyebrow">{t("dialog.eyebrow")}</p>
            <h2 id="favorite-remove-title">{t("dialog.title", { name: removeTarget.name })}</h2>
            <p>{removeTarget.favorite.theme.trim() || removeTarget.favorite.copy.trim()
              ? t("dialog.notesWarning")
              : t("dialog.referenceWarning")}</p>
            <div className="favorites-dialog-actions">
              <button type="button" autoFocus onClick={() => setRemoveTarget(null)} disabled={removing}>{t("dialog.keep")}</button>
              <button type="button" className="danger" onClick={() => void confirmRemove()} disabled={removing}>
                {removing ? t("dialog.removing") : t("dialog.remove")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function FavoriteGrid({
  type,
  entries,
  onSaveNotes,
  onRemove,
}: {
  type: FavoriteItemType;
  entries: FavoriteShelfEntry[];
  onSaveNotes: (entry: FavoriteShelfEntry, theme: string, copy: string) => Promise<void>;
  onRemove: (entry: FavoriteShelfEntry) => void;
}) {
  const { locale, t } = useMessages(COPY);
  return (
    <section className={`favorites-grid ${type}`} aria-label={t("grid.aria", { type: typeLabel(type, t) })}>
      {entries.map((entry) => (
        <article className={`favorite-card ${type}${entry.missing ? " missing" : ""}`} key={entry.favorite.itemId}>
          <button
            type="button"
            className="favorite-card-open"
            onClick={() => openFavoriteSource(entry, t("source.legacyConfirm"))}
            disabled={entry.missing}
            aria-label={entry.missing
              ? t("open.missing", { name: entry.name })
              : entry.sourceConfirmation
                ? t("open.confirm", { name: entry.name })
                : t("open.item", { name: entry.name })}
          >
            <FavoritePreview entry={entry} />
          </button>
          <div className="favorite-card-body">
            <div className="favorite-source-row">
              <div>
                {type === "note" ? <p className="favorite-note-footer-meta">{t("note.meta", { date: formatDate(entry.sourceUpdatedAt, locale, t) })}</p> : <h2>{entry.name}</h2>}
                {type === "canvas" ? <p>{entry.summary} · {formatDate(entry.sourceUpdatedAt, locale, t)}</p> : null}
                {entry.sourceConfirmation ? <p className="favorite-source-confirmation">{t("source.confirm")}</p> : null}
                {entry.missing ? <p>{entry.summary}</p> : null}
              </div>
              <button type="button" className="favorite-remove" onClick={() => onRemove(entry)} aria-label={t("remove.named", { name: entry.name })} title={t("dialog.remove")}>
                <FavoriteGlyph filled />
              </button>
            </div>
            {(type === "material" || type === "note") && entry.tags.length ? (
              <div className="favorite-tag-row" aria-label={t("tags.aria", { name: entry.name })}>
                {entry.tags.slice(0, 3).map((tag) => (
                  <span
                    className="favorite-tag-chip"
                    key={tag.id}
                    style={{ "--favorite-tag-color": tag.color || "var(--favorite-accent)" } as CSSProperties}
                    title={tag.name}
                  >
                    {tag.name}
                  </span>
                ))}
                {entry.tags.length > 3 ? <span className="favorite-tag-more">+{entry.tags.length - 3}</span> : null}
              </div>
            ) : null}
            <FavoriteNotesEditor entry={entry} onSave={onSaveNotes} />
          </div>
        </article>
      ))}
    </section>
  );
}

function FavoritePreview({ entry }: { entry: FavoriteShelfEntry }) {
  const { t } = useMessages(COPY);
  const source = previewSource(entry.previewUrl);
  if (entry.favorite.itemType === "note") {
    return (
      <span className={`favorite-note-cover ${source ? "has-image" : "article"}`}>
        {source ? <img src={source} alt="" /> : null}
        <span className="favorite-note-cover-content">
          <NoteIcon />
          <strong>{entry.name}</strong>
          {entry.summary ? <small>{entry.summary}</small> : null}
        </span>
      </span>
    );
  }
  if (entry.favorite.itemType === "canvas") {
    return (
      <span className={`favorite-canvas-cover ${source ? "has-image" : ""}`}>
        {source ? <img src={source} alt="" /> : <><CanvasIcon /><small>{t("preview.canvas")}</small></>}
      </span>
    );
  }
  return (
    <span className={`favorite-material-cover ${source ? "has-image" : ""}`}>
      {source ? <img src={source} alt="" /> : <><MaterialKindIcon kind={entry.previewKind} /><small>{entry.materialKind || t("preview.material")}</small></>}
      {entry.previewKind !== "image" ? <span className="favorite-kind-badge">{materialKindLabel(entry.previewKind, t)}</span> : null}
    </span>
  );
}

function FavoriteNotesEditor({
  entry,
  onSave,
}: {
  entry: FavoriteShelfEntry;
  onSave: (entry: FavoriteShelfEntry, theme: string, copy: string) => Promise<void>;
}) {
  const { t } = useMessages(COPY);
  const [editing, setEditing] = useState(false);
  const [theme, setTheme] = useState(entry.favorite.theme);
  const [copy, setCopy] = useState(entry.favorite.copy);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const editorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (editing) return;
    setTheme(entry.favorite.theme);
    setCopy(entry.favorite.copy);
  }, [editing, entry.favorite.copy, entry.favorite.theme]);

  const save = async () => {
    if (saving) return;
    if (theme === entry.favorite.theme && copy === entry.favorite.copy) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setStatus("");
    try {
      await onSave(entry, theme, copy);
      setEditing(false);
    } catch {
      setStatus(t("editor.error"));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div
        className="favorite-notes-editor"
        ref={editorRef}
        onBlur={(event) => {
          if (!event.relatedTarget || !editorRef.current?.contains(event.relatedTarget as Node)) void save();
        }}
      >
        <input
          autoFocus
          value={theme}
          maxLength={120}
          onChange={(event) => setTheme(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void save(); }
            if (event.key === "Escape") setEditing(false);
          }}
          placeholder={t("editor.theme")}
          aria-label={t("editor.theme")}
        />
        <textarea
          value={copy}
          maxLength={1200}
          rows={3}
          onChange={(event) => setCopy(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
            if (event.key === "Escape") setEditing(false);
          }}
          placeholder={t("editor.copy")}
          aria-label={t("editor.copyAria")}
        />
        <div className="favorite-editor-actions">
          <span>{status || (saving ? t("editor.saving") : t("editor.shortcut"))}</span>
          <button type="button" onClick={() => void save()} disabled={saving}>{t("editor.save")}</button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" className="favorite-notes-display" onClick={() => setEditing(true)}>
      <strong>{entry.favorite.theme || t("editor.addTheme")}</strong>
      <span>{entry.favorite.copy || t("editor.copy")}</span>
      <EditIcon />
    </button>
  );
}

function FavoriteEmpty({ type, hasQuery }: { type: FavoriteItemType; hasQuery: boolean }) {
  const { t } = useMessages(COPY);
  const copy = type === "material"
    ? t("empty.material")
    : type === "note"
      ? t("empty.note")
      : t("empty.canvas");
  return (
    <section className="favorites-empty">
      <FavoriteGlyph />
      <h2>{hasQuery ? t("empty.noMatch") : t("empty.none", { type: typeLabel(type, t) })}</h2>
      <p>{hasQuery ? t("empty.queryHint") : copy}</p>
    </section>
  );
}

function FavoriteSkeleton({ type }: { type: FavoriteItemType }) {
  const { t } = useMessages(COPY);
  return <div className={`favorites-grid ${type} skeleton`} aria-label={t("loading.aria")}>{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>;
}

function previewSource(value: string | null) {
  if (!value?.trim()) return "";
  const source = value.trim();
  if (/^(https?:|asset:|blob:|data:)/i.test(source)) return source;
  try { return convertFileSrc(source); } catch { return source; }
}

function formatDate(value: string | null, locale: "zh-CN" | "en-US", t: FavoriteT) {
  if (!value) return t("date.unknown");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("date.unknown") : date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

function materialKindLabel(kind: FavoriteShelfEntry["previewKind"], t: FavoriteT) {
  if (kind === "video") return t("kind.video");
  if (kind === "audio") return t("kind.audio");
  return t("kind.file");
}

function SearchIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" /><path d="m12.2 12.2 4 4" /></svg>; }
function EditIcon() { return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="m4 12.8-.6 2.3 2.3-.6 7.8-7.8-1.7-1.7Z" /><path d="m10.9 5.9 1.7 1.7" /></svg>; }
function NoteIcon() { return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M7 4h11l4 4v16H7Z" /><path d="M18 4v5h4M10 13h8M10 17h8" /></svg>; }
function CanvasIcon() { return <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="5" width="24" height="20" rx="3" /><circle cx="11" cy="12" r="2" /><path d="m7 22 7-7 4 4 3-3 4 5" /></svg>; }
function MaterialKindIcon({ kind }: { kind: FavoriteShelfEntry["previewKind"] }) { return kind === "audio" ? <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M13 22V8l12-2v14" /><circle cx="9" cy="23" r="4" /><circle cx="21" cy="21" r="4" /></svg> : <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="6" width="24" height="20" rx="3" /><path d="m12 12 8 4-8 4Z" /></svg>; }
