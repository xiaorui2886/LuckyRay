// Community fixture frontend: the production Community page + plugin entry menu,
// mounted on a fresh fixture profile served by `--extension-community-fixture`.
// Everything below the banner is production code; only the shell, the note
// read-back panel and the evidence hooks belong to the fixture.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "../../src/core/theme/themeTokens.css";
import "../../src/app/appShell.css";
import "./fixture.css";
import { I18nProvider } from "../../src/core/i18n/index";
import CommunityPage from "../../src/features/community/CommunityPage";
import { PluginEntryMenu } from "../../src/features/community/ScriptPlugins";
import { installLuckyRayBridge } from "../../src/luckyrayBridge";
import { applyGlobalSettings, readSavedSettings } from "../../src/features/settings/useSettings";
import { activateBackendCurrentKnowledgeUiSource, parseKnowledgeDocumentNoteId, readKnowledgeDocument, type KnowledgeDocumentSnapshot } from "../../src/core/services/knowledge";
import { consumeNavFocus } from "../../src/core/services/context";
import { extensionPackages } from "../../src/core/extensions/packages";
import { applyPackageTheme } from "../../src/core/extensions/theme";
import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from "../../src/app/applicationModalIsolation";

type Status = { identifier: string; root: string; seeded?: { materials?: { id: string; name: string }[]; vault?: { id: string; root: string }; seedNote?: string } };
type Readback = { at: string; noteId: string; ref: { vaultId: string; relativePath: string } | null; snapshot: KnowledgeDocumentSnapshot | null; error: string | null };

declare global { interface Window { __fixture?: { status: Status; knowledge: unknown; readbacks: Readback[]; violations: unknown[] }; __fixtureInvoke?: typeof invoke } }
window.__fixtureInvoke = invoke;
const modalStore = createApplicationModalIsolationStore();

document.addEventListener("securitypolicyviolation", event => {
  const detail = { blockedURI: event.blockedURI, directive: event.violatedDirective, at: new Date().toISOString() };
  window.__fixture?.violations.push(detail);
  void invoke("extension_fixture_csp_violation", { detail }).catch(() => {});
});

/** The production locate() sets a nav focus and navigates to #notes. Without the full
 *  NotesPage mounted, the fixture consumes that focus and reads the target back through
 *  the production knowledge client — proving the reference, not claiming editor acceptance. */
function LocateReadback() {
  const [readbacks, setReadbacks] = useState<Readback[]>([]);
  useEffect(() => {
    const check = async () => {
      if (window.location.hash !== "#notes") return;
      const focus = consumeNavFocus("note");
      window.location.hash = "";
      if (!focus) return;
      const ref = parseKnowledgeDocumentNoteId(focus.id);
      const entry: Readback = { at: new Date().toISOString(), noteId: focus.id, ref, snapshot: null, error: null };
      if (ref) {
        try { entry.snapshot = await readKnowledgeDocument(ref); } catch (error) { entry.error = String(error); }
      } else entry.error = "nav focus id is not a knowledge document id";
      setReadbacks(list => [entry, ...list]);
      window.__fixture?.readbacks.unshift(entry);
      void invoke("extension_fixture_report", { name: `locate-readback-${Date.now()}`, report: { ...entry, snapshot: entry.snapshot && { ...entry.snapshot, content: entry.snapshot.content.slice(0, 4000) } } }).catch(() => {});
    };
    const onHash = () => void check();
    window.addEventListener("hashchange", onHash);
    void check();
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (!readbacks.length) return null;
  return <section className="fixture-readback" data-fixture-readback>
    <h3>fixture 目标读回（生产 locate 引用 → 生产 readDocument；不是完整笔记编辑器）</h3>
    {readbacks.map(entry => <article key={entry.at}>
      <div><code>{entry.noteId}</code></div>
      {entry.error && <div className="fixture-readback-error">{entry.error}</div>}
      {entry.snapshot && <>
        <div><strong>{entry.snapshot.title}</strong> · <code>{entry.snapshot.relativePath}</code> · revision {entry.snapshot.revision}</div>
        <pre>{entry.snapshot.content.slice(0, 2000)}</pre>
      </>}
    </article>)}
  </section>;
}

function FixtureShell({ status }: { status: Status }) {
  return <div className="react-nav-shell fixture-shell" data-fixture-shell>
    <header className="fixture-banner" role="note">
      <strong>隔离测试实例</strong>
      <span>identifier <code>{status.identifier}</code></span>
      <span>数据根 <code>{status.root}</code></span>
      <span>非日常主开发 · 仅本实例的 fixture 数据 · 关闭窗口即结束</span>
    </header>
    <CommunityPage />
    <PluginEntryMenu />
    <LocateReadback />
  </div>;
}

async function boot() {
  applyGlobalSettings(readSavedSettings());
  await installLuckyRayBridge();
  const status = await invoke<Status>("extension_fixture_status");
  let knowledge: unknown = null;
  try { knowledge = await activateBackendCurrentKnowledgeUiSource(); } catch (error) { knowledge = { error: String(error) }; }
  await extensionPackages.refresh();
  // Match AppShell's existing base-settings + active-package projection. No fixture theme truth.
  const syncTheme = () => { applyGlobalSettings(readSavedSettings()); applyPackageTheme(extensionPackages.activeTheme(), document.documentElement); };
  extensionPackages.subscribe(syncTheme);
  syncTheme();
  window.__fixture = { status, knowledge, readbacks: [], violations: [] };
  createRoot(document.getElementById("root")!).render(<I18nProvider locale="zh-CN"><ApplicationModalIsolationProvider store={modalStore}><FixtureShell status={status} /></ApplicationModalIsolationProvider></I18nProvider>);
  document.body.dataset.fixtureReady = "1";
  void invoke("extension_fixture_report", { name: "boot", report: { ok: true, knowledge, userAgent: navigator.userAgent, at: new Date().toISOString() } }).catch(() => {});
}
boot().catch(error => {
  document.body.dataset.fixtureReady = "error";
  document.getElementById("root")!.textContent = `fixture boot failed: ${String(error)}`;
  void invoke("extension_fixture_report", { name: "boot", report: { ok: false, error: String(error), stack: (error as Error)?.stack } }).catch(() => {});
});
