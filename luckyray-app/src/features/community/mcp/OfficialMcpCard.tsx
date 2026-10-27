import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { defineMessages, useMessages } from "../../../core/i18n/index";
import { CommunityDrawer, CommunityIcon } from "../CommunityPresentation";
import {
  canConnect,
  connectionLabel,
  isRunning,
  safeErrorCode,
  validTunnelId,
  type McpAction,
  type McpStatus,
} from "./model";
import "./officialMcp.css";

const copy = defineMessages({
  title: { "zh-CN": "LuckyRay MCP", "en-US": "LuckyRay MCP" },
  official: { "zh-CN": "官方插件", "en-US": "Official plugin" },
  intro: {
    "zh-CN": "把网页里的灵感，直接带进你的素材库与知识库。",
    "en-US": "Bring ideas from the web straight into your libraries.",
  },
  detail: {
    "zh-CN":
      "让 ChatGPT、dot 搜索素材、保存图片与文件，并把 Markdown 文档导入知识库。安装包包含本机连接组件，无需命令行。",
    "en-US":
      "Let ChatGPT and dot find assets, save images and files, and import Markdown notes. Includes local connection components; no terminal required.",
  },
  add: { "zh-CN": "添加", "en-US": "Add" },
  update: { "zh-CN": "更新插件", "en-US": "Update plugin" },
  updateHint: {
    "zh-CN": "有经过校验的插件更新。先停止连接，再更新；已有授权和加密连接配置会保留。",
    "en-US": "A verified plugin update is available. Stop the connection, then update. Existing access and encrypted setup are kept.",
  },
  manage: { "zh-CN": "管理连接", "en-US": "Manage connection" },
  more: { "zh-CN": "了解与设置", "en-US": "Details & setup" },
  unavailable: {
    "zh-CN": "安装包尚未上架",
    "en-US": "Package not yet available",
  },
  busy: { "zh-CN": "正在处理…", "en-US": "Working…" },
  installing: { "zh-CN": "正在校验并安装插件…", "en-US": "Verifying and installing the plugin…" },
  retry: { "zh-CN": "重新检查", "en-US": "Check again" },
  install: { "zh-CN": "未安装", "en-US": "Not installed" },
  authorize: { "zh-CN": "等待授权", "en-US": "Authorization needed" },
  configure: { "zh-CN": "等待配置", "en-US": "Setup needed" },
  connecting: { "zh-CN": "正在连接", "en-US": "Connecting" },
  webPending: {
    "zh-CN": "隧道就绪 · 等待网页调用",
    "en-US": "Tunnel ready · awaiting web use",
  },
  ready: { "zh-CN": "已连接", "en-US": "Connected" },
  stopped: { "zh-CN": "未连接", "en-US": "Disconnected" },
  failed: { "zh-CN": "连接需处理", "en-US": "Connection needs attention" },
  included: {
    "zh-CN": "按需下载，默认不安装。停止或卸载不会删除素材和笔记。",
    "en-US":
      "An optional download, not installed by default. Stopping or uninstalling keeps your assets and notes.",
  },
  access: { "zh-CN": "素材库与知识库", "en-US": "Materials & knowledge" },
  about: { "zh-CN": "插件说明", "en-US": "About this plugin" },
  accessDetails: { "zh-CN": "查看授权范围", "en-US": "View access scope" },
  accessSummary: {
    "zh-CN": "可搜索与读取所选库、导入素材和新建 Markdown 笔记；不编辑或删除已有笔记，不开放终端或 Agent。",
    "en-US": "Search and read selected libraries, import assets, and create Markdown notes. No editing or deleting existing notes, terminal access, or Agent control.",
  },
  connectionDetails: { "zh-CN": "连接说明", "en-US": "Connection help" },
  scope: {
    "zh-CN":
      "允许搜索与读取所选库、导入素材、新建 Markdown 笔记；不允许修改或删除已有笔记，也不开放终端与 Agent 控制。授权固定绑定这两个库，切换软件当前库不会改变它。",
    "en-US":
      "Allows search and read in the selected libraries, asset import, and new Markdown notes. No editing or deleting existing notes, terminal access, or Agent control. Access stays bound to these libraries when you switch the active library.",
  },
  library: { "zh-CN": "素材库", "en-US": "Material library" },
  vault: { "zh-CN": "知识库", "en-US": "Knowledge vault" },
  choose: { "zh-CN": "请选择", "en-US": "Choose" },
  grant: { "zh-CN": "一起授权", "en-US": "Authorize both" },
  revoke: { "zh-CN": "关闭授权", "en-US": "Turn off access" },
  clearExpired: {
    "zh-CN": "清除失效授权后重新选择",
    "en-US": "Clear expired access and choose again",
  },
  granted: { "zh-CN": "两项授权已开启", "en-US": "Both libraries authorized" },
  expiry: { "zh-CN": "有效期至", "en-US": "Expires" },
  consent: {
    "zh-CN": "确认允许网页 AI 使用上述权限，有效期 30 天",
    "en-US": "Allow web AI to use this access for 30 days",
  },
  tunnel: { "zh-CN": "网页连接", "en-US": "Web connection" },
  tunnelHint: {
    "zh-CN":
      "填入你自己的 OpenAI Tunnel ID 和运行密钥。网页账号仍需有隧道使用权限；本插件不会替你创建账号或开通权益。",
    "en-US":
      "Enter your OpenAI Tunnel ID and runtime key. Your web account needs tunnel access; this plugin does not create an account or grant service eligibility.",
  },
  tunnelId: { "zh-CN": "Tunnel ID", "en-US": "Tunnel ID" },
  tunnelIdHelp: {
    "zh-CN": "在 OpenAI 隧道管理页打开隧道详情，复制完整的 tunnel_… ID。",
    "en-US": "Open your tunnel in OpenAI tunnel settings and copy its full tunnel_… ID.",
  },
  tunnelIdError: {
    "zh-CN": "请输入完整的 tunnel_… 隧道 ID，不要填写 API 密钥、Key ID 或网页地址。",
    "en-US": "Enter the full tunnel_… ID, not an API key, Key ID, or web address.",
  },
  keyRequired: {
    "zh-CN": "填写运行 API 密钥后即可保存连接配置。",
    "en-US": "Enter a runtime API key to save the connection setup.",
  },
  saveFirst: {
    "zh-CN": "请先保存连接配置，再连接或开启随 LuckyRay 启动连接。",
    "en-US": "Save the connection setup before connecting or enabling connect on launch.",
  },
  key: { "zh-CN": "运行 API 密钥", "en-US": "Runtime API key" },
  keySaved: {
    "zh-CN": "已加密保存；留空保持原密钥",
    "en-US": "Encrypted key saved; leave blank to keep it",
  },
  keyHint: {
    "zh-CN":
      "仅保存在此 Windows 用户的加密存储中，不放进命令行、日志或配置明文。",
    "en-US":
      "Stored encrypted for this Windows user, never in command-line arguments, logs, or plaintext configuration.",
  },
  save: { "zh-CN": "保存连接配置", "en-US": "Save connection setup" },
  editing: {
    "zh-CN": "先停止连接，再更改配置。",
    "en-US": "Stop the connection before changing setup.",
  },
  start: { "zh-CN": "连接", "en-US": "Connect" },
  stop: { "zh-CN": "停止连接", "en-US": "Stop connection" },
  launch: {
    "zh-CN": "随 LuckyRay 启动连接",
    "en-US": "Connect when LuckyRay starts",
  },
  launchHint: {
    "zh-CN": "开启后，下次打开 LuckyRay 自动连接；未开启时，点击连接即可。",
    "en-US":
      "Reconnect automatically when LuckyRay opens. Otherwise, connect here with one click.",
  },
  webGuide: { "zh-CN": "网页端怎么配置？", "en-US": "Set up the web side" },
  tutorial: { "zh-CN": "查看完整中文教程", "en-US": "Read the setup guide (Chinese)" },
  webStep: {
    "zh-CN":
      "先在 OpenAI 网页创建自己的隧道与运行密钥，保存到上方并连接。隧道就绪后，在 ChatGPT 的连接器页面添加对应隧道；最后让网页 AI 搜索一次素材，验证整条链路。",
    "en-US":
      "Create your tunnel and runtime key on OpenAI, save them above, and connect. Once ready, add the matching tunnel in ChatGPT connector settings. Ask web AI to search assets to verify the complete connection.",
  },
  portal: { "zh-CN": "打开隧道管理页", "en-US": "Open tunnel management" },
  uninstall: { "zh-CN": "卸载插件", "en-US": "Uninstall plugin" },
  uninstallHint: {
    "zh-CN":
      "将停止此插件的后台连接并撤销两项授权，移除插件及其连接配置。素材、笔记和其他 MCP 连接不受影响。",
    "en-US":
      "Stops this plugin, revokes both library scopes, and removes its files and connection settings. Assets, notes, and other MCP connections are kept.",
  },
  confirmUninstall: { "zh-CN": "确认卸载", "en-US": "Confirm uninstall" },
  cancel: { "zh-CN": "取消", "en-US": "Cancel" },
  error: {
    "zh-CN": "操作未完成。请重新检查连接状态后重试。",
    "en-US":
      "The operation did not finish. Check the connection state and retry.",
  },
  externalTunnel: {
    "zh-CN":
      "检测到另一条隧道连接正在运行。请先关闭原来的 tunnel-client，再点击连接；插件不会擅自结束其他连接。",
    "en-US":
      "Another tunnel client is running. Close that connection first, then connect here. This plugin will not terminate other connections.",
  },
  changed: {
    "zh-CN": "连接设置刚刚发生变化，已重新读取。请确认当前内容后再操作。",
    "en-US":
      "Connection settings changed and were refreshed. Review them before trying again.",
  },
  grantInvalid: {
    "zh-CN": "授权已关闭、过期或目标库发生变化。请重新选择两个库并授权。",
    "en-US":
      "Access expired, was revoked, or its target changed. Select both libraries and authorize again.",
  },
  notReady: {
    "zh-CN":
      "隧道暂时无法就绪。请核对 Tunnel ID、运行密钥和网页账号的隧道权限，再重新连接。",
    "en-US":
      "The tunnel could not become ready. Check the Tunnel ID, runtime key, and your account’s tunnel access, then reconnect.",
  },
  keyRejected: {
    "zh-CN": "OpenAI 未接受运行密钥。请在安全输入框保存有效的运行 API 密钥后重连。",
    "en-US": "OpenAI rejected the runtime key. Save a valid runtime API key in the secure input and reconnect.",
  },
  accessDenied: {
    "zh-CN": "OpenAI 拒绝了隧道访问。请检查运行密钥的 Tunnels Read + Use 权限和隧道所属组织。",
    "en-US": "OpenAI denied tunnel access. Check the runtime key's Tunnels Read + Use permission and the tunnel organization.",
  },
  runtimeInvalid: {
    "zh-CN": "官方连接组件启动参数不兼容，连接已停止。请保留错误码以便修复。",
    "en-US": "The official connection runtime rejected its startup options. Keep the error code for repair.",
  },
  networkUnavailable: {
    "zh-CN": "无法连接 OpenAI 隧道服务，请检查本机网络后重连。",
    "en-US": "The OpenAI tunnel service could not be reached. Check the local network and reconnect.",
  },
  tunnelMissing: {
    "zh-CN": "OpenAI 未找到该隧道。请核对 Tunnel ID，以及运行密钥与隧道是否属于同一组织。",
    "en-US": "OpenAI could not find this tunnel. Check the Tunnel ID and that the runtime key belongs to the same organization.",
  },
  configurationRejected: {
    "zh-CN": "OpenAI 拒绝了隧道配置。请检查官方隧道管理页中的状态及所属组织。",
    "en-US": "OpenAI rejected the tunnel configuration. Check its status and organization on the official tunnel page.",
  },
  serviceUnavailable: {
    "zh-CN": "OpenAI 隧道服务暂时不可用或请求过于频繁，请稍后重连。",
    "en-US": "The OpenAI tunnel service is unavailable or rate limited. Reconnect later.",
  },
  managedConfigurationFailed: {
    "zh-CN": "官方隧道组件未能取得可用的连接配置，请保留错误码以便排查。",
    "en-US": "The official tunnel runtime could not obtain its connection configuration. Keep the error code for diagnosis.",
  },
  packageInvalid: {
    "zh-CN": "插件文件校验未通过，已阻止启动。请重新安装经过验证的官方插件包。",
    "en-US":
      "Plugin verification failed and startup was blocked. Reinstall the verified official package.",
  },
  secretInvalid: {
    "zh-CN": "无法读取当前 Windows 用户的加密配置。请重新保存连接配置。",
    "en-US":
      "The encrypted setup could not be read for this Windows user. Save the connection setup again.",
  },
  invalidTunnel: {
    "zh-CN": "请检查 Tunnel ID，不能填网页地址或 API 密钥。",
    "en-US": "Check the Tunnel ID; do not enter a web address or API key.",
  },
  noVault: {
    "zh-CN": "请先在知识库中创建或打开一个库，再回来授权。",
    "en-US": "Create or open a knowledge vault first, then return here.",
  },
});

export default function OfficialMcpCard() {
  const { t } = useMessages(copy);
  const errorText = (code: string) => {
    if (code === "plugin-update-required" || code === "stop-before-update")
      return t("updateHint");
    if (code === "tunnel-key-rejected") return t("keyRejected");
    if (code === "tunnel-access-denied") return t("accessDenied");
    if (code === "tunnel-runtime-options-invalid") return t("runtimeInvalid");
    if (code === "tunnel-network-unavailable") return t("networkUnavailable");
    if (code === "tunnel-not-found") return t("tunnelMissing");
    if (code === "tunnel-configuration-rejected") return t("configurationRejected");
    if (code === "tunnel-service-unavailable" || code === "tunnel-service-rate-limited") return t("serviceUnavailable");
    if (code === "tunnel-managed-configuration-failed") return t("managedConfigurationFailed");
    if (code === "external-tunnel-running") return t("externalTunnel");
    if (code === "plugin-state-changed") return t("changed");
    if (
      code.includes("grant") ||
      code === "not-authorized" ||
      code === "pairing-expired"
    )
      return t("grantInvalid");
    if (code === "tunnel-not-ready" || code === "tunnel-retry-exhausted")
      return t("notReady");
    if (
      code.includes("checksum") ||
      code.includes("integrity") ||
      code.includes("inventory") ||
      code.includes("payload")
    )
      return t("packageInvalid");
    if (code === "private-secret-storage-failed") return t("secretInvalid");
    return t("error");
  };
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [operation, setOperation] = useState<McpAction | null>(null);
  const [library, setLibrary] = useState(""),
    [vault, setVault] = useState("");
  const [tunnelId, setTunnelId] = useState(""),
    [key, setKey] = useState("");
  const [consent, setConsent] = useState(false),
    [remove, setRemove] = useState(false);
  const lock = useRef(false),
    mounted = useRef(true),
    loadedForm = useRef(false);
  const refresh = useCallback(async () => {
    const next = await invoke<McpStatus>("community_mcp_status");
    if (!mounted.current) return;
    setStatus(next);
    if (!loadedForm.current) {
      setTunnelId(next.tunnelId ?? "");
      loadedForm.current = true;
    }
  }, []);
  const act = async (
    action: McpAction,
    payload: Record<string, unknown> = {},
  ) => {
    if (lock.current || !status) return;
    lock.current = true;
    setOperation(action);
    setBusy(true);
    setError("");
    try {
      await invoke("community_mcp_action", {
        input: { action, revision: status.revision, ...payload },
      });
      await refresh();
      setConsent(false);
    } catch (e) {
      if (mounted.current) setError(safeErrorCode(e));
      await refresh().catch(() => {});
    } finally {
      lock.current = false;
      if (mounted.current) {
        setOperation(null);
        setBusy(false);
        setKey("");
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((e) => {
      if (mounted.current) setError(safeErrorCode(e));
    });
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      if (!lock.current && document.visibilityState === "visible")
        void refresh().catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);
  const close = () => {
    setOpen(false);
    setKey("");
    setRemove(false);
    setConsent(false);
  };
  const installed = !!status && status.phase !== "absent";
  const running = !!status && isRunning(status.phase);
  const normalizedTunnelId = tunnelId.trim();
  const tunnelIdInvalid = !!normalizedTunnelId && !validTunnelId(normalizedTunnelId);
  const label = status ? connectionLabel(status) : "stopped";
  return (
    <>
      <article
        className="community-card official-mcp-card"
        aria-labelledby="official-mcp-title"
      >
        <div className="official-mcp-heading">
          <CommunityIcon name="plugin" tile />
          <div>
            <div className="official-mcp-title-line">
              <h3 id="official-mcp-title">{t("title")}</h3>
              <span className="community-readonly">{t("official")}</span>
            </div>
            <p>{t("intro")}</p>
          </div>
        </div>
        <p className="community-card-desc">{t("detail")}</p>
        <div className="community-card-actions">
          <span
            className={`community-status${label === "ready" ? " is-on" : ""}`}
          >
            {status ? t(label) : error ? t("failed") : t("busy")}
          </span>
          <div className="official-mcp-actions">
            <button
              type="button"
              className="community-text-button"
              onClick={() => setOpen(true)}
            >
              {installed ? t("manage") : t("more")}
              <CommunityIcon name="arrow" />
            </button>
            {!installed && (
              <button
                type="button"
                className="lr-cap-run"
                disabled={busy || !status?.packageAvailable}
                onClick={() => {
                  setOpen(true);
                  void act("install");
                }}
              >
                {busy ? t("busy") : t("add")}
              </button>
            )}
          </div>
        </div>
      </article>
      {open && (
        <CommunityDrawer
          title={t("title")}
          label={t("official")}
          onClose={close}
          dismissible={!busy}
          footer={
            <div className="official-mcp-footer">
              <span role="status">
                {busy ? t(operation === "install" ? "installing" : "busy") : status ? t(label) : ""}
              </span>
              {installed && status && (
                <button
                  type="button"
                  className="lr-cap-run"
                  disabled={busy || (!running && !canConnect(status))}
                  onClick={() => void act(running ? "disconnect" : "connect")}
                >
                  {running ? t("stop") : t("start")}
                </button>
              )}
            </div>
          }
        >
          <div className="official-mcp-body">
            <div className="official-mcp-overview">
              <p>{t("intro")}</p>
              {status && <div className="official-mcp-overview-meta"><span className={`community-status${label === "ready" ? " is-on" : ""}`}>{t(label)}</span>{status.version && <span className="official-mcp-version">v{status.version}</span>}</div>}
              <details className="official-mcp-explanation"><summary>{t("about")}</summary><p>{t("detail")}</p></details>
            </div>
            {busy && operation === "install" && <div className="official-mcp-progress">
              <span>{t("installing")}</span>
              <progress aria-label={t("installing")} />
            </div>}
            {(error || status?.errorCode) && (
              <div className="official-mcp-error" role="alert">
                <p>{errorText(safeErrorCode(error || status?.errorCode))}</p>
                <code>{safeErrorCode(error || status?.errorCode)}</code>
                <button
                  type="button"
                  className="community-text-button"
                  disabled={busy}
                  onClick={() =>
                    void refresh()
                      .then(() => setError(""))
                      .catch((e) => setError(safeErrorCode(e)))
                  }
                >
                  {t("retry")}
                </button>
              </div>
            )}
            {!installed && (
              <section className="official-mcp-section">
                <p>{t("included")}</p>
                <button
                  type="button"
                  className="lr-cap-run"
                  disabled={busy || !status?.packageAvailable}
                  onClick={() => void act("install")}
                >
                  {status?.packageAvailable ? t("add") : t("unavailable")}
                </button>
              </section>
            )}
            {installed && status?.updateAvailable && (
              <section className="official-mcp-section">
                <p>{t("updateHint")}</p>
                <button type="button" className="lr-cap-run"
                  disabled={busy || isRunning(status.phase) || !status.packageAvailable}
                  onClick={() => void act("install")}>{t("update")}</button>
              </section>
            )}
            {installed && status && (
              <>
                <section className="official-mcp-section">
                  <h3>
                    <CommunityIcon name="note" />
                    {t("access")}
                  </h3>
                  <p>{t("accessSummary")}</p>
                  <details className="official-mcp-explanation"><summary>{t("accessDetails")}</summary><p>{t("scope")}</p></details>
                  {status.authorized && status.grant ? (
                    <div className="official-mcp-granted">
                      <strong>{t("granted")}</strong>
                      <span>
                        {status.libraries.find(
                          (l) => l.id === status.grant?.libraryId,
                        )?.name ?? t("library")}{" "}
                        ·{" "}
                        {status.vaults.find(
                          (v) => v.id === status.grant?.vaultId,
                        )?.name ?? t("vault")}
                      </span>
                      <small>
                        {t("expiry")}{" "}
                        {new Date(
                          status.grant.expiresAt * 1000,
                        ).toLocaleDateString()}
                      </small>
                      <button
                        type="button"
                        className="community-text-button official-mcp-danger"
                        disabled={busy}
                        onClick={() => void act("revoke")}
                      >
                        {t("revoke")}
                      </button>
                    </div>
                  ) : (
                    <>
                      {status.grant && (
                        <button
                          type="button"
                          className="community-text-button"
                          disabled={busy}
                          onClick={() => void act("revoke")}
                        >
                          {t("clearExpired")}
                        </button>
                      )}
                      <div className="official-mcp-fields">
                        <label>
                          {t("library")}
                          <select
                            aria-label={t("library")}
                            value={library}
                            disabled={busy}
                            onChange={(e) => {
                              setLibrary(e.target.value);
                              setConsent(false);
                            }}
                          >
                            <option value="">{t("choose")}</option>
                            {status.libraries.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t("vault")}
                          <select
                            aria-label={t("vault")}
                            value={vault}
                            disabled={busy}
                            onChange={(e) => {
                              setVault(e.target.value);
                              setConsent(false);
                            }}
                          >
                            <option value="">{t("choose")}</option>
                            {status.vaults.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {!status.vaults.length && <p>{t("noVault")}</p>}
                      <label className="official-mcp-check">
                        <input
                          type="checkbox"
                          checked={consent}
                          disabled={busy}
                          onChange={(e) => setConsent(e.target.checked)}
                        />
                        <span>{t("consent")}</span>
                      </label>
                      <button
                        type="button"
                        className="lr-cap-run"
                        disabled={
                          busy ||
                          !!status.grant ||
                          !consent ||
                          !library ||
                          !vault
                        }
                        onClick={() =>
                          void act("authorize", {
                            libraryId: library,
                            vaultId: vault,
                            confirmed: true,
                          })
                        }
                      >
                        {t("grant")}
                      </button>
                    </>
                  )}
                </section>
                <section className="official-mcp-section">
                  <h3>
                    <CommunityIcon name="browser" />
                    {t("tunnel")}
                  </h3>
                  <details className="official-mcp-explanation"><summary>{t("connectionDetails")}</summary><p>{t("tunnelHint")}</p></details>
                  <button
                    type="button"
                    className="community-text-button"
                    onClick={() =>
                      void openUrl(
                        "https://platform.openai.com/settings/organization/tunnels",
                      ).catch(() => setError("external-browser-unavailable"))
                    }
                  >
                    {t("portal")}
                    <CommunityIcon name="arrow" />
                  </button>
                  <div className="official-mcp-fields official-mcp-fields-stack">
                    <label>
                      {t("tunnelId")}
                      <input
                        value={tunnelId}
                        aria-invalid={tunnelIdInvalid || undefined}
                        aria-describedby={tunnelIdInvalid ? "official-mcp-tunnel-help official-mcp-tunnel-error" : "official-mcp-tunnel-help"}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={135}
                        disabled={busy || running}
                        placeholder="tunnel_…"
                        onChange={(e) => setTunnelId(e.target.value)}
                      />
                    </label>
                    <p id="official-mcp-tunnel-help" className="official-mcp-muted">{t("tunnelIdHelp")}</p>
                    {tunnelIdInvalid && <p id="official-mcp-tunnel-error" className="official-mcp-field-error" role="alert">{t("tunnelIdError")}</p>}
                    <label>
                      {t("key")}
                      <input
                        type="password"
                        value={key}
                        autoComplete="new-password"
                        spellCheck={false}
                        maxLength={4096}
                        disabled={busy || running}
                        placeholder={status.hasKey ? t("keySaved") : ""}
                        onChange={(e) => setKey(e.target.value)}
                      />
                    </label>
                  </div>
                  <p className="official-mcp-muted">{t("keyHint")}</p>
                  {!status.hasKey && !key && <p className="official-mcp-muted">{t("keyRequired")}</p>}
                  {running ? (
                    <p>{t("editing")}</p>
                  ) : (
                    <button
                      type="button"
                      className="lr-cap-run secondary"
                      disabled={
                        busy ||
                        !validTunnelId(normalizedTunnelId) ||
                        (!key && !status.hasKey)
                      }
                      onClick={() =>
                        void act("configure", {
                          tunnelId: normalizedTunnelId,
                          apiKey: key || null,
                          confirmed: true,
                        })
                      }
                    >
                      {t("save")}
                    </button>
                  )}
                  {!status.configured && <p className="official-mcp-muted">{t("saveFirst")}</p>}
                  <label className="official-mcp-check">
                    <input
                      type="checkbox"
                      checked={status.connectOnLaunch}
                      disabled={
                        busy || !status.configured || !status.authorized
                      }
                      onChange={(e) =>
                        void act("preferences", {
                          connectOnLaunch: e.target.checked,
                          confirmed: true,
                        })
                      }
                    />
                    <span>
                      {t("launch")}
                      <small>{t("launchHint")}</small>
                    </span>
                  </label>
                </section>
                <details className="official-mcp-section">
                  <summary>{t("webGuide")}</summary>
                  <p>{t("webStep")}</p>
                  <button
                    type="button"
                    className="lr-cap-run secondary"
                    onClick={() => void openUrl("https://github.com/xiaorui2886/LuckyRay/blob/main/docs/official-mcp/README.zh-CN.md")}
                  >
                    {t("tutorial")}
                  </button>
                </details>
                <section className="official-mcp-section official-mcp-remove">
                  {remove ? (
                    <>
                      <p>{t("uninstallHint")}</p>
                      <div className="official-mcp-actions">
                        <button
                          type="button"
                          className="lr-cap-run official-mcp-danger"
                          disabled={busy}
                          onClick={() =>
                            void act("uninstall", { confirmed: true }).then(
                              () => setRemove(false),
                            )
                          }
                        >
                          {t("confirmUninstall")}
                        </button>
                        <button
                          type="button"
                          className="lr-cap-run secondary"
                          disabled={busy}
                          onClick={() => setRemove(false)}
                        >
                          {t("cancel")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="community-text-button official-mcp-danger"
                      disabled={busy}
                      onClick={() => setRemove(true)}
                    >
                      {t("uninstall")}
                    </button>
                  )}
                </section>
              </>
            )}
          </div>
        </CommunityDrawer>
      )}
    </>
  );
}
