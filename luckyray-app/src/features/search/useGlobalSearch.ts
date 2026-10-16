import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLLECTION_NAV_SETTING_KEY,
  DEFAULT_SEARCH_SCOPES,
  isCollectionBoxSearchEnabled,
  resolveSearchScopes,
  searchCoordinator,
  type SearchResult,
  type SearchResultGroup,
  type SearchScope,
} from "./searchCore";
import { useI18n } from "../../core/i18n/index";

export type SearchOverlayScope = "all" | SearchScope;

function parseScopeShortcut(value: string): { text: string; scope?: SearchOverlayScope } {
  let scope: SearchOverlayScope | undefined;
  const text = value.replace(/\btype:([^\s]+)/gi, (_, raw: string) => {
    const normalized = raw.toLocaleLowerCase();
    if (/^(知识库|笔记|note|notes|knowledge)$/i.test(normalized)) scope = "knowledge";
    if (/^(素材库|素材|asset|assets|material|materials)$/i.test(normalized)) scope = "materials";
    if (/^(画布|canvas|canvases)$/i.test(normalized)) scope = "canvas";
    if (/^(素材箱|采集箱|collection|inbox)$/i.test(normalized)) scope = "collection-box";
    return "";
  });
  return { text: text.replace(/\s+/g, " ").trim(), scope };
}

export function useGlobalSearch() {
  const { locale } = useI18n();
  const [query, setQuery] = useState("");
  const [matchedQuery, setMatchedQuery] = useState("");
  const [scope, setScope] = useState<SearchOverlayScope>("all");
  const [groups, setGroups] = useState<SearchResultGroup[]>([]);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [collectionBoxEnabled, setCollectionBoxEnabled] = useState(isCollectionBoxSearchEnabled);
  const versionRef = useRef(0);
  const collectionBoxEnabledRef = useRef(collectionBoxEnabled);

  useEffect(() => {
    collectionBoxEnabledRef.current = collectionBoxEnabled;
  }, [collectionBoxEnabled]);

  useEffect(() => searchCoordinator.retain(), []);

  useEffect(() => {
    const onSettingsChange = (event: Event) => {
      const settings = (event as CustomEvent<{ settings?: Record<string, unknown> }>).detail?.settings;
      const next = settings?.[COLLECTION_NAV_SETTING_KEY];
      const nextEnabled = typeof next === "boolean" ? next : isCollectionBoxSearchEnabled();
      const wasEnabled = collectionBoxEnabledRef.current;
      collectionBoxEnabledRef.current = nextEnabled;
      setCollectionBoxEnabled(nextEnabled);
      if (wasEnabled && !nextEnabled) {
        searchCoordinator.cancel();
        searchCoordinator.invalidate("collection-box");
        setGroups((current) => current.filter((group) => group.scope !== "collection-box"));
        setFocusedIdx(-1);
        setLoading(false);
      }
    };
    window.addEventListener("luckyray:settings-change", onSettingsChange);
    return () => window.removeEventListener("luckyray:settings-change", onSettingsChange);
  }, []);

  const search = useCallback(async (rawQuery: string, requestedScope?: SearchOverlayScope) => {
    const version = ++versionRef.current;
    const parsed = parseScopeShortcut(rawQuery);
    const candidateScope = requestedScope || parsed.scope || scope;
    const nextScope = candidateScope === "collection-box" && !collectionBoxEnabled ? "all" : candidateScope;
    const text = parsed.text;
    if (!text) {
      setGroups([]);
      setFocusedIdx(-1);
      setLoading(false);
      setMatchedQuery("");
      return;
    }
    setMatchedQuery(text);
    setLoading(true);
    try {
      const response = await searchCoordinator.search({
        text,
        scopes: resolveSearchScopes(nextScope),
        limit: 30,
        locale,
      });
      if (version !== versionRef.current || response.stale) return;
      setGroups(response.groups);
      setFocusedIdx(-1);
    } finally {
      if (version === versionRef.current) setLoading(false);
    }
  }, [collectionBoxEnabled, locale, scope]);

  const previousLocaleRef = useRef(locale);
  useEffect(() => {
    if (previousLocaleRef.current === locale) return;
    previousLocaleRef.current = locale;
    searchCoordinator.invalidate();
    if (query.trim()) void search(query, scope);
  }, [locale, query, scope, search]);

  useEffect(() => {
    if (collectionBoxEnabled || scope !== "collection-box") return;
    searchCoordinator.cancel();
    searchCoordinator.invalidate("collection-box");
    setGroups([]);
    setFocusedIdx(-1);
    setLoading(false);
    setScope("all");
    if (query.trim()) void search(query, "all");
  }, [collectionBoxEnabled, query, scope, search]);

  const results = useMemo(() => groups.flatMap((group) => group.results), [groups]);
  const counts = useMemo(() => {
    const byScope = new Map(groups.map((group) => [group.scope, group.results.length]));
    const knowledge = byScope.get("knowledge") || 0;
    const materials = byScope.get("materials") || 0;
    const canvas = byScope.get("canvas") || 0;
    const collectionBox = byScope.get("collection-box") || 0;
    return {
      all: scope === "all" ? knowledge + materials + canvas : results.length,
      knowledge,
      materials,
      canvas,
      "collection-box": collectionBox,
    };
  }, [groups, results.length, scope]);

  const refreshCanvasMetadata = useCallback(() => {
    searchCoordinator.invalidate("canvas");
  }, []);

  return {
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
    defaultScopes: DEFAULT_SEARCH_SCOPES,
    collectionBoxEnabled,
    refreshCanvasMetadata,
  };
}

export type { SearchResult };
