import { useEffect, useState } from "react";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { dshEngineUpdate, type DshEngineUpdatePhase, type DshEngineUpdateStatus } from "../../core/services/dshEngineUpdate";
import "./dshEngineUpdate.css";

const COPY = defineMessages({
  current: { "zh-CN": "当前引擎", "en-US": "Current engine" },
  candidate: { "zh-CN": "适用版本", "en-US": "Compatible update" },
  upstream: { "zh-CN": "上游发行", "en-US": "Upstream release" },
  catalogMissing: { "zh-CN": "LuckyRay 签名兼容目录尚未配置；发现上游版本不代表允许安装。", "en-US": "LuckyRay's signed compatibility catalog is not configured. Discovery does not authorize installation." },
  preview: { "zh-CN": "预览通道", "en-US": "Preview channel" },
  development: { "zh-CN": "隔离开发签名源", "en-US": "Isolated development signing source" },
  production: { "zh-CN": "受信发行源", "en-US": "Trusted distribution source" },
  unknown: { "zh-CN": "无法确认", "en-US": "Unknown" },
  check: { "zh-CN": "检查更新", "en-US": "Check for updates" },
  install: { "zh-CN": "下载并验证升级", "en-US": "Download and verify update" },
  cancel: { "zh-CN": "取消当前操作", "en-US": "Cancel operation" },
  cancelPending: { "zh-CN": "已收到取消请求，正在安全停止并清理未完成的暂存文件…", "en-US": "Cancellation requested. Safely stopping and cleaning incomplete staging…" },
  "stage.catalog": { "zh-CN": "正在检查签名更新清单…", "en-US": "Checking the signed update catalog…" },
  "stage.download": { "zh-CN": "正在下载更新包", "en-US": "Downloading update archive" },
  "stage.bootstrap": { "zh-CN": "正在下载并校验官方运行组件", "en-US": "Downloading and verifying official bootstrap" },
  "stage.inputs": { "zh-CN": "正在下载并逐项校验冻结依赖", "en-US": "Downloading and verifying frozen inputs" },
  "stage.assemble": { "zh-CN": "正在离线组装并检查原生模块", "en-US": "Assembling offline and checking native modules" },
  "stage.extract": { "zh-CN": "正在解压并核对文件", "en-US": "Extracting and checking files" },
  "stage.verify": { "zh-CN": "正在校验完整引擎文件", "en-US": "Verifying the complete engine closure" },
  "stage.schedule": { "zh-CN": "正在登记安全切换；此步不能取消…", "en-US": "Recording the safe switch; this step cannot be cancelled…" },
  recover: { "zh-CN": "撤销未激活的切换", "en-US": "Abandon unactivated switch" },
  verify: { "zh-CN": "完成本机健康检查", "en-US": "Verify local engine health" },
  restartFinish: { "zh-CN": "重启软件并完成更新", "en-US": "Restart LuckyRay and finish update" },
  restarting: { "zh-CN": "正在准备重启并完成切换…", "en-US": "Preparing restart and switch…" },
  restartPreparing: { "zh-CN": "正在准备重启并完成切换：引擎与后台任务正在安全收尾，窗口会保持响应，随后正常退出并自动重新打开。此步骤不能取消，请勿重复点击。", "en-US": "Preparing restart and switch: the engine and background tasks are draining safely. The window stays responsive, then quits normally and reopens automatically. This step cannot be cancelled; do not click repeatedly." },
  restartConfirmCold: { "zh-CN": "将正常退出 LuckyRay 并自动重新打开以完成引擎切换。请先保存其他页面的更改。现在重启？", "en-US": "LuckyRay will quit normally and reopen automatically to finish the engine switch. Save changes on other pages first. Restart now?" },
  restartConfirmWarm: { "zh-CN": "将先完成切换准备，再正常退出并自动重新打开。请先结束 LightSeek 会话和远程任务、保存其他页面更改；未发送的草稿请先自行保存，退出过程不会自动发送。现在重启？", "en-US": "The switch is prepared first, then LuckyRay quits normally and reopens automatically. Finish LightSeek sessions and remote tasks, save changes elsewhere, and save any unsent draft yourself (quitting never sends it). Restart now?" },
  busy: { "zh-CN": "处理中…", "en-US": "Working…" },
  error: { "zh-CN": "更新状态暂不可读取；没有执行升级。", "en-US": "Update status unavailable; no update was performed." },
  "phase.initializing": { "zh-CN": "正在核验运行资源，尚未就绪；不会跳过检查或自动安装。", "en-US": "Verifying runtime resources; not ready yet. Checks will not be skipped and nothing is installed automatically." },
  "phase.recovery_required": { "zh-CN": "引擎或更新记录无法验证；已停止升级，请保留现有数据。", "en-US": "Engine or update record cannot be verified. Updating is stopped; preserve current data." },
  "phase.switch_incomplete": { "zh-CN": "引擎切换在重启后未完成，现有引擎与资料未被替换。可撤销本次切换并恢复，或稍后重试更新；失败类别已记录在应用数据目录。", "en-US": "The engine switch did not complete after restart; the current engine and data were not replaced. You can abandon the switch to recover or retry later; the failure category is recorded in the app data directory." },
  "phase.recovered_restart_required": { "zh-CN": "未激活的待切换记录已保留归档；请正常关闭并重新打开 LuckyRay。", "en-US": "The unactivated switch record was archived. Close and reopen LuckyRay normally." },
  "phase.recovered": { "zh-CN": "未激活的待切换记录已归档，现有引擎和资料未改动。", "en-US": "The unactivated switch was archived. The current engine and data were not changed." },
  "phase.verification_required": { "zh-CN": "新版已切换，尚未完成启动和资源链验收；不会自动用旧备份覆盖新数据。", "en-US": "New engine is active but startup and resource-chain acceptance remain unverified. Old backups will not overwrite new data." },
  "phase.verification_failed": { "zh-CN": "本机健康检查未通过。请先打开 LightSeek 旧会话并处理插件问题；当前引擎与资料均未回滚。", "en-US": "Local health check failed. Open an existing LightSeek session and resolve plugin issues; the engine and data were not rolled back." },
  "phase.healthy": { "zh-CN": "新版引擎、会话界面和插件组合已通过本机健康检查；三条资源链仍需维护端单独验收。", "en-US": "The engine, session surface, and plugin composition passed local health checks. The three resource paths still require separate maintainer acceptance." },
  "phase.restart_required": { "zh-CN": "新版已验证暂存。冷宿主可直接重启切换；已使用 LightSeek 时，请结束任务、保存其他页面更改并核对草稿，然后准备正常退出。草稿不会自动发送。", "en-US": "Update staged. A cold host can restart directly. If LightSeek has been used, finish tasks, save changes elsewhere, and review drafts before preparing a normal quit. Drafts are never sent automatically." },
  "phase.exit_prepared": { "zh-CN": "已准备在本次正常退出后切换。请用窗口×（设置为直接退出时）或系统托盘“退出 LuckyRay”，待进程完全退出后重新打开；隐藏窗口或异常终止不会激活更新。仍可撤销未激活切换。", "en-US": "The switch is prepared for a normal quit. Use the window close button (when set to Exit) or tray Quit LuckyRay, wait for full exit, then reopen. Hiding or crashing will not activate it. You can still abandon the switch." },
  "phase.working": { "zh-CN": "正在检查或准备更新。", "en-US": "Checking or preparing the update." },
  "phase.unconfigured": { "zh-CN": "此构建没有受信签名更新源，在线升级不可用。", "en-US": "This build has no trusted signed update source; online upgrading is unavailable." },
  "phase.current": { "zh-CN": "当前没有适用于此宿主的更高版本。", "en-US": "No higher compatible engine is available for this host." },
  "phase.requires_host": { "zh-CN": "候选要求的宿主版本、接口或能力与当前 LuckyRay 不兼容。", "en-US": "The candidate requires a host version, interface, or capability that this LuckyRay build does not support." },
  "phase.legacy_contract": { "zh-CN": "旧版更新清单绑定的宿主构建已变化；维护端需重新验证并提供兼容清单。", "en-US": "The legacy catalog is bound to a different host build. Maintainers must verify and provide a compatible catalog." },
  "phase.no_candidate": { "zh-CN": "受信更新源暂无候选清单；尚未获得新版安装许可。", "en-US": "The trusted update source has no candidate catalog. No new engine is authorized for installation." },
  "phase.upgrade_path": { "zh-CN": "候选未验证从当前引擎版本升级；需维护端补充升级验证。", "en-US": "The candidate has not been verified for upgrading from your current engine. Maintainers must qualify that upgrade path." },
  "phase.check_failed": { "zh-CN": "检查失败或离线，不能判定已是最新版。", "en-US": "Check failed or offline; current status is unknown." },
  "phase.untrusted": { "zh-CN": "更新清单的签名、格式或有效期校验失败，已拒绝。", "en-US": "The update catalog failed signature, format, or validity checks and was rejected." },
  "phase.prepare_failed": { "zh-CN": "下载或验证失败，现有引擎未切换。", "en-US": "Download or verification failed; the current engine was not switched." },
  "phase.cancelled": { "zh-CN": "下载已取消，现有引擎未切换。", "en-US": "Download cancelled; the current engine was not switched." },
  "phase.available": { "zh-CN": "找到适用于当前宿主的受信版本。", "en-US": "A trusted compatible engine is available." },
  "phase.idle": { "zh-CN": "可检查适用于当前宿主的引擎更新。", "en-US": "Check for compatible engine updates." },
  "phase.upstream_unvalidated": { "zh-CN": "上游有新版，但 LuckyRay 尚未验证；不能直接安装。", "en-US": "An upstream release is available, but LuckyRay has not verified it. Installation is not allowed." },
  "phase.upstream_unavailable": { "zh-CN": "官方上游源不可访问或发行身份无法确认，不能判定已是最新。", "en-US": "The official upstream is unreachable or its identity could not be confirmed. Latest status is unknown." },
  "phase.upstream_identity": { "zh-CN": "目录制品与官方发行身份不匹配，已拒绝下载。", "en-US": "The catalog artifact does not match the official release identity. Download was refused." },
});

const PHASE_KEYS: Record<DshEngineUpdatePhase, keyof typeof COPY> = {
  initializing: "phase.initializing",
  recovery_required: "phase.recovery_required", switch_incomplete: "phase.switch_incomplete", verification_required: "phase.verification_required",
  verification_failed: "phase.verification_failed", healthy: "phase.healthy",
  recovered_restart_required: "phase.recovered_restart_required",
  recovered: "phase.recovered",
  restart_required: "phase.restart_required", exit_prepared: "phase.exit_prepared", working: "phase.working", unconfigured: "phase.unconfigured",
  current: "phase.current", requires_host: "phase.requires_host", check_failed: "phase.check_failed",
  legacy_contract: "phase.legacy_contract", no_candidate: "phase.no_candidate", upgrade_path: "phase.upgrade_path",
  untrusted: "phase.untrusted", prepare_failed: "phase.prepare_failed", available: "phase.available", idle: "phase.idle",
  cancelled: "phase.cancelled",
  upstream_unvalidated: "phase.upstream_unvalidated", upstream_unavailable: "phase.upstream_unavailable",
  upstream_identity: "phase.upstream_identity",
};

export default function DshEngineUpdateCard() {
  const { t } = useMessages(COPY);
  const [status, setStatus] = useState<DshEngineUpdateStatus | null>(dshEngineUpdate.latest());
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const unsubscribe = dshEngineUpdate.subscribe((next) => { if (active) setStatus(next); });
    void dshEngineUpdate.status().catch(() => { if (active) setError(true); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!busy && status?.phase !== "initializing") return;
    const timer = window.setInterval(() => { void dshEngineUpdate.status().catch(() => {}); }, 500);
    return () => window.clearInterval(timer);
  }, [busy, status?.phase]);
  const run = async (action: "check" | "install" | "verify" | "prepareExit" | "recover") => {
    if (busy || restarting) return;
    setBusy(true); setError(false);
    try { await dshEngineUpdate[action](); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const workStage = status?.workStage as "catalog" | "download" | "bootstrap" | "inputs" | "assemble" | "extract" | "verify" | "schedule" | undefined;
  const workKey = workStage ? `stage.${workStage}` as keyof typeof COPY : "phase.working";
  const percent = status?.progressTotal && status.progressDone !== null
    ? Math.min(100, Math.floor(100 * status.progressDone / status.progressTotal)) : null;
  const working = status?.phase === "working";
  return <div className="dsh-engine-update-card" aria-live="polite">
    <div className="dsh-engine-update-versions">
      <span>{t("current")}: <strong>{status?.currentVersion ?? t("unknown")}</strong></span>
      {status?.channel === "preview" ? <span>{t("preview")}</span> : null}
      {status?.sourceClass === "development" || status?.sourceClass === "production" ? <span>{t(status.sourceClass)}</span> : null}
      {status?.candidateVersion && status.phase === "available" ? <span>{t("candidate")}: <strong>{status.candidateVersion}</strong></span> : null}
      {status?.upstreamVersion ? <span>{t("upstream")}: <strong>{status.upstreamVersion}</strong></span> : null}
    </div>
    <p role={error ? "alert" : undefined}>{restarting ? t("restartPreparing") : error ? t("error") : working && status?.cancelRequested ? t("cancelPending") : working ? <>{t(workKey)}{percent !== null ? ` ${percent}% (${status?.progressDone}/${status?.progressTotal})` : ""}</> : status ? <>{t(PHASE_KEYS[status.phase])}{status.switchError ? ` (${status.switchError})` : ""}</> : t("busy")}</p>
    {working && percent !== null ? <progress value={status?.progressDone ?? 0} max={status?.progressTotal ?? 1} aria-label={t(workKey)} /> : null}
    {!working && status?.catalogStatus === "unconfigured" && status.phase !== "unconfigured" ? <p>{t("catalogMissing")}</p> : null}
    {!working && status?.upstreamUnvalidated && status.phase !== "upstream_unvalidated" ? <p>{t("phase.upstream_unvalidated")}</p> : null}
    <div className="settings-action-row">
      <button className="settings-btn" type="button" disabled={busy || restarting || !status?.canCheck} onClick={() => void run("check")}>{busy ? t("busy") : t("check")}</button>
      {status?.canInstall ? <button className="settings-btn settings-btn-primary" type="button" disabled={busy} onClick={() => void run("install")}>{t("install")}</button> : null}
      {status?.canCancel ? <button className="settings-btn" type="button" onClick={() => void dshEngineUpdate.cancel().catch(() => setError(true))}>{t("cancel")}</button> : null}
      {status?.canRecover ? <button className="settings-btn" type="button" disabled={busy} onClick={() => void run("recover")}>{t("recover")}</button> : null}
      {status?.canVerify ? <button className="settings-btn settings-btn-primary" type="button" disabled={busy} onClick={() => void run("verify")}>{t("verify")}</button> : null}
      {status?.canRestart || status?.canPrepareExit ? <button className="settings-btn settings-btn-primary" type="button" disabled={busy || restarting} onClick={() => { if (restarting || busy) return; if (window.confirm(t(status.canRestart ? "restartConfirmCold" : "restartConfirmWarm"))) { setRestarting(true); void dshEngineUpdate.restart().catch(() => { setRestarting(false); setError(true); }); } }}>{restarting ? t("restarting") : t("restartFinish")}</button> : null}
    </div>
  </div>;
}
