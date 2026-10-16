import { useEffect, useRef, useState } from "react";
import {
  createDefaultDshPluginCompatClient,
  dshPluginCompatReasonToken,
  dshPluginCompatActionFailure,
  type DshPluginCompatStatus,
} from "../../core/services/dshPluginCompat";
import { defineMessages, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "title": { "zh-CN": "LightSeek 扩展兼容", "en-US": "LightSeek extension compatibility" },
  "desc": { "zh-CN": "查看当前 LightSeek 扩展组合的兼容结论；被暂停的扩展可在此恢复（下次启动前会重新检查）。", "en-US": "Compatibility verdicts for the current LightSeek extension set; suspended extensions can be restored here (rechecked before the next start)." },
  "modeOn": { "zh-CN": "当前正在以兼容模式运行。", "en-US": "Currently running in compatibility mode." },
  "none": { "zh-CN": "当前加载配置中没有发现可检查的第三方扩展；这不代表所有已安装包都已通过兼容检查。", "en-US": "No checkable third-party extensions in the current loading configuration. This does not verify every installed package." },
  "scope": { "zh-CN": "检查范围：当前 web profile 的 bundle、profile patch 与 home patch。未加载的依赖包单独列出，不参与隔离。", "en-US": "Scope: bundles in the current web profile, profile patch and home patch. Dependencies outside this loading set are listed separately and are not quarantined." },
  "invalid": { "zh-CN": "当前加载清单缺失或无法解析，不能给出完整检查结果。", "en-US": "The current loading manifest is missing or invalid. Inspection is incomplete." },
  "patchError": { "zh-CN": "有配置层无法读取或超出检查大小限制，检查范围不完整。", "en-US": "A patch layer is unreadable or exceeds the inspection limit. Coverage is incomplete." },
  "inactive": { "zh-CN": "依赖包 · 未参与当前加载", "en-US": "Dependencies outside the current loading set" },
  "missingPackage": { "zh-CN": "包文件无法确认", "en-US": "Package files not verified" },
  "historical": { "zh-CN": "历史隔离记录 · 当前未加载", "en-US": "Historical quarantine · not currently loaded" },
  "cancel": { "zh-CN": "取消等待", "en-US": "Stop waiting" },
  "cancelled": { "zh-CN": "已停止等待结果；已提交的检查可能仍在完成。重新检查可读取最新结果。", "en-US": "Stopped waiting. The submitted check may still finish; recheck to read the latest results." },
  "unavailable": { "zh-CN": "LightSeek 宿主未运行，暂无法读取。", "en-US": "The LightSeek host is not running; unavailable." },
  "unresolved": { "zh-CN": "未能定位真实挂载项", "en-US": "Mount entry could not be located" },
  "limited": { "zh-CN": "本环境未执行第三方扩展的动态试运行，结论为静态检查范围。", "en-US": "Dynamic trial runs are not executed here; verdicts cover the static scope." },
  "recheck": { "zh-CN": "重新检查扩展", "en-US": "Recheck extensions" },
  "rechecking": { "zh-CN": "正在检查…", "en-US": "Checking…" },
  "restore": { "zh-CN": "恢复此扩展", "en-US": "Restore this extension" },
  "busy": { "zh-CN": "操作进行中…", "en-US": "Working…" },
  "error": { "zh-CN": "操作未完成，请重试。", "en-US": "The action did not complete. Try again." },
  "reason.pass": { "zh-CN": "静态检查通过", "en-US": "Static checks passed" },
  "reason.failed": { "zh-CN": "不兼容：缺少依赖或导入项", "en-US": "Incompatible: missing dependency or import" },
  "reason.quarantined": { "zh-CN": "已暂停加载", "en-US": "Suspended from loading" },
  "reason.limited": { "zh-CN": "未能完全检查", "en-US": "Not fully verified" },
  "reason.unknown": { "zh-CN": "未确认", "en-US": "Unverified" },
  "reason.unchecked": { "zh-CN": "尚未检查", "en-US": "Not checked yet" },
});

const REASON_COPY = {
  pass: "reason.pass",
  failed: "reason.failed",
  quarantined: "reason.quarantined",
  limited: "reason.limited",
  unknown: "reason.unknown",
  unchecked: "reason.unchecked",
} as const;

/**
 * Persistent host-side entry for extension compatibility: reachable while
 * LSH runs fine, so users never need to break the surface on purpose to
 * review or restore suspended extensions. Read-mostly; failures stay quiet
 * because the panel is informational, not a blocker.
 */
export default function DshPluginCompatSettingsCard({ shouldShow }: { shouldShow?: boolean }) {
  const { t } = useMessages(COPY);
  const [status, setStatus] = useState<DshPluginCompatStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const generation = useRef(0);

  const refresh = (attempt: number) => (
    createDefaultDshPluginCompatClient()
      .then((compat) => compat.status())
      .then((next) => {
        if (attempt !== generation.current) return null;
        setStatus(next);
        setFailed(false);
        return next;
      })
      .catch(() => {
        if (attempt === generation.current) setFailed(true);
        return null;
      })
  );

  useEffect(() => {
    void refresh(++generation.current);
    return () => { generation.current += 1; };
  }, []);

  const run = async (action: (client: Awaited<ReturnType<typeof createDefaultDshPluginCompatClient>>) => Promise<unknown>) => {
    const attempt = ++generation.current;
    setBusy(true); setActionFailed(false); setCancelled(false);
    try {
      const client = await createDefaultDshPluginCompatClient();
      if (attempt !== generation.current) return;
      const result = await action(client);
      const next = await client.status();
      if (attempt !== generation.current) return;
      setStatus(next); setFailed(false);
      setActionFailed(dshPluginCompatActionFailure(result) !== null);
    } catch { if (attempt === generation.current) setActionFailed(true); }
    finally { if (attempt === generation.current) setBusy(false); }
  };

  if (shouldShow === false) return null;

  return (
    <div className="dsh-plugin-compat-settings" data-testid="dsh-plugin-compat-settings">
      <p className="dsh-plugin-compat-settings-title">{t("title")}</p>
      <p className="dsh-plugin-compat-settings-desc">
        {status?.compatMode ? `${t("modeOn")} ` : ""}
        {t("desc")}
      </p>
      {failed ? <p>{t("unavailable")}</p> : null}
      {actionFailed ? <p role="alert">{t("error")}</p> : null}
      {cancelled ? <p role="status">{t("cancelled")}</p> : null}
      <p className="dsh-plugin-compat-settings-desc">{t("scope")}</p>
      {status && !status.manifestValid ? <p role="alert">{t("invalid")}</p> : null}
      {status?.patchLayers.some((layer) => !["read", "absent"].includes(layer.state)) ? <p role="alert">{t("patchError")}</p> : null}
      {status?.manifestValid && status.plugins.length === 0 && !failed ? <p>{t("none")}</p> : null}
      {status && status.plugins.length > 0 ? (
        <ul className="dsh-plugin-compat-list">
          {status.plugins.map((plugin) => (
            <li key={`${plugin.packageName}/${plugin.entryId}`}>
              <span className="dsh-plugin-compat-name">
                {plugin.packageName}
                {plugin.version ? `@${plugin.version}` : ""}
              </span>
              <span className="dsh-plugin-compat-outcome">
                {plugin.resolved === false
                  ? t("unresolved")
                  : t(REASON_COPY[dshPluginCompatReasonToken(plugin)])}
              </span>
              {plugin.quarantined ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    void run((compat) => compat.apply({ kind: "restore", entryId: plugin.entryId }));
                  }}
                >
                  {t("restore")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {status && status.inactiveDependencies.length > 0 && <section><h3>{t("inactive")}</h3><ul className="dsh-plugin-compat-list">{status.inactiveDependencies.map((entry) => <li key={entry.packageName}><span>{entry.packageName}{entry.version ? `@${entry.version}` : ""}</span>{!entry.installed && <span>{t("missingPackage")}</span>}</li>)}</ul></section>}
      {status && status.historicalQuarantine.length > 0 && <section><h3>{t("historical")}</h3><ul className="dsh-plugin-compat-list">{status.historicalQuarantine.map((entry) => <li key={`${entry.packageName}/${entry.entryId}`}>{entry.packageName}{entry.version ? `@${entry.version}` : ""}</li>)}</ul></section>}
      <p className="dsh-plugin-compat-limited">{t("limited")}</p>
      <div className="dsh-plugin-compat-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (busy) return;
            void run((compat) => compat.check(false));
          }}
        >
          {busy ? t("rechecking") : t("recheck")}
        </button>
        {busy && <button type="button" onClick={() => { generation.current += 1; setBusy(false); setCancelled(true); }}>{t("cancel")}</button>}
      </div>
    </div>
  );
}
