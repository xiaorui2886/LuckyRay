// EXT-PAGE-R1: the real main-area page for a plugin `page` contribution.
// Waits for the package registry, validates the page against the single
// registry truth, then hosts the shared invocation body — no modal chrome.
import { useMemo } from "react";
import { extensionPackages, packageCompatibility, type InstalledPackage, type ScriptContribution, type ScriptResource } from "../../core/extensions/packages";
import { PluginInvocation, usePluginCopy } from "./ScriptPlugins";
import { useScriptPackages } from "./ScriptPlugins";
import { useMessages } from "../../core/i18n/index";
import { parsePluginPagePath } from "../../app/shellNav";
import "./scriptPlugins.css";

const COPY = {
  "page.loading": { "zh-CN": "正在读取插件状态…", "en-US": "Reading plugin state…" },
  "page.invalidPath": { "zh-CN": "页面地址无效。", "en-US": "This page address is invalid." },
  "page.notInstalled": { "zh-CN": "提供该页面的插件未安装或已卸载。", "en-US": "The plugin providing this page is not installed or was uninstalled." },
  "page.disabled": { "zh-CN": "插件已停用。重新启用后可再次打开此页面；你的侧栏显示偏好已保留。", "en-US": "The plugin is disabled. Enable it to use this page again; your sidebar choice is kept." },
  "page.incompatible": { "zh-CN": "该插件与当前宿主版本不兼容，页面不可用。", "en-US": "The plugin is incompatible with this host version; the page is unavailable." },
  "page.missing": { "zh-CN": "该页面不存在（可能已被更新移除）。", "en-US": "This page no longer exists (it may have been removed by an update)." },
  "page.backToCommunity": { "zh-CN": "返回社区", "en-US": "Back to Community" },
} as const;

export function PluginPageHost({ path }: { path: string }) {
  const packages = useScriptPackages();
  const hostVersion = extensionPackages.snapshot().hostVersion;
  const loaded = extensionPackages.snapshot().ready;
  const parsed = useMemo(() => parsePluginPagePath(path), [path]);
  const copy = usePluginCopy();

  // Wait for the registry before judging validity (direct URL / startup restore).
  if (!loaded) return <PageNotice textKey="page.loading" />;
  if (!parsed) return <PageNotice textKey="page.invalidPath" />;

  const entry: InstalledPackage | undefined = packages.find((item) => item.package.manifest.id === parsed.packageId);
  if (!entry) return <PageNotice textKey="page.notInstalled" />;
  if (!entry.enabled) return <PageNotice textKey="page.disabled" />;
  if (!packageCompatibility(entry.package, hostVersion).compatible) return <PageNotice textKey="page.incompatible" />;
  const contribution = (entry.package.resource as ScriptResource).contributions.find(
    (item: ScriptContribution) => item.id === parsed.pageId && item.kind === "page",
  );
  if (!contribution) return <PageNotice textKey="page.missing" />;

  return (
    <section className="plugin-page" data-plugin-page={parsed.packageId} data-plugin-page-id={parsed.pageId}>
      <header className="plugin-page-head">
        <h1>{contribution.label}</h1>
        <p>{entry.package.manifest.name} · v{entry.package.manifest.version}</p>
      </header>
      {/* digest+epoch in the key: disable/update/uninstall rebinds to the new build and
          never reuses an old invocation session. */}
      <PluginInvocation
        key={`${parsed.packageId}:${entry.digest}:${entry.epoch ?? 0}:${parsed.pageId}`}
        pkg={entry}
        contribution={contribution}
        close={() => {}}
        t={copy.t}
        variant="page"
        sessionKey={`${parsed.packageId}/${parsed.pageId}`}
      />
    </section>
  );
}

function PageNotice({ textKey }: { textKey: keyof typeof COPY }) {
  const { t } = useMessages(COPY);
  return (
    <section className="plugin-page plugin-page-unavailable" role="status">
      <p>{t(textKey)}</p>
      <button className="lr-cap-run secondary" onClick={() => { window.location.hash = "#community"; }}>{t("page.backToCommunity")}</button>
    </section>
  );
}
