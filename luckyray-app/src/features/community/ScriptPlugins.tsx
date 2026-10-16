import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm as hostConfirm, save } from "@tauri-apps/plugin-dialog";
import { extensionPackages, parseLocalPackage, ExtensionError, THEME_TOKEN_KEYS, type InstalledPackage, type ScriptContribution, type ScriptResource } from "../../core/extensions/packages";
import { PluginRunError, domainErrorCode, runPlugin, type PluginProgress, type PluginRunResult, type PluginScope, type PluginUi } from "../../core/extensions/runtime";
import { listLegacyFilteredMaterialAssets, listLegacyMaterialAssets } from "../../core/services/materials";
import { ensureActiveKnowledgeUiSource, knowledgeDocumentNoteId, listKnowledgeDocuments, searchKnowledgeDocuments } from "../../core/services/knowledge";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import { focusEntity } from "../../core/services/context";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { EXT_PACKAGE_MESSAGES } from "./extensionMessages";
import { SCRIPT_PLUGIN_MESSAGES, pluginErrorCode, pluginErrorCopyKey, type PluginCopyKey } from "./pluginMessages";
import { LIST_SHOWN, NOTES_LIST_CAP, PICK_LIMITS, describeOutcomes, describeScriptPackage, filterByQuery, mergeFieldValues, nextGrants, pluginChanged, sameStrings, scopeSignature, type OutcomeView, type PluginView, type RunScope } from "./scriptPluginModel";
import { pageVisibleInSidebar, writeSidebarPref, savePageSession, restorePageSession } from "./pluginPages";
import { pluginPagePath } from "../../app/shellNav";
import "./scriptPlugins.css";
import { CommunityDrawer, CommunityIcon, CommunityState, communityMatchesStatus, type CommunityStatusFilter } from "./CommunityPresentation";
import { COMMUNITY_UI_MESSAGES } from "./communityMessages";

const COPY = defineMessages({ ...EXT_PACKAGE_MESSAGES, ...SCRIPT_PLUGIN_MESSAGES });
type Translate = (key: PluginCopyKey, params?: Readonly<Record<string, string | number>>) => string;
function useCopy(): { t: Translate } {
  const { t } = useMessages(COPY);
  return { t: t as unknown as Translate };
}
export function usePluginCopy(): { t: Translate } { return useCopy(); }

export function useScriptPackages() {
  const [packages, setPackages] = useState(() => extensionPackages.snapshot().packages);
  useEffect(() => extensionPackages.subscribe(() => setPackages(extensionPackages.snapshot().packages)), []);
  return packages.filter(p => p.package.manifest.type === "script");
}
export function openPlugin(id: string, contribution: string) { window.dispatchEvent(new CustomEvent("luckyray:plugin-open", { detail: { id, contribution } })); }
/** A `page` contribution opens as a real main-area page, never as the modal dialog. */
export function openPluginPage(id: string, pageId: string) { window.location.hash = `#${pluginPagePath(id, pageId)}`; }

function permissionCopy(t: Translate, permission: string) {
  const key = `plugin.perm.${permission}` as PluginCopyKey;
  return key in COPY ? t(key) : permission;
}
function kindCopy(t: Translate, kind: ScriptContribution["kind"]) { return t(`plugin.kind.${kind}` as PluginCopyKey); }
function materialKindCopy(t: Translate, kind: string) {
  const key = `plugin.material.${kind}` as PluginCopyKey;
  return key in COPY ? t(key) : kind;
}
function errorText(t: Translate, error: unknown) { return t(pluginErrorCopyKey(error), { code: pluginErrorCode(error) }); }
/**
 * Write/uninstall confirmation. Inside Tauri the dialog plugin's init script replaces
 * `window.confirm` with an async call to a command this plugin version does not
 * register, so it always rejects; the plugin's own `confirm()` (native OK/Cancel
 * dialog over the allowed `message` command) is the working equivalent. Browsers
 * keep their synchronous confirm. Either way the answer is awaited.
 */
async function confirmWithHost(message: string): Promise<boolean> {
  if ("__TAURI_INTERNALS__" in window) return hostConfirm(message, { title: "LuckyRay", kind: "warning" });
  return Boolean(await Promise.resolve(window.confirm(message)));
}
const EMPTY_PROGRESS: PluginProgress = { outcomes: [], unconfirmed: [], failures: [] };
const WRITE_METHODS = new Set(["data.set", "materials.tags", "knowledge.create", "knowledge.insert", "canvas.export"]);
function methodCopy(t: Translate, method: string) {
  const key = `plugin.dialog.method.${method}` as PluginCopyKey;
  return key in COPY ? t(key) : method;
}

type Notice = { kind: "info" | "error"; text: string };

/** Installed functional plugins: install/update, consent, enable/disable, uninstall, entries. */
export function ScriptPackagesPanel({ search = "", compact = false, statusFilter = "all", onClearFilters, onBusyChange }: { search?: string; compact?: boolean; statusFilter?: CommunityStatusFilter; onClearFilters?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useCopy();
  const { t: ui } = useMessages(COMMUNITY_UI_MESSAGES);
  const packages = useScriptPackages();
  const [hostVersion, setHostVersion] = useState(() => extensionPackages.snapshot().hostVersion);
  useEffect(() => extensionPackages.subscribe(() => setHostVersion(extensionPackages.snapshot().hostVersion)), []);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const loadPackages = useCallback(async () => {
    setLoad("loading");
    try { await extensionPackages.refresh(); setLoad("ready"); } catch { setLoad("error"); }
  }, []);
  useEffect(() => { void loadPackages(); }, [loadPackages]);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [optionalChoice, setOptionalChoice] = useState<Record<string, string[]>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const allViews = useMemo(() => packages.map(p => describeScriptPackage(p, hostVersion)).sort((a, b) => a.name.localeCompare(b.name)), [packages, hostVersion]);
  const views = allViews.filter(view => communityMatchesStatus(view.enabled, statusFilter) && `${view.name} ${view.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const detail = allViews.find(view => view.id === detailId);
  useEffect(() => { onBusyChange?.(busy !== null); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    const exit = () => { if (window.location.hash.split("?")[0] !== "#community") setDetailId(null); };
    window.addEventListener("hashchange", exit);
    return () => window.removeEventListener("hashchange", exit);
  }, []);

  // One mutation at a time; the message names the package the completed call actually touched.
  const act = useCallback(async (key: string, run: () => Promise<Notice | void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(key); setNotice(null);
    try { const result = await run(); if (result) setNotice(result); }
    catch (error) { setNotice({ kind: "error", text: errorText(t, error) }); }
    finally { inFlight.current = false; setBusy(null); }
  }, [t]);
  const current = async (view: PluginView) => {
    const latest = await extensionPackages.refresh();
    if (pluginChanged(view, latest.packages.find(p => p.package.manifest.id === view.id))) throw new ExtensionError("plugin-changed");
    return latest;
  };
  const install = (file: File) => act("install", async () => {
    const text = await file.text();
    const parsed = parseLocalPackage(text);
    if (parsed.manifest.type !== "script") throw new ExtensionError("plugin-not-script");
    const latest = await extensionPackages.refresh();
    const existing = latest.packages.some(p => p.package.manifest.id === parsed.manifest.id);
    const next = existing ? await extensionPackages.update(text, latest.revision) : await extensionPackages.install(text, latest.revision);
    const name = next.packages.find(p => p.package.manifest.id === parsed.manifest.id)?.package.manifest.name ?? parsed.manifest.name;
    return { kind: "info", text: t(existing ? "pack.updated" : "pack.installed", { name }) };
  });
  const update = (view: PluginView, file: File) => act(`update:${view.id}`, async () => {
    const text = await file.text();
    const parsed = parseLocalPackage(text);
    if (parsed.manifest.id !== view.id || parsed.manifest.type !== "script") return { kind: "error", text: t("pack.error.mismatch", { name: view.name }) };
    const latest = await current(view);
    await extensionPackages.update(text, latest.revision);
    return { kind: "info", text: t("pack.updated", { name: parsed.manifest.name }) };
  });
  const saveGrants = (view: PluginView) => act(`grant:${view.id}`, async () => {
    const grants = nextGrants(view, optionalChoice[view.id] ?? view.granted);
    const latest = await current(view);
    await extensionPackages.grant(view.id, grants, latest.revision);
    return { kind: "info", text: t("plugin.grant.saved", { name: view.name, count: grants.length }) };
  });
  const revokeAll = (view: PluginView) => act(`grant:${view.id}`, async () => {
    const latest = await current(view);
    await extensionPackages.grant(view.id, [], latest.revision);
    setOptionalChoice(choice => ({ ...choice, [view.id]: [] }));
    return { kind: "info", text: t("plugin.grant.revoked", { name: view.name }) };
  });
  const toggle = (view: PluginView) => act(`toggle:${view.id}`, async () => {
    const latest = await current(view);
    await (view.enabled ? extensionPackages.disable(view.id, latest.revision) : extensionPackages.enable(view.id, latest.revision));
    return { kind: "info", text: t(view.enabled ? "pack.disabledOne" : "pack.enabledOne", { name: view.name }) };
  });
  const uninstall = (view: PluginView) => {
    void act(`uninstall:${view.id}`, async () => {
      if (!(await confirmWithHost(t("plugin.uninstallConfirm", { name: view.name })))) return;
      const latest = await current(view);
      await extensionPackages.uninstall(view.id, latest.revision);
      return { kind: "info", text: t("pack.uninstalled", { name: view.name }) };
    });
  };

  return <section className="community-section plugin-section" aria-busy={busy !== null}>
    <div className="community-section-head plugin-section-head">
      <div><h2>{ui("community.localPlugins")}</h2><p>{ui("community.pluginDesc")}</p></div>
      {compact && load === "ready" && <span className="community-count-label">{ui("community.count", { count: views.length })}</span>}
      {!compact && <label className={`lr-cap-run plugin-file-button${busy === "install" ? " is-busy" : ""}`}>
        {t("plugin.install")}
        <input type="file" accept=".json,.lrpack.json,application/json" disabled={busy !== null} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void install(file); }} />
      </label>}
    </div>
    {notice && <div className={`community-message plugin-notice${notice.kind === "error" ? " error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
    {load === "error" && <CommunityState kind="error" message={`${t("plugin.panel.loadFailed")}${packages.length > 0 ? ` ${t("plugin.panel.stale")}` : ""}`} action={<button className="lr-cap-run secondary" onClick={() => void loadPackages()}>{t("plugin.panel.retry")}</button>} />}
    {load === "loading" && allViews.length === 0 && <CommunityState kind="loading" message={t("plugin.panel.loading")} />}
    {load === "ready" && views.length === 0 && <CommunityState kind={allViews.length ? "no-match" : "empty"} message={allViews.length ? undefined : t("plugin.panel.empty")} action={allViews.length && onClearFilters ? <button className="lr-cap-run secondary" onClick={onClearFilters}>{ui("community.clear")}</button> : undefined} />}
    <div className="community-card-list community-plugin-grid">
      {views.map(view => <PluginCard key={view.id} view={view} t={t} busy={busy}
        optional={optionalChoice[view.id] ?? view.granted.filter(p => view.optional.includes(p))}
        onOptional={next => setOptionalChoice(choice => ({ ...choice, [view.id]: next }))}
        onSaveGrants={() => void saveGrants(view)} onRevoke={() => void revokeAll(view)} onToggle={() => void toggle(view)}
        onUpdate={file => void update(view, file)} onUninstall={() => uninstall(view)} onDetail={() => setDetailId(detailId === view.id ? null : view.id)} />)}
    </div>
    {detail && <PluginDetails view={detail} t={t} busy={busy} notice={notice}
      optional={optionalChoice[detail.id] ?? detail.granted.filter(permission => detail.optional.includes(permission))}
      onOptional={next => setOptionalChoice(choice => ({ ...choice, [detail.id]: next }))}
      onSaveGrants={() => void saveGrants(detail)} onRevoke={() => void revokeAll(detail)} onToggle={() => void toggle(detail)}
      onUpdate={file => void update(detail, file)} onUninstall={() => uninstall(detail)} onDetail={() => setDetailId(null)}
    />}
  </section>;
}

type PluginCardProps = {
  view: PluginView; t: Translate; busy: string | null; optional: string[]; onOptional: (next: string[]) => void;
  onSaveGrants: () => void; onRevoke: () => void; onToggle: () => void; onUpdate: (file: File) => void; onUninstall: () => void; onDetail: () => void;
};

function pluginStatusKey(view: PluginView): PluginCopyKey {
  return `plugin.status.${{ enabled: "enabled", disabled: "disabled", "needs-consent": "needsConsent", incompatible: "incompatible" }[view.status]}` as PluginCopyKey;
}

function PluginCard({ view, t, busy, optional, onToggle, onDetail }: PluginCardProps) {
  const { t: ui } = useMessages(COMMUNITY_UI_MESSAGES);
  const locked = busy !== null;
  const grantsDirty = !sameStrings(nextGrants(view, optional), view.granted);
  const canEnable = view.compatible && view.missingRequired.length === 0 && !grantsDirty;
  return <article className={`community-card plugin-card is-${view.status}`} aria-busy={busy?.endsWith(`:${view.id}`) ?? false}>
    <div className={`community-card-top${view.id === "example.page-desk" ? " is-page-extension" : ""}`}><CommunityIcon name={view.id === "example.material-manifest" ? "checklist" : "plugin"} tile /><div className="community-card-heading"><h3 className="community-card-title">{view.name}</h3><span className="plugin-version">v{view.version}</span></div><span className={`plugin-status plugin-status-${view.status}`}><i aria-hidden="true" />{view.status === "disabled" ? ui("community.disabled") : t(pluginStatusKey(view))}</span></div>
    <p className="community-card-desc">{ui(view.id === "example.material-manifest" ? "community.materialManifest" : view.id === "example.page-desk" ? "community.pageDesk" : "community.pluginFallback")}</p>
    <div className="community-card-meta">{view.id === "example.material-manifest" && <><span>{ui("community.tagMaterials")}</span><span>{ui("community.tagNotes")}</span></>}{view.id === "example.page-desk" && <><span>{ui("community.tagPage")}</span><span>{ui("community.tagData")}</span></>}<small>{t("plugin.entry.header", { count: view.contributions.length })}</small></div>
    {!view.compatible && <p className="ext-package-warn">{t("pack.incompatible", { host: view.minHostVersion })}</p>}
    <div className="community-card-actions plugin-card-actions"><button className={`lr-cap-run${view.enabled ? " secondary" : ""}`} disabled={locked || (!view.enabled && !canEnable)} onClick={onToggle}>{t(view.enabled ? "plugin.disable" : "plugin.enable")}</button><button className="community-text-button" disabled={locked} onClick={onDetail}>{t("plugin.details")}<CommunityIcon name="arrow" /></button></div>
    {view.enabled && view.contributions.length > 0 && <div className="plugin-entries plugin-card-entries">{view.contributions.slice(0, 2).map(entry => <button key={entry.id} className="community-text-button plugin-entry" disabled={locked} onClick={() => entry.kind === "page" ? openPluginPage(view.id, entry.id) : openPlugin(view.id, entry.id)}>{entry.label}<CommunityIcon name="arrow" /></button>)}{view.contributions.length > 2 && <button className="community-text-button" disabled={locked} onClick={onDetail}>{ui("community.entries")} · {view.contributions.length}</button>}</div>}
  </article>;
}

function PluginDetails({ view, t, busy, optional, onOptional, onSaveGrants, onRevoke, onToggle, onUpdate, onUninstall, onDetail, notice }: PluginCardProps & { notice: Notice | null }) {
  const { t: ui } = useMessages(COMMUNITY_UI_MESSAGES);
  const locked = busy !== null;
  const grantsDirty = !sameStrings(nextGrants(view, optional), view.granted);
  const canEnable = view.compatible && view.missingRequired.length === 0 && !grantsDirty;
  const openEntry = (entry: ScriptContribution) => {
    onDetail();
    // Let the existing modal lease restore focus before invoking the original host entry.
    requestAnimationFrame(() => entry.kind === "page" ? openPluginPage(view.id, entry.id) : openPlugin(view.id, entry.id));
  };
  return <CommunityDrawer title={view.name} label={ui("community.details")} dismissible={!locked} onClose={onDetail} footer={<>
      {view.compatible && view.required.length + view.optional.length > 0 && <button className="lr-cap-run" disabled={locked || (!grantsDirty && view.missingRequired.length === 0)} onClick={onSaveGrants}>{t("plugin.grant.save")}</button>}
      <button className="lr-cap-run secondary" disabled={locked || (!view.enabled && !canEnable)} onClick={onToggle}>{t(view.enabled ? "plugin.disable" : "plugin.enable")}</button>
      <label className="lr-cap-run secondary plugin-file-button">{t("plugin.update")}<input type="file" aria-label={t("plugin.update")} accept=".json,.lrpack.json,application/json" disabled={locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onUpdate(file); }} /></label>
      <button className="lr-cap-run secondary danger" disabled={locked} onClick={onUninstall}>{t("plugin.uninstall")}</button>
    </>}>
      {notice && <div className={`community-drawer-message${notice.kind === "error" ? " error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
      <p className="community-drawer-intro">{ui("community.pluginFallback")}</p>
      <div className="community-detail-status"><span className={`plugin-status plugin-status-${view.status}`}>{t(pluginStatusKey(view))}</span><span>v{view.version}</span></div>
      {!view.compatible && <div className="ext-package-warn">{t("pack.incompatible", { host: view.minHostVersion })}</div>}
      {view.compatible && view.status === "needs-consent" && view.granted.length > 0 && <div className="ext-package-note">{t("plugin.consentCleared")}</div>}
      {view.required.length + view.optional.length > 0 && <fieldset className="plugin-permissions" disabled={locked || !view.compatible}>
        <legend>{t("plugin.perm.caption")}</legend>
        {view.required.map(permission => <label key={permission} className="plugin-permission is-required"><input type="checkbox" checked readOnly disabled /><span className="plugin-permission-text"><span className="plugin-permission-badge">{t("plugin.perm.required")}</span>{permissionCopy(t, permission)}</span></label>)}
        {view.optional.map(permission => <label key={permission} className="plugin-permission"><input type="checkbox" checked={optional.includes(permission)} onChange={e => onOptional(e.target.checked ? [...optional, permission] : optional.filter(p => p !== permission))} /><span className="plugin-permission-text"><span className="plugin-permission-badge optional">{t("plugin.perm.optional")}</span>{permissionCopy(t, permission)}</span></label>)}
      </fieldset>}
      {view.compatible && view.granted.length > 0 && <button className="community-text-button" disabled={locked} onClick={onRevoke}>{t("plugin.grant.revokeAll")}</button>}
      <section className="community-detail-section"><h3>{ui("community.entries")}</h3>{!view.enabled && <p className="community-muted">{ui("community.afterEnable")}</p>}<div className="community-entry-list">{view.contributions.map(entry => <div key={entry.id} className="community-entry-row"><span><strong>{entry.label}</strong><small>{kindCopy(t, entry.kind)}</small></span><button className="lr-cap-run secondary plugin-entry" disabled={locked || !view.enabled} onClick={() => openEntry(entry)}>{ui("community.open")}<CommunityIcon name="arrow" /></button>{view.enabled && entry.kind === "page" && <SidebarPrefToggle view={view} pageId={entry.id} label={entry.label} />}</div>)}</div></section>
      <details className="community-detail-technical"><summary>{ui("community.moreInfo")}</summary><dl className="community-info plugin-detail">
        <dt>{t("pack.detail.id")}</dt><dd><code>{view.id}</code></dd>
        <dt>{t("pack.detail.version")}</dt><dd>{view.version} · data v{view.dataVersion}</dd>
        <dt>{t("pack.detail.host")}</dt><dd>{view.minHostVersion}</dd>
        <dt>{t("pack.detail.required")}</dt><dd>{view.modules.required.join(", ") || t("pack.detail.none")}</dd>
        <dt>{t("pack.detail.optional")}</dt><dd>{view.modules.optional.join(", ") || t("pack.detail.none")}</dd>
        <dt>{t("plugin.perm.required")}</dt><dd><code>{view.required.join(", ") || t("pack.detail.none")}</code></dd>
        <dt>{t("plugin.perm.optional")}</dt><dd><code>{view.optional.join(", ") || t("pack.detail.none")}</code></dd>
      </dl></details>
  </CommunityDrawer>;
}

type Selection = { id: string; contribution: string; digest: string | null; epoch: number | null };

/** Always-mounted host surface: plugin menu plus the modal invocation. Plugin code never touches this DOM. */
export function PluginEntryMenu() {
  const { t } = useCopy();
  const packages = useScriptPackages();
  const [selected, setSelected] = useState<Selection | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // While a run is in flight, only the dialog's own Stop/Close path may end it, so the
  // "accepted writes may still finish" notice is never skipped by Escape or the backdrop.
  const busyRef = useRef(false);
  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; contribution: string }>).detail;
      const entry = extensionPackages.snapshot().packages.find(p => p.package.manifest.id === detail.id);
      setSelected({ id: detail.id, contribution: detail.contribution, digest: entry?.digest ?? null, epoch: entry?.epoch ?? null });
    };
    window.addEventListener("luckyray:plugin-open", listener);
    return () => window.removeEventListener("luckyray:plugin-open", listener);
  }, []);
  useEffect(() => {
    if (!selected) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busyRef.current) setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  const enabled = packages.filter(p => p.enabled);
  const pkg = packages.find(p => p.package.manifest.id === selected?.id);
  // Fail closed: an instance is live only for the exact digest+epoch it was opened with.
  const live = !!pkg && !!selected && selected.digest !== null && pkg.enabled && pkg.digest === selected.digest && (pkg.epoch ?? null) === selected.epoch;
  const contribution = live ? (pkg.package.resource as ScriptResource).contributions.find(c => c.id === selected.contribution) : undefined;
  const close = () => setSelected(null);
  if (!enabled.length && !selected) return null;
  return <>
    {enabled.length > 0 && <details className="plugin-entry-menu"><summary>{t("plugin.menu.label")}</summary>
      {enabled.map(p => <div className="plugin-entry-group" key={p.package.manifest.id}><span className="plugin-entry-group-name">{p.package.manifest.name}</span>
        {(p.package.resource as ScriptResource).contributions.map(c => <button key={c.id} onClick={() => c.kind === "page" ? openPluginPage(p.package.manifest.id, c.id) : openPlugin(p.package.manifest.id, c.id)}>{c.label}<small>{kindCopy(t, c.kind)}</small></button>)}
      </div>)}
    </details>}
    {selected && <div className="plugin-dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) close(); }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={contribution?.label ?? t("plugin.menu.label")} className="plugin-dialog">
        {pkg && contribution && live
          ? <PluginInvocation key={`${pkg.package.manifest.id}:${pkg.digest}:${pkg.epoch ?? 0}:${contribution.id}`} pkg={pkg} contribution={contribution} close={close} onBusyChange={busy => { busyRef.current = busy; }} t={t} />
          : <><header className="plugin-dialog-head"><h2>{pkg?.package.manifest.name ?? selected.id}</h2><button className="lr-cap-run secondary" onClick={close}>{t("plugin.close")}</button></header><p className="plugin-invalidated" role="alert">{t("plugin.menu.invalidated", { name: pkg?.package.manifest.name ?? selected.id })}</p></>}
      </div>
    </div>}
  </>;
}

type PickItem = { id: string; name: string; meta?: string };
type PickState = { status: "loading" | "ready" | "error"; items: PickItem[]; total: number | null; capped?: boolean; error?: string };
const PICK_IDLE: PickState = { status: "loading", items: [], total: null };

function ObjectPicker({ title, module, state, selected, names, max, disabled, onChange, onSearch, hint, t }: {
  title: string; module: string; state: PickState; selected: string[]; names: Map<string, string>; max: number; disabled: boolean;
  onChange: (next: string[]) => void; onSearch: (query: string) => void; hint?: ReactNode; t: Translate;
}) {
  const [query, setQuery] = useState("");
  const first = useRef(true);
  // The owner loads the initial list; only user-typed queries go through the debounce.
  useEffect(() => { if (first.current) { first.current = false; return; } const timer = setTimeout(() => onSearch(query), 250); return () => clearTimeout(timer); }, [query, onSearch]);
  const shownIds = new Set(state.items.map(item => item.id));
  const pinned = selected.filter(id => !shownIds.has(id)).map(id => ({ id, name: names.get(id) ?? id }));
  const toggle = (id: string, checked: boolean) => onChange(checked ? (selected.includes(id) || selected.length >= max ? selected : [...selected, id]) : selected.filter(value => value !== id));
  return <fieldset className="plugin-picker" disabled={disabled}>
    <legend>{title}<span className="plugin-picker-count">{t("plugin.dialog.pick.selected", { count: selected.length, max })}</span></legend>
    <input type="search" className="plugin-picker-search" value={query} placeholder={t("plugin.dialog.pick.search")} aria-label={`${title} ${t("plugin.dialog.pick.search")}`} onChange={e => setQuery(e.target.value)} />
    <div className="plugin-picker-list" role="group">
      {pinned.map(item => <label key={`pinned:${item.id}`} className="plugin-pick is-pinned"><input type="checkbox" checked onChange={() => toggle(item.id, false)} /><span>{item.name}</span></label>)}
      {state.status === "loading" && <div className="plugin-picker-state">{t("plugin.dialog.pick.loading")}</div>}
      {state.status === "error" && <div className="plugin-picker-state is-error">{t("plugin.dialog.pick.loadFailed", { module, reason: (state.error ?? "").replace(/。+$/, "") })}</div>}
      {state.status === "ready" && state.items.length === 0 && <div className="plugin-picker-state">{query.trim() ? t("plugin.dialog.pick.noMatch") : t("plugin.dialog.pick.empty")}</div>}
      {state.status === "ready" && state.items.map(item => <label key={item.id} className="plugin-pick"><input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && selected.length >= max} onChange={e => toggle(item.id, e.target.checked)} /><span>{item.name}</span>{item.meta && <small>{item.meta}</small>}</label>)}
    </div>
    {state.status === "ready" && state.total !== null && state.total > state.items.length && <div className="plugin-picker-hint">{t("plugin.dialog.pick.more", { total: state.total, shown: state.items.length })}</div>}
    {state.status === "ready" && state.capped && <div className="plugin-picker-hint">{t("plugin.dialog.pick.capped", { shown: state.items.length })}</div>}
    {hint && <div className="plugin-picker-hint">{hint}</div>}
  </fieldset>;
}

export function PluginInvocation({ pkg, contribution, close, onBusyChange, t, variant = "dialog", sessionKey }: { pkg: InstalledPackage; contribution: ScriptContribution; close: () => void; onBusyChange?: (busy: boolean) => void; t: Translate; variant?: "dialog" | "page"; sessionKey?: string }) {
  const grants = useMemo(() => pkg.grants ?? [], [pkg.grants]);
  const needMaterials = grants.some(p => p.startsWith("materials."));
  const needKnowledge = grants.some(p => p.startsWith("knowledge."));
  const needCanvas = grants.some(p => p.startsWith("canvas."));
  const [materials, setMaterials] = useState<PickState>(PICK_IDLE);
  const [notes, setNotes] = useState<PickState>(PICK_IDLE);
  const [canvases, setCanvases] = useState<{ state: PickState; all: PickItem[] }>({ state: PICK_IDLE, all: [] });
  const restored = variant === "page" && sessionKey ? restorePageSession(sessionKey, pkg.digest, pkg.epoch ?? null) : null;
  const [materialIds, setMaterialIds] = useState<string[]>(restored?.materialIds ?? []);
  const [documents, setDocuments] = useState<string[]>(restored?.documents ?? []);
  const [canvasIds, setCanvasIds] = useState<string[]>(restored?.canvasIds ?? []);
  const [allowCreate, setAllowCreate] = useState(false);
  const [writes, setWrites] = useState(false);
  const fieldsRef = useRef<Record<string, string>>({});
  const scopeRef = useRef({ materialIds, documents, canvasIds });
  scopeRef.current = { materialIds, documents, canvasIds };
  const [busy, setBusy] = useState(false);
  const [ui, setUi] = useState<PluginUi | null>(restored?.ui ?? null);
  const uiRef = useRef<PluginUi | null>(restored?.ui ?? null);
  uiRef.current = ui;
  const [fields, setFields] = useState<Record<string, string>>(restored?.fields ?? {});
  const [progress, setProgress] = useState<PluginProgress>(EMPTY_PROGRESS);
  // One round = one non-theme run. Its host-confirmed record is shown whether the plugin's UI arrived or not.
  const [round, setRound] = useState<"idle" | "running" | "done" | "failed" | "cancelled">("idle");
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const names = useRef(new Map<string, string>());
  const edited = useRef(new Set<string>(restored?.edited ?? []));
  fieldsRef.current = fields;
  const sourceAtOpen = useRef(readActiveKnowledgeWriteSource());
  const controller = useRef<AbortController | null>(null);
  const live = useRef(true);
  const sequence = useRef({ materials: 0, notes: 0 });
  const log = useCallback((message: string) => setLogs(old => [...old.slice(-19), message]), []);
  const remember = useCallback((items: PickItem[]) => { for (const item of items) names.current.set(item.id, item.name); return items; }, []);

  const loadMaterials = useCallback(async (query: string) => {
    if (!needMaterials) return;
    const ticket = ++sequence.current.materials;
    setMaterials(state => ({ ...state, status: "loading" }));
    try {
      // No server-side limit: the full match count feeds the "showing N of total" hint honestly.
      const assets = query.trim() ? await listLegacyFilteredMaterialAssets({ query: query.trim() }) : await listLegacyMaterialAssets();
      if (!live.current || ticket !== sequence.current.materials) return;
      setMaterials({ status: "ready", total: assets.length, items: remember(assets.slice(0, LIST_SHOWN).map(a => ({ id: a.id, name: a.name, meta: [materialKindCopy(t, a.kind), a.mimeType].filter(Boolean).join(" · ") }))) });
    } catch (error) { if (live.current && ticket === sequence.current.materials) { log(pluginErrorCode(error)); setMaterials({ status: "error", items: [], total: null, error: errorText(t, error) }); } }
  }, [log, needMaterials, remember, t]);
  const loadNotes = useCallback(async (query: string) => {
    if (!needKnowledge) return;
    const ticket = ++sequence.current.notes;
    if (!sourceAtOpen.current?.vaultId) { setNotes({ status: "error", items: [], total: null, error: t("plugin.dialog.noKnowledgeSource") }); return; }
    setNotes(state => ({ ...state, status: "loading" }));
    try {
      const searching = query.trim().length > 0;
      const list = searching ? await searchKnowledgeDocuments(query.trim(), LIST_SHOWN) : await listKnowledgeDocuments({ limit: NOTES_LIST_CAP });
      if (!live.current || ticket !== sequence.current.notes) return;
      setNotes({ status: "ready", total: null, capped: searching && list.length >= LIST_SHOWN, items: remember(list.map(n => ({ id: n.documentRef.relativePath, name: n.title || n.relativePath, meta: n.relativePath }))) });
    } catch (error) { if (live.current && ticket === sequence.current.notes) { log(pluginErrorCode(error)); setNotes({ status: "error", items: [], total: null, error: errorText(t, error) }); } }
  }, [log, needKnowledge, remember, t]);
  const filterCanvases = useCallback((query: string) => setCanvases(current => current.state.status === "ready" ? { ...current, state: { ...current.state, items: filterByQuery(current.all, query, LIST_SHOWN), total: current.all.length } } : current), []);
  useEffect(() => {
    live.current = true;
    void loadMaterials(""); void loadNotes("");
    if (needCanvas) invoke<{ id: string; name: string }[]>("list_canvases").then(list => { if (live.current) setCanvases({ all: remember(list), state: { status: "ready", items: list.slice(0, LIST_SHOWN), total: list.length } }); }).catch(error => { if (live.current) { log(pluginErrorCode(error)); setCanvases({ all: [], state: { status: "error", items: [], total: null, error: errorText(t, error) } }); } });
    return () => { live.current = false; controller.current?.abort(); };
  }, [loadMaterials, loadNotes, log, needCanvas, remember, t]);

  const scope: RunScope = { materialIds, documents, canvasIds, allowCreate, writes };
  const signature = scopeSignature(scope);
  const stale = lastSignature !== null && lastSignature !== signature;
  const summaryParts = () => {
    const parts: string[] = [];
    if (needMaterials) parts.push(t("plugin.dialog.summary.materials", { count: materialIds.length }));
    if (needKnowledge) parts.push(t("plugin.dialog.summary.notes", { count: documents.length }));
    if (needCanvas) parts.push(t("plugin.dialog.summary.canvases", { count: canvasIds.length }));
    if (needKnowledge && grants.includes("knowledge.create")) parts.push(t("plugin.dialog.summary.create", { value: t(allowCreate ? "plugin.yes" : "plugin.no") }));
    return parts.join(" · ");
  };
  const writeScope = () => [
    materialIds.length && grants.includes("materials.tags") ? t("plugin.dialog.writeScope.materials", { count: materialIds.length }) : "",
    documents.length && grants.includes("knowledge.insert") ? t("plugin.dialog.writeScope.notes", { count: documents.length }) : "",
    allowCreate && grants.includes("knowledge.create") ? t("plugin.dialog.writeScope.create") : "",
    canvasIds.length && grants.includes("canvas.export") ? t("plugin.dialog.writeScope.canvas", { count: canvasIds.length }) : "",
    t("plugin.dialog.writeScope.data"),
  ].filter(Boolean).join("；");

  const execute = async (action: string, themeOnly = false, initial = false) => {
    if (busy || !live.current) return;
    setBusy(true); setNotice(null);
    const abort = new AbortController(); controller.current = abort;
    const runScope = scope; const runSignature = signature;
    // Only the run that still owns the controller may touch round state: a stopped
    // run's late dispatch results must never overwrite a newer round.
    const current = () => live.current && controller.current === abort;
    // Preflight may only continue, and a round may only be reset, while this run still owns
    // the controller AND has not been stopped. `current()` alone stays in use for late results
    // of work that was already dispatched: those are real host outcomes and must still land.
    const active = () => current() && !abort.signal.aborted;
    let roundStarted = false;
    try {
      const source = sourceAtOpen.current;
      let knowledge: PluginScope["knowledge"] = null;
      if (runScope.allowCreate || runScope.documents.length) {
        if (!source?.vaultId || source !== readActiveKnowledgeWriteSource()) throw Error("plugin-source-changed");
        const activated = await ensureActiveKnowledgeUiSource();
        if (!active()) return;
        if (source !== readActiveKnowledgeWriteSource() || activated.vaultId !== source.vaultId) throw Error("plugin-source-changed");
        knowledge = { allowCreate: runScope.allowCreate, vaultId: source.vaultId, sourceEpoch: activated.sourceEpoch, documents: [...runScope.documents], parentRelativePath: null };
      }
      const allowWrites = runScope.writes && !themeOnly;
      if (allowWrites) {
        const confirmed = await confirmWithHost(t("plugin.dialog.writeConfirm", { scope: writeScope() }));
        // A run stopped while its confirmation was open must not reset or start anything, whether or not another run took over.
        if (!active() || !confirmed) return;
      }
      let exportPath: string | null = null;
      if (allowWrites && runScope.canvasIds.length && grants.includes("canvas.export")) {
        exportPath = await save({ title: t("plugin.dialog.module.canvas"), defaultPath: "canvas.svg", filters: [{ name: "SVG", extensions: ["svg"] }] });
        if (!active() || !exportPath) return;
      }
      const style = getComputedStyle(document.documentElement);
      const theme = Object.fromEntries(THEME_TOKEN_KEYS.map(key => [key, style.getPropertyValue(key).trim()]).filter(([, value]) => /^#[a-f0-9]{6}$/i.test(value)));
      if (!active()) return;
      if (!themeOnly) {
        // A new round starts only now (after confirmations): the previous round's UI and record must not pose as this one.
        // The initial page fetch keeps a restored draft visible until its result lands.
        if (!initial) setUi(null);
        setProgress(EMPTY_PROGRESS); setRound("running"); roundStarted = true;
      }
      const result: PluginRunResult = await runPlugin(pkg.package.manifest.id, { materialIds: [...runScope.materialIds], canvasIds: [...runScope.canvasIds], knowledge, writes: allowWrites, exportPath, theme }, { contribution: contribution.id, action, fields }, abort.signal, log, themeOnly ? undefined : latest => { if (current()) setProgress(latest); });
      if (abort.signal.aborted || !current()) return;
      setUi(result.ui);
      if (themeOnly) { setFields(current => mergeFieldValues(current, result.ui.fields, edited.current)); return; }
      if (initial) {
        // Initial page/settings fetch: keep what the user already typed (or restored from this
        // session) and take the plugin's value only for untouched fields.
        setFields(current => mergeFieldValues(current, result.ui.fields, edited.current));
      } else {
        edited.current.clear();
        setFields(mergeFieldValues({}, result.ui.fields, edited.current));
      }
      setProgress({ outcomes: result.outcomes, unconfirmed: result.unconfirmed, failures: result.failures });
      setRound("done");
      setLastSignature(runSignature);
      log(`${t("plugin.dialog.outcomes")}: ${result.receipts.length}`);
    } catch (error) {
      if (!live.current) return;
      log(pluginErrorCode(error));
      if (themeOnly || !current()) return;
      if (!roundStarted) {
        // Failed before the round began (source changed, confirmation refused, no export path): the previous round stays as it was.
        setNotice({ kind: "error", text: errorText(t, error) });
        return;
      }
      // The host-confirmed record survives the failure; the plugin's UI for this round does not exist.
      if (error instanceof PluginRunError) setProgress({ outcomes: error.outcomes, unconfirmed: error.unconfirmed, failures: error.failures });
      if (abort.signal.aborted) { setRound("cancelled"); return; }
      setRound("failed");
      setNotice({ kind: "error", text: errorText(t, error) });
    } finally { if (!abort.signal.aborted && current()) setBusy(false); }
  };
  const executeRef = useRef(execute); executeRef.current = execute;
  // A settings entry needs no objects or write consent: fetch its form right away instead of
  // asking the user to run through the scope ceremony first.
  const isSettings = contribution.kind === "settings" || variant === "page";
  useEffect(() => {
    if (!isSettings) return;
    const timer = setTimeout(() => { void executeRef.current("run", false, true); }, 0);
    return () => clearTimeout(timer);
  }, [isSettings]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => { if (ui && !busy) void executeRef.current("theme", true); }, 150); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [!!ui, busy]);
  const stop = () => { controller.current?.abort(); setBusy(false); setNotice({ kind: "info", text: t("plugin.dialog.cancelled") }); log(t("plugin.dialog.cancelled")); };
  // Page variant: keep the user's in-progress fields and selection for this session only.
  useEffect(() => {
    if (variant !== "page" || !sessionKey) return;
    return () => {
      savePageSession(sessionKey, { digest: pkg.digest, epoch: pkg.epoch ?? null, ui: uiRef.current, fields: fieldsRef.current, edited: [...edited.current], materialIds: scopeRef.current.materialIds, documents: scopeRef.current.documents, canvasIds: scopeRef.current.canvasIds });
    };
  }, [variant, sessionKey, pkg.digest, pkg.epoch]);
  // Closing a running plugin first stops it and shows the cancellation notice; a second close dismisses.
  const requestClose = () => { if (busy) stop(); else close(); };
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const locate = (outcome: OutcomeView) => {
    if ((outcome.key === "noteCreated" || outcome.key === "noteInserted") && outcome.documentRef) {
      focusEntity("note", knowledgeDocumentNoteId(outcome.documentRef));
      window.location.hash = "#notes";
      close();
    }
  };
  const outcomeText = (outcome: OutcomeView) => t(`plugin.dialog.outcome.${outcome.key}` as PluginCopyKey, outcome.params);
  const roundOutcomes = describeOutcomes(progress.outcomes);
  // Only a native pre-execution refusal may be shown as "not performed"; an unknown failure is the same
  // event as its unconfirmed write (linked by call number) and only lends it the raw diagnostic.
  const refusedWrites = progress.failures.filter(failure => WRITE_METHODS.has(failure.method) && failure.kind === "refused");
  const diagnosticFor = (write: { call: number }) => { const code = progress.failures.find(failure => failure.call === write.call && failure.kind === "unknown")?.code; return code ? domainErrorCode(code) : undefined; };
  const targetCopy = (write: { method: string; target: string }) => write.method === "data.set" ? t("plugin.dialog.writeScope.data") : names.current.get(write.target) ?? write.target;

  return <>
    {variant === "dialog" && <header className="plugin-dialog-head"><div><h2>{pkg.package.manifest.name}</h2><p>{contribution.label} · {kindCopy(t, contribution.kind)}</p></div><button className="lr-cap-run secondary" onClick={requestClose}>{t("plugin.close")}</button></header>}
    {!isSettings && <section className="plugin-scope" aria-label={t("plugin.dialog.scopeTitle")}>
      <div className="plugin-scope-summary">
        <strong>{summaryParts()}</strong>
        <span className={writes ? "is-writes" : ""}>{t(writes ? "plugin.dialog.writes.on" : "plugin.dialog.writes.off")}</span>
      </div>
      <div className="plugin-pickers">
        {needMaterials && <ObjectPicker title={t("plugin.dialog.module.materials")} module={t("plugin.dialog.module.materials")} state={materials} selected={materialIds} names={names.current} max={PICK_LIMITS.materials} disabled={busy} onChange={setMaterialIds} onSearch={loadMaterials} t={t} />}
        {needKnowledge && <ObjectPicker title={t("plugin.dialog.module.knowledge")} module={t("plugin.dialog.module.knowledge")} state={notes} selected={documents} names={names.current} max={PICK_LIMITS.notes} disabled={busy} onChange={setDocuments} onSearch={loadNotes} t={t}
          hint={t("plugin.dialog.pick.notesCap", { cap: NOTES_LIST_CAP })} />}
        {needCanvas && <ObjectPicker title={t("plugin.dialog.module.canvas")} module={t("plugin.dialog.module.canvas")} state={canvases.state} selected={canvasIds} names={names.current} max={PICK_LIMITS.canvases} disabled={busy} onChange={setCanvasIds} onSearch={filterCanvases} t={t} />}
      </div>
      <div className="plugin-run-consents">
        {needKnowledge && grants.includes("knowledge.create") && <label className="plugin-toggle"><input type="checkbox" checked={allowCreate} disabled={busy} onChange={e => setAllowCreate(e.target.checked)} />{t("plugin.dialog.createToggle")}</label>}
        <label className="plugin-toggle"><input type="checkbox" checked={writes} disabled={busy} onChange={e => setWrites(e.target.checked)} />{t("plugin.dialog.writeToggle")}</label>
      </div>
      <p className="plugin-scope-hint">{t("plugin.dialog.hint")}</p>
    </section>}
    {!isSettings && <div className="plugin-run-bar">
      <button className="lr-cap-run" disabled={busy} onClick={() => void execute("run")}>{t("plugin.run")}</button>
      {busy && <><span className="plugin-running" aria-live="polite">{t("plugin.dialog.running")}</span><button className="lr-cap-run secondary" onClick={stop}>{t("plugin.stop")}</button></>}
    </div>}
    {isSettings && busy && <div className="plugin-run-bar"><span className="plugin-running" aria-live="polite">{t("plugin.dialog.running")}</span><button className="lr-cap-run secondary" onClick={stop}>{t("plugin.stop")}</button></div>}
    {notice && <div className={`community-message plugin-notice${notice.kind === "error" ? " error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
    {ui && <section className={`plugin-output${stale ? " is-stale" : ""}`} aria-label={t("plugin.dialog.outputTitle")}>
      {stale && <div className="plugin-stale" role="status">{t("plugin.dialog.stale")}</div>}
      {variant === "dialog" || ui.title !== contribution.label ? <h3>{ui.title}</h3> : null}
      {ui.text && <pre className="plugin-output-text">{ui.text}</pre>}
      {ui.fields?.map(f => <label key={f.id} className="plugin-field">{f.label}<input value={fields[f.id] ?? ""} maxLength={1000} disabled={busy} onChange={e => { edited.current.add(f.id); setFields(current => ({ ...current, [f.id]: e.target.value })); }} /></label>)}
      {ui.actions && ui.actions.length > 0 && <div className="plugin-actions">{ui.actions.map(a => <button key={a.id} className="lr-cap-run secondary" disabled={busy || stale} onClick={() => void execute(a.id)}>{a.label}</button>)}</div>}
    </section>}
    {round !== "idle" && (variant === "dialog" || round === "failed" || round === "cancelled" || roundOutcomes.length > 0 || progress.unconfirmed.length > 0 || refusedWrites.length > 0) && <section className={`plugin-round is-${round}`} aria-label={t("plugin.dialog.round.title")} aria-live="polite">
      <h4>{t("plugin.dialog.round.title")}{round === "running" && <span className="plugin-round-state">{t("plugin.dialog.round.running")}</span>}{round === "cancelled" && <span className="plugin-round-state">{t("plugin.dialog.round.cancelled")}</span>}{round === "failed" && <span className="plugin-round-state">{t("plugin.dialog.round.failed")}</span>}</h4>
      {roundOutcomes.length === 0 && progress.unconfirmed.length === 0 && refusedWrites.length === 0
        ? <p>{round === "running" ? t("plugin.dialog.round.nothingYet") : t("plugin.dialog.outcomes.none")}</p>
        : <ul>
          {roundOutcomes.map((outcome, index) => <li key={`ok:${index}`} className="is-confirmed"><span>{outcomeText(outcome)}</span>{"path" in outcome.params && outcome.params.path && <code>{outcome.params.path}</code>}{(outcome.key === "noteCreated" || outcome.key === "noteInserted") && outcome.documentRef && <button className="lr-cap-run secondary" disabled={busy} onClick={() => locate(outcome)}>{t("plugin.dialog.outcome.locate")}</button>}</li>)}
          {progress.unconfirmed.map(write => { const code = diagnosticFor(write); return <li key={`unknown:${write.call}`} className="is-unconfirmed"><span>{code ? t("plugin.dialog.round.unconfirmedDiag", { method: methodCopy(t, write.method), target: targetCopy(write), code }) : t("plugin.dialog.round.unconfirmed", { method: methodCopy(t, write.method), target: targetCopy(write) })}</span></li>; })}
          {refusedWrites.map(failure => <li key={`refused:${failure.call}`} className="is-failed"><span>{t("plugin.dialog.round.refused", { method: methodCopy(t, failure.method), reason: t(pluginErrorCopyKey(failure.code)).replace(/。+$/, "") })}</span></li>)}
        </ul>}
      {progress.unconfirmed.length > 0 && <p className="plugin-round-hint">{t("plugin.dialog.round.unconfirmedHint")}</p>}
    </section>}
    {(variant === "dialog" || round === "failed" || round === "cancelled" || progress.unconfirmed.length > 0) && <details className="plugin-logs"><summary>{t("plugin.dialog.logs")}</summary><pre>{logs.join("\n")}</pre></details>}
  </>;
}


/** Host-owned "show in sidebar" preference, per page. Hidden ≠ disabled: the toggle
 * only controls the sidebar shortcut; the page stays reachable from the community card. */
function SidebarPrefToggle({ view, pageId, label }: { view: PluginView; pageId: string; label: string }) {
  const { t } = useCopy();
  const key = `${view.id}/${pageId}`;
  const [visible, setVisible] = useState(() => pageVisibleInSidebar(key));
  useEffect(() => {
    const sync = () => setVisible(pageVisibleInSidebar(key));
    window.addEventListener("luckyray:settings-change", sync);
    return () => window.removeEventListener("luckyray:settings-change", sync);
  }, [key]);
  return <label className="plugin-page-pref" title={t("plugin.page.prefHint")}>
    <input type="checkbox" aria-label={t("plugin.page.showInSidebar", { label })} checked={visible} onChange={(event) => { writeSidebarPref(key, event.target.checked); setVisible(event.target.checked); }} />
    <span>{t("plugin.page.sidebarShort")}</span>
  </label>;
}
