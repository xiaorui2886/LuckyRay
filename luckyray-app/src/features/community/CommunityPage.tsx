import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  listCapabilities,
  type LocalCapability as Capability,
} from "../../core/services/capabilities";
import { focusEntity } from "../../core/services/context";
import {
  createKnowledgeDocument,
  insertIntoCurrentKnowledgeDocument,
  knowledgeDocumentNoteId,
  normalizeKnowledgeError,
  type KnowledgeCreateInput,
  type KnowledgeDocumentSnapshot,
  type KnowledgeMutationResult,
} from "../../core/services/knowledge";
import { extensionPackages, parseLocalPackage, type InstalledPackage } from "../../core/extensions/packages";
import { extensionTemplates } from "../../core/extensions/templates";
import type { TemplateResource } from "../../core/extensions/packages";
import OfficialMcpCard from "./mcp/OfficialMcpCard";
import CollectorServiceStatus from "./CollectorServiceStatus";
import { ScriptPackagesPanel } from "./ScriptPlugins";
import { PackagesPanel, extensionErrorCopyKey } from "./ExtensionPackagesPanel";
import { TemplateFlow } from "./TemplateFlow";
import { EXT_PACKAGE_MESSAGES } from "./extensionMessages";
import "./community.css";
import "../../components/editorialContentChrome.css";
import { defineMessages, useMessages, type Locale } from "../../core/i18n/index";
import { KNOWLEDGE_SOURCE_CHANGED_EVENT } from "../../core/services/knowledgeSource";
import { CommunityDrawer, CommunityDrawerBoundary, CommunityFilters, CommunityIcon, CommunityState, communityMatchesStatus, type CommunityStatusFilter } from "./CommunityPresentation";
import { COMMUNITY_UI_MESSAGES } from "./communityMessages";

const COPY = defineMessages({
  ...EXT_PACKAGE_MESSAGES,
  ...COMMUNITY_UI_MESSAGES,
  "tab.skills": { "zh-CN": "技能", "en-US": "Skills" },
  "tab.packages": { "zh-CN": "主题", "en-US": "Themes" },
  "tab.extensions": { "zh-CN": "插件", "en-US": "Plugins" },
  "tab.templates": { "zh-CN": "模板/工作流", "en-US": "Templates & workflows" },
  "tab.status": { "zh-CN": "工具", "en-US": "Tools" },
  "template.weekly.name": { "zh-CN": "周报", "en-US": "Weekly review" },
  "template.weekly.desc": { "zh-CN": "本周素材、笔记、待办的回顾模板", "en-US": "Review this week’s assets, notes, and tasks" },
  "template.design.name": { "zh-CN": "设计评审", "en-US": "Design critique" },
  "template.design.desc": { "zh-CN": "视觉、交互、结构三维点评模板", "en-US": "Review visuals, interaction, and structure" },
  "template.tech.name": { "zh-CN": "技术笔记", "en-US": "Technical note" },
  "template.tech.desc": { "zh-CN": "问题、尝试、结论、参考链接结构", "en-US": "Structure a problem, attempts, conclusions, and references" },
  "header.title": { "zh-CN": "社区", "en-US": "Community" },
  "header.description": { "zh-CN": "管理扩展、主题与创作工具", "en-US": "Manage extensions, themes, and creative tools" },
  "header.install": { "zh-CN": "安装本地扩展", "en-US": "Install local extension" },
  "header.search": { "zh-CN": "搜索名称或 ID", "en-US": "Search by name or ID" },
  "header.local": { "zh-CN": "你的扩展", "en-US": "Your extensions" },
  "error.page": { "zh-CN": "社区页面加载失败，请刷新后重试。", "en-US": "Community could not load. Refresh and try again." },
  "error.load": { "zh-CN": "加载失败，请稍后重试。", "en-US": "Could not load. Try again later." },
  "status.copied": { "zh-CN": "已复制仓库内插件目录", "en-US": "Extension directory copied" },
  "error.copy": { "zh-CN": "复制失败，请稍后重试。", "en-US": "Could not copy. Try again later." },
  "status.created": { "zh-CN": "已新建模板笔记：{name}", "en-US": "Template note created: {name}" },
  "status.inserted": { "zh-CN": "已插入当前笔记：{name}", "en-US": "Inserted into current note: {name}" },
  "error.template": { "zh-CN": "模板操作失败，请稍后重试。", "en-US": "Template action failed. Try again later." },
  "action.refresh": { "zh-CN": "刷新", "en-US": "Refresh" },
  "tabs.aria": { "zh-CN": "社区页面", "en-US": "Community sections" },
  "skills.title": { "zh-CN": "本地技能", "en-US": "Local skills" },
  "extensions.title": { "zh-CN": "浏览器扩展", "en-US": "Browser extension" },
  "extensions.desc": { "zh-CN": "将浏览器中的内容收集到 LuckyRay。", "en-US": "Collect content from your browser into LuckyRay." },
  "extensions.source": { "zh-CN": "浏览器插件源码目录", "en-US": "Browser extension source directory" },
  "action.copyPath": { "zh-CN": "复制路径", "en-US": "Copy path" },
  "extensions.capabilities": { "zh-CN": "扩展能力", "en-US": "Extension capabilities" },
  "workflows.title": { "zh-CN": "工作流目录", "en-US": "Workflow directory" },
  "templates.title": { "zh-CN": "内置笔记模板", "en-US": "Built-in note templates" },
  "templates.desc": { "zh-CN": "从一个清晰的结构开始记录。", "en-US": "Start your next note with a clear structure." },
  "action.insert": { "zh-CN": "插入当前笔记", "en-US": "Insert into current note" },
  "action.create": { "zh-CN": "新建笔记", "en-US": "Create note" },
  "status.title": { "zh-CN": "本地安装状态", "en-US": "Local status" },
  "status.desc": { "zh-CN": "只显示当前独立产品面的静态状态。", "en-US": "Static status for the current independent surfaces." },
  "status.desktop": { "zh-CN": "桌面端", "en-US": "Desktop" },
  "status.catalog": { "zh-CN": "能力目录", "en-US": "Capability catalog" },
  "status.readOnly": { "zh-CN": "只读；不提供旧 Agent 执行", "en-US": "Read-only; no legacy Agent execution" },
  "status.extension": { "zh-CN": "浏览器插件", "en-US": "Browser extension" },
  "status.repository": { "zh-CN": "仓库内独立项目", "en-US": "Independent in-repository project" },
  "capability.desc": { "zh-CN": "查看本地已登记的能力与说明。", "en-US": "Browse locally registered capabilities and their descriptions." },
  "capability.loading": { "zh-CN": "正在读取…", "en-US": "Reading…" },
  "capability.empty": { "zh-CN": "暂无能力。", "en-US": "No capabilities." },
  "capability.noDescription": { "zh-CN": "暂无说明", "en-US": "No description" },
  "capability.registered": { "zh-CN": "已登记", "en-US": "Registered" },
  "capability.disabled": { "zh-CN": "未启用", "en-US": "Disabled" },
  "capability.readOnly": { "zh-CN": "只读", "en-US": "Read-only" },
});

type CommunityTab = "skills" | "packages" | "extensions" | "templates" | "status";
type CommunityTemplateFilter = "all" | "builtin" | "packages" | "workflows";

const TABS: Array<{ key: CommunityTab; labelKey: "tab.skills" | "tab.packages" | "tab.extensions" | "tab.templates" | "tab.status"; icon: "plugin" | "theme" | "workflow" | "note" | "browser" }> = [
  { key: "extensions", labelKey: "tab.extensions", icon: "plugin" },
  { key: "packages", labelKey: "tab.packages", icon: "theme" },
  { key: "templates", labelKey: "tab.templates", icon: "workflow" },
  { key: "skills", labelKey: "tab.skills", icon: "note" },
  { key: "status", labelKey: "tab.status", icon: "browser" },
];

const TEMPLATES = [
  { id: "weekly", nameKey: "template.weekly.name", descKey: "template.weekly.desc" },
  { id: "design-critique", nameKey: "template.design.name", descKey: "template.design.desc" },
  { id: "tech-note", nameKey: "template.tech.name", descKey: "template.tech.desc" },
] as const;

const EXTENSION_DIR = "browser-extension-prototype";

type CommunityKnowledgeDependencies = {
  create(input: KnowledgeCreateInput): Promise<KnowledgeDocumentSnapshot>;
  insertCurrent(input: { text: string; appendIfNoCursor?: boolean }): Promise<KnowledgeMutationResult>;
  focus(noteId: string): void;
};

export function createCommunityKnowledgeActions(
  dependencies: CommunityKnowledgeDependencies = {
    create: createKnowledgeDocument,
    insertCurrent: insertIntoCurrentKnowledgeDocument,
    focus(noteId) {
      focusEntity("note", noteId);
      window.location.hash = "#notes";
    },
  },
) {
  return {
    insertCurrent(text: string) {
      return dependencies.insertCurrent({ text, appendIfNoCursor: true });
    },
    async createAndFocus(title: string, content: string) {
      const document = await dependencies.create({ title, content });
      dependencies.focus(knowledgeDocumentNoteId(document.documentRef));
      return document;
    },
  };
}

const communityKnowledgeActions = createCommunityKnowledgeActions();

function templateContent(templateId: string, locale: Locale) {
  if (locale === "en-US") {
    if (templateId === "weekly") return "# Weekly review\n\n## Completed this week\n\n## Key assets\n\n## Important notes\n\n## Next week\n";
    if (templateId === "design-critique") return "# Design critique\n\n## Goal\n\n## Visuals\n\n## Interaction\n\n## Structure\n\n## Recommendations\n";
    return "# Technical note\n\n## Problem\n\n## Attempts\n\n## Conclusion\n\n## References\n";
  }
  if (templateId === "weekly") return "# 周报\n\n## 本周完成\n\n## 关键素材\n\n## 重要笔记\n\n## 下周计划\n";
  if (templateId === "design-critique") return "# 设计评审\n\n## 目标\n\n## 视觉\n\n## 交互\n\n## 结构\n\n## 建议\n";
  return "# 技术笔记\n\n## 问题\n\n## 尝试\n\n## 结论\n\n## 参考链接\n";
}

function initialCommunityTab(): CommunityTab {
  const query = window.location.hash.split("?")[1] || "";
  const value = new URLSearchParams(query).get("tab");
  return TABS.some((tab) => tab.key === value) ? value as CommunityTab : "extensions";
}

export default function CommunityPage() {
  return <CommunityErrorBoundary><CommunityDrawerBoundary><CommunityPageContent /></CommunityDrawerBoundary></CommunityErrorBoundary>;
}

function CommunityErrorFallback() {
  const { t } = useMessages(COPY);
  return <section className="page community-page"><h1>{t("header.title")}</h1><p>{t("error.page")}</p></section>;
}

class CommunityErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <CommunityErrorFallback />;
    }
    return this.props.children;
  }
}

function CommunityPageContent() {
  const { locale, t } = useMessages(COPY);
  const [activeTab, setActiveTab] = useState<CommunityTab>(initialCommunityTab);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<{ text: string; scope?: "copy" } | null>(null);
  const copyAttempt = useRef(0);
  const [packagesBusy, setPackagesBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CommunityStatusFilter>("all");
  const [templateFilter, setTemplateFilter] = useState<CommunityTemplateFilter>("all");
  const [registry, setRegistry] = useState(() => extensionPackages.snapshot());
  const [capabilityFailed, setCapabilityFailed] = useState(false);
  const [capabilityDetail, setCapabilityDetail] = useState<Capability | null>(null);
  const [guide, setGuide] = useState<"install" | "permissions" | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateTarget, setTemplateTarget] = useState<Awaited<ReturnType<typeof extensionTemplates.probeTarget>>>({ target: null, insertAvailable: false });
  const searchRef = useRef<HTMLInputElement | null>(null);
  const templateInFlight = useRef(false);
  const [installBusy, setInstallBusy] = useState(false);
  const installing = useRef(false);
  const [templateOpen, setTemplateOpen] = useState<{ id: string; name: string; resource: TemplateResource } | null>(null);

  useEffect(() => extensionPackages.subscribe(() => setRegistry(extensionPackages.snapshot())), []);
  useEffect(() => {
    setError(current => current?.scope === "copy" ? null : current);
    return () => { copyAttempt.current += 1; };
  }, [activeTab]);
  const selectTab = useCallback((tab: CommunityTab) => {
    setActiveTab(tab); setFilter("all"); setTemplateFilter("all"); setTemplateOpen(null); setCapabilityDetail(null); setGuide(null);
    window.location.hash = `#community?tab=${tab}`;
  }, []);
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.split("?")[0] !== "#community") { copyAttempt.current += 1; setError(current => current?.scope === "copy" ? null : current); setTemplateOpen(null); setCapabilityDetail(null); setGuide(null); return; }
      setCapabilityDetail(null); setGuide(null);
      setTemplateOpen(null);
      setActiveTab(initialCommunityTab());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (window.location.hash.split("?")[0] !== "#community" || event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable], [role='dialog']")) return;
      if (document.querySelector("[role='dialog']")) return;
      event.preventDefault(); searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (activeTab !== "templates") return;
    let disposed = false;
    const probe = () => { void extensionTemplates.probeTarget().then(next => { if (!disposed) setTemplateTarget(next); }).catch(() => { if (!disposed) setTemplateTarget({ target: null, insertAvailable: false }); }); };
    probe();
    window.addEventListener(KNOWLEDGE_SOURCE_CHANGED_EVENT, probe);
    window.addEventListener("focus", probe);
    return () => { disposed = true; window.removeEventListener(KNOWLEDGE_SOURCE_CHANGED_EVENT, probe); window.removeEventListener("focus", probe); };
  }, [activeTab]);

  const toastTimer = useRef<number | null>(null);
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); }, []);
  const notifyPackages = useCallback((kind: "info" | "error", text: string, scope?: "copy") => {
    if (toastTimer.current !== null) { window.clearTimeout(toastTimer.current); toastTimer.current = null; }
    setError(null); setMessage("");
    if (kind === "error") {
      // Errors carry a recovery path; keep them until the next action.
      setError({ text, scope });
      return;
    }
    // C: a plain success must not hold the page; let it fade on its own.
    setMessage(text);
    toastTimer.current = window.setTimeout(() => { setMessage(""); toastTimer.current = null; }, 3200);
  }, []);

  const openTemplate = useCallback((id: string, name: string, resource: TemplateResource) => {
    setTemplateOpen({ id, name, resource });
  }, []);

  // R3: locate the created note through the writer's own reference. When no
  // precise reference is available we open the notes surface without claiming a
  // specific file, and never guess a note from the title.
  const locateTemplateOutcome = useCallback((outcome: { documentRef: unknown | null; title: string; uncertain: boolean }) => {
    const noteId = outcome.documentRef ? knowledgeDocumentNoteId(outcome.documentRef as Parameters<typeof knowledgeDocumentNoteId>[0]) : null;
    if (noteId) {
      focusEntity("note", noteId);
      window.location.hash = "#notes";
      return;
    }
    // Uncertain or insert-into-current: open notes so the user can check.
    window.location.hash = "#notes";
    if (outcome.uncertain) notifyPackages("error", t("pack.template.writtenUnconfirmed"));
  }, [notifyPackages, t]);

  const load = useCallback(async () => {
    setLoading(true);
    setCapabilityFailed(false);
    setError(null);
    try {
      setCapabilities(await listCapabilities());
    } catch {
      setCapabilities([]);
      setCapabilityFailed(true);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const refreshAll = async () => {
    await load();
    try { await extensionPackages.refresh(); }
    catch (error) { notifyPackages("error", t(extensionErrorCopyKey(error))); }
  };

  const groups = useMemo(() => ({
    skills: capabilities.filter((item) => item.type === "skill"),
    extensions: capabilities.filter((item) => item.type === "extension"),
    workflows: capabilities.filter((item) => item.type === "workflow"),
  }), [capabilities]);

  const install = async (file: File) => {
    if (installing.current) return;
    installing.current = true; setInstallBusy(true);
    try {
      const text = await file.text(); const parsed = parseLocalPackage(text);
      const current = await extensionPackages.refresh();
      const existing = current.packages.some((entry) => entry.package.manifest.id === parsed.manifest.id);
      await (existing ? extensionPackages.update(text, current.revision) : extensionPackages.install(text, current.revision));
      selectTab(parsed.manifest.type === "script" ? "extensions" : parsed.manifest.type === "theme" ? "packages" : "templates");
      setQuery("");
      notifyPackages("info", t(existing ? "pack.updated" : "pack.installed", { name: parsed.manifest.name }));
    } catch (error) { notifyPackages("error", t(extensionErrorCopyKey(error))); }
    finally { installing.current = false; setInstallBusy(false); }
  };

  const copyExtensionDir = useCallback(async () => {
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(EXTENSION_DIR);
      if (attempt !== copyAttempt.current) return;
      notifyPackages("info", t("status.copied"));
    } catch {
      if (attempt !== copyAttempt.current) return;
      notifyPackages("error", t("community.copyFallback"), "copy");
    }
  }, [notifyPackages, t]);

  const useTemplate = useCallback(async (template: typeof TEMPLATES[number], create: boolean) => {
    if (templateInFlight.current) return;
    templateInFlight.current = true; setTemplateBusy(true);
    try {
      const name = t(template.nameKey);
      const content = templateContent(template.id, locale);
      if (create) await communityKnowledgeActions.createAndFocus(name, content);
      else await communityKnowledgeActions.insertCurrent(content);
      notifyPackages("info", create ? t("status.created", { name }) : t("status.inserted", { name }));
    } catch (error) {
      const code = normalizeKnowledgeError(error).code;
      const key = code === "knowledge-source-inactive" || code === "knowledge-vault-required" || code === "knowledge-vault-not-current"
        ? "community.knowledgeRequired"
        : code === "knowledge-current-context-required" ? "pack.template.insertUnavailable"
        : code === "knowledge-revision-conflict" || code === "knowledge-editor-dirty" || code === "knowledge-desktop-draft-conflict"
          ? "community.knowledgeChanged" : "community.templateOutcomeUnknown";
      notifyPackages("error", t(key));
    }
    finally { templateInFlight.current = false; setTemplateBusy(false); }
  }, [locale, notifyPackages, t]);

  const clearFilters = () => { setQuery(""); setFilter("all"); setTemplateFilter("all"); searchRef.current?.focus(); };
  const packageCount = (type: "script" | "theme" | "template") => registry.packages.filter(item => item.package.manifest.type === type).length;
  const counts: Record<CommunityTab, number> = { extensions: packageCount("script"), packages: packageCount("theme"), templates: TEMPLATES.length + packageCount("template") + groups.workflows.length, skills: groups.skills.length, status: groups.extensions.length };
  const countReady = (tab: CommunityTab) => tab === "templates" ? registry.ready && !loading && !capabilityFailed : tab === "extensions" || tab === "packages" ? registry.ready : !loading && !capabilityFailed;
  const statusItems = activeTab === "skills" ? groups.skills : activeTab === "status" ? groups.extensions : registry.packages.filter(item => item.package.manifest.type === (activeTab === "packages" ? "theme" : "script"));
  const enabledCount = statusItems.filter(item => item.enabled).length;
  const filteredTemplates = TEMPLATES.filter(template => `${template.id} ${t(template.nameKey)} ${t(template.descKey)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const capabilityProps = { loading, failed: capabilityFailed, query, filter, onRetry: load, onClear: clearFilters, onDetail: setCapabilityDetail };
  const templateFilters: Array<{ id: CommunityTemplateFilter; label: string; count?: number }> = [
    { id: "all", label: t("community.all"), count: counts.templates },
    { id: "builtin", label: t("community.builtin"), count: TEMPLATES.length },
    { id: "packages", label: t("community.packages"), count: packageCount("template") },
    { id: "workflows", label: t("community.workflows"), count: groups.workflows.length },
  ];
  const statusFilters: Array<{ id: CommunityStatusFilter; label: string; count?: number }> = [
    { id: "all", label: t("community.all"), count: statusItems.length },
    { id: "enabled", label: t(activeTab === "skills" || activeTab === "status" ? "community.registered" : "community.enabled"), count: enabledCount },
    { id: "disabled", label: t("community.disabled"), count: statusItems.length - enabledCount },
  ];

  return (
    <div id="page-community" className="community-page page editorial-page-surface">
      <div className="community-rail">
      <div className="community-toolbar">
      <header className="page-header editorial-page-heading">
        <div><h1>{t("header.title")}</h1><p>{t("header.description")}</p></div>
        <label className="lr-cap-run secondary community-install plugin-file-button"><CommunityIcon name="plus" />{t("header.install")}<input type="file" aria-label={t("header.install")} accept=".json,.lrpack.json,application/json" disabled={installBusy || packagesBusy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void install(file); }} /></label>
      </header>
      <div className="community-library-head">
      <div className="community-tabs" role="tablist" aria-label={t("tabs.aria")}>
        {TABS.map((tab, index) => <button key={tab.key} id={`community-tab-${tab.key}`} role="tab" aria-controls="community-panel" aria-selected={activeTab === tab.key} tabIndex={activeTab === tab.key ? 0 : -1} className={`community-tab${activeTab === tab.key ? " active" : ""}`} onClick={() => selectTab(tab.key)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
          if (next < 0) return; event.preventDefault(); selectTab(TABS[next].key); document.getElementById(`community-tab-${TABS[next].key}`)?.focus();
        }}><CommunityIcon name={tab.icon} />{t(tab.labelKey)}{countReady(tab.key) && <span className="community-tab-count">{counts[tab.key]}</span>}</button>)}
      </div>
      </div>
      </div>
      <div className="community-library-content" id="community-panel" role="tabpanel" aria-labelledby={`community-tab-${activeTab}`} tabIndex={0}>
      <div className="community-browse-toolbar">
        {activeTab === "templates" ? <CommunityFilters value={templateFilter} onChange={setTemplateFilter} options={templateFilters.map(option => ({ ...option, count: countReady(activeTab) ? option.count : undefined }))} /> : <CommunityFilters value={filter} onChange={setFilter} options={statusFilters.map(option => ({ ...option, count: countReady(activeTab) ? option.count : undefined }))} />}
        <label className="community-search"><CommunityIcon name="search" /><input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("header.search")} aria-label={t("header.search")} />{query ? <button type="button" className="community-icon-button" aria-label={t("community.clearSearch")} onClick={() => { setQuery(""); searchRef.current?.focus(); }}><CommunityIcon name="close" /></button> : <kbd aria-hidden="true">/</kbd>}</label>
      </div>
      {(message || error) && <div className={`community-message${error ? " error" : ""}`} role={error ? "alert" : "status"}>{error?.text || message}{error && <button className="lr-cap-run secondary" onClick={() => void refreshAll()}>{t("action.refresh")}</button>}</div>}
      {activeTab === "skills" && <ReadOnlyCapabilitySection title={t("skills.title")} items={groups.skills} {...capabilityProps} />}
      {activeTab === "templates" && (templateFilter === "all" || templateFilter === "builtin") && <CommunitySection title={t("templates.title")} desc={t("templates.desc")}><div className="community-card-list community-template-grid">{filteredTemplates.map(template => <article className="community-card community-note-template" key={template.id}>
        <div className="community-note-preview" aria-hidden="true"><strong>{t(template.nameKey)}</strong>{templateContent(template.id, locale).split("\n").filter(line => line.startsWith("## ")).slice(0, 3).map(line => <span key={line}>{line.slice(3)}</span>)}</div>
        <h3 className="community-card-title">{t(template.nameKey)}</h3><p className="community-card-desc">{t(template.descKey)}</p>
        <div className="community-card-actions"><button className="lr-cap-run secondary" disabled={templateBusy || !templateTarget.insertAvailable} title={templateTarget.insertAvailable ? undefined : t("pack.template.insertUnavailable")} onClick={() => void useTemplate(template, false)}>{t("action.insert")}</button><button className="lr-cap-run" disabled={templateBusy || !templateTarget.target} title={templateTarget.target ? undefined : t("community.knowledgeRequired")} onClick={() => void useTemplate(template, true)}>{t("action.create")}</button></div>
      </article>)}</div>{filteredTemplates.length === 0 && <CommunityState kind="no-match" action={<button className="lr-cap-run" onClick={clearFilters}>{t("community.clear")}</button>} />}</CommunitySection>}
      {(activeTab === "packages" || activeTab === "templates" && (templateFilter === "all" || templateFilter === "packages")) && <>
        <PackagesPanel
          key={activeTab}
          kind={activeTab === "packages" ? "theme" : "template"}
          search={query}
          statusFilter={activeTab === "packages" ? filter : "all"}
          onClearFilters={clearFilters}
          compact
          service={extensionPackages}
          copy={{ t, locale }}
          onBusyChange={setPackagesBusy}
          onMessage={notifyPackages}
          renderTemplateActions={(pkg) => (
            (() => {
              const entry = extensionPackages.snapshot().packages.find(
                (item: InstalledPackage) => item.package.manifest.id === pkg.id,
              );
              const resource = entry?.enabled ? entry.package.resource as TemplateResource : null;
              return resource
                ? <button className="lr-cap-run secondary" disabled={packagesBusy} onClick={() => openTemplate(pkg.id, pkg.name, resource)}>{t("pack.template.title")}</button>
                : null;
            })()
          )}
        />
      </>}
        {templateOpen && activeTab === "templates" && (
          <CommunityDrawer title={templateOpen.name} label={t("pack.template.title")} icon="note" dismissible={!templateBusy} onClose={() => setTemplateOpen(null)}>
            <TemplateFlow
              key={`${templateOpen.id}::${templateOpen.name}`}
              actions={extensionTemplates}
              templateId={templateOpen.id}
              templateName={templateOpen.name}
              resource={templateOpen.resource}
              t={t}
              onLocate={locateTemplateOutcome}
              onMessage={notifyPackages}
              onBusyChange={setTemplateBusy}
            />
            <div className="ext-template-actions">
              <button className="lr-cap-run secondary" disabled={templateBusy} onClick={() => setTemplateOpen(null)}>{t("pack.template.back")}</button>
            </div>
          </CommunityDrawer>
        )}
      {activeTab === "extensions" && <>
            <OfficialMcpCard />
        <ScriptPackagesPanel search={query} statusFilter={filter} onClearFilters={clearFilters} onBusyChange={setPackagesBusy} compact />
        <CommunityGuide onOpen={setGuide} />
      </>}
      {activeTab === "status" && <>
        <section className="community-collector"><div className="community-collector-copy"><span className="community-eyebrow">LUCKYRAY / COLLECTOR</span><h2>{t("community.collectorTitle")}</h2><p>{t("community.collectorDesc")}</p><CollectorServiceStatus /><div className="community-source-path"><span>{t("community.collectorSource")}</span><code tabIndex={0}>{EXTENSION_DIR}</code></div><button className="lr-cap-run secondary" onClick={() => void copyExtensionDir()}><CommunityIcon name="copy" />{t("action.copyPath")}</button></div><div className="community-collector-art" aria-hidden="true"><div className="community-collector-mini"><div className="community-collector-mini-head"><CommunityIcon name="browser" /><strong>{t("community.collectorPreview")}</strong><small>{t("community.illustration")}</small></div><div className="community-collector-mini-tabs"><span>{t("community.images")}</span><span>{t("community.article")}</span><span>{t("community.link")}</span></div><div className="community-collector-mini-items"><i /><i /><i /></div><div className="community-collector-mini-location">{t("community.previewLocation")}</div><div className="community-collector-mini-action">{t("community.previewSave")}</div></div></div></section>
        <ReadOnlyCapabilitySection title={t("extensions.capabilities")} items={groups.extensions} {...capabilityProps} />
      </>}
      {activeTab === "templates" && (templateFilter === "all" || templateFilter === "workflows") && <ReadOnlyCapabilitySection title={t("workflows.title")} items={groups.workflows} {...capabilityProps} filter="all" />}
      {activeTab === "skills" && <CommunityGuide onOpen={setGuide} />}
      {capabilityDetail && <CommunityDrawer title={capabilityDetail.name} label={t("community.capabilityDetails")} icon={capabilityDetail.type === "workflow" ? "workflow" : "note"} onClose={() => setCapabilityDetail(null)} footer={<span className="community-readonly">{t("community.readOnly")}</span>}><p className="community-drawer-intro">{capabilityDetail.description || t("capability.noDescription")}</p><dl className="community-info"><dt>{t("pack.detail.id")}</dt><dd><code>{capabilityDetail.id}</code></dd><dt>{t("pack.detail.type")}</dt><dd>{t("community.readOnly")}</dd><dt>{t("status.title")}</dt><dd>{capabilityDetail.enabled ? t("capability.registered") : t("capability.disabled")}</dd></dl>{capabilityDetail.available === false && <p className="ext-package-warn">{capabilityDetail.unavailableReason || t("community.capabilityUnavailable")}</p>}</CommunityDrawer>}
      {guide && <CommunityDrawer title={t(guide === "install" ? "community.guideInstall" : "community.guidePermissions")} label={t("community.guideTitle")} onClose={() => setGuide(null)}><p className="community-drawer-intro">{t(guide === "install" ? "community.guideInstallBody" : "community.guidePermissionsBody")}</p></CommunityDrawer>}
      </div>
      </div>
    </div>
  );
}

function ReadOnlyCapabilitySection({ title, items, loading, failed, query, filter, onRetry, onClear, onDetail }: { title: string; items: Capability[]; loading: boolean; failed: boolean; query: string; filter: CommunityStatusFilter; onRetry: () => void; onClear: () => void; onDetail: (item: Capability) => void }) {
  const { t } = useMessages(COPY);
  const shown = items.filter(item => communityMatchesStatus(Boolean(item.enabled), filter) && `${item.id} ${item.name} ${item.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <CommunitySection title={title} desc={t("capability.desc")} badge={t("community.readOnly")}>
    {loading ? <CommunityState kind="loading" /> : failed ? <CommunityState kind="error" message={t("error.load")} action={<button className="lr-cap-run secondary" onClick={onRetry}>{t("pack.load.retry")}</button>} /> : shown.length === 0 ? <CommunityState kind={items.length ? "no-match" : "empty"} message={items.length ? undefined : t("capability.empty")} action={items.length ? <button className="lr-cap-run" onClick={onClear}>{t("community.clear")}</button> : undefined} /> : <div className="community-card-list community-capability-grid">{shown.map(item => <article className="community-card community-capability-card" key={item.id}><div className="community-card-top"><CommunityIcon name={item.type === "workflow" ? "workflow" : item.type === "extension" ? "browser" : "note"} tile /><h3 className="community-card-title">{item.name}</h3></div><p className="community-card-desc">{item.description || t("capability.noDescription")}</p><div className="community-card-actions"><span className={`community-status${item.enabled ? " is-on" : ""}`}>{item.enabled ? t("capability.registered") : t("capability.disabled")}</span><button className="community-text-button" onClick={() => onDetail(item)}>{t("community.viewCapability")}<CommunityIcon name="arrow" /></button></div></article>)}</div>}
    <p className="community-catalog-note"><CommunityIcon name="info" />{t("community.readOnlyHint")}</p>
  </CommunitySection>;
}

function CommunitySection({ title, desc, children, badge }: { title: string; desc: string; children: ReactNode; badge?: string }) {
  return <section className="community-section"><div className="community-section-head"><div><h2>{title}</h2><p>{desc}</p></div>{badge && <span className="community-readonly">{badge}</span>}</div>{children}</section>;
}

function CommunityGuide({ onOpen }: { onOpen: (guide: "install" | "permissions") => void }) {
  const { t } = useMessages(COMMUNITY_UI_MESSAGES);
  return <aside className="community-guide"><CommunityIcon name="plugin" /><div><h3>{t("community.guideTitle")}</h3><p>{t("community.guideDesc")}</p></div><div className="community-guide-links"><button className="community-text-button" onClick={() => onOpen("install")}>{t("community.guideInstall")}<CommunityIcon name="arrow" /></button><button className="community-text-button" onClick={() => onOpen("permissions")}>{t("community.guidePermissions")}<CommunityIcon name="arrow" /></button></div></aside>;
}
