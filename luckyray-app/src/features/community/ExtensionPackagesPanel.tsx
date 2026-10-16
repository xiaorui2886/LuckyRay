import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  THEME_TOKEN_KEYS,
  packageCompatibility,
  parseLocalPackage,
  type ExtensionError,
  type ExtensionPackageService,
  type InstalledPackage,
  type PackageState,
  type TemplateResource,
  type ScriptResource,
  type ThemeResource,
} from "../../core/extensions/packages";
import { EXTENSION_ERROR_COPY, type ExtCopyKey } from "./extensionMessages";
import { useMessages } from "../../core/i18n/index";
import { COMMUNITY_UI_MESSAGES } from "./communityMessages";
import { CommunityDrawer, CommunityIcon, CommunityState, communityMatchesStatus, type CommunityStatusFilter } from "./CommunityPresentation";

type Locale = "zh-CN" | "en-US";
type Translate = (key: ExtCopyKey, vars?: Record<string, string>) => string;

type PackageView = {
  id: string;
  name: string;
  version: string;
  type: "theme" | "template" | "script";
  enabled: boolean;
  digest: string;
  requiredModules: string[];
  optionalModules: string[];
  compatible: boolean;
  unavailableOptional: string[];
  minHostVersion: string;
};

/** Map a native/TS extension error code onto a stable, human copy key. */
export function extensionErrorCopyKey(error: unknown): ExtCopyKey {
  const code = (error as ExtensionError | undefined)?.code;
  if (typeof code === "string" && code in EXTENSION_ERROR_COPY) {
    return EXTENSION_ERROR_COPY[code as keyof typeof EXTENSION_ERROR_COPY];
  }
  return "pack.error.unknown";
}

export function describePackage(pkg: InstalledPackage, hostVersion: string): PackageView {
  const manifest = pkg.package.manifest;
  const compatibility = packageCompatibility(pkg.package, hostVersion);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    enabled: pkg.enabled,
    digest: pkg.digest,
    requiredModules: manifest.requiredModules,
    optionalModules: manifest.optionalModules,
    compatible: compatibility.compatible,
    unavailableOptional: compatibility.unavailableOptional,
    minHostVersion: manifest.minHostVersion,
  };
}

function matches(pkg: PackageView, query: string) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  return pkg.name.toLowerCase().includes(q) || pkg.id.toLowerCase().includes(q);
}

export type PackagesPanelProps = {
  kind?: "theme" | "template";
  search?: string;
  compact?: boolean;
  statusFilter?: CommunityStatusFilter;
  onClearFilters?: () => void;
  service: ExtensionPackageService;
  copy: { t: Translate; locale: Locale };
  onBusyChange?: (busy: boolean) => void;
  onMessage?: (kind: "info" | "error", text: string) => void;
  /** Report the currently previewed theme id (null when none) to the host page. */
  onPreviewChange?: (preview: string | null) => void;
  /** Extra render slot for the "create note" / "insert" actions. */
  renderTemplateActions?: (pkg: PackageView) => ReactNode;
};

type Pending = "install" | "read" | null;

/** The single, panel-owned theme preview. Owns the service disposer too. */
type PreviewOwnership = { id: string; version: string; digest: string; dispose: () => void } | null;

/**
 * Installed-package surface: install / enable / disable / update / uninstall plus
 * theme preview. All state comes from the C0 extensionPackages service; this
 * component never keeps a second copy of package state or theme tokens.
 */
export function PackagesPanel({
  service,
  copy,
  onBusyChange,
  onMessage: reportMessage,
  onPreviewChange,
  renderTemplateActions,
  kind,
  search,
  compact = false,
  statusFilter = "all",
  onClearFilters,
}: PackagesPanelProps) {
  const { t } = copy;
  const { t: ui } = useMessages(COMMUNITY_UI_MESSAGES);
  const [state, setState] = useState<PackageState>(() => service.snapshot());
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const onMessage = useCallback((kind: "info" | "error", text: string) => {
    setNotice({ kind, text });
    reportMessage?.(kind, text);
  }, [reportMessage]);
  const [busy, setBusy] = useState<Pending>(null);
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set());
  const [localQuery, setQuery] = useState("");
  const query = search ?? localQuery;
  const [detailId, setDetailId] = useState<string | null>(null);
  const inFlight = useRef(false);

  // R6: the initial list load has its own state; an empty list is only shown
  // after a successful read. A failed read offers an explicit retry instead of
  // masquerading as "nothing installed".
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const loadPackages = useCallback(async () => {
    setLoad("loading");
    try {
      await service.refresh();
      setLoad("ready");
    } catch {
      setLoad("error");
    }
  }, [service]);

  // R1: exactly one preview may be owned at a time, and it is bound to the
  // package identity (id+version+digest) that started it. A confirm/cancel can
  // only act on the preview it owns, so previewing A then B never lets A's
  // confirm enable B.
  const [preview, setPreview] = useState<PreviewOwnership>(null);
  const previewRef = useRef<PreviewOwnership>(null);
  const setOwnedPreview = useCallback((next: PreviewOwnership) => {
    // Release a previously owned preview before replacing it (preview A → B).
    const previous = previewRef.current;
    if (previous && previous !== next) { try { previous.dispose(); } catch { /* ignore */ } }
    previewRef.current = next;
    setPreview(next);
    onPreviewChange?.(next ? next.id : null);
  }, [onPreviewChange]);

  useEffect(() => {
    const unsubscribe = service.subscribe(() => setState(service.snapshot()));
    setState(service.snapshot());
    return unsubscribe;
  }, [service]);

  // R6: the panel owns its first read so a failure is visible and retryable,
  // rather than depending solely on AppShell's one-shot refresh.
  useEffect(() => { void loadPackages(); }, [loadPackages]);

  useEffect(() => {
    onBusyChange?.(busy !== null);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // The community may be retained by the shell. Route departure must release
  // its existing preview owner even when React does not unmount this panel.
  useEffect(() => {
    const exit = () => { if (window.location.hash.split("?")[0] !== "#community") { setOwnedPreview(null); setDetailId(null); } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !inFlight.current) setOwnedPreview(null); };
    window.addEventListener("hashchange", exit);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("hashchange", exit); window.removeEventListener("keydown", escape); };
  }, [setOwnedPreview]);

  // Unmount must release any owned preview so no dangling overlay remains.
  useEffect(() => () => {
    const owned = previewRef.current;
    if (owned) { try { owned.dispose(); } catch { /* ignore */ } }
    previewRef.current = null;
  }, []);

  // R1: a preview whose package was updated, removed, or superseded must stop
  // being offered for confirmation. The service already drops its internal
  // preview on enable/disable/uninstall; mirror that here so no stale card can
  // confirm a different theme.
  useEffect(() => {
    const owned = previewRef.current;
    if (!owned) return;
    const entry = state.packages.find((item) => item.package.manifest.id === owned.id);
    const stillCurrent = entry
      && entry.package.manifest.version === owned.version
      && entry.digest === owned.digest
      && !entry.enabled;
    if (!stillCurrent) setOwnedPreview(null);
  }, [state, setOwnedPreview]);

  // Re-check the service's own preview after every state change; if it has
  // cleared (e.g. the service invalidated it), stop offering confirmation.
  useEffect(() => {
    if (previewRef.current && !service.activeTheme()) setOwnedPreview(null);
  }, [state, service, setOwnedPreview]);

  const invoke = useCallback(async <T,>(kind: Exclude<Pending, null>, run: () => Promise<T>, key: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    setBusy(kind);
    try {
      await run();
      setBlocked((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    } catch (error) {
      setBlocked((prev) => new Set(prev).add(key));
      onMessage?.("error", t(extensionErrorCopyKey(error)));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [onMessage, t]);

  const packages = useMemo(
    () => state.packages
      .map((entry) => describePackage(entry, state.hostVersion))
      .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "theme" ? -1 : 1),
    [state],
  );

  const themes = packages.filter((pkg) => pkg.type === "theme");
  const templates = packages.filter((pkg) => pkg.type === "template");

  const install = useCallback(async (file: File) => {
    await invoke("install", async () => {
      const text = await file.text();
      const parsed = parseLocalPackage(text);
      const latest = await service.refresh();
      const next = await service.install(text, latest.revision);
      const installed = next.packages.find((entry) => entry.package.manifest.id === parsed.manifest.id);
      onMessage?.("info", t("pack.installed", { name: installed?.package.manifest.name ?? parsed.manifest.name }));
    }, `install:${file.name}`);
  }, [invoke, onMessage, service, t]);

  const setEnabled = useCallback((pkg: PackageView, enabled: boolean) => {
    void invoke("read", async () => {
      const latest = await service.refresh();
      const current = latest.packages.find((entry) => entry.package.manifest.id === pkg.id);
      if (!current || current.digest !== pkg.digest) {
        onMessage?.("error", t("pack.error.changed"));
        return;
      }
      await (enabled ? service.enable(pkg.id, latest.revision) : service.disable(pkg.id, latest.revision));
      onMessage?.("info", t(enabled ? "pack.enabledOne" : "pack.disabledOne", { name: pkg.name }));
    }, `toggle:${pkg.id}`);
  }, [invoke, onMessage, service, t]);

  const update = useCallback(async (pkg: PackageView, file: File) => {
    await invoke("install", async () => {
      const text = await file.text();
      // R2: the chosen file must describe the package the user actually picked.
      // A wrong-file selection is rejected before any mutation, and the service
      // stays the authority for version/type checks.
      const parsed = parseLocalPackage(text);
      if (parsed.manifest.id !== pkg.id || parsed.manifest.type !== pkg.type) {
        onMessage?.("error", t("pack.error.mismatch", { name: pkg.name }));
        return;
      }
      const latest = await service.refresh();
      const current = latest.packages.find((entry) => entry.package.manifest.id === pkg.id);
      if (!current || current.digest !== pkg.digest) {
        onMessage?.("error", t("pack.error.changed"));
        return;
      }
      await service.update(text, latest.revision);
      onMessage?.("info", t("pack.updated", { name: pkg.name }));
    }, `update:${pkg.id}`);
  }, [invoke, onMessage, service, t]);

  const uninstall = useCallback((pkg: PackageView) => {
    void invoke("read", async () => {
      const latest = await service.refresh();
      await service.uninstall(pkg.id, latest.revision);
      onMessage?.("info", t("pack.uninstalled", { name: pkg.name }));
    }, `uninstall:${pkg.id}`);
  }, [invoke, onMessage, service, t]);

  const detail = detailId ? packages.find((pkg) => pkg.id === detailId) ?? null : null;
  const detailResource = detailId
    ? state.packages.find((entry) => entry.package.manifest.id === detailId)?.package.resource ?? null
    : null;

  const themeActions = (pkg: PackageView) => <ThemeActions
    service={service} pkg={pkg} t={t}
    owned={preview?.id === pkg.id && preview.version === pkg.version && preview.digest === pkg.digest}
    onStart={() => {
      try { const release = service.previewTheme(pkg.id); setOwnedPreview({ id: pkg.id, version: pkg.version, digest: pkg.digest, dispose: release }); }
      catch (error) { onMessage?.("error", t(extensionErrorCopyKey(error))); }
    }}
    onStop={() => setOwnedPreview(null)}
    onConfirm={async () => {
      const owned = previewRef.current;
      if (!owned || owned.id !== pkg.id || owned.version !== pkg.version || owned.digest !== pkg.digest) return;
      await invoke("read", async () => {
        const latest = await service.refresh();
        const current = latest.packages.find((entry) => entry.package.manifest.id === owned.id);
        if (!current || current.digest !== owned.digest || current.enabled) {
          setOwnedPreview(null); onMessage?.("error", t("pack.error.changed")); return;
        }
        await service.confirmPreview(latest.revision);
        setOwnedPreview(null);
        onMessage?.("info", t("pack.theme.applied", { name: pkg.name }));
      }, `theme-confirm:${pkg.id}`);
    }} busy={busy !== null}
  />;

  const manageActions = (pkg: PackageView) => <>
    {pkg.type === "theme" ? themeActions(pkg) : <span onClickCapture={() => setDetailId(null)}>{renderTemplateActions?.(pkg)}</span>}
    <button className="lr-cap-run secondary" disabled={busy !== null || !pkg.compatible} onClick={() => setEnabled(pkg, !pkg.enabled)}>{blocked.has(`toggle:${pkg.id}`) ? t("pack.retry") : t(pkg.enabled ? "pack.disable" : "pack.enable")}</button>
    <label className="lr-cap-run secondary ext-package-update">{blocked.has(`update:${pkg.id}`) ? t("pack.retry") : t("pack.update")}<input aria-label={t("pack.update")} type="file" accept=".json,.lrpack.json,application/json" disabled={busy !== null} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void update(pkg, file); }} /></label>
    <button className="lr-cap-run secondary danger" disabled={busy !== null} onClick={() => uninstall(pkg)}>{blocked.has(`uninstall:${pkg.id}`) ? t("pack.retry") : t("pack.uninstall")}</button>
  </>;

  return (
    <section className="community-section ext-packages" aria-busy={busy !== null}>
      {!compact && <div className="ext-packages-toolbar">
        <div className="ext-packages-intro">
          <h3 className="community-section-title">{t("pack.installed.title")}</h3>
          <p className="community-card-desc">{t("pack.installed.desc")}</p>
        </div>
        <div className="ext-packages-actions">
          <input
            className="ext-packages-search"
            type="search"
            value={query}
            placeholder={t("pack.search.placeholder")}
            aria-label={t("pack.search.aria")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className={`lr-cap-run ext-install${busy === "install" ? " is-busy" : ""}`}>
            {t("pack.install")}
            <input
              type="file"
              accept=".json,.lrpack.json,application/json"
              disabled={busy !== null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void install(file);
              }}
            />
          </label>
        </div>
      </div>}

      {load === "error" && <CommunityState kind="error" message={t("pack.load.failed")} action={<button className="lr-cap-run secondary" onClick={() => void loadPackages()}>{t("pack.load.retry")}</button>} />}
      {load === "loading" && <CommunityState kind="loading" message={t("pack.load.loading")} />}
      {preview && <div className="community-preview-notice" role="status"><CommunityIcon name="theme" /><span>{ui("community.previewing", { name: packages.find(pkg => pkg.id === preview.id)?.name ?? preview.id })}</span><button className="lr-cap-run secondary" disabled={busy !== null} onClick={() => setOwnedPreview(null)}>{t("pack.theme.cancel")}</button></div>}
      <div className={kind === "theme" ? "community-theme-layout" : undefined}>
      {load === "ready" && <div className="ext-packages-groups">
        {kind !== "template" && <PackageGroup
          title={ui("community.themeTitle")}
          description={ui("community.themeDesc")}
          empty={t("pack.group.themes.empty")}
          noMatch={t("pack.search.noMatch")}
          query={query}
          packages={themes.filter((pkg) => matches(pkg, query) && communityMatchesStatus(pkg.enabled, statusFilter))}
          total={themes.length} state={state} onClear={onClearFilters}
          busy={busy} blocked={blocked} t={t}
          onToggle={setEnabled} onDetail={setDetailId}
          renderActions={themeActions}
        />}
        {kind !== "theme" && <PackageGroup
          title={t("pack.group.templates")}
          description={ui("community.packageFallback")}
          empty={t("pack.group.templates.empty")}
          noMatch={t("pack.search.noMatch")}
          query={query}
          packages={templates.filter((pkg) => matches(pkg, query) && communityMatchesStatus(pkg.enabled, statusFilter))}
          total={templates.length} state={state} onClear={onClearFilters}
          busy={busy} blocked={blocked} t={t}
          onToggle={setEnabled} onDetail={setDetailId}
          renderActions={renderTemplateActions ? (pkg) => <>{renderTemplateActions(pkg)}</> : undefined}
        />}
      </div>}

      {kind === "theme" && <aside className="community-theme-note"><CommunityIcon name="theme" /><div><h3>{ui("community.themeNote")}</h3><p>{ui("community.themeHint")}</p><p>{ui("community.themeGlobal")}</p><button className="community-text-button" onClick={() => { setOwnedPreview(null); window.location.hash = "#settings"; }}>{ui("community.themeSettingsOpen")}<CommunityIcon name="arrow" /></button></div></aside>}
      </div>
      {detail && <CommunityDrawer title={detail.name} label={t("pack.details")} icon={detail.type === "theme" ? "theme" : "note"} dismissible={busy === null} onClose={() => { setOwnedPreview(null); setDetailId(null); }} footer={manageActions(detail)}>{notice && <div className={`community-drawer-message${notice.kind === "error" ? " error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}<PackageDetail pkg={detail} t={t} resource={detailResource} /></CommunityDrawer>}
    </section>
  );
}

function PackageGroup({
  title, description, empty, packages, total, state, onClear, busy, blocked, t, onToggle, onDetail, renderActions,
}: {
  title: string;
  description: string;
  empty: string;
  noMatch: string;
  query: string;
  packages: PackageView[];
  total: number;
  state: PackageState;
  onClear?: () => void;
  busy: Pending;
  blocked: Set<string>;
  t: Translate;
  onToggle: (pkg: PackageView, enabled: boolean) => void;
  onDetail: (id: string) => void;
  renderActions?: (pkg: PackageView) => ReactNode;
}) {
  const { t: ui } = useMessages(COMMUNITY_UI_MESSAGES);
  return (
    <div className="ext-packages-group">
      <div className="community-section-head"><div><h2>{title}</h2><p>{description}</p></div></div>
      {packages.length === 0
        ? <CommunityState kind={total ? "no-match" : "empty"} message={total ? undefined : empty} action={total && onClear ? <button className="lr-cap-run secondary" onClick={onClear}>{ui("community.clear")}</button> : undefined} />
        : <div className={`community-card-list ${packages[0].type === "theme" ? "community-theme-grid" : "community-package-template-list"}`}>
          {packages.map((pkg) => {
            const toggleKey = `toggle:${pkg.id}`;
            const resource = state.packages.find(entry => entry.package.manifest.id === pkg.id)?.package.resource;
            return (
              <article className={`community-card ext-package-card ${pkg.type === "theme" ? "community-theme-card" : "community-package-template-card"}${pkg.enabled ? " is-enabled" : ""}${pkg.compatible ? "" : " is-incompatible"}`} key={pkg.id}>
                {pkg.type === "theme" && resource && "tokens" in resource && <ThemeThumbnail resource={resource} name={pkg.name} />}
                <div className="community-card-body">
                  <div className="community-card-top">
                    <CommunityIcon name={pkg.type === "theme" ? "theme" : "note"} tile />
                    <div className="community-card-heading">
                      <div className="ext-package-title-row">
                        <span className="ext-package-name">{pkg.name}</span>
                        <span className="ext-package-version">v{pkg.version}</span>
                      </div>
                    </div>
                    <span className={`ext-package-state${pkg.enabled ? " is-on" : ""}`}>{t(pkg.enabled ? "pack.state.enabled" : "pack.state.disabled")}</span>
                  </div>
                  <p className="community-card-desc">{pkg.type === "theme" && resource && "base" in resource ? ui("community.themeBase", { base: ui(resource.base === "light" ? "community.light" : "community.dark") }) : ui("community.packageFallback")}</p>
                  {!pkg.compatible && <div className="ext-package-warn">{t("pack.incompatible", { host: pkg.minHostVersion })}</div>}
                  {pkg.unavailableOptional.length > 0 && <div className="ext-package-note">{t("pack.optionalMissing", { modules: pkg.unavailableOptional.join(", ") })}</div>}
                </div>
                <div className="community-card-actions ext-package-actions">
                  {renderActions?.(pkg)}
                  <button className={`lr-cap-run${pkg.enabled ? " secondary" : ""}`} disabled={busy !== null || !pkg.compatible} onClick={() => onToggle(pkg, !pkg.enabled)}>
                    {blocked.has(toggleKey) ? t("pack.retry") : t(pkg.enabled ? "pack.disable" : "pack.enable")}
                  </button>
                  <button className="community-text-button" disabled={busy !== null} onClick={() => onDetail(pkg.id)}>{t("pack.details")}<CommunityIcon name="arrow" /></button>
                </div>
              </article>
            );
          })}
        </div>}
    </div>
  );
}

function ThemeThumbnail({ resource, name }: { resource: ThemeResource; name: string }) {
  const { t } = useMessages(COMMUNITY_UI_MESSAGES);
  const tokens = resource.tokens;
  const style = {
    "--thumb-bg": tokens["--theme-app-bg"] ?? "var(--theme-app-bg)",
    "--thumb-surface": tokens["--theme-surface-panel"] ?? "var(--bg-surface)",
    "--thumb-card": tokens["--theme-card-bg"] ?? "var(--theme-card-bg)",
    "--thumb-text": tokens["--text-primary"] ?? "var(--text-primary)",
    "--thumb-accent": tokens["--accent"] ?? "var(--accent)",
  } as CSSProperties;
  return <div className="community-theme-thumbnail" style={style} role="img" aria-label={t("community.themeThumbnail", { name })}><div className="community-thumb-top"><i /><i /><i /></div><div className="community-thumb-workspace"><aside><b /><span /><span /><span /></aside><section><b /><div><i /><i /><i /></div><span /></section></div></div>;
}

function ThemeActions({
  service, pkg, t, owned, onStart, onStop, onConfirm, busy,
}: {
  service: ExtensionPackageService;
  pkg: PackageView;
  t: Translate;
  owned: boolean;
  onStart: () => void;
  onStop: () => void;
  onConfirm: () => void | Promise<void>;
  busy: boolean;
}) {
  void service;
  // R1: confirmation controls render only for the card that owns the current
  // preview. Every other theme card shows the plain preview action.
  if (owned) {
    return <div className="ext-theme-preview-actions">
      <button className="lr-cap-run" disabled={busy} onClick={() => void onConfirm()}>{t("pack.theme.confirm")}</button>
      <button className="lr-cap-run secondary" disabled={busy} onClick={onStop}>{t("pack.theme.cancel")}</button>
    </div>;
  }
  return <button className="lr-cap-run secondary" disabled={!pkg.compatible || busy} onClick={onStart}>{t("pack.theme.preview")}</button>;
}

function PackageDetail({ pkg, t, resource }: { pkg: PackageView; t: Translate; resource: ThemeResource | TemplateResource | ScriptResource | null }) {
  const themeTokenCount = pkg.type === "theme" && resource && "tokens" in resource && resource.tokens
    ? Object.keys(resource.tokens).filter((key) => (THEME_TOKEN_KEYS as readonly string[]).includes(key)).length
    : 0;
  return (
    <div className="ext-package-detail">
      {pkg.type === "theme" && resource && "tokens" in resource && <ThemeThumbnail resource={resource} name={pkg.name} />}
      <dl className="community-info ext-package-detail-grid">
        <dt>{t("pack.detail.id")}</dt><dd>{pkg.id}</dd>
        <dt>{t("pack.detail.version")}</dt><dd>{pkg.version}</dd>
        <dt>{t("pack.detail.type")}</dt><dd>{t(pkg.type === "theme" ? "pack.type.theme" : "pack.type.template")}</dd>
        <dt>{t("pack.detail.host")}</dt><dd>{pkg.minHostVersion}</dd>
        <dt>{t("pack.detail.required")}</dt><dd>{pkg.requiredModules.length ? pkg.requiredModules.join(", ") : t("pack.detail.none")}</dd>
        <dt>{t("pack.detail.optional")}</dt><dd>{pkg.optionalModules.length ? pkg.optionalModules.join(", ") : t("pack.detail.none")}</dd>
      </dl>
      {pkg.unavailableOptional.length > 0 && <div className="ext-package-note">{t("pack.optionalMissing", { modules: pkg.unavailableOptional.join(", ") })}</div>}
      <div className="ext-package-detail-theme">
        {pkg.type === "theme" && <span>{t("pack.detail.themeTokens", { count: String(themeTokenCount), total: String(THEME_TOKEN_KEYS.length) })}</span>}
      </div>
    </div>
  );
}
