import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import packageMetadata from "../../../package.json";
import aboutBrandIcon from "../../../src-tauri/icons/icon.png";
import { getGlobalShortcutSuggestions, readGlobalShortcutStatus, subscribeGlobalShortcutStatus, type GlobalShortcutRegistrationStatus } from "../../app/globalShortcuts";
import {
  SHORTCUT_SCOPE_ORDER,
  findShortcutConflicts,
  getShortcutDefinition,
  type ShortcutCommandId,
  type ShortcutScope,
} from "../../app/shortcuts";
import type { LuckyRayBridge } from "../../core/bridge/luckyRayBridge";
import { describeAiProvider, getAiConnectionFailureHint, normalizeAiApiKey, resolveAiBaseUrlForKey } from "../../core/services/aiProviders";
import { testActiveAiModelMessage, type AiModelProfile } from "../../core/services/aiModelProfiles";
import { createAgentSearchSettingsLifecycle, createDefaultAgentSearchSettingsClient, type AgentSearchSettingsStatus } from "../../core/services/agentSearch";
import { createDefaultDshHostClient, readDshHostStatusAfterOperations, runDshHostDiagnostic, type DshHostStatus } from "../../core/services/dshHost";
import DshPluginCompatSettingsCard from "./DshPluginCompatSettingsCard";
import DesktopUpdateCard from "./DesktopUpdateCard";
import MaterialsMcpPanel from "./MaterialsMcpPanel";
import { DESKTOP_LINKS, isOfficialDesktopLink } from "../../core/services/desktopUpdates";
import DshEngineUpdateCard from "./DshEngineUpdateCard";
import { clearCache as svcClearCache, createBackup as svcCreateBackup, restoreBackup as svcRestoreBackup, openDataDir as svcOpenDataDir } from "../../core/services/system";
import { applyAccentTheme, applyGlobalSettings, readSavedSettings, useSettings } from "./useSettings";
import type { SettingsMap, SettingsValue } from "./useSettings";
import { THEME_PRESETS, type ThemePreset } from "../../core/theme/themePresets";
import { extensionPackages } from "../../core/extensions/packages";
import "./settings.css";
import AiModelProfilesPanel from "./AiModelProfilesPanel";
import CompanionGatewayPanel from "./CompanionGatewayPanel";
import LayoutSettingsPanel from "./LayoutSettingsPanel";
import { useI18n, type MessageKey } from "../../core/i18n/index";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";

type TabKey = "general" | "layout" | "appearance" | "shortcut" | "ai" | "companion" | "storage" | "about";
type ConfirmKind = "warn" | "danger";
type ConfirmActionButton = {
  label: string;
  kind?: "primary" | "danger";
  action: () => Promise<void> | void;
};
type ConfirmActionState = {
  title: string;
  body: ReactNode;
  kind?: ConfirmKind;
  action?: () => Promise<void> | void;
  actions?: ConfirmActionButton[];
};

type BridgeBackupInfo = Awaited<ReturnType<LuckyRayBridge["listBackups"]>>[number];
type BridgeStorageUsage = Awaited<ReturnType<LuckyRayBridge["getStorageUsage"]>>;
type Translator = ReturnType<typeof useI18n>["t"];

function localizedDshHostStatus(status: DshHostStatus, t: Translator): string {
  if (status.stage === "initializing") return t("settings.ai.dsh.loading");
  if (status.latestProbePassed && status.hostReusable) return t("settings.ai.dsh.passed");
  if (status.shuttingDown) return t("settings.ai.dsh.shuttingDown");
  if (status.canProbe) return t("settings.ai.dsh.ready");
  return t("settings.ai.dsh.unavailable");
}

function localizedAgentSearchConnection(code: string, t: Translator): string {
  const keys: Record<string, MessageKey> = {
    ready: "settings.status.search.ready",
    "web-network-disabled": "settings.status.search.networkDisabled",
    "web-search-unauthorized": "settings.status.search.unauthorized",
    "web-search-rate-limited": "settings.status.search.rateLimited",
    "web-search-timeout": "settings.status.search.timeout",
    "web-search-config-invalid": "settings.status.search.configInvalid",
    "web-search-empty": "settings.status.search.empty",
  };
  return t(keys[code] || "settings.status.searchUnavailable");
}

function localizedShortcutName(id: string, t: Translator, fallback: string) {
  const definition = getShortcutDefinition(id as ShortcutCommandId);
  return definition ? t(definition.nameKey as MessageKey) : fallback;
}

function localizedShortcutScope(scope: ShortcutScope, t: Translator) {
  return t(`settings.shortcuts.scope.${scope}` as MessageKey);
}

const TABS: Array<{ key: TabKey; labelKey: MessageKey }> = [
  { key: "general", labelKey: "settings.tab.general" },
  { key: "appearance", labelKey: "settings.tab.appearance" },
  { key: "layout", labelKey: "settings.tab.layout" },
  { key: "shortcut", labelKey: "settings.tab.shortcuts" },
  { key: "ai", labelKey: "settings.tab.ai" },
  { key: "companion", labelKey: "settings.tab.companion" },
  { key: "storage", labelKey: "settings.tab.storage" },
  { key: "about", labelKey: "settings.tab.about" },
];

const ACTIVE_TAB_KEY = "luckyray-settings-v1-activePanel";
type AiPersistOptions = { syncUi?: boolean };
type AgentSearchSettingsOwner = ReturnType<ReturnType<typeof createAgentSearchSettingsLifecycle>["attach"]>;
const APP_VERSION = packageMetadata.version;

function getBridge(): LuckyRayBridge | null {
  return window.__LUCKYRAY__ || null;
}

function loadActiveTab(): TabKey {
  const value = sessionStorage.getItem(ACTIVE_TAB_KEY);
  return TABS.some((tab) => tab.key === value) ? value as TabKey : "general";
}

export default function SettingsPage() {
  const { locale, plural, t } = useI18n();
  const [activeTab, setActiveTab] = useState<TabKey>(loadActiveTab);
  useEffect(() => {
    const openPanel = (event: Event) => {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel;
      if (panel === "companion") setActiveTab("companion");
    };
    window.addEventListener("luckyray:settings-open-panel", openPanel);
    return () => window.removeEventListener("luckyray:settings-open-panel", openPanel);
  }, []);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [connectionState, setConnectionState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [agentSearchStatus, setAgentSearchStatus] = useState<AgentSearchSettingsStatus | null>(null);
  const [agentSearchLoadFailed, setAgentSearchLoadFailed] = useState(false);
  const [collectionTransportReady, setCollectionTransportReady] = useState<boolean | null>(null);
  const [agentSearchEnabled, setAgentSearchEnabled] = useState(false);
  const [agentSearchProvider, setAgentSearchProvider] = useState<"tavily" | "searxng">("tavily");
  const [agentSearchKeyDraft, setAgentSearchKeyDraft] = useState("");
  const [agentSearchKeyVisible, setAgentSearchKeyVisible] = useState(false);
  const [agentSearchEndpoint, setAgentSearchEndpoint] = useState("");
  const [agentSearchAllowLocal, setAgentSearchAllowLocal] = useState(false);
  const [agentSearchBusy, setAgentSearchBusy] = useState<"save" | "test" | "">("");
  const [dshHostStatus, setDshHostStatus] = useState<DshHostStatus | null>(null);
  const [dshHostBusy, setDshHostBusy] = useState(false);
  const [recordingId, setRecordingId] = useState<ShortcutCommandId | null>(null);
  const [activeShortcutScope, setActiveShortcutScope] = useState<ShortcutScope>("global");
  const [appDataDir, setAppDataDir] = useState("");
  const [backups, setBackups] = useState<BridgeBackupInfo[]>([]);
  const [storageBusy, setStorageBusy] = useState("");
  const [storageUsage, setStorageUsage] = useState<BridgeStorageUsage | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionState | null>(null);
  const closeConfirmAction = useCallback(() => setConfirmAction(null), []);
  const confirmDialogSurface = useApplicationModalSurface<HTMLDivElement>(Boolean(confirmAction), closeConfirmAction, {
    closeOnBackdrop: false,
  });
  const [globalShortcutStatus, setGlobalShortcutStatus] = useState<GlobalShortcutRegistrationStatus | null>(() => readGlobalShortcutStatus());
  const aiSettingsDirtyRef = useRef(false);
  const aiPersistChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const agentSearchEnabledRef = useRef(false);
  const agentSearchOwnerRef = useRef<AgentSearchSettingsOwner | null>(null);
  const shortcutScopeTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const applyAgentSearchStatus = useCallback((status: AgentSearchSettingsStatus) => {
    setAgentSearchLoadFailed(false);
    setAgentSearchStatus(status);
    agentSearchEnabledRef.current = status.enabled;
    setAgentSearchEnabled(status.enabled);
    setAgentSearchProvider(status.selectedProvider);
    setAgentSearchEndpoint(status.searxngEndpoint || "");
    setAgentSearchAllowLocal(status.searxngAllowLocal);
    setAgentSearchKeyDraft("");
  }, []);

  const agentSearchLifecycle = useMemo(
    () => createAgentSearchSettingsLifecycle(applyAgentSearchStatus),
    [applyAgentSearchStatus],
  );

  const refreshRuntimeStatus = useCallback(async () => {
    const bridge = getBridge();
    const [collectionResult] = await Promise.allSettled([
      bridge?.getCollectionServerBaseUrl?.() ?? Promise.reject(new Error("bridge unavailable")),
    ]);
    setCollectionTransportReady(
      collectionResult.status === "fulfilled" && /^http:\/\/127\.0\.0\.1:\d+$/.test(collectionResult.value),
    );
  }, []);

  useEffect(() => {
    if (activeTab !== "general") return;
    void refreshRuntimeStatus();
  }, [activeTab, refreshRuntimeStatus]);

  useEffect(() => {
    if (activeTab !== "ai") return;
    const owner = agentSearchLifecycle.attach();
    agentSearchOwnerRef.current = owner;
    void createDefaultAgentSearchSettingsClient()
      .then((client) => owner.run(() => client.status()))
      .catch(() => {
        if (owner.isActive()) {
          setAgentSearchStatus(null);
          setAgentSearchLoadFailed(true);
        }
      });
    return () => {
      owner.release();
      if (agentSearchOwnerRef.current === owner) agentSearchOwnerRef.current = null;
    };
  }, [activeTab, agentSearchLifecycle]);

  useEffect(() => {
    if (activeTab !== "ai") return;
    let active = true;
    let timer: ReturnType<typeof window.setTimeout> | undefined;
    void createDefaultDshHostClient()
      .then(async (client) => {
        const refresh = async () => {
          try {
            const status = await readDshHostStatusAfterOperations(client);
            if (!active) return;
            setDshHostStatus(status);
            // Only observe pending admission; never probe/retry automatically.
            if (status.stage === "initializing") timer = window.setTimeout(() => void refresh(), 500);
          } catch {
            if (active) setDshHostStatus(null);
          }
        };
        await refresh();
      })
      .catch(() => {
        if (active) setDshHostStatus(null);
      });
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeTab]);

  const { settings, get, set, patch, shortcuts, updateShortcut, resetShortcut, resetShortcuts, resetSettings } = useSettings();
  const normalizedQuery = query.trim().toLowerCase();
  const shortcutConflicts = useMemo(() => getShortcutConflictMap(shortcuts), [shortcuts]);
  const shortcutConflictCount = shortcutConflicts.size;
  const activeScopeShortcuts = useMemo(
    () => shortcuts.filter((item) => item.scope === activeShortcutScope),
    [activeShortcutScope, shortcuts],
  );
  const globalShortcutSuggestions = useMemo(() => getGlobalShortcutSuggestions(globalShortcutStatus, shortcuts), [globalShortcutStatus, shortcuts]);
  const bridgeAvailable = Boolean(getBridge());
  const accentColor = String(get("appearance.accentColor", "#7c8aff"));
  const agentSearchToggleState: { state: "loading" | "error" | "ready"; enabled?: boolean } = agentSearchStatus
    ? { state: "ready", enabled: agentSearchStatus.enabled }
    : { state: agentSearchLoadFailed ? "error" : "loading" };

  const setActive = useCallback((tab: TabKey) => {
    setActiveTab(tab);
    sessionStorage.setItem(ACTIVE_TAB_KEY, tab);
  }, []);

  const showStatus = useCallback((text: string, isError = false) => {
    setMessage(isError ? "" : text);
    setError(isError ? text : "");
  }, []);

  const selectShortcutScope = useCallback((scope: ShortcutScope) => {
    setActiveShortcutScope(scope);
    setRecordingId(null);
  }, []);

  const handleShortcutScopeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % SHORTCUT_SCOPE_ORDER.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + SHORTCUT_SCOPE_ORDER.length) % SHORTCUT_SCOPE_ORDER.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = SHORTCUT_SCOPE_ORDER.length - 1;
    else return;
    event.preventDefault();
    selectShortcutScope(SHORTCUT_SCOPE_ORDER[nextIndex]);
    shortcutScopeTabRefs.current[nextIndex]?.focus();
  }, [selectShortcutScope]);

  const saveAgentSearchSettings = useCallback(async (clearTavilyApiKey = false) => {
    setAgentSearchBusy("save");
    try {
      const client = await createDefaultAgentSearchSettingsClient();
      const owner = agentSearchOwnerRef.current;
      if (!owner?.isActive()) return;
      await owner.run(() => client.update({
        enabled: agentSearchEnabledRef.current,
        provider: agentSearchProvider,
        ...(!clearTavilyApiKey && agentSearchKeyDraft.trim()
          ? { tavilyApiKey: agentSearchKeyDraft.trim() }
          : {}),
        clearTavilyApiKey,
        searxngEndpoint: agentSearchEndpoint.trim() || null,
        clearSearxngEndpoint: !agentSearchEndpoint.trim(),
        searxngAllowLocal: agentSearchAllowLocal,
      }));
      showStatus(clearTavilyApiKey ? t("settings.status.search.keyCleared") : t("settings.status.search.saved"));
    } catch {
      showStatus(t("settings.status.search.invalid"), true);
    } finally {
      setAgentSearchBusy("");
    }
  }, [agentSearchAllowLocal, agentSearchEndpoint, agentSearchKeyDraft, agentSearchProvider, showStatus, t]);
  const toggleAgentSearchEnabled = useCallback(async (enabled: boolean) => {
    agentSearchEnabledRef.current = enabled;
    setAgentSearchEnabled(enabled);
    setAgentSearchBusy("save");
    try {
      const client = await createDefaultAgentSearchSettingsClient();
      const owner = agentSearchOwnerRef.current;
      if (!owner?.isActive()) return;
      await owner.run(() => client.update({
        enabled,
        provider: agentSearchProvider,
        clearTavilyApiKey: false,
        searxngEndpoint: agentSearchEndpoint.trim() || null,
        clearSearxngEndpoint: !agentSearchEndpoint.trim(),
        searxngAllowLocal: agentSearchAllowLocal,
      }));
      showStatus(enabled ? t("settings.status.search.enabled") : t("settings.status.search.disabled"));
    } catch {
      showStatus(t("settings.status.search.saveFailed"), true);
    } finally {
      setAgentSearchBusy("");
    }
  }, [agentSearchAllowLocal, agentSearchEndpoint, agentSearchProvider, showStatus, t]);

  const runDshDiagnostic = useCallback(async (retry: boolean) => {
    setDshHostBusy(true);
    try {
      const client = await createDefaultDshHostClient();
      const status = await runDshHostDiagnostic(client, retry);
      setDshHostStatus(status);
      showStatus(localizedDshHostStatus(status, t), !status.latestProbePassed);
    } catch {
      setDshHostStatus(null);
      showStatus(t("settings.status.dshUnavailable"), true);
    } finally {
      setDshHostBusy(false);
    }
  }, [showStatus, t]);

  const testAgentSearchConnection = useCallback(async () => {
    setAgentSearchBusy("test");
    try {
      const client = await createDefaultAgentSearchSettingsClient();
      const result = await client.testConnection();
      showStatus(localizedAgentSearchConnection(result.code, t), !result.ok);
    } catch {
      showStatus(t("settings.status.searchUnavailable"), true);
    } finally {
      setAgentSearchBusy("");
    }
  }, [showStatus, t]);

  const applyGlobalShortcutSuggestion = useCallback((id: ShortcutCommandId, value: string, name: string) => {
    updateShortcut(id, value);
    showStatus(t("settings.status.changed", { name, value }));
  }, [showStatus, t, updateShortcut]);

  const applyAllGlobalShortcutSuggestions = useCallback(() => {
    let count = 0;
    for (const item of globalShortcutSuggestions) {
      const first = item.suggestions[0];
      if (!first) continue;
      updateShortcut(item.id, first);
      count += 1;
    }
    showStatus(count ? plural(count, { one: "settings.status.shortcutSuggestions.one", other: "settings.status.shortcutSuggestions.other" }) : t("settings.status.shortcutNoSuggestions"));
  }, [globalShortcutSuggestions, plural, showStatus, t, updateShortcut]);

  useEffect(() => {
    if (!message && !error) return;
    const timer = window.setTimeout(() => {
      setMessage("");
      setError("");
    }, error ? 3000 : 1500);
    return () => window.clearTimeout(timer);
  }, [error, message]);

  const persistAiPatch = useCallback((values: SettingsMap, options: AiPersistOptions = {}) => {
    const run = async () => {
      const saved = readSavedSettings();
      const bridge = getBridge();
      const nextProvider = String(values["ai.provider"] ?? saved["ai.provider"] ?? get("ai.provider", "deepseek"));
      const hasApiKeyUpdate = Object.prototype.hasOwnProperty.call(values, "ai.apiKey");
      const nextApiKey = hasApiKeyUpdate
        ? normalizeAiApiKey(String(values["ai.apiKey"] ?? ""))
        : "";
      const nextBaseUrl = resolveAiBaseUrlForKey(nextProvider, String(values["ai.baseUrl"] ?? saved["ai.baseUrl"] ?? get("ai.baseUrl", "")), nextApiKey);
      const nextModel = String(values["ai.model"] ?? saved["ai.model"] ?? get("ai.model", ""));
      const nextTemperature = Number(values["ai.temperature"] ?? saved["ai.temperature"] ?? get("ai.temperature", 0.7));
      const nextMaxTokens = Number(values["ai.maxTokens"] ?? saved["ai.maxTokens"] ?? get("ai.maxTokens", 2000));

      const next = {
        provider: nextProvider,
        apiKey: nextApiKey,
        baseUrl: nextBaseUrl,
        model: nextModel,
        temperature: nextTemperature,
        maxTokens: nextMaxTokens,
      };

      if (options.syncUi) {
        patch({
          "ai.provider": next.provider,
          "ai.baseUrl": next.baseUrl,
          "ai.model": next.model,
          "ai.temperature": next.temperature,
          "ai.maxTokens": next.maxTokens,
        });
      }

      if (!bridge?.setSettings) return next;
      try {
        await bridge.setSettings({
          aiProvider: String(next.provider || ""),
          ...(hasApiKeyUpdate ? { aiApiKey: String(next.apiKey || "") } : {}),
          aiBaseURL: String(next.baseUrl || ""),
          aiModel: String(next.model || ""),
          aiTemperature: Number(next.temperature),
          aiMaxTokens: Number(next.maxTokens),
          temperature: Number(next.temperature),
          maxTokens: Number(next.maxTokens),
        });
      } catch {
        showStatus(t("settings.status.aiSaveFailed"), true);
      }
      return next;
    };
    const queued = aiPersistChainRef.current.then(run, run);
    aiPersistChainRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [get, patch, showStatus, t]);

  const setSetting = useCallback((key: string, value: SettingsValue) => {
    if (key.startsWith("ai.")) aiSettingsDirtyRef.current = true;
    set(key, value);
    const nextSettings = { [key]: value };
    if (key === "appearance.accentColor" && typeof value === "string") {
      applyAccentTheme(value);
      window.dispatchEvent(new CustomEvent("luckyray:settings-accent", { detail: { color: value } }));
    }
    window.dispatchEvent(new CustomEvent("luckyray:settings-change", { detail: { settings: nextSettings } }));
    if (key.startsWith("ai.")) void persistAiPatch({ [key]: value });
  }, [persistAiPatch, set]);

  const handleSelectThemePreset = useCallback((preset: ThemePreset) => {
    patch({
      "general.theme": preset.id,
      "appearance.accentColor": preset.recommendedAccent,
    });
    applyAccentTheme(preset.recommendedAccent);
    document.documentElement.dataset.theme = preset.id;
    // R1b: switching back to a built-in theme must explicitly leave any enabled
    // extension theme, otherwise applyGlobalSettings keeps overlaying it. Use the
    // existing service (no second theme authority); re-apply settings after the
    // package state settles so the extension-theme overlay is cleared.
    const activeThemeId = extensionPackages.enabledThemeId();
    if (activeThemeId) {
      void extensionPackages.disable(activeThemeId, extensionPackages.snapshot().revision)
        .then(() => applyGlobalSettings(readSavedSettings(), document.documentElement))
        .catch(() => { /* the built-in preset still applies; package state stays as-is */ });
    }
    window.dispatchEvent(new CustomEvent("luckyray:settings-accent", { detail: { color: preset.recommendedAccent } }));
    window.dispatchEvent(new CustomEvent("luckyray:settings-change", {
      detail: {
        settings: {
          "general.theme": preset.id,
          "appearance.accentColor": preset.recommendedAccent,
        },
      },
    }));
  }, [patch]);

  const handleAutoLaunchChange = useCallback(async (value: boolean) => {
    const previous = Boolean(get("general.autoLaunch", false));
    setSetting("general.autoLaunch", value);
    const bridge = getBridge();
    if (!bridge?.setAutoLaunchEnabled) {
      showStatus(t("settings.status.autolaunchUnavailable"), true);
      setSetting("general.autoLaunch", previous);
      return;
    }
    try {
      await bridge.setAutoLaunchEnabled(value);
      const actual = bridge.getAutoLaunchEnabled ? await bridge.getAutoLaunchEnabled() : value;
      setSetting("general.autoLaunch", actual);
      showStatus(actual ? t("settings.status.autolaunchOn") : t("settings.status.autolaunchOff"));
    } catch {
      setSetting("general.autoLaunch", previous);
      showStatus(t("settings.status.autolaunchFailed"), true);
    }
  }, [get, setSetting, showStatus, t]);

  useEffect(() => {
    applyGlobalSettings();
    window.dispatchEvent(new CustomEvent("luckyray:settings-accent", { detail: { color: accentColor } }));
  }, [accentColor]);

  useEffect(() => {
    if (activeTab !== "ai") return;
    const bridge = getBridge();
    if (!bridge?.getSettings) return;
    let cancelled = false;
    bridge.getSettings().then((remote) => {
      if (cancelled) return;
      if (aiSettingsDirtyRef.current) return;
      const next: SettingsMap = {};
      if (remote.aiProvider) next["ai.provider"] = remote.aiProvider;
      if (remote.aiBaseURL) next["ai.baseUrl"] = resolveAiBaseUrlForKey(remote.aiProvider, remote.aiBaseURL, "");
      if (remote.aiModel) next["ai.model"] = remote.aiModel;
      if (typeof remote.aiTemperature === "number") next["ai.temperature"] = remote.aiTemperature;
      if (typeof remote.aiMaxTokens === "number") next["ai.maxTokens"] = remote.aiMaxTokens;
      patch(next);
    }).catch(() => showStatus(t("settings.status.aiReadFailed"), true));
    return () => {
      cancelled = true;
    };
  }, [activeTab, patch, showStatus, t]);

  useEffect(() => {
    if (activeTab !== "general") return;
    const bridge = getBridge();
    if (!bridge?.getAutoLaunchEnabled) return;
    let cancelled = false;
    bridge.getAutoLaunchEnabled()
      .then((enabled) => {
        if (!cancelled) patch({ "general.autoLaunch": enabled });
      })
      .catch(() => showStatus(t("settings.status.autolaunchReadFailed"), true));
    return () => {
      cancelled = true;
    };
  }, [activeTab, patch, showStatus, t]);

  const loadStorageInfo = useCallback(async () => {
    const bridge = getBridge();
    try {
      if (bridge?.getStorageUsage) {
        const usage = await bridge.getStorageUsage();
        setStorageUsage(usage);
        if (usage.app_data_dir) setAppDataDir(usage.app_data_dir);
      } else if (bridge?.getAppDataDir) {
        setAppDataDir(await bridge.getAppDataDir());
      }
      if (bridge?.listBackups) setBackups(await bridge.listBackups());
    } catch {
      showStatus(t("settings.status.storageReadFailed"), true);
    }
  }, [showStatus, t]);

  useEffect(() => {
    if (activeTab !== "storage") return;
    void loadStorageInfo();
  }, [activeTab, loadStorageInfo]);

  useEffect(() => {
    if (activeTab !== "shortcut") return;
    return subscribeGlobalShortcutStatus(setGlobalShortcutStatus);
  }, [activeTab]);

  useEffect(() => {
    if (!recordingId) return;
    const timer = window.setTimeout(() => {
      setRecordingId(null);
      showStatus(t("settings.status.shortcutTimeout"));
    }, 5000);
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingId(null);
        showStatus(t("settings.status.shortcutCancelled"));
        return;
      }
      if (event.ctrlKey && event.metaKey) {
        setRecordingId(null);
        showStatus(t("settings.status.shortcutMixedModifiers"));
        return;
      }
      const shortcut = formatShortcut(event);
      if (!shortcut) return;
      if (recordingId === "searchModeToggle" && event.key === "Tab" && event.shiftKey) {
        showStatus("Shift+Tab 保留用于向前移动焦点，请选择其他快捷键。"); setRecordingId(null); return;
      }
      const next = shortcuts.map((item) => item.id === recordingId ? { ...item, value: shortcut } : item);
      const conflict = findShortcutConflicts(next).find((item) => item.ids.includes(recordingId));
      if (conflict) {
        const otherId = conflict.ids.find((id) => id !== recordingId) || recordingId;
        showStatus(t("settings.status.shortcutConflict", { shortcut, name: localizedShortcutName(otherId, t, otherId) }));
        setRecordingId(null);
        return;
      }
      updateShortcut(recordingId, shortcut);
      setRecordingId(null);
      showStatus(t("settings.status.shortcutUpdated", { shortcut }));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [recordingId, shortcuts, showStatus, t, updateShortcut]);

  const tabMatches = useMemo(() => {
    if (!normalizedQuery) return new Set(TABS.map((tab) => tab.key));
    const hits = new Set<TabKey>();
    for (const tab of TABS) {
      if (`${t(tab.labelKey)} ${panelSearchText[tab.key]}`.toLowerCase().includes(normalizedQuery)) hits.add(tab.key);
    }
    return hits;
  }, [normalizedQuery, t]);

  useEffect(() => {
    if (tabMatches.has(activeTab)) return;
    const first = TABS.find((tab) => tabMatches.has(tab.key));
    if (first) setActive(first.key);
  }, [activeTab, setActive, tabMatches]);

  const handleActiveProfileChanged = useCallback((profile: AiModelProfile) => {
    aiSettingsDirtyRef.current = true;
    patch({
      "ai.provider": profile.provider,
      "ai.baseUrl": profile.baseUrl,
      "ai.model": profile.model,
      "ai.temperature": profile.temperature,
      "ai.maxTokens": profile.maxOutputTokens,
    });
  }, [patch]);

  const testAi = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiChatComplete) {
      setConnectionState("error");
      showStatus(t("settings.status.aiBridgeUnavailable"), true);
      return;
    }
    setConnectionState("loading");
    showStatus("");
    let usedSettings: { provider?: string; model?: string; baseUrl?: string } | undefined;
    let failureDetail = "";
    try {
      const remote = await bridge.getSettings();
      usedSettings = {
        provider: remote.aiProvider ?? undefined,
        model: remote.aiModel ?? undefined,
        baseUrl: remote.aiBaseURL ?? undefined,
      };
      const result = await testActiveAiModelMessage(bridge);
      if (!result.success) {
        failureDetail = [result.error_message, result.error_detail].filter(Boolean).join(" ");
        throw new Error("ai-connection-failed");
      }
      setConnectionState("success");
      showStatus(t("settings.status.aiConnectionPassed"));
    } catch {
      setConnectionState("error");
      const providerName = describeAiProvider(usedSettings?.provider);
      const hint = getAiConnectionFailureHint(usedSettings?.provider, failureDetail, usedSettings?.baseUrl);
      const summary = usedSettings
        ? t("settings.status.aiUsed", { provider: providerName, model: usedSettings.model || t("settings.status.modelUnset"), baseUrl: usedSettings.baseUrl || t("settings.status.defaultAddress") })
        : "";
      showStatus(t("settings.status.aiConnectionFailed", { summary: summary ? ` ${summary}` : "", hint: hint ? ` ${hint}` : "" }), true);
    }
  }, [showStatus, t]);

  const runStorageAction = useCallback(async (label: string, action: () => Promise<string | void>) => {
    setStorageBusy(label);
    showStatus("");
    try {
      const success = await action();
      showStatus(success || t("settings.status.actionDone", { label }));
      await loadStorageInfo();
    } catch {
      showStatus(t("settings.status.actionFailed", { label }), true);
    } finally {
      setStorageBusy("");
    }
  }, [loadStorageInfo, showStatus, t]);

  const chooseManagedLibraryDir = useCallback(async () => {
    showStatus("");
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ title: t("settings.dialog.selectManaged"), directory: true, multiple: false });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      const currentCustomDir = String(get("materials.managedLibraryDir", ""));
      const currentDir = currentCustomDir || (appDataDir ? `${appDataDir}\\asset-library` : "");
      if (currentDir && normalizePathForCompare(currentDir) === normalizePathForCompare(path)) {
        setSetting("materials.managedLibraryDir", currentCustomDir ? path : "");
        showStatus(t("settings.status.managedUnchanged"));
        return;
      }
      setConfirmAction({
        title: t("settings.dialog.changeManaged.title"),
        kind: "warn",
        body: (
          <div className="settings-confirm-stack">
            <p>{t("settings.dialog.changeManaged.new")}</p>
            <strong>{path}</strong>
            <p>{t("settings.dialog.changeManaged.copy")}</p>
          </div>
        ),
        actions: [
          {
            label: t("settings.dialog.changeManaged.future"),
            action: () => {
              setSetting("materials.managedLibraryDir", path);
              showStatus(t("settings.status.managedUpdated"));
            },
          },
          {
            label: t("settings.dialog.changeManaged.migrate"),
            kind: "primary",
            action: () => runStorageAction(t("settings.action.migrateManaged"), async () => {
              const { invoke } = await import("@tauri-apps/api/core");
              const result = await invoke<{ moved_count: number; skipped_count: number; failed_count: number }>("migrate_managed_asset_library", {
                fromDir: currentCustomDir || null,
                toDir: path,
              });
              setSetting("materials.managedLibraryDir", path);
              return t("settings.status.managedMigrated", { moved: result.moved_count, skipped: result.skipped_count, failed: result.failed_count });
            }),
          },
        ],
      });
    } catch {
      showStatus(t("settings.status.managedSelectFailed"), true);
    }
  }, [appDataDir, get, runStorageAction, setSetting, showStatus, t]);

  const clearAllDataWithBackup = useCallback(() => runStorageAction(t("settings.action.clearContent"), async () => {
    const bridge = getBridge();
    if (!bridge?.clearAllData) throw new Error(t("settings.status.bridgeUnavailable"));
    const result = await bridge.clearAllData();
    resetSettings();
    resetShortcuts();
    for (const key of [
      "luckyray-materials-filter-v1",
      "luckyray-graph-view-v1",
      "luckyray:active-context-v1",
      "luckyray-settings-v1-activePanel",
    ]) {
      try {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      } catch {}
    }
    return plural(result.cleared_tables.length, {
      one: "settings.status.cleared.one",
      other: "settings.status.cleared.other",
    }, { backup: result.backup_id, size: formatSize(result.removed_bytes) });
  }), [plural, resetSettings, resetShortcuts, runStorageAction, t]);

  const handleAboutLink = useCallback(async (label: string, url?: string) => {
    if (!url || !isOfficialDesktopLink(url)) {
      showStatus(t("settings.status.linkUnavailable", { label }));
      return;
    }
    try {
      if (isTauri()) {
        const bridge = getBridge();
        if (!bridge?.openExternalUrl) throw new Error("external-browser-unavailable");
        await bridge.openExternalUrl(url);
        showStatus(t("settings.status.linkOpened", { label }));
      } else {
        // Keep window.open synchronous with the click, before any await. With
        // noopener its null return cannot distinguish success from popup blocking.
        window.open(url, "_blank", "noopener,noreferrer");
        showStatus(t("settings.status.browserLinkRequested", { label }));
      }
    } catch {
      showStatus(t("settings.status.linkFailed", { label }), true);
    }
  }, [showStatus, t]);

  const shouldShow = useCallback((text: string) => !normalizedQuery || text.toLowerCase().includes(normalizedQuery), [normalizedQuery]);

  return (
    <div id="page-settings" className="page luckyray-settings-page">
      <div className="settings-layout">
        <aside className="settings-nav" id="settings-nav">
          <div className="settings-nav-search">
            <svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2">
              <circle cx="7" cy="7" r="4" />
              <line x1="10" y1="10" x2="14" y2="14" />
            </svg>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.search.placeholder")} autoComplete="off" />
          </div>
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                className={`settings-nav-item${isActive ? " active" : ""}${tabMatches.has(tab.key) ? "" : " muted"}`}
                onClick={() => setActive(tab.key)}
                style={{ color: isActive ? "var(--accent)" : "#8e8e96" }}
                type="button"
              >
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </aside>

        <main className="settings-content" id="settings-content">
          {(message || error) && (
            <div
              className={`settings-message experience-toast ${error ? "error experience-toast--error" : "experience-toast--success"}`}
              role={error ? "alert" : "status"}
              aria-live={error ? "assertive" : "polite"}
            >
              {error || message}
            </div>
          )}
          {!tabMatches.size && <div className="settings-no-results">{t("settings.search.empty")}</div>}

          <Panel tab="general" active={activeTab}>
            <PanelHead title={t("settings.tab.general")} desc={t("settings.general.description")} />
            <Group title="搜索" searchText="搜索 模式 切换 快捷键 search mode" shouldShow={shouldShow}>
              <SettingRow label="启用搜索模式切换快捷键" desc="在顶部搜索框聚焦时，通过快捷键切换素材 / 全局搜索。键位在「快捷键 → 全局」中修改；关闭不影响搜索框上的切换按钮。" searchText="搜索 模式 切换 快捷键 search mode" shouldShow={shouldShow}>
                <button type="button" role="switch" aria-label="启用搜索模式切换快捷键" aria-checked={get("search.modeShortcutEnabled", true)} className={`toggle${get("search.modeShortcutEnabled", true) ? " on" : ""}`} onClick={() => setSetting("search.modeShortcutEnabled", !get("search.modeShortcutEnabled", true))} />
              </SettingRow>
            </Group>
            <Group title={t("settings.general.language.group")} searchText="语言 区域 界面语言 简体中文 English language" shouldShow={shouldShow}>
              <SettingRow label={t("settings.general.language.label")} desc={t("settings.general.language.description")} searchText="界面语言 简体中文 English language" shouldShow={shouldShow}>
                <SegmentedControl
                  value={locale}
                  options={[["zh-CN", t("language.simplifiedChinese")], ["en-US", t("language.english")]]}
                  onChange={(value) => setSetting("general.language", value === "en-US" ? "en-US" : "zh-CN")}
                />
              </SettingRow>
            </Group>
            <Group title={t("settings.general.startup.group")} searchText="启动行为 启动时 上次 素材库 知识库 图谱 startup" shouldShow={shouldShow}>
              <SettingRow label={t("settings.general.startup.label")} desc={t("settings.general.startup.description")} searchText="启动时 打开上次 素材库 知识库 图谱 startup" shouldShow={shouldShow}>
                <Select value={get("general.startup", "last")} onChange={(value) => setSetting("general.startup", value)} options={[["last", t("settings.general.startup.last")], ["materials", t("settings.general.startup.materials")], ["notes", t("settings.general.startup.notes")], ["graph", t("settings.general.startup.graph")]]} />
              </SettingRow>
            </Group>
            <Group title={t("settings.general.density.group")} searchText="显示 信息密度 紧凑 舒适 宽松 density" shouldShow={shouldShow}>
              <SettingRow label={t("settings.general.density.label")} desc={t("settings.general.density.description")} searchText="信息密度 紧凑 舒适 宽松 density" shouldShow={shouldShow}>
                <SegmentedControl value={get("general.density", "comfortable")} options={[["compact", t("settings.general.density.compact")], ["comfortable", t("settings.general.density.comfortable")], ["loose", t("settings.general.density.loose")]]} onChange={(value) => setSetting("general.density", value)} />
              </SettingRow>
            </Group>
            <Group title={t("settings.general.close.group")} searchText="关闭 托盘 自启动 close launch" shouldShow={shouldShow}>
              <SettingRow label={t("settings.general.close.label")} desc={t("settings.general.close.description")} searchText="关闭窗口 托盘 退出 询问 close" shouldShow={shouldShow}>
                <Select value={get("general.onClose", "tray")} onChange={(value) => setSetting("general.onClose", value)} options={[["tray", t("settings.general.close.tray")], ["exit", t("settings.general.close.exit")], ["ask", t("settings.general.close.ask")]]} />
              </SettingRow>
              <SettingRow label={t("settings.general.autolaunch.label")} desc={t("settings.general.autolaunch.description")} searchText="开机 自启动 launch startup" shouldShow={shouldShow}>
                <Toggle value={get("general.autoLaunch", false)} onChange={(value) => void handleAutoLaunchChange(value)} />
              </SettingRow>
            </Group>
            <Group title={t("settings.general.collection.group")} searchText="收集 收集箱 导航栏 筛选 collection" shouldShow={shouldShow}>
              <SettingRow label={t("settings.general.collection.service.label")} desc={t("settings.general.collection.service.description")} searchText="浏览器 收集 插件 扩展 本机服务 browser collection" shouldShow={shouldShow}>
                <div className="settings-action-row">
                  <span className={`settings-conn-state ${collectionTransportReady === true ? "success" : collectionTransportReady === false ? "error" : "loading"}`}>
                    {collectionTransportReady === true ? t("settings.general.collection.service.ready") : collectionTransportReady === false ? t("settings.general.collection.service.unavailable") : t("settings.general.collection.service.checking")}
                  </span>
                  <button className="settings-btn" type="button" onClick={() => void refreshRuntimeStatus()}>{t("common.action.refresh")}</button>
                </div>
              </SettingRow>
            </Group>
          </Panel>

          <Panel tab="layout" active={activeTab}>
            <LayoutSettingsPanel settings={settings} setSetting={setSetting} shouldShow={shouldShow}/>
          </Panel>

          <Panel tab="appearance" active={activeTab}>
            <PanelHead title={t("settings.tab.appearance")} desc={t("settings.appearance.description")} />
            <Group title={t("settings.appearance.theme.group")} searchText="主题 预设 主题预设 强调色 主色 theme accent" shouldShow={shouldShow}>
              <SettingRow label={t("settings.appearance.theme.label")} desc={t("settings.appearance.theme.description")} stack searchText="主题 预设 theme preset" shouldShow={shouldShow}>
                <ThemePresetSelector
                  value={String(get("general.theme", "dark"))}
                  onSelect={handleSelectThemePreset}
                />
              </SettingRow>
              <SettingRow label={t("settings.appearance.accent.label")} desc={t("settings.appearance.accent.description")} stack searchText="主色 星蓝 薄荷 琥珀 玫瑰 accent" shouldShow={shouldShow}>
                <div className="settings-color-row">
                  {[
                    ["#7c8aff", t("settings.appearance.accent.starBlue")],
                    ["#4ade80", t("settings.appearance.accent.mint")],
                    ["#fbbf24", t("settings.appearance.accent.amber")],
                    ["#fb7185", t("settings.appearance.accent.rose")],
                  ].map(([value, label]) => (
                    <button key={value} className={`settings-color-swatch${accentColor === value ? " active" : ""}`} style={{ background: value }} onClick={() => setSetting("appearance.accentColor", value)} title={label}>
                      <span className="settings-color-name">{label}</span>
                    </button>
                  ))}
                </div>
              </SettingRow>
            </Group>
            <Group title={t("settings.appearance.typography.group")} searchText="排版 字体 字号 等宽 行距 typography" shouldShow={shouldShow}>
              <SettingRow label={t("settings.appearance.fontSize.label")} searchText="字体大小 font size" shouldShow={shouldShow}>
                <Select value={get("appearance.fontSize", "md")} onChange={(value) => setSetting("appearance.fontSize", value)} options={[["xs", t("settings.appearance.fontSize.xs")], ["sm", t("settings.appearance.fontSize.sm")], ["md", t("settings.appearance.fontSize.md")], ["lg", t("settings.appearance.fontSize.lg")], ["xl", t("settings.appearance.fontSize.xl")]]} />
              </SettingRow>
              <SettingRow label={t("settings.appearance.fontFamily.label")} searchText="正文字体 font family" shouldShow={shouldShow}>
                <Select value={get("appearance.fontFamily", "system")} onChange={(value) => setSetting("appearance.fontFamily", value)} options={[["system", t("settings.appearance.fontFamily.system")], ["sf", "SF Pro"], ["inter", "Inter"], ["source", t("settings.appearance.fontFamily.source")], ["pingfang", t("settings.appearance.fontFamily.pingfang")]]} />
              </SettingRow>
              <SettingRow label={t("settings.appearance.mono.label")} desc={t("settings.appearance.mono.description")} searchText="等宽字体 monospace" shouldShow={shouldShow}>
                <Select value={get("appearance.monoFont", "jetbrains")} onChange={(value) => setSetting("appearance.monoFont", value)} options={[["system", t("settings.appearance.fontFamily.system")], ["jetbrains", "JetBrains Mono"], ["fira", "Fira Code"], ["cascadia", "Cascadia Code"]]} />
              </SettingRow>
              <SettingRow label={t("settings.appearance.lineHeight.label")} searchText="行距 line spacing" shouldShow={shouldShow}>
                <SegmentedControl value={get("appearance.lineHeight", "comfortable")} options={[["compact", t("settings.general.density.compact")], ["comfortable", t("settings.general.density.comfortable")], ["loose", t("settings.general.density.loose")]]} onChange={(value) => setSetting("appearance.lineHeight", value)} />
              </SettingRow>
            </Group>
            <Group title={t("settings.appearance.motion.group")} searchText="窗口 动画 模糊 motion" shouldShow={shouldShow}>
              <SettingRow label={t("settings.appearance.motion.label")} desc={t("settings.appearance.motion.description")} searchText="过渡动画 GPU motion" shouldShow={shouldShow}>
                <Toggle value={get("appearance.animations", true)} onChange={(value) => setSetting("appearance.animations", value)} />
              </SettingRow>
              <SettingRow label={t("settings.appearance.blur.label")} desc={t("settings.appearance.blur.description")} searchText="毛玻璃 模糊 blur" shouldShow={shouldShow}>
                <Toggle value={get("appearance.blur", true)} onChange={(value) => setSetting("appearance.blur", value)} />
              </SettingRow>
            </Group>
            <Group title={t("settings.appearance.preview.group")} searchText="实时预览 当前设置效果 preview" shouldShow={shouldShow}>
              <SettingRow label={t("settings.appearance.preview.label")} searchText="实时预览 当前设置效果 preview" shouldShow={shouldShow}>
                <div className="settings-preview-card">
                  <div className="settings-preview-thumb" style={{ background: `linear-gradient(135deg, ${accentColor}, var(--accent-hover))` }} />
                  <div className="settings-preview-info">
                    <div className="settings-preview-title">{t("settings.appearance.preview.title")}</div>
                    <div className="settings-preview-meta">{t("settings.appearance.preview.meta")}</div>
                  </div>
                </div>
              </SettingRow>
            </Group>
          </Panel>

          <Panel tab="shortcut" active={activeTab}>
            <PanelHead title={t("settings.tab.shortcuts")} desc={t("settings.shortcuts.description")} />
            {shortcutConflictCount > 0 && (
              <div className="settings-inline-warning">
                {plural(shortcutConflictCount, { one: "settings.shortcuts.conflicts.one", other: "settings.shortcuts.conflicts.other" })}
              </div>
            )}
            {globalShortcutStatus?.failures.length ? (
              <div className="settings-inline-warning settings-shortcut-warning">
                <div>{t("settings.shortcuts.registrationFailed", { items: globalShortcutStatus.failures.map((item) => `${item.shortcut} (${localizedShortcutName(item.id, t, shortcutName(shortcuts, item.id))})`).join(", ") })}</div>
                {globalShortcutSuggestions.length ? (
                  <div className="settings-shortcut-suggestions">
                    {globalShortcutSuggestions.map((item) => (
                      <div key={item.id} className="settings-shortcut-suggestion">
                        <span className="settings-shortcut-suggestion-label">{t("settings.shortcuts.suggest", { name: localizedShortcutName(item.id, t, item.name) })}</span>
                        <div className="settings-shortcut-suggestion-keys">
                          {item.suggestions.length ? item.suggestions.map((suggestion) => (
                            <button key={suggestion} type="button" onClick={() => applyGlobalShortcutSuggestion(item.id, suggestion, item.name)}>
                              {suggestion}
                            </button>
                          )) : <span className="settings-shortcut-suggestion-empty">{t("settings.shortcuts.noSuggestion")}</span>}
                        </div>
                      </div>
                    ))}
                    {globalShortcutSuggestions.some((item) => item.suggestions.length) && (
                      <button className="settings-shortcut-apply" type="button" onClick={applyAllGlobalShortcutSuggestions}>{t("settings.shortcuts.applyAll")}</button>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="settings-shortcut-scope-tabs-scroll">
              <div className="settings-shortcut-scope-tabs" role="tablist" aria-label={t("settings.shortcuts.scopeTabs.aria")}>
                {SHORTCUT_SCOPE_ORDER.map((scope, index) => {
                  const scopedShortcuts = shortcuts.filter((item) => item.scope === scope);
                  const scopedConflicts = scopedShortcuts.filter((item) => shortcutConflicts.has(item.id)).length;
                  const isActive = activeShortcutScope === scope;
                  return (
                    <button
                      key={scope}
                      ref={(element) => { shortcutScopeTabRefs.current[index] = element; }}
                      id={`settings-shortcut-tab-${scope}`}
                      className={`settings-shortcut-scope-tab${isActive ? " active" : ""}`}
                      type="button"
                      role="tab"
                      aria-controls={`settings-shortcut-panel-${scope}`}
                      aria-selected={isActive}
                      aria-label={`${t("settings.shortcuts.scopeTab.aria", { scope: localizedShortcutScope(scope, t) })}${scopedConflicts > 0 ? `. ${t("settings.shortcuts.scopeTab.conflicts")}` : ""}`}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => selectShortcutScope(scope)}
                      onKeyDown={(event) => handleShortcutScopeKeyDown(event, index)}
                    >
                      <span>{localizedShortcutScope(scope, t)}</span>
                      {scopedConflicts > 0 ? (
                        <span className="settings-shortcut-scope-conflicts" title={t("settings.shortcuts.scopeTab.conflicts")} aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              id={`settings-shortcut-panel-${activeShortcutScope}`}
              className="setting-group settings-shortcut-scope-panel"
              role="tabpanel"
              aria-labelledby={`settings-shortcut-tab-${activeShortcutScope}`}
              tabIndex={0}
            >
              <p className="settings-group-note">{t(`settings.shortcuts.groupDescription.${activeShortcutScope}` as MessageKey)}</p>
              <table className="settings-table">
                <thead>
                  <tr><th>{t("settings.shortcuts.column.function")}</th><th className="settings-col-key">{t("settings.shortcuts.column.shortcut")}</th><th className="settings-col-action">{t("settings.shortcuts.column.action")}</th></tr>
                </thead>
                <tbody>
                  {activeScopeShortcuts.map((item) => {
                    const conflict = shortcutConflicts.get(item.id);
                    const definition = getShortcutDefinition(item.id);
                    return (
                      <tr key={item.id} className={conflict ? "settings-shortcut-conflict-row" : undefined}>
                        <td className="settings-col-name">
                          <span>{localizedShortcutName(item.id, t, item.name)}</span>
                          {definition ? <small>{t(definition.descriptionKey as MessageKey)}</small> : null}
                        </td>
                        <td>
                          <button className={`settings-shortcut-cell${recordingId === item.id ? " recording" : ""}${conflict ? " conflict" : ""}`} onClick={() => setRecordingId(item.id)}>
                            {recordingId === item.id ? t("settings.shortcuts.record") : item.value}
                          </button>
                          {conflict && <div className="settings-shortcut-conflict">{t("settings.shortcuts.conflict", { items: conflict.map((id) => localizedShortcutName(id, t, id)).join(", ") })}</div>}
                        </td>
                        <td className="settings-col-action">
                          <button className="settings-shortcut-reset" onClick={() => resetShortcut(item.id)}>{t("common.action.reset")}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {activeShortcutScope === "materials" && <section className="setting-group" aria-label="影视工具快捷键">
              <h3>影视工具</h3>
              <p className="settings-group-note">以下为影视查看器内的固定操作键，仅在查看器激活时生效；文字输入时不触发。素材快速预览中，再按预览快捷键即可关闭。按时间定位，不假设视频帧率。</p>
              <table className="settings-table"><thead><tr><th>功能</th><th className="settings-col-key">快捷键</th></tr></thead><tbody>
                {FILM_SHORTCUT_REFERENCE.filter(([name, key]) => shouldShow(`${name} ${key} 影视 视频`)).map(([name, key]) => <tr key={name}><td>{name}</td><td><kbd>{key}</kbd></td></tr>)}
              </tbody></table>
            </section>}
            <div className="settings-action-row">
              <button className="settings-btn settings-btn-danger" onClick={() => setConfirmAction({ title: t("settings.shortcuts.resetConfirm.title"), kind: "warn", body: t("settings.shortcuts.resetConfirm.body"), action: () => { resetShortcuts(); showStatus(t("settings.shortcuts.resetDone")); } })}>{t("settings.shortcuts.resetAll")}</button>
              <span>{t("settings.shortcuts.globalNote")}</span>
            </div>
            {recordingId && <div className="settings-recording-toast"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 2" /></svg><span>{t("settings.shortcuts.recording")}</span></div>}
          </Panel>

          <Panel tab="ai" active={activeTab}>
            <PanelHead title={t("settings.tab.ai")} desc={t("settings.ai.description")} />
            <Group title={t("settings.ai.dsh.group")} searchText="DSH DeepSeek Harness 运行 诊断 diagnostics" shouldShow={shouldShow}>
              <SettingRow label={t("settings.ai.dsh.update.label")} desc={t("settings.ai.dsh.update.description")} searchText="LightSeek DSH 引擎 更新 upgrade" shouldShow={shouldShow} stack>
                <DshEngineUpdateCard />
              </SettingRow>
              <SettingRow label={t("settings.ai.dsh.label")} desc={t("settings.ai.dsh.description")} searchText="DeepSeek Harness 诊断 diagnostics" shouldShow={shouldShow}>
                <div className="settings-control-stack">
                  <span className={`settings-conn-state ${dshHostStatus?.latestProbePassed ? "success" : !dshHostStatus || dshHostStatus.stage === "initializing" ? "loading" : "error"}`}>
                    {dshHostStatus ? localizedDshHostStatus(dshHostStatus, t) : t("settings.ai.dsh.loading")}
                  </span>
                  <div className="settings-action-row">
                    <button className="settings-btn settings-btn-primary" type="button" disabled={dshHostBusy || dshHostStatus === null || !dshHostStatus.canProbe} onClick={() => void runDshDiagnostic(false)}>
                      {dshHostBusy ? t("settings.ai.dsh.diagnosing") : t("settings.ai.dsh.run")}
                    </button>
                    <button className="settings-btn" type="button" disabled={dshHostBusy || dshHostStatus === null || !dshHostStatus.canRetry} onClick={() => void runDshDiagnostic(true)}>{t("settings.ai.dsh.retry")}</button>
                    {dshHostStatus?.durationMs !== null && dshHostStatus?.durationMs !== undefined
                      ? <span className="settings-muted-text">{t("settings.ai.dsh.duration", { duration: dshHostStatus.durationMs })}</span>
                      : null}
                  </div>
                </div>
              </SettingRow>
              <SettingRow label={t("settings.ai.pluginCompat.label")} desc={t("settings.ai.pluginCompat.description")} searchText="LightSeek 扩展 兼容 compatibility extensions" shouldShow={shouldShow}>
                <DshPluginCompatSettingsCard />
              </SettingRow>
            </Group>
            <Group title={t("settings.ai.models.group")} searchText="模型配置 provider model configuration" shouldShow={shouldShow}>
              <AiModelProfilesPanel onActiveProfileChanged={handleActiveProfileChanged} onStatus={showStatus} />
              <SettingRow label={t("settings.ai.test.label")} desc={t("settings.ai.test.description")} searchText="连接测试 模型消息测试 model test" shouldShow={shouldShow}>
                <div className="settings-control-stack">
                  <button className="settings-btn settings-btn-primary" disabled={connectionState === "loading"} onClick={() => void testAi()}>{connectionState === "loading" ? t("settings.ai.test.testing") : t("settings.ai.test.send")}</button>
                  <ConnectionState state={connectionState} bridgeAvailable={bridgeAvailable} />
                </div>
              </SettingRow>
            </Group>
            <Group title={t("settings.ai.search.group")} searchText="联网搜索 Tavily SearXNG web search" shouldShow={shouldShow}>
              <SettingRow label={t("settings.ai.search.enabled.label")} desc={t("settings.ai.search.enabled.description")} searchText="启用联网搜索模块 web search" shouldShow={shouldShow}>
                {agentSearchToggleState.state === "ready"
                  ? <Toggle value={Boolean(agentSearchToggleState.enabled)} onChange={(v) => void toggleAgentSearchEnabled(v)} />
                  : <span className="settings-muted-text">{t(agentSearchToggleState.state === "error" ? "settings.ai.search.status.loadFailed" : "settings.ai.search.status.loading")}</span>}
              </SettingRow>
              <SettingRow label={t("settings.ai.search.provider.label")} desc={t("settings.ai.search.provider.description")} searchText="搜索服务 Tavily SearXNG search provider" shouldShow={shouldShow}>
                <Select value={agentSearchProvider} onChange={(value) => setAgentSearchProvider(value === "searxng" ? "searxng" : "tavily")} options={[["tavily", t("settings.ai.search.provider.tavily")], ["searxng", t("settings.ai.search.provider.searxng")]]} />
              </SettingRow>
              {agentSearchProvider === "tavily" ? (
                <SettingRow label="Tavily API Key" desc={t(agentSearchStatus?.tavilyConfigured ? "settings.ai.search.key.configured" : "settings.ai.search.key.local")} searchText="Tavily API Key" shouldShow={shouldShow}>
                  <div className="settings-secret-input-row compact">
                    <input className="settings-input settings-secret-input" type={agentSearchKeyVisible ? "text" : "password"} autoComplete="new-password" value={agentSearchKeyDraft} onChange={(event) => setAgentSearchKeyDraft(event.target.value)} placeholder={agentSearchStatus?.tavilyConfigured ? t("settings.ai.search.key.placeholderConfigured") : "tvly-..."} />
                    <button className="settings-btn" type="button" onClick={() => setAgentSearchKeyVisible((visible) => !visible)}>{t(agentSearchKeyVisible ? "settings.ai.search.hideKey" : "settings.ai.search.showKey")}</button>
                    {agentSearchStatus?.tavilyConfigured && <button className="settings-btn settings-btn-danger" disabled={Boolean(agentSearchBusy)} onClick={() => void saveAgentSearchSettings(true)}>{t("settings.ai.search.clearKey")}</button>}
                  </div>
                </SettingRow>
              ) : (
                <>
                  <SettingRow label="SearXNG Endpoint" desc={t("settings.ai.search.endpoint.description")} searchText="SearXNG Endpoint" shouldShow={shouldShow}>
                    <input className="settings-input settings-input-wide" value={agentSearchEndpoint} onChange={(event) => setAgentSearchEndpoint(event.target.value)} placeholder="https://search.example.com/search" />
                  </SettingRow>
                  <SettingRow label={t("settings.ai.search.local.label")} desc={t("settings.ai.search.local.description")} searchText="本机 SearXNG local loopback" shouldShow={shouldShow}>
                    <Toggle value={agentSearchAllowLocal} onChange={setAgentSearchAllowLocal} />
                  </SettingRow>
                </>
              )}
              <SettingRow label={t("settings.ai.search.status.label")} desc={t("settings.ai.search.privacy")} searchText="联网搜索状态 隐私 测试连接 web search status" shouldShow={shouldShow}>
                <div className="settings-control-stack">
                  <span className="settings-muted-text">{t(agentSearchStatus?.ready ? "settings.ai.search.status.ready" : agentSearchEnabled ? "settings.ai.search.status.incomplete" : "settings.ai.search.status.disabled")}</span>
                  <div className="settings-action-row">
                    <button className="settings-btn settings-btn-primary" disabled={Boolean(agentSearchBusy)} onClick={() => void saveAgentSearchSettings(false)}>{t(agentSearchBusy === "save" ? "settings.ai.search.saving" : "settings.ai.search.save")}</button>
                    <button className="settings-btn" disabled={Boolean(agentSearchBusy) || !agentSearchStatus?.ready} onClick={() => void testAgentSearchConnection()}>{t(agentSearchBusy === "test" ? "settings.ai.search.testing" : "settings.ai.search.test")}</button>
                  </div>
                </div>
              </SettingRow>
            </Group>
          </Panel>

          {activeTab === "companion" && <CompanionGatewayPanel />}

          <Panel tab="storage" active={activeTab}>
            <PanelHead title={t("settings.tab.storage")} desc={t("settings.storage.description")} />
            {activeTab === "storage" && <MaterialsMcpPanel />}
            <Group title={t("settings.storage.data.group")} searchText="数据目录 当前路径 素材库 缩略图 数据库 data" shouldShow={shouldShow}>
              <SettingRow label={t("settings.storage.data.path.label")} desc={t("settings.storage.data.path.description")} searchText="应用数据路径 当前路径 appdata" shouldShow={shouldShow}>
                <div className="setting-control">
                  <input className="settings-input settings-input-mono settings-input-path" value={appDataDir || t("settings.storage.reading")} readOnly />
                  <button className="settings-btn" disabled={!appDataDir} onClick={() => void svcOpenDataDir(appDataDir)}>{t("common.action.open")}</button>
                </div>
              </SettingRow>
              <SettingRow label={t("settings.storage.importMode.label")} desc={t("settings.storage.importMode.description")} searchText="素材管理方式 托管 复制 链接 source asset mode" shouldShow={shouldShow}>
                <SegmentedControl
                  value={get("materials.importMode", "linked")}
                  options={[["managed", t("settings.storage.importMode.managed")], ["linked", t("settings.storage.importMode.linked")], ["source", t("settings.storage.importMode.source")]]}
                  onChange={(value) => setSetting("materials.importMode", value)}
                />
              </SettingRow>
              <SettingRow label={t("settings.storage.managedDir.label")} desc={t("settings.storage.managedDir.description")} searchText="托管素材目录 managed asset directory" shouldShow={shouldShow}>
                <div className="setting-control">
                  <input
                    className="settings-input settings-input-mono settings-input-path"
                    value={String(get("materials.managedLibraryDir", "")) || (appDataDir ? `${appDataDir}\\asset-library` : t("settings.storage.managedDir.default"))}
                    readOnly
                  />
                  <button className="settings-btn" onClick={() => void chooseManagedLibraryDir()}>{t("common.action.change")}</button>
                  <button className="settings-btn" disabled={!get("materials.managedLibraryDir", "")} onClick={() => setSetting("materials.managedLibraryDir", "")}>{t("common.label.default")}</button>
                </div>
              </SettingRow>
              <SettingRow label={t("settings.storage.sourceDelete.label")} desc={t("settings.storage.sourceDelete.description")} searchText="源文件删除 source delete" shouldShow={shouldShow}>
                <Select
                  value={get("materials.sourceDeletePolicy", "ask")}
                  onChange={(value) => setSetting("materials.sourceDeletePolicy", value)}
                  options={[["ask", t("settings.general.close.ask")], ["recordOnly", t("settings.storage.sourceDelete.recordOnly")]]}
                />
              </SettingRow>
            </Group>
            <Group title={t("settings.storage.locations.group")} searchText="默认素材库目录 缩略图缓存目录 数据库路径 storage locations" shouldShow={shouldShow}>
              <SettingRow label={t("settings.storage.locations.library.label")} desc={t("settings.storage.locations.library.description")} searchText="默认素材库目录 asset-library" shouldShow={shouldShow}>
                <input className="settings-input settings-input-mono settings-input-path" value={appDataDir ? `${appDataDir}\\asset-library` : t("settings.storage.notRead")} readOnly />
              </SettingRow>
              <SettingRow label={t("settings.storage.locations.thumbnails.label")} desc={t("settings.storage.locations.thumbnails.description")} searchText="缩略图缓存目录 thumbnail cache" shouldShow={shouldShow}>
                <input className="settings-input settings-input-mono settings-input-path" value={appDataDir ? `${appDataDir}\\thumbnails` : t("settings.storage.notRead")} readOnly />
              </SettingRow>
              <SettingRow label={t("settings.storage.locations.database.label")} desc={t("settings.storage.locations.database.description")} searchText="数据库路径 sqlite database" shouldShow={shouldShow}>
                <input className="settings-input settings-input-mono settings-input-path" value={appDataDir ? `${appDataDir}\\luckyray.db` : "%APPDATA%\\com.luckyray.desktop\\luckyray.db"} readOnly />
              </SettingRow>
            </Group>
            <Group title={t("settings.storage.overview.group")} searchText="存储总览 素材 笔记 缓存 storage overview" shouldShow={shouldShow}>
              <StorageOverview usage={storageUsage} />
            </Group>
            <Group title={t("settings.storage.cache.group")} searchText="缓存 缩略图 清理 cache" shouldShow={shouldShow}>
              <SettingRow label={t("settings.storage.cache.label")} desc={t("settings.storage.cache.description", { size: formatSize(storageUsage?.thumbnail_size_bytes) })} searchText="缩略图缓存 清理 cache" shouldShow={shouldShow}>
                <button className="settings-btn" disabled={!!storageBusy} onClick={() => void runStorageAction(t("settings.storage.cache.clear"), async () => {
                  const result = await svcClearCache();
                  showStatus(plural(result.removed_files, { one: "settings.status.cacheCleared.one", other: "settings.status.cacheCleared.other" }, { size: formatSize(result.removed_bytes) }));
                })}>{t(storageBusy === t("settings.storage.cache.clear") ? "settings.storage.cache.clearing" : "settings.storage.cache.clear")}</button>
              </SettingRow>
            </Group>
            <Group title={t("settings.storage.backup.group")} searchText="备份 创建 恢复 backup" shouldShow={shouldShow}>
              <SettingRow label={t("settings.storage.backup.label")} desc={t("settings.storage.backup.description")} searchText="立即备份 创建备份 backup" shouldShow={shouldShow}>
                <button className="settings-btn settings-btn-primary" disabled={!!storageBusy} onClick={() => void runStorageAction(t("settings.storage.backup.create"), async () => { await svcCreateBackup(); })}>{t(storageBusy === t("settings.storage.backup.create") ? "settings.storage.backup.creating" : "settings.storage.backup.create")}</button>
              </SettingRow>
              <BackupList backups={backups} storageBusy={storageBusy} onRestore={(backup) => setConfirmAction({
                title: t("settings.storage.backup.restoreTitle"),
                kind: "warn",
                body: t("settings.storage.backup.restoreBody", { id: backup.id }),
                action: async () => runStorageAction(t("settings.storage.backup.restore"), async () => {
                  await svcRestoreBackup(backup.id);
                }),
              })} />
            </Group>
            <Group title={t("settings.storage.danger.group")} searchText="危险 重置 清除 数据 danger reset" shouldShow={shouldShow} danger>
              <SettingRow label={t("settings.storage.reset.label")} desc={t("settings.storage.reset.description")} searchText="重置 本地 偏好 shortcut reset" shouldShow={shouldShow}>
                <button className="settings-btn settings-btn-danger" onClick={() => setConfirmAction({ title: t("settings.storage.reset.title"), kind: "warn", body: t("settings.storage.reset.body"), action: () => { resetSettings(); resetShortcuts(); showStatus(t("settings.storage.reset.done")); } })}>{t("settings.storage.reset.label")}</button>
              </SettingRow>
              <SettingRow label={t("settings.storage.clear.label")} desc={t("settings.storage.clear.description")} searchText="清除应用内容 清除数据 clear data" shouldShow={shouldShow}>
                <button className="settings-btn settings-btn-danger" disabled={!!storageBusy} onClick={() => setConfirmAction({ title: t("settings.storage.clear.title"), kind: "danger", body: t("settings.storage.clear.body"), action: clearAllDataWithBackup })}>{t("settings.storage.clear.label")}</button>
              </SettingRow>
            </Group>
          </Panel>

          <Panel tab="about" active={activeTab}>
            <PanelHead title={t("settings.tab.about")} desc={t("settings.about.description")} />
            <div className="settings-about-hero">
              <div className="settings-about-logo"><img src={aboutBrandIcon} alt="LuckyRay" /></div>
              <div className="settings-about-info">
                <div className="settings-about-name">LuckyRay <span className="settings-about-version">{APP_VERSION}</span></div>
                <div className="settings-about-tags">
                  <span className="settings-pill accent">{APP_VERSION}</span>
                  <span className="settings-pill">{t("settings.about.localFirst")}</span>
                </div>
              </div>
            </div>
            <div className="settings-about-desc">
              <p>{t("settings.about.summary")}</p>
              <p>{t("settings.about.version", { version: APP_VERSION })}</p>
            </div>
            <Group title={t("settings.about.credits.group")} searchText="致谢 Eagle Obsidian Notion Raycast credits" shouldShow={shouldShow}>
              <div className="settings-credits">{t("settings.about.credits")}</div>
            </Group>
            <div className="setting-group settings-about-links-group" hidden={!shouldShow(`${t("settings.about.links.group")} ${t("settings.update.title")} ${t("settings.update.automatic")} GitHub 反馈 官网 links updates`)}>
              <h3>{t("settings.about.links.group")}</h3>
              <div className="settings-about-links settings-about-links-with-updates">
                <button type="button" className="settings-link-card" onClick={() => void handleAboutLink("GitHub", DESKTOP_LINKS.github)}>
                  <svg viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 0 0-2.05 12.65c.32.06.44-.14.44-.31v-1.13c-1.8.4-2.18-.87-2.18-.87-.3-.75-.72-.95-.72-.95-.6-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.52.71 1.9.54.06-.42.23-.71.4-.87-1.43-.16-2.95-.72-2.95-3.2 0-.71.25-1.3.67-1.75-.07-.16-.3-.83.07-1.73 0 0 .55-.17 1.8.67a6.3 6.3 0 0 1 3.27 0c1.25-.84 1.8-.67 1.8-.67.37.9.13 1.57.07 1.73.42.45.67 1.04.67 1.75 0 2.49-1.52 3.04-2.96 3.2.23.2.44.6.44 1.2v1.78c0 .17.12.37.45.31A6.5 6.5 0 0 0 8 1.5Z" /></svg>
                  <div><div className="settings-link-name">GitHub</div><div className="settings-link-desc">{t("settings.about.github.pending")}</div></div>
                </button>
                <button type="button" className="settings-link-card" onClick={() => void handleAboutLink(t("settings.about.feedback"), DESKTOP_LINKS.support)}>
                  <svg viewBox="0 0 16 16"><path d="M2 4h12M2 8h12M2 12h8" /></svg>
                  <div><div className="settings-link-name">{t("settings.about.feedback")}</div><div className="settings-link-desc">{t("settings.about.feedback.pending")}</div></div>
                </button>
                <button type="button" className="settings-link-card" onClick={() => void handleAboutLink(t("settings.about.website"), DESKTOP_LINKS.website)}>
                  <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></svg>
                  <div><div className="settings-link-name">{t("settings.about.website")}</div><div className="settings-link-desc">{t("settings.about.website.pending")}</div></div>
                </button>
                <DesktopUpdateCard version={APP_VERSION} active={activeTab === "about"} openLink={handleAboutLink} />
              </div>
            </div>
            <div className="settings-about-footer">
              <span>© 2026 LuckyRay · Made with love in China</span>
            </div>
          </Panel>
        </main>
      </div>

      {confirmAction && (
        <div className="settings-confirm-overlay open experience-dialog-backdrop" onPointerDown={confirmDialogSurface.onBackdropPointerDown}>
          <div ref={confirmDialogSurface.surfaceRef} className="settings-confirm experience-dialog" role={confirmAction.kind === "danger" ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="settings-confirm-title" aria-describedby="settings-confirm-body" tabIndex={-1} onKeyDown={confirmDialogSurface.onSurfaceKeyDown}>
            <div className="settings-confirm-head">
              <div className={`settings-confirm-icon ${confirmAction.kind || "warn"}`}>{confirmAction.kind === "danger" ? "!" : "?"}</div>
              <div className="settings-confirm-title" id="settings-confirm-title">{confirmAction.title}</div>
            </div>
            <div className="settings-confirm-body" id="settings-confirm-body">{confirmAction.body}</div>
            <div className="settings-confirm-actions">
              <button className="settings-confirm-btn" onClick={() => setConfirmAction(null)}>{t("common.action.cancel")}</button>
              {confirmAction.actions?.length ? confirmAction.actions.map((item) => (
                <button
                  key={item.label}
                  className={`settings-confirm-btn ${item.kind === "danger" ? "danger" : item.kind === "primary" ? "primary" : ""}`}
                  onClick={() => {
                    const action = item.action;
                    setConfirmAction(null);
                    void action();
                  }}
                >
                  {item.label}
                </button>
              )) : (
                <button className={`settings-confirm-btn ${confirmAction.kind === "danger" ? "danger" : ""}`} onClick={() => {
                  const action = confirmAction.action;
                  setConfirmAction(null);
                  void action?.();
                }}>{t("common.action.confirm")}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const FILM_SHORTCUT_REFERENCE = [
  ["播放 / 暂停选中片段或整条时间线", "Space / K"],
  ["向前 / 向后定位 0.1 秒", "← / →"],
  ["向前 / 向后定位 5 秒", "Shift + ← / →"],
  ["添加标记", "M"], ["打开 / 关闭标记列表", "Shift + M"],
  ["设置入点 / 出点", "I / O"], ["保存片段标记", "Ctrl / Cmd + Enter"],
  ["截取当前画面", "C"], ["全屏 / 退出全屏", "F"],
  ["打开 / 关闭视频素材详情", "?"], ["定位到首尾", "Home / End"],
  ["退出全屏、关闭当前面板或返回素材库", "Esc"],
] as const;

const panelSearchText: Record<TabKey, string> = {
  general: "语言 中文 English 启动 密度 关闭 自启动 收集箱 搜索 模式 切换 快捷键 search mode",
  layout: "布局 导航 素材库 知识库 图谱 工作区 画布 社区 AI 标签 收藏 智能文件夹 收集箱 插件 显示 隐藏 保存 应用 layout navigation visibility plugins",
  appearance: "外观 颜色 字体 排版 等宽 行距 动画 模糊 实时预览",
  shortcut: "快捷键 全局搜索 快速预览 新建笔记 侧边栏 详情 命令面板 AI 助手 影视 视频 播放 暂停 入点 出点 截帧 标记 片段 全屏",
  ai: "AI DSH provider model base url api key temperature tokens 连接测试 联网搜索 Tavily SearXNG",
  companion: "连接手机 局域网 配对 二维码 设备 撤销 安全记录 防火墙",
  storage: "存储 数据目录 路径 素材库 缩略图 数据库 总览 缓存 备份 导出 危险操作",
  about: "关于 产品 致谢 链接 版本 更新",
};

function Panel({ tab, active, children }: { tab: TabKey; active: TabKey; children: ReactNode }) {
  if (active !== tab) return null;
  return <section className="settings-panel active">{children}</section>;
}

function PanelHead({ title, desc }: { title: string; desc: string }) {
  return (
    <>
      <h2>{title}</h2>
      <p className="settings-panel-sub">{desc}</p>
    </>
  );
}

function Group({ title, children, searchText, shouldShow, danger }: { title: string; children: ReactNode; searchText: string; shouldShow: (text: string) => boolean; danger?: boolean }) {
  if (!shouldShow(`${title} ${searchText}`)) return null;
  return (
    <div className={`setting-group${danger ? " settings-danger" : ""}`}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function SettingRow({ label, desc, children, stack, searchText, shouldShow }: { label: string; desc?: string; children: ReactNode; stack?: boolean; searchText: string; shouldShow: (text: string) => boolean }) {
  if (!shouldShow(`${label} ${desc || ""} ${searchText}`)) return null;
  return (
    <div className={`setting-row${stack ? " setting-row-stack" : ""}`}>
      <div className="setting-label">
        {label}
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ value, onChange, disabled = false }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return <button className={`toggle${value ? " on" : ""}`} disabled={disabled} onClick={() => onChange(!value)} type="button" title={t(value ? "settings.toggle.on" : "settings.toggle.off")} />;
}

function Select({ value, options, onChange }: { value: string; options: string[][]; onChange: (value: string) => void }) {
  return (
    <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
    </select>
  );
}

function SegmentedControl({ value, options, onChange }: { value: string; options: string[][]; onChange: (value: string) => void }) {
  return (
    <div className="settings-segment">
      {options.map(([optionValue, label]) => {
        const isActive = value === optionValue;
        return (
          <button
            key={optionValue}
            type="button"
            className={`settings-segment-item${isActive ? " active" : ""}`}
            onClick={() => onChange(optionValue)}
            style={{ color: isActive ? "#f0f0f2" : "#5a5a62" }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ConnectionState({ state, bridgeAvailable }: { state: "idle" | "loading" | "success" | "error"; bridgeAvailable: boolean }) {
  const { t } = useI18n();
  if (state === "idle") return <span className="settings-muted-text">{t(bridgeAvailable ? "settings.connection.bridgeReady" : "settings.connection.bridgeMissing")}</span>;
  if (state === "loading") return <span className="settings-conn-state loading"><span className="settings-spinner" />{t("settings.connection.connecting")}</span>;
  if (state === "success") return <span className="settings-conn-state success">{t("settings.connection.connected")}</span>;
  return <span className="settings-conn-state error">{t("settings.connection.failed")}</span>;
}

function StorageOverview({ usage }: { usage: BridgeStorageUsage | null }) {
  const { plural, t } = useI18n();
  const total = usage?.total_size_bytes ?? 0;
  const safeTotal = Math.max(total, 1);
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const usedPct = usage ? Math.min(1, total / safeTotal) : 0;
  const offset = circumference * (1 - usedPct);
  const pct = (value: number) => Math.max(0, Math.min(100, Math.round((value / safeTotal) * 100)));
  const bars = [
    { label: t("settings.storage.category.assets"), size: formatSize(usage?.asset_library_size_bytes), pct: pct(usage?.asset_library_size_bytes ?? 0), color: "linear-gradient(90deg,var(--accent),var(--accent-hover))" },
    { label: t("settings.storage.category.database"), size: formatSize(usage?.db_size_bytes), pct: pct(usage?.db_size_bytes ?? 0), color: "linear-gradient(90deg,#4ade80,#22c55e)" },
    { label: t("settings.storage.category.thumbnails"), size: formatSize(usage?.thumbnail_size_bytes), pct: pct(usage?.thumbnail_size_bytes ?? 0), color: "linear-gradient(90deg,#fbbf24,#f59e0b)" },
    { label: t("settings.storage.category.canvas"), size: formatSize(usage?.canvas_size_bytes), pct: pct(usage?.canvas_size_bytes ?? 0), color: "linear-gradient(90deg,#a78bfa,#7c8aff)" },
    { label: t("settings.storage.category.generated"), size: formatSize(usage?.generated_media_size_bytes), pct: pct(usage?.generated_media_size_bytes ?? 0), color: "linear-gradient(90deg,#38bdf8,#0ea5e9)" },
    { label: t("settings.storage.category.other"), size: formatSize(usage?.other_data_size_bytes), pct: pct(usage?.other_data_size_bytes ?? 0), color: "linear-gradient(90deg,#94a3b8,#64748b)" },
    { label: t("settings.storage.category.backups"), size: formatSize(usage?.backup_size_bytes), pct: pct(usage?.backup_size_bytes ?? 0), color: "linear-gradient(90deg,#f472b6,#db2777)" },
  ];
  return (
    <div className="settings-storage-overview">
      <div className="settings-ring">
        <svg viewBox="0 0 120 120">
          <circle className="settings-ring-track" cx="60" cy="60" r={radius} />
          <circle className="settings-ring-progress" cx="60" cy="60" r={radius} strokeDasharray={circumference} strokeDashoffset={offset} />
        </svg>
        <div className="settings-ring-text">
          <div className="settings-ring-used">{formatSize(total)}</div>
          <div className="settings-ring-total">{usage ? [
            plural(usage.asset_count, { one: "settings.storage.assets.one", other: "settings.storage.assets.other" }),
            plural(usage.note_count, { one: "settings.storage.notes.one", other: "settings.storage.notes.other" }),
          ].join(" · ") : t("common.label.loading")}</div>
        </div>
      </div>
      <div className="settings-bar-list">
        {bars.map((bar) => (
          <div className="settings-bar-item" key={bar.label}>
            <div className="settings-bar-label">{bar.label}</div>
            <div className="settings-bar-track"><div className="settings-bar-fill" style={{ width: `${bar.pct}%`, background: bar.color }} /></div>
            <div className="settings-bar-size">{bar.size}</div>
            <div className="settings-bar-pct">{bar.pct}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BackupList({ backups, storageBusy, onRestore }: { backups: BridgeBackupInfo[]; storageBusy: string; onRestore: (backup: BridgeBackupInfo) => void }) {
  const { locale, plural, t } = useI18n();
  if (backups.length === 0) return <div className="settings-empty">{t("settings.backups.empty")}</div>;
  return (
    <div className="settings-backup-list">
      {backups.map((backup) => (
        <div className="settings-backup-item" key={backup.id}>
          <span className="settings-backup-name">{backup.id}</span>
          <span className="settings-backup-time">{formatBackupTime(backup.manifest?.created_at, locale)}</span>
          <span className="settings-backup-size">{formatSize(backup.manifest?.db_size_bytes)}</span>
          <span className="settings-backup-count">{plural(backup.manifest?.asset_count ?? 0, { one: "settings.backups.files.one", other: "settings.backups.files.other" })}</span>
          <button className="settings-backup-restore" disabled={!!storageBusy} onClick={() => onRestore(backup)}>{t("settings.storage.backup.restore")}</button>
        </div>
      ))}
    </div>
  );
}

function formatBackupTime(value: string | undefined, locale: "zh-CN" | "en-US") {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(locale);
}

function formatSize(bytes?: number) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function normalizePathForCompare(path: string) {
  return path.trim().replace(/[\\/]+$/g, "").replace(/\//g, "\\").toLowerCase();
}

function formatShortcut(event: KeyboardEvent) {
  const key = normalizeKey(event.key);
  if (!key) return "";
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  if (!["Control", "Shift", "Alt", "Meta"].includes(key)) parts.push(key);
  return parts.join("+");
}

function normalizeKey(key: string) {
  if (key === " ") return "Space";
  if (key === "Escape") return "Esc";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function getShortcutConflictMap(shortcuts: Array<{ id: ShortcutCommandId; value: string }>) {
  const conflicts = new Map<ShortcutCommandId, ShortcutCommandId[]>();
  for (const conflict of findShortcutConflicts(shortcuts)) {
    const [left, right] = conflict.ids;
    conflicts.set(left, [...(conflicts.get(left) || []), right]);
    conflicts.set(right, [...(conflicts.get(right) || []), left]);
  }
  return conflicts;
}

function shortcutName(shortcuts: Array<{ id: string; name: string }>, id: string) {
  return shortcuts.find((item) => item.id === id)?.name || id;
}

function ThemePresetSelector({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (preset: ThemePreset) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="settings-theme-preset-grid" role="radiogroup" aria-label={t("settings.theme.selector")}>
      {THEME_PRESETS.map((preset) => {
        const isSelected = value === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={`settings-theme-preset-card${isSelected ? " active" : ""}`}
            onClick={() => onSelect(preset)}
          >
            <div className="settings-theme-preview-swatches" aria-hidden="true">
              {preset.previewTokens.map((color, idx) => (
                <span
                  key={idx}
                  className="settings-theme-swatch-dot"
                  style={{ background: color }}
                />
              ))}
            </div>
            <span className="settings-theme-preset-name">{t(`settings.theme.preset.${preset.id}` as MessageKey)}</span>
            {isSelected && <span className="settings-theme-preset-check" aria-hidden="true">✓</span>}
          </button>
        );
      })}
    </div>
  );
}
