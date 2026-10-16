import { Activity, Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import { isEnabled } from "../featureFlags";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FeatureFlagKey } from "../featureFlags";
import { installLuckyRayBridge } from "../luckyrayBridge";
import { startMaterialWatchService } from "../features/materials/materialWatch";
import { applyGlobalSettings, getShellAccentTheme, readSavedSettings, useSavedLocale } from "../features/settings/useSettings";
import { PluginEntryMenu, useScriptPackages, openPlugin } from "../features/community/ScriptPlugins";
import { PluginPageHost } from "../features/community/PluginPageHost";
import { usePluginSidebarPages } from "./usePluginSidebarPages";
import type { ScriptResource } from "../core/extensions/packages";
import { extensionPackages } from "../core/extensions/packages";
import { I18nProvider, useI18n } from "../core/i18n/index";
import { resolveScopedShortcut, type ShortcutCommandId, type ShortcutScope } from "./shortcuts";
import { registerLuckyRayGlobalShortcuts } from "./globalShortcuts";
import { getCommandIdForShortcut, listPaletteCommands, runAppCommand, type LuckyRayCommand } from "../core/commands/appCommands";
import { focusEntity } from "../core/services/context";
import { canvasEditorHash } from "../features/canvas/canvasNavigation";
import LegacyRoute from "./LegacyRoute";
import { AppSidebar, AppTitlebar } from "./AppSidebar";
import type { ShellRoute } from "./AppSidebar";
import {
  ApplicationModalIsolationProvider,
  createApplicationModalIsolationStore,
  useApplicationModalIsolationSnapshot,
} from "./applicationModalIsolation";
import { CompactSurfaceCoordinatorProvider, type CompactSurfaceCoordinator } from "./compactSurfaceCoordinator";
import { normalizeRetiredWorkspaceRoute, selectShellRouteMode } from "./shellRouteSelection";
import { selectCompactShellForViewport } from "./shellViewport";
import { syncWindowSurfaceBackground } from "./windowSurfaceBackground";
import { canApplyCompanionPresentation } from "./companionPresentationLease";
import { ExperienceOverlayProvider } from "../components/ExperienceOverlay";
import { CompanionPresentationProvider } from "../features/settings/CompanionPresentation";
import PhoneConnectionDialog from "../features/settings/PhoneConnectionDialog";
import {windowLayoutStore} from "../workspace/layoutStore";
import {defaultPresentation} from "../workspace/presentation";
import {newlyHiddenNavigationFallback,resolveNavigationPresentation,type NavigationVisibility} from "../workspace/navigationVisibility";
import {readSidebarPrefs} from "../features/community/pluginPages";
import "./appShell.css";
import "../components/experienceLayer.css";

type SidebarMotionIntent = "automatic" | "manual";

const TagsPage = lazy(() => import("../features/tags/TagsPage"));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage"));
const DshNativeSurfacePage = lazy(() => import("../features/ai/DshNativeSurfacePage"));
const MaterialsPage = lazy(() => import("../features/materials/MaterialsPage"));
const NoteAttachmentsPage = lazy(() => import("../features/materials/NoteAttachmentsPage"));
const NotesPage = lazy(() => import("../features/notes/NotesPage"));
const GraphPage = lazy(() => import("../features/graph/GraphPage"));
const CommunityPage = lazy(() => import("../features/community/CommunityPage"));
const CollectionPage = lazy(() => import("../features/collection/CollectionPage"));
const FavoritesPage = lazy(() => import("../features/favorites/FavoritesPage"));
const SmartFoldersPage = lazy(() => import("../features/smartFolders/SmartFoldersPage"));
const CanvasHomePage = lazy(() => import("../features/canvas/CanvasHomePage"));
const CanvasSpike = lazy(() => import("../CanvasSpike"));
const SearchOverlay = lazy(() => import("../features/search/SearchOverlay"));
const BrowserPage = lazy(() => import("../features/browser/BrowserPage"));

const ROUTE_CONFIG: Record<string, { flag: FeatureFlagKey; Component: LazyExoticComponent<ComponentType> }> = {
  tags: { flag: "tagsReact", Component: TagsPage },
  settings: { flag: "settingsReact", Component: SettingsPage },
  ai: { flag: "aiReact", Component: DshNativeSurfacePage },
  materials: { flag: "materialsReact", Component: MaterialsPage },
  attachments: { flag: "materialsReact", Component: NoteAttachmentsPage },
  notes: { flag: "notesReact", Component: NotesPage },
  graph: { flag: "graphReact", Component: GraphPage },
};

const SHELL_ROUTES: ShellRoute[] = ["materials", "attachments", "notes", "graph", "canvas", "browser", "community", "ai", "tags", "collection", "favorites", "smart", "settings", "plugins"];
const LAST_ROUTE_KEY = "luckyray-last-route-v1";
const RETAINED_WORKSPACE_ROUTES = new Set(["materials", "notes", "graph"]);

function getHashRoute(): string {
  return getHashPath().split("/")[0] || "";
}

function getHashPath(): string {
  return normalizeRetiredWorkspaceRoute(window.location.hash.replace(/^#\/?/, "").split("?")[0] || "");
}

function getShellRoute(route: string): ShellRoute {
  route = normalizeRetiredWorkspaceRoute(route);
  return SHELL_ROUTES.includes(route as ShellRoute) ? (route as ShellRoute) : "materials";
}

function readLastRoute(): string {
  try {
    return normalizeRetiredWorkspaceRoute(localStorage.getItem(LAST_ROUTE_KEY) || "materials");
  } catch {
    return "materials";
  }
}

function resolveInitialRoute(): string {
  const hashRoute = getHashRoute();
  if (hashRoute) return hashRoute;
  const settings = readSavedSettings();
  const startup = String(settings["general.startup"] || "last");
  if (startup === "last") return readLastRoute();
  return getShellRoute(startup);
}

function rememberRoute(key: string) {
  try {
    localStorage.setItem(LAST_ROUTE_KEY, key);
  } catch {
    // Ignore storage failures in restricted webviews.
  }
}

function shouldAllowNativeContextMenu(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  if (element.closest("[data-native-context-menu]")) return true;
  if (element.closest("input, textarea, select")) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

export default function AppShell() {
  const locale = useSavedLocale();
  return (
    <I18nProvider locale={locale}>
      <CompanionPresentationProvider><LocalizedAppShell /></CompanionPresentationProvider>
    </I18nProvider>
  );
}

function LocalizedAppShell() {
  const [route, setRoute] = useState(resolveInitialRoute);
  const [hashPath, setHashPath] = useState(getHashPath);
  const [searchOpen, setSearchOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [shortcutRevision, setShortcutRevision] = useState(0);
  const applicationModalStore = useMemo(createApplicationModalIsolationStore, []);
  const applicationModalActive = useApplicationModalIsolationSnapshot(applicationModalStore);

  const commandContext = useMemo(() => ({
    openSearch: () => {
      if (!applicationModalStore.getSnapshot()) setSearchOpen(true);
    },
    openCommandPalette: () => {
      if (!applicationModalStore.getSnapshot()) setCommandOpen(true);
    },
    getRoute: () => getShellRoute(getHashRoute()),
  }), [applicationModalStore]);

  useEffect(() => {
    const normalizeRetiredHash = () => {
      const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0];
      if (normalizeRetiredWorkspaceRoute(raw) !== raw) window.history.replaceState(null, "", "#notes");
    };
    normalizeRetiredHash();
    const onHashChange = () => {
      normalizeRetiredHash();
      const nextRoute = getHashRoute();
      const nextPath = getHashPath();
      setHashPath(nextPath);
      setRoute(nextRoute);
      rememberRoute(nextRoute === "plugins" ? nextPath : nextRoute);
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    if (!getHashRoute()) {
      const initial = resolveInitialRoute();
      window.history.replaceState(null, "", `#${initial}`);
      setHashPath(getHashPath());
      rememberRoute(initial);
    } else {
      setHashPath(getHashPath());
      rememberRoute(getHashPath());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const runGlobalShortcutCommand = useCallback((command: ShortcutCommandId) => {
    if (applicationModalStore.getSnapshot()) return;
    const commandId = getCommandIdForShortcut(command);
    if (commandId) void runAppCommand(commandId, commandContext);
  }, [applicationModalStore, commandContext]);

  useEffect(() => {
    const onShortcutsChange = () => setShortcutRevision((value) => value + 1);
    window.addEventListener("luckyray:shortcuts-change", onShortcutsChange);
    return () => window.removeEventListener("luckyray:shortcuts-change", onShortcutsChange);
  }, []);

  useEffect(() => {
    return registerLuckyRayGlobalShortcuts(runGlobalShortcutCommand);
  }, [runGlobalShortcutCommand, shortcutRevision]);

  useEffect(() => {
    const suppressNativeContextMenu = (event: MouseEvent) => {
      if (shouldAllowNativeContextMenu(event.target)) return;
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppressNativeContextMenu, true);
    return () => window.removeEventListener("contextmenu", suppressNativeContextMenu, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const activeScope: Exclude<ShortcutScope, "global"> | null = route === "materials"
        ? "materials"
        : route === "notes"
          ? "knowledge"
          : route === "canvas"
            ? "canvas"
            : route === "graph"
              ? "graph"
              : null;
      const command = resolveScopedShortcut(event, activeScope, undefined, {
        modalOpen: Boolean(applicationModalStore.getSnapshot()),
        ids: [
        "globalSearch",
        "commandPalette",
        "newNote",
        "quickNote",
        "aiAssistant",
        "toggleSidebar",
        "toggleDetail",
        "captureClip",
        "openSettings",
        "closeNoteTab",
        "nextNoteTab",
        "prevNoteTab",
        "toggleNotesIndex",
        ],
      });

      const commandId = command ? getCommandIdForShortcut(command) : null;
      if (command === "globalSearch" || command === "commandPalette") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (commandId) void runAppCommand(commandId, commandContext);
        return;
      }
      if (command === "openSettings") {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.location.hash = "#settings";
        return;
      }
      if (commandId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void runAppCommand(commandId, commandContext);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applicationModalStore, commandContext, route]);

  useEffect(() => {
    const openSearch = () => {
      if (!applicationModalStore.getSnapshot() && isEnabled("searchReact")) setSearchOpen(true);
    };
    window.addEventListener("luckyray:search-open", openSearch);
    return () => window.removeEventListener("luckyray:search-open", openSearch);
  }, [applicationModalStore]);

  useEffect(() => {
    if (!applicationModalActive) return;
    setSearchOpen(false);
    setCommandOpen(false);
  }, [applicationModalActive]);

  const handleCloseSearch = useCallback(() => setSearchOpen(false), []);
  const config = ROUTE_CONFIG[route];
  const routeMode = selectShellRouteMode(route, !!config && isEnabled(config.flag));
  const useNavShell = isEnabled("navShellReact");

  useEffect(() => {
    if (!bridgeReady) return;
    const prefetch = () => {
      void Promise.allSettled([
        import("../features/notes/NotesPage"),
        import("../features/graph/GraphPage"),
        import("../features/tags/TagsPage"),
      ]);
    };
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(prefetch, { timeout: 2500 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timer = window.setTimeout(prefetch, 1600);
    return () => window.clearTimeout(timer);
  }, [bridgeReady]);

  useEffect(() => {
    let cancelled = false;
    setBridgeReady(false);
    let stopWatchService: (() => void) | undefined;
    installLuckyRayBridge()
      .then((bridge) => {
        if (cancelled) return;
        stopWatchService = startMaterialWatchService(bridge);
        setBridgeReady(true);
      })
      .catch((error) => {
        console.warn("[luckyray] bridge install failed", error);
        if (!cancelled) setBridgeReady(true);
      });
    return () => {
      cancelled = true;
      stopWatchService?.();
    };
  }, []);

  if (useNavShell) {
    return (
      <ApplicationModalIsolationProvider store={applicationModalStore}>
        <ReactNavShell
          route={getShellRoute(route)}
          hashPath={hashPath}
          bridgeReady={bridgeReady}
          searchOpen={searchOpen}
          commandOpen={commandOpen}
          applicationModalActive={applicationModalActive}
          onOpenSearch={commandContext.openSearch}
          onCloseSearch={handleCloseSearch}
          onCloseCommand={() => setCommandOpen(false)}
        />
      </ApplicationModalIsolationProvider>
    );
  }

  const content = routeMode !== "legacy" ? (
    <RetainedShellContent
      route={route}
      bridgeReady={bridgeReady}
      hashPath={hashPath}
      nativeSurfacesVisible={!(searchOpen || commandOpen)}
    />
  ) : (
    <LegacyRoute key={route} />
  );

  return (
    <ApplicationModalIsolationProvider store={applicationModalStore}>
      {content}
      {isEnabled("searchReact") && (
        <Suspense fallback={null}>
          <SearchOverlay open={searchOpen && !applicationModalActive} onClose={handleCloseSearch} />
        </Suspense>
      )}
      <PluginEntryMenu />
      <CommandPalette open={commandOpen && !applicationModalActive} onClose={() => setCommandOpen(false)} />
    </ApplicationModalIsolationProvider>
  );
}

function ReactNavShell({
  route,
  hashPath,
  bridgeReady,
  searchOpen,
  commandOpen,
  applicationModalActive,
  onOpenSearch,
  onCloseSearch,
  onCloseCommand,
}: {
  route: ShellRoute;
  hashPath: string;
  bridgeReady: boolean;
  searchOpen: boolean;
  commandOpen: boolean;
  applicationModalActive: boolean;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onCloseCommand: () => void;
}) {
  const [settingsSnapshot, setSettingsSnapshot] = useState(readSavedSettings);
  // Projection + first refresh use the existing registry. Sidebar preferences
  // survive missing packages so the same stable page can return after reinstall.
  const sidebarPluginPages = usePluginSidebarPages(settingsSnapshot);
  const [layoutStore]=useState(()=>windowLayoutStore("main"));
  const workspaceLayout=useSyncExternalStore(layoutStore.subscribe,layoutStore.getSnapshot);
  const previousNavigationVisibility=useRef<NavigationVisibility|null>(null);
  const [compactShell, setCompactShell] = useState(() => selectCompactShellForViewport(window.innerWidth, false));
  const [compactNavigationExpanded, setCompactNavigationExpanded] = useState(false);
  const [sidebarMotionIntent, setSidebarMotionIntent] = useState<SidebarMotionIntent>("automatic");
  const [aiPersonalBrowserOpen, setAiPersonalBrowserOpen] = useState(false);
  const [aiContentBrowserOpen, setAiContentBrowserOpen] = useState(false);
  const [lightSeekRestartRequest, setLightSeekRestartRequest] = useState(0);
  const [lightSeekRestarting, setLightSeekRestarting] = useState(false);
  const lightSeekRestartRequestRef = useRef(0);
  const lightSeekRestartingRef = useRef(false);
  const [navState, setNavState] = useState<{ stack: string[]; index: number }>({ stack: [route === "plugins" && getHashPath() ? getHashPath() : route], index: 0 });
  const navStateRef = useRef(navState);
  const pendingHistoryRouteRef = useRef<string | null>(null);
  const compactShellRef = useRef(compactShell);
  const aiDrawerCloserRef = useRef<(() => void) | null>(null);
  const themeId = String(settingsSnapshot["general.theme"] || "dark");
  const accentColor = String(settingsSnapshot["appearance.accentColor"] || "#7c8aff");

  useLayoutEffect(() => {
    const syncCompactShell = () => {
      const nextCompact = selectCompactShellForViewport(window.innerWidth, compactShellRef.current);
      if (nextCompact === compactShellRef.current) return;
      setSidebarMotionIntent("automatic");
      if (nextCompact && !compactShellRef.current) setCompactNavigationExpanded(false);
      compactShellRef.current = nextCompact;
      setCompactShell(nextCompact);
    };
    syncCompactShell();
    window.addEventListener("resize", syncCompactShell);
    return () => window.removeEventListener("resize", syncCompactShell);
  }, []);

  const closeCompactNavigation = useCallback(() => {
    setCompactNavigationExpanded(false);
  }, []);

  const closeAiPersonalBrowser = useCallback(() => {
    setAiPersonalBrowserOpen(false);
  }, []);

  const closeAiContentBrowser = useCallback(() => {
    setAiContentBrowserOpen(false);
  }, []);

  const closeAiDrawers = useCallback(() => {
    closeAiPersonalBrowser();
    closeAiContentBrowser();
  }, [closeAiContentBrowser, closeAiPersonalBrowser]);

  const toggleCompactNavigation = useCallback(() => {
    if (!compactShell) return;
    setSidebarMotionIntent("manual");
    setCompactNavigationExpanded((current) => {
      if (!current) aiDrawerCloserRef.current?.();
      return !current;
    });
  }, [compactShell]);

  const markManualSidebarMotion = useCallback(() => {
    setSidebarMotionIntent("manual");
  }, []);

  const registerAiDrawerCloser = useCallback((closer: () => void) => {
    aiDrawerCloserRef.current = closer;
    return () => {
      if (aiDrawerCloserRef.current === closer) aiDrawerCloserRef.current = null;
    };
  }, []);

  useEffect(() => registerAiDrawerCloser(closeAiDrawers), [closeAiDrawers, registerAiDrawerCloser]);

  useEffect(() => {
    if (route !== "ai") closeAiPersonalBrowser();
    if (route !== "ai") closeAiContentBrowser();
  }, [closeAiContentBrowser, closeAiPersonalBrowser, route]);

  const toggleAiPersonalBrowser = useCallback(() => {
    closeCompactNavigation();
    setAiPersonalBrowserOpen((current) => {
      if (!current) setAiContentBrowserOpen(false);
      return !current;
    });
  }, [closeCompactNavigation]);

  const toggleAiContentBrowser = useCallback(() => {
    closeCompactNavigation();
    setAiContentBrowserOpen((current) => {
      if (!current) setAiPersonalBrowserOpen(false);
      return !current;
    });
  }, [closeCompactNavigation]);

  const restartLightSeek = useCallback(() => {
    if (lightSeekRestartingRef.current) return;
    const request = lightSeekRestartRequestRef.current + 1;
    lightSeekRestartRequestRef.current = request;
    lightSeekRestartingRef.current = true;
    setLightSeekRestarting(true);
    setLightSeekRestartRequest(request);
  }, []);

  const acceptLightSeekRestart = useCallback((request: number) => {
    if (lightSeekRestartRequestRef.current !== request) return;
    setLightSeekRestartRequest(0);
  }, []);

  const settleLightSeekRestart = useCallback((request: number) => {
    if (lightSeekRestartRequestRef.current !== request) return;
    lightSeekRestartingRef.current = false;
    setLightSeekRestarting(false);
  }, []);

  const compactSurfaceCoordinator = useMemo<CompactSurfaceCoordinator>(() => ({
    compact: compactShell,
    compactNavigationExpanded,
    toggleCompactNavigation,
    closeCompactNavigation,
    registerAiDrawerCloser,
  }), [closeCompactNavigation, compactNavigationExpanded, compactShell, registerAiDrawerCloser, toggleCompactNavigation]);

  const commitNavState = useCallback((next: { stack: string[]; index: number }) => {
    navStateRef.current = next;
    setNavState(next);
  }, []);

  // Plugin pages carry their full path in the stack so A/page1, B/page1 and A/page2
  // stay distinct history entries; built-in routes keep using their top-level name.
  const activeNavKey = route === "plugins" ? hashPath : route;
  useEffect(() => {
    const current = navStateRef.current;
    if (current.stack[current.index] === activeNavKey) return;
    if (pendingHistoryRouteRef.current === activeNavKey) {
      pendingHistoryRouteRef.current = null;
      return;
    }
    const stack = [...current.stack.slice(0, current.index + 1), activeNavKey];
    commitNavState({ stack, index: stack.length - 1 });
  }, [commitNavState, activeNavKey]);

  const navigateKey = useCallback((key: string) => {
    const current = navStateRef.current;
    if (current.stack[current.index] === key) {
      // Same as the parent behaviour for canvas: re-clicking the current entry resets
      // its sub-path; other built-ins keep their sub-path (tags/smart children).
      const resetsSubPath = key === "canvas" || key.startsWith("plugins/");
      if (resetsSubPath && getHashPath() !== key) window.location.hash = `#${key}`;
      return;
    }
    const stack = [...current.stack.slice(0, current.index + 1), key];
    pendingHistoryRouteRef.current = key;
    commitNavState({ stack, index: stack.length - 1 });
    window.location.hash = `#${key}`;
  }, [commitNavState]);
  const navigate = useCallback((page: ShellRoute) => navigateKey(page), [navigateKey]);
  useEffect(() => {
    const next: NavigationVisibility = {presentation:resolveNavigationPresentation(workspaceLayout.presentation??defaultPresentation(),settingsSnapshot["general.showCollectionNav"]===true),pluginKeys:readSidebarPrefs(settingsSnapshot)};
    const fallback=newlyHiddenNavigationFallback(activeNavKey,previousNavigationVisibility.current,next);
    previousNavigationVisibility.current=next;
    if(!fallback)return;
    // Replace this history entry so Back cannot strand the user on the entry
    // they just hid. Direct links remain usable after the visibility change.
    const current=navStateRef.current,stack=[...current.stack];stack[current.index]=fallback;
    pendingHistoryRouteRef.current=fallback;
    commitNavState({stack,index:current.index});
    window.location.replace(`#${fallback}`);
  }, [workspaceLayout, settingsSnapshot, activeNavKey, commitNavState]);


  const applicationModalActiveRef = useRef(applicationModalActive);
  applicationModalActiveRef.current = applicationModalActive;
  const presentCompanionTarget = useCallback((target: { domain: "materials" | "knowledge"; id: string }) => {
    if (target.domain === "materials") {
      focusEntity("asset", target.id, { action: "detail", source: "companion-services" });
      navigate("materials");
    } else {
      focusEntity("note", target.id, { action: "focus", source: "companion-services" });
      navigate("notes");
    }
  }, [navigate]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<unknown>("luckyray:companion-presentation-open", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      const offer = payload as Record<string, unknown>;
      const requestId = offer.requestId;
      if (typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId)) return;
      const acknowledge = (accepted: boolean) => {
        void invoke("companion_gateway_presentation_ack", { requestId, accepted }).catch(() => undefined);
      };
      const target = offer.target;
      if (!target || typeof target !== "object") return;
      const typedTarget = target as Record<string, unknown>;
      const domain = typedTarget.domain;
      const id = domain === "materials" ? typedTarget.assetId : typedTarget.noteId;
      if ((domain !== "materials" && domain !== "knowledge")
          || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id)
          || (domain === "knowledge" && (typeof typedTarget.vaultId !== "string"
            || !/^[A-Za-z0-9_-]{1,160}$/.test(typedTarget.vaultId)
            || typeof offer.navigationId !== "string"
            || !/^kdoc-[a-f0-9]{1,8192}$/.test(offer.navigationId)))) {
        return;
      }
      const typed: { domain: "materials" | "knowledge"; id: string } = {
        domain, id: domain === "knowledge" ? offer.navigationId as string : id,
      };
      if (applicationModalActiveRef.current) return;
      // Measure from before IPC using the renderer's monotonic clock; a
      // stalled/reloaded callback cannot use an expired native claim.
      const claimStartedAt = performance.now();
      void invoke<number>("companion_gateway_presentation_claim", { requestId }).then((remainingMs) => {
        if (!canApplyCompanionPresentation(remainingMs, performance.now() - claimStartedAt, disposed)) {
          acknowledge(false);
          return;
        }
        try {
          presentCompanionTarget(typed);
          acknowledge(true);
        } catch {
          acknowledge(false);
        }
      }).catch(() => undefined);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => { disposed = true; unlisten?.(); };
  }, [presentCompanionTarget]);

  const goBack = useCallback(() => {
    const current = navStateRef.current;
    const target = current.stack[current.index - 1];
    if (!target) return;
    pendingHistoryRouteRef.current = target;
    commitNavState({ ...current, index: Math.max(0, current.index - 1) });
    window.location.hash = `#${target}`;
  }, [commitNavState]);

  const goForward = useCallback(() => {
    const current = navStateRef.current;
    const target = current.stack[current.index + 1];
    if (!target) return;
    pendingHistoryRouteRef.current = target;
    commitNavState({ ...current, index: Math.min(current.stack.length - 1, current.index + 1) });
    window.location.hash = `#${target}`;
  }, [commitNavState]);

  const contextualChildOpen = Boolean(
    (route === "tags" && hashPath.split("/")[1]) ||
    (route === "smart" && hashPath.split("/")[1]),
  );
  const goBackFromCurrentView = useCallback(() => {
    if ((route === "tags" && hashPath.split("/")[1]) || (route === "smart" && hashPath.split("/")[1])) {
      window.location.hash = route === "tags" ? "#tags" : "#smart";
      return;
    }
    goBack();
  }, [goBack, hashPath, route]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (applicationModalActive) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "textarea" || target?.isContentEditable) return;
      const command = resolveScopedShortcut(event, null, undefined, {
        modalOpen: applicationModalActive,
        ids: ["navigateBack", "navigateForward"],
      });
      if (command === "navigateBack") {
        event.preventDefault();
        goBackFromCurrentView();
      } else if (command === "navigateForward") {
        event.preventDefault();
        goForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applicationModalActive, goBackFromCurrentView, goForward]);

  const contentMode =
    route === "materials" ? "materials-mode" :
    route === "notes" ? "notes-mode" :
    route === "graph" ? "graph-mode" :
    route === "canvas" ? "canvas-mode" :
    route === "community" ? "community-mode" :
    route === "browser" ? "browser-mode" :
    route === "settings" ? "settings-mode" :
    route === "tags" ? "tags-mode" :
    route === "collection" ? "collection-mode" :
    route === "favorites" ? "favorites-mode" :
    route === "smart" ? "smart-mode" :
    route === "ai" ? "ai-mode" :
    route === "plugins" ? "plugins-mode" :
    "standard-page";

  useLayoutEffect(() => {
    applyGlobalSettings(settingsSnapshot);
    void syncWindowSurfaceBackground();
  }, [settingsSnapshot]);

  useEffect(() => {
    const unsubscribe = extensionPackages.subscribe(() => setSettingsSnapshot(current => ({ ...current })));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    // Read the same normalized values actually applied to the desktop root.
    void invoke("publish_extension_appearance", { appearance: {
      theme: document.documentElement.dataset.theme || "dark",
      accent: /^#[a-f0-9]{6}$/i.test(String(settingsSnapshot["appearance.accentColor"]))
        ? String(settingsSnapshot["appearance.accentColor"]) : "#7c8aff",
    } }).catch(() => console.warn("[appearance] extension projection unavailable"));
  }, [settingsSnapshot]);

  useEffect(() => {
    const onSettings = (event: Event) => {
      const patch = (event as CustomEvent<{ settings?: Record<string, unknown> }>).detail?.settings || {};
      setSettingsSnapshot((current) => ({ ...current, ...patch } as ReturnType<typeof readSavedSettings>));
    };
    const onAccent = (event: Event) => {
      const color = (event as CustomEvent<{ color?: string }>).detail?.color;
      if (color) setSettingsSnapshot((current) => ({ ...current, "appearance.accentColor": color }));
    };
    window.addEventListener("luckyray:settings-change", onSettings);
    window.addEventListener("luckyray:settings-accent", onAccent);
    return () => {
      window.removeEventListener("luckyray:settings-change", onSettings);
      window.removeEventListener("luckyray:settings-accent", onAccent);
    };
  }, []);

  const accentStyle = getShellAccentTheme(extensionPackages.activeTheme()?.base || themeId, accentColor) as CSSProperties;
  const [lightSeekToolsOpen, setLightSeekToolsOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const nativeSurfacesVisible = !(searchOpen || commandOpen || lightSeekToolsOpen || applicationModalActive);

  return (
    <div className="react-nav-shell" data-route={route} data-sidebar-motion={sidebarMotionIntent} style={accentStyle}>
      <ExperienceOverlayProvider><CompactSurfaceCoordinatorProvider value={compactSurfaceCoordinator}>
        <AppSidebar route={route}
          onNavigate={navigate}
          applicationModalIsolated={applicationModalActive}
          compactAutoCollapsed={compactShell}
          compactExpanded={compactNavigationExpanded}
          onCompactToggle={toggleCompactNavigation}
          onManualToggle={markManualSidebarMotion}
          pluginPages={sidebarPluginPages}
          activePluginPagePath={route === "plugins" ? hashPath : undefined}
          onOpenPluginPage={navigateKey}
          onOpenPhone={() => setPhoneOpen(true)}
        />
        <div className={`main${route === "graph" ? " graph-mode" : ""}`} inert={phoneOpen || undefined} aria-hidden={phoneOpen || undefined}>
          <AppTitlebar
            route={route}
            hashPath={hashPath}
            onOpenSearch={onOpenSearch}
            canGoBack={contextualChildOpen || navState.index > 0}
            canGoForward={navState.index < navState.stack.length - 1}
            onBack={goBackFromCurrentView}
            onForward={goForward}
            applicationModalIsolated={applicationModalActive}
            aiPersonalBrowserOpen={aiPersonalBrowserOpen}
            onToggleAiPersonalBrowser={toggleAiPersonalBrowser}
            aiContentBrowserOpen={aiContentBrowserOpen}
            onToggleAiContentBrowser={toggleAiContentBrowser}
            lightSeekRestarting={lightSeekRestarting}
            onRestartLightSeek={restartLightSeek}
            onLightSeekToolsOpenChange={setLightSeekToolsOpen}
          />
          <div className="content-wrap">
            <div className={`content ${contentMode}`}>
              <RetainedShellContent
                route={route}
                bridgeReady={bridgeReady}
                hashPath={hashPath}
                aiPersonalBrowserOpen={aiPersonalBrowserOpen}
                aiContentBrowserOpen={aiContentBrowserOpen}
                nativeSurfacesVisible={nativeSurfacesVisible}
                lightSeekRestartRequest={lightSeekRestartRequest}
                lightSeekRestarting={lightSeekRestarting}
                onLightSeekRestartAccepted={acceptLightSeekRestart}
                onLightSeekRestartSettled={settleLightSeekRestart}
              />
            </div>
          </div>
        </div>
      </CompactSurfaceCoordinatorProvider>
      {isEnabled("searchReact") && (
        <Suspense fallback={null}>
          <SearchOverlay open={searchOpen && !applicationModalActive} onClose={onCloseSearch} />
        </Suspense>
      )}
      <PluginEntryMenu />
      <CommandPalette open={commandOpen && !applicationModalActive} onClose={onCloseCommand} />
      {phoneOpen && <PhoneConnectionDialog onClose={() => setPhoneOpen(false)} onMore={() => {
        setPhoneOpen(false);
        sessionStorage.setItem("luckyray-settings-v1-activePanel", "companion");
        window.dispatchEvent(new CustomEvent("luckyray:settings-open-panel", { detail: { panel: "companion" } }));
        navigate("settings");
      }} />}
      </ExperienceOverlayProvider>
    </div>
  );
}

function RetainedShellContent({
  route,
  bridgeReady,
  hashPath,
  aiPersonalBrowserOpen = false,
  aiContentBrowserOpen = false,
  nativeSurfacesVisible = true,
  lightSeekRestartRequest = 0,
  lightSeekRestarting = false,
  onLightSeekRestartAccepted,
  onLightSeekRestartSettled,
}: {
  route: string;
  bridgeReady: boolean;
  hashPath: string;
  aiPersonalBrowserOpen?: boolean;
  aiContentBrowserOpen?: boolean;
  nativeSurfacesVisible?: boolean;
  lightSeekRestartRequest?: number;
  lightSeekRestarting?: boolean;
  onLightSeekRestartAccepted?: (request: number) => void;
  onLightSeekRestartSettled?: (request: number) => void;
}) {
  const [retainedRoutes, setRetainedRoutes] = useState<string[]>(() => (
    RETAINED_WORKSPACE_ROUTES.has(route) ? [route] : []
  ));

  useEffect(() => {
    if (!RETAINED_WORKSPACE_ROUTES.has(route)) return;
    setRetainedRoutes((current) => current.includes(route) ? current : [...current, route]);
  }, [route]);

  if (!bridgeReady) return <LoadingFallback />;
  const activeIsRetained = RETAINED_WORKSPACE_ROUTES.has(route);
  return (
    <>
      {retainedRoutes.map((retainedRoute) => {
        const config = ROUTE_CONFIG[retainedRoute];
        if (!config || !isEnabled(config.flag)) return null;
        const Component = config.Component;
        if(retainedRoute==='notes'||retainedRoute==='graph')return <div key={retainedRoute} aria-hidden={route!==retainedRoute} inert={route!==retainedRoute} style={{display:route===retainedRoute?'contents':'none'}}><Suspense fallback={route===retainedRoute?<LoadingFallback/>:null}>{retainedRoute==='graph'?<GraphPage visible={route===retainedRoute}/>:<NotesPage visible={route===retainedRoute}/>}</Suspense></div>;
        return (
          <Activity key={retainedRoute} mode={route === retainedRoute ? "visible" : "hidden"}>
            <Suspense fallback={route === retainedRoute ? <LoadingFallback /> : null}>
              <Component />
            </Suspense>
          </Activity>
        );
      })}
      {!activeIsRetained && renderShellContent(
        route,
        bridgeReady,
        hashPath,
        aiPersonalBrowserOpen,
        aiContentBrowserOpen,
        nativeSurfacesVisible,
        lightSeekRestartRequest,
        lightSeekRestarting,
        onLightSeekRestartAccepted,
        onLightSeekRestartSettled,
      )}
    </>
  );
}

function renderShellContent(
  route: string,
  bridgeReady: boolean,
  hashPath = getHashPath(),
  aiPersonalBrowserOpen = false,
  aiContentBrowserOpen = false,
  nativeSurfacesVisible = true,
  lightSeekRestartRequest = 0,
  lightSeekRestarting = false,
  onLightSeekRestartAccepted?: (request: number) => void,
  onLightSeekRestartSettled?: (request: number) => void,
) {
  if (!bridgeReady) return <LoadingFallback />;
  const config = ROUTE_CONFIG[route];
  const routeMode = selectShellRouteMode(route, !!config && isEnabled(config.flag));
  if (route === "ai" && config && routeMode !== "legacy") {
    return (
      <Suspense key={route} fallback={<LoadingFallback />}>
        <DshNativeSurfacePage
          personalBrowserOpen={aiPersonalBrowserOpen}
          contentBrowserOpen={aiContentBrowserOpen}
          nativeSurfacesVisible={nativeSurfacesVisible}
          restartRequest={lightSeekRestartRequest}
          restarting={lightSeekRestarting}
          onRestartAccepted={onLightSeekRestartAccepted}
          onRestartSettled={onLightSeekRestartSettled}
        />
      </Suspense>
    );
  }
  if (config && routeMode !== "legacy") {
    if (route === "tags") {
      return (
        <Suspense key={route} fallback={<LoadingFallback />}>
          <TagsPage hashPath={hashPath} />
        </Suspense>
      );
    }
    return (
      <Suspense key={route} fallback={<LoadingFallback />}>
        <config.Component />
      </Suspense>
    );
  }
  if (route === "plugins") {
    return (
      <Suspense key={route} fallback={<LoadingFallback />}>
        <PluginPageHost path={hashPath} />
      </Suspense>
    );
  }
  if (route === "community") {
    return (
      <Suspense key={route} fallback={<LoadingFallback />}>
        <CommunityPage />
      </Suspense>
    );
  }
  if (route === "browser") {
    return (
      <Suspense key={route} fallback={<LoadingFallback />}>
        <BrowserPage />
      </Suspense>
    );
  }
  if (route === "collection") {
    return (
      <Suspense key={route} fallback={<LoadingFallback />}>
        <CollectionPage />
      </Suspense>
    );
  }
  if (route === "favorites") {
    return (
      <Suspense key={route} fallback={<LoadingFallback />}>
        <FavoritesPage />
      </Suspense>
    );
  }
  if (route === "smart") {
    return (
      <Suspense key={route} fallback={<LoadingFallback />}>
        <SmartFoldersPage hashPath={hashPath} />
      </Suspense>
    );
  }
  if (route === "canvas") {
    const canvasView = hashPath.split("/")[1] || "";
    if (canvasView !== "main") {
      return (
        <CanvasRouteBoundary resetKey={`canvas-home:${hashPath}`}>
          <Suspense key="canvas-home" fallback={<LoadingFallback />}>
            <CanvasHomePage onOpenCanvas={(canvasId) => { window.location.hash = canvasEditorHash(canvasId); }} />
          </Suspense>
        </CanvasRouteBoundary>
      );
    }
    return (
      <CanvasRouteBoundary resetKey={`canvas-main:${hashPath}`}>
        <Suspense key={`canvas-main:${hashPath}`} fallback={<LoadingFallback />}>
          <CanvasSpike />
        </Suspense>
      </CanvasRouteBoundary>
    );
  }
  return <LegacyRoute key={route} />;
}

// Keeps the shell (navigation, layout, phone and settings entries) usable when
// the canvas route fails to load or render - for example when the dev server
// answers 431 and the large CanvasSpike dynamic import cannot be fetched.
//
// "重试" performs one user-initiated reload: once a dynamic import has failed
// the browser module map replays that failure for the same URL, so re-rendering
// alone cannot recover. There is deliberately no timer and no automatic reload,
// and nothing here clears caches, cookies or user data.
class CanvasRouteBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="shell-page-fallback" role="alert">
        <p style={{ margin: "0 0 10px" }}>画布加载失败。主界面仍可正常使用——请确认本地开发服务正常后重试。</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button type="button" onClick={() => { window.location.reload(); }}>重试</button>
          <button type="button" onClick={() => { window.location.hash = "#canvas"; }}>返回画布首页</button>
        </div>
      </div>
    );
  }
}

function LoadingFallback() {
  const { t } = useI18n();
  return (
    <div className="shell-page-fallback" role="status" aria-live="polite" aria-atomic="true">
      {t("shell.loading")}
    </div>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const plugins = useScriptPackages().filter(p => p.enabled);
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const commands = useMemo<LuckyRayCommand[]>(() => listPaletteCommands(locale), [locale]);
  const commandContext = useMemo(() => ({
    openSearch: () => window.dispatchEvent(new CustomEvent("luckyray:search-open")),
    getRoute: () => getShellRoute(getHashRoute()),
  }), []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((command) => `${command.label} ${command.hint} ${command.id} ${command.keywords}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const run = useCallback(async (command: LuckyRayCommand) => {
    await runAppCommand(command.id, commandContext);
    onClose();
  }, [commandContext, onClose]);

  if (!open) return null;
  return (
    <div className="command-palette-overlay" onMouseDown={onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-palette-search">
          <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4" /><line x1="10" y1="10" x2="14" y2="14" /></svg>
          <input value={query} onChange={(event) => setQuery(event.target.value)} autoFocus placeholder={t("shell.command.placeholder")} />
        </div>
        <div className="command-palette-list">
          {plugins.flatMap(p => (p.package.resource as ScriptResource).contributions.filter(c => c.kind === "command" && `${p.package.manifest.name} ${c.label}`.toLowerCase().includes(query.toLowerCase())).map(c => <button className="command-palette-item" key={`${p.package.manifest.id}:${c.id}`} onClick={() => { openPlugin(p.package.manifest.id, c.id); onClose(); }}><span>{p.package.manifest.name} · {c.label}</span><kbd>插件</kbd></button>))}
          {visible.length === 0 ? (
            <div className="command-palette-empty">{t("shell.command.empty")}</div>
          ) : visible.map((command) => (
            <button key={command.id} className="command-palette-item" onClick={() => void run(command)}>
              <span>{command.label}</span>
              <kbd>{command.hint}</kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
