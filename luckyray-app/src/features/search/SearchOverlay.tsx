import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { openSearchResult } from "./searchEntityResolver";
import { openInLightSeek } from "../../core/services/openInLightSeek";
import { useGlobalSearch, type SearchOverlayScope, type SearchResult } from "./useGlobalSearch";
import { useI18n, type I18nContextValue, type MessageKey } from "../../core/i18n/index";
import "./search.css";
import { consumeGlobalSearchQuery, consumeMaterialSearchReturn } from "./searchOpenIntent";
import { dispatchMaterialsToolbarCommand } from "../materials/materialsToolbarProtocol";
import { matchesShortcut } from "../../app/shortcuts";
import { readSavedSettings } from "../settings/useSettings";

const SCOPES: Array<{ key: SearchOverlayScope; labelKey: MessageKey }> = [
  { key: "all", labelKey: "search.scope.all" },
  { key: "knowledge", labelKey: "search.scope.knowledge" },
  { key: "materials", labelKey: "search.scope.materials" },
  { key: "canvas", labelKey: "search.scope.canvas" },
  { key: "collection-box", labelKey: "search.scope.collection" },
];

const SEARCH_HISTORY_KEY = "luckyray-search-history-v1";

function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveSearchHistory(items: string[]) {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(items.slice(0, 8)));
  } catch {}
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function highlightMatch(value: string, query: string): string {
  if (!query) return escapeHtml(value);
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return escapeHtml(value);
  return `${escapeHtml(value.slice(0, index))}<mark>${escapeHtml(value.slice(index, index + query.length))}</mark>${escapeHtml(value.slice(index + query.length))}`;
}

function getResultIcon(item: SearchResult): string {
  switch (item.ref.kind) {
    case "material-asset":
      return '<svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" fill="none" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="6" cy="6" r="1.5"/><path d="M14 10l-4-4-6 6"/></svg>';
    case "collection-item":
      return '<svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" fill="none" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6h12"/></svg>';
    case "canvas":
      return '<svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" fill="none" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 5h2v2H5zM9 5h2v2H9zM5 9h2v2H5zM9 9h2v2H9z"/></svg>';
    default:
      return '<svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" fill="none" stroke-width="1.5"><path d="M3 2h7l4 4v8H3z"/><path d="M10 2v4h4"/><path d="M6 9h4M6 11h2"/></svg>';
  }
}

function resultTypeLabel(item: SearchResult, t: I18nContextValue["t"]): string {
  if (item.ref.kind === "material-asset") return t("search.result.material");
  if (item.ref.kind === "collection-item") return t("search.result.collection");
  if (item.ref.kind === "real-vault-note") return t("search.result.vaultNote");
  return t("search.result.localNote");
}

export default function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const {
    query,
    setQuery,
    matchedQuery,
    scope,
    setScope,
    groups,
    results,
    counts,
    focusedIdx,
    setFocusedIdx,
    loading,
    search,
    collectionBoxEnabled,
    refreshCanvasMetadata,
  } = useGlobalSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const materialReturn = useRef(false);
  const queryRef = useRef(query); queryRef.current = query;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [history, setHistory] = useState<string[]>(() => readSearchHistory());
  const [itemMenu, setItemMenu] = useState<{ item: SearchResult; x: number; y: number } | null>(null);
  const [handoffError, setHandoffError] = useState("");

  useEffect(() => {
    if (!open) return;
    const seed = consumeGlobalSearchQuery();
    materialReturn.current = consumeMaterialSearchReturn();
    if (seed !== undefined) { setQuery(seed); setScope("all"); void search(seed, "all"); }
    refreshCanvasMetadata();
    setHistory(readSearchHistory());
    setItemMenu(null);
    setHandoffError("");
    setFocusedIdx(-1);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 100);
    return () => {
      window.clearTimeout(timer);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (materialReturn.current) {
        materialReturn.current = false;
        dispatchMaterialsToolbarCommand({ type: "set-query", query: queryRef.current });
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.react-nav-shell[data-route="materials"] .titlebar-material-search input')?.focus({ preventScroll: true }));
      }
    };
  }, [open, refreshCanvasMetadata, setFocusedIdx]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    if (!itemMenu) return;
    const close = () => setItemMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [itemMenu]);

  const rememberQuery = useCallback((value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    const next = [normalized, ...history.filter((item) => item !== normalized)].slice(0, 8);
    setHistory(next);
    saveSearchHistory(next);
  }, [history]);

  const handleInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void search(value), 200);
  }, [search, setQuery]);

  const handleScope = useCallback((nextScope: SearchOverlayScope) => {
    setScope(nextScope);
    if (query.trim()) void search(query, nextScope);
  }, [query, search, setScope]);

  const handleSelect = useCallback((item: SearchResult) => {
    rememberQuery(query);
    onClose();
    openSearchResult(item);
  }, [onClose, query, rememberQuery]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (materialReturn.current && !(event.key === "Tab" && event.shiftKey)
      && readSavedSettings()["search.modeShortcutEnabled"] !== false && matchesShortcut(event.nativeEvent, "searchModeToggle")) {
      event.preventDefault(); event.stopPropagation();
      dispatchMaterialsToolbarCommand({ type: "set-search-mode", mode: "materials" });
      onClose(); return;
    }
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedIdx(Math.min(focusedIdx + 1, results.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedIdx(Math.max(focusedIdx - 1, 0));
      return;
    }
    if (event.key === "Enter" && focusedIdx >= 0 && results[focusedIdx]) {
      event.preventDefault();
      handleSelect(results[focusedIdx]);
    }
  }, [focusedIdx, handleSelect, onClose, results, setFocusedIdx]);

  const handleHistorySearch = useCallback((value: string) => {
    setQuery(value);
    void search(value);
    inputRef.current?.focus();
  }, [search, setQuery]);

  const openItemMenu = useCallback((item: SearchResult, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setItemMenu({ item, x: event.clientX, y: event.clientY });
  }, []);

  const askAiForItem = useCallback((item: SearchResult) => {
    try {
      openInLightSeek({
        source: "search",
        text: t("search.handoff.prompt", {
          type: resultTypeLabel(item, t),
          title: item.title,
          excerpt: item.excerpt || "",
        }).trim(),
      });
      setHandoffError("");
      setItemMenu(null);
      onClose();
    } catch {
      setHandoffError(t("search.handoff.failed"));
    }
  }, [onClose, t]);

  const copyResultText = useCallback(async (item: SearchResult) => {
    try {
      await navigator.clipboard?.writeText([item.title, item.excerpt].filter(Boolean).join("\n"));
    } catch {}
    setItemMenu(null);
  }, []);

  const visibleScopes = SCOPES.filter((item) => item.key !== "collection-box" || collectionBoxEnabled);

  if (!open) return null;

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(event) => event.stopPropagation()}>
        <div className="search-input-wrap">
          <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" /><line x1="11" y1="11" x2="14" y2="14" /></svg>
          <input
            ref={inputRef}
            type="text"
            placeholder={t("search.placeholder")}
            value={query}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
          />
          <span className="search-kbd">ESC</span>
        </div>

        <div className="search-tabs">
          {visibleScopes.map((item) => (
            <button
              key={item.key}
              className={`search-tab${scope === item.key ? " active" : ""}`}
              onClick={() => handleScope(item.key)}
            >
              {t(item.labelKey)}
              {counts[item.key] > 0 && <span className="search-tab-count">{counts[item.key]}</span>}
            </button>
          ))}
        </div>

        <div className="search-results">
          {!query.trim() ? (
            <>
              {history.length > 0 && (
                <div className="search-history">
                  <div className="search-section-label">{t("search.recent")}</div>
                  <div className="search-quick">
                    {history.map((item) => (
                      <button key={item} className="search-quick-item" onClick={() => handleHistorySearch(item)}>{item}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="search-section-label">{t("search.scope.label")}</div>
              <div className="search-quick">
                {visibleScopes.slice(1).map((item) => (
                  <button key={item.key} className="search-quick-item" onClick={() => handleScope(item.key)}>{t(item.labelKey)}</button>
                ))}
              </div>
            </>
          ) : results.length === 0 ? (
            <div className="search-empty">
              <p>{loading
                ? t("search.searching")
                : t("search.empty", { scope: t(visibleScopes.find((item) => item.key === scope)?.labelKey || "search.scope.all") })}</p>
            </div>
          ) : (
            groups.filter((group) => group.results.length > 0).map((group) => (
              <div key={group.scope}>
                <div className="search-section-label">{t(SCOPES.find((item) => item.key === group.scope)?.labelKey || "search.scope.all")}</div>
                {group.results.map((item) => {
                  const index = results.findIndex((candidate) => candidate.ref.kind === item.ref.kind && candidate.ref.id === item.ref.id);
                  return (
                    <SearchResultItem
                      key={`${item.ref.kind}:${item.ref.id}`}
                      item={item}
                      query={matchedQuery}
                      focused={focusedIdx === index}
                      onClick={() => handleSelect(item)}
                      onContextMenu={(event) => openItemMenu(item, event)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="search-hints">
          <span className="search-hint"><kbd>↑↓</kbd> {t("search.hint.navigate")}</span>
          <span className="search-hint"><kbd>Enter</kbd> {t("search.hint.open")}</span>
          <span className="search-hint"><kbd>Ctrl+K</kbd> {t("search.hint.search")}</span>
          {collectionBoxEnabled && <span className="search-hint">{t("search.collectionIsolated")}</span>}
        </div>
        {handoffError ? <div className="search-empty" role="status"><p>{handoffError}</p></div> : null}
        {itemMenu && (
          <div
            className="search-result-menu"
            style={{ left: itemMenu.x, top: itemMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button onClick={() => handleSelect(itemMenu.item)}>{t("common.action.open")}</button>
            <button onClick={() => askAiForItem(itemMenu.item)}>{t("search.action.sendLightSeek")}</button>
            <button onClick={() => void copyResultText(itemMenu.item)}>{t("search.action.copyText")}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function SearchResultItem({
  item,
  query,
  focused,
  onClick,
  onContextMenu,
}: {
  item: SearchResult;
  query: string;
  focused: boolean;
  onClick: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  return (
    <div className={`search-result-item${focused ? " focused" : ""}`} onClick={onClick} onContextMenu={onContextMenu}>
      <div className="search-result-icon" dangerouslySetInnerHTML={{ __html: getResultIcon(item) }} />
      <div className="search-result-info">
        <div className="search-result-name" dangerouslySetInnerHTML={{ __html: highlightMatch(item.title, query) }} />
        {(item.secondary || item.excerpt) && (
          <div className="search-result-path">
            {item.secondary && <span className="search-result-secondary">{item.secondary}</span>}
            {item.excerpt && <span className="search-result-excerpt" dangerouslySetInnerHTML={{ __html: highlightMatch(item.excerpt, query) }} />}
          </div>
        )}
      </div>
    </div>
  );
}
