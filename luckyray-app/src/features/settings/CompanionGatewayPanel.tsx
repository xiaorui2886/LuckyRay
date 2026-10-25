import PhoneAuthorizationChoice, { PHONE_AUTHORIZATION_COPY } from "./PhoneAuthorizationChoice";
import type { CompanionAuthorizationMode } from "../../core/services/companionGateway";
import PhoneAccessManager from "./PhoneAccessManager";
import { companionInterfaceHint, orderedCompanionInterfaces, selectedCompanionAddress } from "../../core/services/companionAccess";
import { useEffect, useRef, useState } from "react";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { useCompanionStore, useCompanionView } from "./CompanionPresentation";
import { companionDeviceDisplayLabel, companionGrantKey, type CompanionPresentationStore } from "../../core/services/companionPresentationStore";

import {
  assertCanonicalPairingEnvelope,
  type CompanionServiceGrantState,

  type PairedCompanionDevice,
} from "../../core/services/companionGateway";
import { defineMessages, useMessages } from "../../core/i18n/index";

export const COMPANION_COPY = defineMessages({
  "state.disabled": { "zh-CN": "已关闭", "en-US": "Off" },
  "state.running": { "zh-CN": "运行中", "en-US": "Running" },
  "state.stopping": { "zh-CN": "正在停止", "en-US": "Stopping" },
  "state.recovery": { "zh-CN": "需要恢复", "en-US": "Recovery required" },
  "state.resumeFailed": { "zh-CN": "连接恢复失败", "en-US": "Connection resume failed" },
  "state.starting": { "zh-CN": "启动中", "en-US": "Starting" },
  "state.restarting": { "zh-CN": "正在重启", "en-US": "Restarting" },
  "state.unknown": { "zh-CN": "状态未知", "en-US": "Status unknown" },
  "state.loading": { "zh-CN": "读取中", "en-US": "Loading" },
  "time.never": { "zh-CN": "尚未连接", "en-US": "Never connected" },
  "time.unknown": { "zh-CN": "时间未知", "en-US": "Time unknown" },
  "audit.started": { "zh-CN": "服务已启动", "en-US": "Service started" },
  "audit.stopped": { "zh-CN": "服务已停止", "en-US": "Service stopped" },
  "audit.pairIssued": { "zh-CN": "已生成配对码", "en-US": "Pairing code issued" },
  "audit.pairSucceeded": { "zh-CN": "设备配对成功", "en-US": "Device paired" },
  "audit.pairFailed": { "zh-CN": "配对被拒绝", "en-US": "Pairing rejected" },
  "audit.revoked": { "zh-CN": "设备授权已撤销", "en-US": "Device access revoked" },
  "audit.authFailed": { "zh-CN": "设备认证失败", "en-US": "Device authentication failed" },
  "audit.authSummary": { "zh-CN": "认证失败摘要", "en-US": "Authentication failure summary" },
  "audit.generic": { "zh-CN": "安全事件", "en-US": "Security event" },
  "title": { "zh-CN": "连接手机", "en-US": "Connect phone" },
  "subtitle": { "zh-CN": "启动后通过当前局域网连接受信任的手机，重开应用会恢复原监听地址。点击停止可关闭服务并取消自动恢复。", "en-US": "Once enabled, trusted phones can connect over this local network. Reopening the app restores the same listening address. Stop turns off the service and automatic resume." },
  "gateway.title": { "zh-CN": "本机连接服务", "en-US": "Desktop connection service" },
  "gateway.virtual": { "zh-CN": "疑似虚拟/VPN", "en-US": "Possible virtual/VPN" },
  "gateway.interfaceHint": { "zh-CN": "优先选择与手机同网的以太网或 Wi-Fi。虚拟机、VPN 等地址可能只在电脑内部可用；名称仅作提示。", "en-US": "Choose Ethernet or Wi-Fi on the phone's network first. VM and VPN addresses may be local to this computer; names are only hints." },
  "gateway.reachability": { "zh-CN": "服务已在此地址监听。手机可达性仍取决于同网、路由和专用网络防火墙权限；列表中的地址不代表都能连接。", "en-US": "Listening on this address. Phone reachability still depends on the shared network, routing and Private-network firewall access; listed addresses are not guaranteed reachable." },
  "gateway.interface": { "zh-CN": "局域网接口", "en-US": "Local network interface" },
  "gateway.noInterface": { "zh-CN": "没有安全的局域网 IPv4 接口", "en-US": "No safe local IPv4 interface" },
  "gateway.listen": { "zh-CN": "监听地址", "en-US": "Listening address" },
  "gateway.identity": { "zh-CN": "Desktop 身份", "en-US": "Desktop identity" },
  "gateway.fingerprint": { "zh-CN": "证书指纹", "en-US": "Certificate fingerprint" },
  "gateway.start": { "zh-CN": "启动连接服务", "en-US": "Start connection service" },
  "gateway.retry": { "zh-CN": "重试原地址", "en-US": "Retry saved address" },
  "gateway.resumeFailed": { "zh-CN": "未能恢复原连接地址。可以重试，或停止后重新选择接口。", "en-US": "The saved connection address could not resume. Retry, or Stop before choosing another interface." },
  "gateway.pair": { "zh-CN": "连接新手机", "en-US": "Connect a new phone" },
  "gateway.restart": { "zh-CN": "重启", "en-US": "Restart" },
  "gateway.stop": { "zh-CN": "停止", "en-US": "Stop" },
  "firewall.title": { "zh-CN": "Windows 防火墙由你决定", "en-US": "You control Windows Firewall access" },
  "firewall.description": { "zh-CN": "若系统询问网络访问，仅允许“专用网络”。LuckyRay 不会自动创建或修改防火墙规则。", "en-US": "If Windows asks, allow Private networks only. LuckyRay never creates or changes firewall rules automatically." },
  "devices.title": { "zh-CN": "已配对设备", "en-US": "Paired devices" },
  "devices.empty": { "zh-CN": "还没有已配对设备。启动服务后生成一次性配对码。", "en-US": "No paired devices yet. Start the service to generate a one-time pairing code." },
  "devices.revoked": { "zh-CN": "已撤销", "en-US": "Revoked" },
  "devices.online": { "zh-CN": "当前在线", "en-US": "Online now" },
  "devices.offline": { "zh-CN": "离线", "en-US": "Offline" },
  "devices.lastSeen": { "zh-CN": "{state} · 最近在线 {time}", "en-US": "{state} · Last seen {time}" },
  "devices.revoke": { "zh-CN": "撤销", "en-US": "Revoke" },
  "devices.lshRemote": { "zh-CN": "LSH 远程", "en-US": "LSH remote" },
  "devices.lshRemoteHint": { "zh-CN": "允许此设备在手机上打开本机的 LSH 会话界面", "en-US": "Allow this device to open this desktop's LSH session on the phone" },
  "devices.services": { "zh-CN": "跨端服务权限", "en-US": "Cross-device service access" },
  "devices.servicesHint": { "zh-CN": "信任模式下，开关对所有已保存及未来的库生效；手动模式按显示的库授权。关闭后新请求立即被拒绝。", "en-US": "In Trusted mode, switches apply to every saved and future library. Manual mode uses the shown scope. New requests are denied when turned off." },
  "devices.materialRead": { "zh-CN": "读取素材库", "en-US": "Read materials" },
  "devices.materialWrite": { "zh-CN": "修改素材元数据/移除管理记录", "en-US": "Edit metadata / remove managed records" },
  "devices.materialIngest": { "zh-CN": "导入素材", "en-US": "Import materials" },
  "devices.materialOpen": { "zh-CN": "在桌面打开素材", "en-US": "Open materials on desktop" },
  "devices.vaultRead": { "zh-CN": "读取当前知识库：{name}", "en-US": "Read current vault: {name}" },
  "devices.vaultWrite": { "zh-CN": "新建/修改/删除当前库笔记：{name}", "en-US": "Create / edit / delete notes in current vault: {name}" },
  "devices.vaultIngest": { "zh-CN": "导入当前知识库：{name}", "en-US": "Import into current vault: {name}" },
  "devices.vaultOpen": { "zh-CN": "在桌面打开知识笔记：{name}", "en-US": "Open vault notes on desktop: {name}" },
  "security.title": { "zh-CN": "最近安全记录", "en-US": "Recent security activity" },
  "security.limit": { "zh-CN": "最多 24 条", "en-US": "Latest 24" },
  "security.empty": { "zh-CN": "暂无安全记录。", "en-US": "No security activity yet." },
  "security.device": { "zh-CN": "设备 {id}", "en-US": "Device {id}" },
  "security.desktop": { "zh-CN": "本机服务", "en-US": "Desktop service" },
  "pair.close": { "zh-CN": "关闭配对码", "en-US": "Close pairing code" },
  "pair.title": { "zh-CN": "用手机扫描配对", "en-US": "Scan with your phone to pair" },
  "pair.description": { "zh-CN": "手机与电脑需要处于同一受信任局域网。此配对码不会保存，过期或关闭后立即失效。", "en-US": "Your phone and computer must be on the same trusted local network. This code is never saved and expires when closed or timed out." },
  "pair.qr": { "zh-CN": "一次性手机配对二维码", "en-US": "One-time phone pairing QR code" },
  "pair.expires": { "zh-CN": "{seconds} 秒后过期", "en-US": "Expires in {seconds}s" },
  "pair.regenerate": { "zh-CN": "重新生成", "en-US": "Regenerate" },
  "pair.done": { "zh-CN": "完成", "en-US": "Done" },
  "pair.copy": { "zh-CN": "复制配对信息", "en-US": "Copy pairing info" },
  "pair.copied": { "zh-CN": "已复制，可粘贴到手机", "en-US": "Copied — paste it on your phone" },
  "pair.copyFailed": { "zh-CN": "复制失败，请改用扫码", "en-US": "Copy failed — scan the code instead" },
  "pair.copyHint": { "zh-CN": "扫码不方便时：复制后到手机「连接电脑」→「其他配对方式」→「手动输入配对信息」粘贴。", "en-US": "No camera? Copy, then paste it on your phone under Connect computer → Other ways → Enter pairing info manually." },
  "revoke.close": { "zh-CN": "关闭撤销确认", "en-US": "Close revoke confirmation" },
  "revoke.title": { "zh-CN": "撤销 {name}？", "en-US": "Revoke {name}?" },
  "revoke.description": { "zh-CN": "该设备的现有连接会立即断开，旧凭据不能再次连接。之后需要重新扫码授权。", "en-US": "The current connection ends immediately and old credentials cannot reconnect. A new scan will be required." },
  "revoke.cancel": { "zh-CN": "取消", "en-US": "Cancel" },
  "revoke.confirm": { "zh-CN": "撤销设备", "en-US": "Revoke device" },
  "action.refresh": { "zh-CN": "刷新", "en-US": "Refresh" },
  "error.interfaces": { "zh-CN": "无法读取可用的局域网接口。", "en-US": "Could not read available local network interfaces." },
  "error.interfaceInvalid": { "zh-CN": "只能选择当前可用的本机局域网 IPv4 接口。", "en-US": "Choose an available private IPv4 interface on this computer." },
  "error.bindConflict": { "zh-CN": "该局域网接口暂时无法监听，请稍后重试。", "en-US": "That local network interface cannot listen right now. Try again later." },
  "error.firewall": { "zh-CN": "Windows 网络权限可能阻止监听，请检查专用网络访问权限后重试。", "en-US": "Windows network permissions may be blocking the listener. Check Private network access and retry." },
  "error.rateLimited": { "zh-CN": "配对码生成过于频繁，请稍后再试。", "en-US": "Pairing codes were requested too quickly. Try again later." },
  "error.transition": { "zh-CN": "连接服务正在切换状态，请稍后再试。", "en-US": "The connection service is changing state. Try again shortly." },
  "error.listenerConfig": { "zh-CN": "无法读取或保存监听配置。请停止服务后重新启动；若仍失败，请检查本地数据访问权限。", "en-US": "The listener configuration could not be read or saved. Stop and start again; if it still fails, check access to local app data." },
  "error.permissionChanged": { "zh-CN": "权限或当前库已变化，请核对后重试", "en-US": "Access or the current vault changed. Review and retry." },
  "error.permissionReadback": { "zh-CN": "未能确认授权结果，请刷新后核对", "en-US": "Could not confirm the result. Refresh and review." },
  "devices.lshUnavailable": { "zh-CN": "已授权；本机 LSH 暂不可用", "en-US": "Granted; desktop LSH is currently unavailable" },
  "error.generic": { "zh-CN": "连接手机服务暂不可用。", "en-US": "The phone connection service is temporarily unavailable." },
});


const STATUS_KEYS = {
  disabled: "state.disabled",
  running: "state.running",
  stopping: "state.stopping",
  "recovery-required": "state.recovery",
  "resume-failed": "state.resumeFailed",
} as const;

function shortFingerprint(value: string) {
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-10)}` : value;
}

function formatTime(value: string | null, locale: "zh-CN" | "en-US", t: ReturnType<typeof useMessages<typeof COMPANION_COPY>>["t"]) {
  if (!value) return t("time.never");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("time.unknown") : date.toLocaleString(locale);
}

function auditLabel(action: string, t: ReturnType<typeof useMessages<typeof COMPANION_COPY>>["t"]) {
  const labels: Record<string, string> = {
    "gateway-started": t("audit.started"),
    "gateway-stopped": t("audit.stopped"),
    "pairing-issued": t("audit.pairIssued"),
    "pairing-succeeded": t("audit.pairSucceeded"),
    "pairing-failed": t("audit.pairFailed"),
    "device-revoked": t("audit.revoked"),
    "auth-failed": t("audit.authFailed"),
    "auth-failure-summary": t("audit.authSummary"),
  };
  return labels[action] || t("audit.generic");
}

export function gatewayErrorMessage(error: unknown, t: ReturnType<typeof useMessages<typeof COMPANION_COPY>>["t"]): string {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof source.code === "string" ? source.code : "";
  if (code === "gateway-interface-enumeration-failed") return t("error.interfaces");
  if (["gateway-bind-address-invalid", "gateway-bind-address-not-private", "gateway-bind-address-unavailable"].includes(code)) {
    return t("error.interfaceInvalid");
  }
  if (code === "gateway-bind-conflict") return t("error.bindConflict");
  if (code === "firewall/manual-permission-required") return t("error.firewall");
  if (code === "pairing-rate-limited") return t("error.rateLimited");
  if (code === "gateway-transition-in-progress") return t("error.transition");
  if (code === "gateway-listener-config-unavailable") return t("error.listenerConfig");
  if (code === "gateway-no-interface") return t("gateway.noInterface");
  if (code === "permission-state-changed") return t("error.permissionChanged");
  if (code === "permission-readback-failed") return t("error.permissionReadback");
  return t("error.generic");
}



export default function CompanionGatewayPanel() {
  const store = useCompanionStore();
  return store ? <ConnectedCompanionGatewayPanel store={store} /> : <p role="status">…</p>;
}

function ConnectedCompanionGatewayPanel({ store }: { store: CompanionPresentationStore }) {
  const { locale, t } = useMessages(COMPANION_COPY);
  const { t: auth } = useMessages(PHONE_AUTHORIZATION_COPY);
  const [authorizationMode, setAuthorizationMode] = useState<CompanionAuthorizationMode | null>(null);
  const { state, owner, seconds: secondsRemaining } = useCompanionView(store, true);
  const { status, devices, audit, services: serviceGrants, busy } = state;
  const interfaces = orderedCompanionInterfaces(state.interfaces);
  const pairing = state.pairingOwner === owner ? state.pairing : null;
  const [selectedAddress, setSelectedAddress] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<PairedCompanionDevice | null>(null);
  const [copyState, setCopyState] = useState<{ pairingId: string; state: "copied" | "failed" } | null>(null);
  const pairingRef = useRef(pairing); pairingRef.current = pairing;
  const error = state.error ? gatewayErrorMessage(state.error, t) : "";
  const [pairViewOpen, setPairViewOpen] = useState(false);
  const [closingPairing, setClosingPairing] = useState(false);
  useEffect(() => {
    setSelectedAddress(current => selectedCompanionAddress(current, state.interfaces, status));
  }, [status, state.interfaces]);
  useEffect(() => { setCopyState(null); }, [pairing]);
  const refresh = () => Promise.all([store.refresh(), store.refreshDetails(true)]);
  const startGateway = () => { if (selectedAddress) void store.run("start", client => client.start(selectedAddress)); };
  const stopGateway = () => void store.run("stop", client => client.stop());
  const restartGateway = () => { if (selectedAddress) void store.run("restart", client => client.restart(selectedAddress)); };
  const issuePairing = (replace: boolean) => { if (authorizationMode) void store.issuePairing(owner, replace, authorizationMode); };
  const closePairing = async () => {
    if (closingPairing) return;
    setClosingPairing(true);
    if (await store.releasePairing(owner)) setPairViewOpen(false);
    setClosingPairing(false);
  };
  const copyPairingInfo = async () => {
    if (!pairing) return;
    const pairingId = pairing.pairingId;
    try {
      await navigator.clipboard.writeText(JSON.stringify(assertCanonicalPairingEnvelope(pairing)));
      if (pairingRef.current?.pairingId === pairingId) setCopyState({ pairingId, state: "copied" });
    } catch { if (pairingRef.current?.pairingId === pairingId) setCopyState({ pairingId, state: "failed" }); }
  };
  const confirmRevoke = () => { if (revokeTarget) void store.run("revoke", async client => {
    await client.revokeDevice(revokeTarget.deviceId); setRevokeTarget(null);
  }); };
  const toggleLshRemote = (device: PairedCompanionDevice) => store.toggleLsh(device.deviceId);
  const toggleServiceGrant = (device: PairedCompanionDevice, grantClass: CompanionServiceGrantState["grants"][number]["grantClass"], scopeKind: "catalog" | "vault", scopeId: string) =>
    store.toggleService(device.deviceId, { grantClass, scopeKind, scopeId });
  const askToRevoke = setRevokeTarget;
  const pairingModal = useApplicationModalSurface<HTMLDivElement>(pairViewOpen, () => void closePairing());
  const revokeModal = useApplicationModalSurface<HTMLDivElement>(Boolean(revokeTarget), () => setRevokeTarget(null));

  const stateLabel = busy === "start"
    ? t("state.starting")
    : busy === "stop"
      ? t("state.stopping")
      : busy === "restart"
        ? t("state.restarting")
          : status
            ? t(STATUS_KEYS[status.state])
            : error
              ? t("state.unknown")
              : t("state.loading");
  const isRunning = status?.state === "running";
  const resumeFailed = status?.state === "resume-failed";

  return (
    <section className="settings-panel active companion-panel" aria-labelledby="companion-title">
      <div className="companion-heading">
        <div>
          <h2 id="companion-title">{t("title")}</h2>
          <p className="settings-panel-sub">{t("subtitle")}</p>
        </div>
        <span className={`companion-state companion-state-${status?.state || "loading"}`}>
          <i aria-hidden="true" />{stateLabel}
        </span>
      </div>

            {error && <div className="companion-inline-error" role="alert">{error}</div>}
      {resumeFailed && <div className="companion-inline-error" role="alert">{t("gateway.resumeFailed")} {gatewayErrorMessage(status, t)}</div>}

      <div className="companion-console-grid">
        <article className="companion-card companion-gateway-card">
          <div className="companion-card-head">
            <div>
              <span className="companion-kicker">DESKTOP GATEWAY</span>
              <h3>{t("gateway.title")}</h3>
            </div>
            <button className="settings-btn" type="button" disabled={Boolean(busy || state.loading)} onClick={() => void refresh()}>{t("action.refresh")}</button>
          </div>

          <label className="companion-field">
            <span>{t("gateway.interface")}</span>
            <select
              className="settings-select companion-interface-select"
              value={selectedAddress}
              disabled={Boolean(busy) || isRunning || resumeFailed || interfaces.length === 0}
              onChange={(event) => setSelectedAddress(event.target.value)}
            >
              {interfaces.length === 0 && <option value="">{t("gateway.noInterface")}</option>}
              {(status?.state === "running" || resumeFailed) && status.bindAddress && !interfaces.some((item) => item.address === status.bindAddress) && <option value={status.bindAddress}>{status.bindAddress}</option>}
              {interfaces.map((item) => (
                <option value={item.address} key={item.interfaceId}>
                  {item.name || t("gateway.interface")} · {item.address}/{item.prefixLength}{companionInterfaceHint(item) === "virtual" ? ` · ${t("gateway.virtual")}` : ""}
                </option>
              ))}
            </select>
          </label>

          <p className="settings-panel-sub">{t("gateway.interfaceHint")}</p>
          {status?.state === "running" && <p className="settings-panel-sub">{t("gateway.reachability")}</p>}
          {status?.state === "running" && (
            <dl className="companion-endpoint-facts">
              <div><dt>{t("gateway.listen")}</dt><dd>{status.bindAddress}:{status.port}</dd></div>
              <div><dt>{t("gateway.identity")}</dt><dd>{status.desktopInstanceId}</dd></div>
              <div><dt>{t("gateway.fingerprint")}</dt><dd title={status.certificateFingerprint}>{shortFingerprint(status.certificateFingerprint)}</dd></div>
            </dl>
          )}
          {resumeFailed && status.bindAddress && status.port && (
            <dl className="companion-endpoint-facts"><div><dt>{t("gateway.listen")}</dt><dd>{status.bindAddress}:{status.port}</dd></div></dl>
          )}

          <div className="companion-actions">
            {!isRunning ? (
              <button className="settings-btn settings-btn-primary" type="button" disabled={Boolean(busy) || !selectedAddress || status?.state === "recovery-required" || status?.state === "stopping"} onClick={startGateway}>{resumeFailed ? t("gateway.retry") : t("gateway.start")}</button>
            ) : (
              <>
                <button className="settings-btn settings-btn-primary" type="button" disabled={Boolean(busy)} onClick={() => { setAuthorizationMode(null); setPairViewOpen(true); }}>{t("gateway.pair")}</button>
                <button className="settings-btn" type="button" disabled={Boolean(busy)} onClick={restartGateway}>{t("gateway.restart")}</button>
                <button className="settings-btn settings-btn-danger" type="button" disabled={Boolean(busy)} onClick={stopGateway}>{t("gateway.stop")}</button>
              </>
            )}
            {(resumeFailed || status?.state === "recovery-required") && <button className="settings-btn settings-btn-danger" type="button" disabled={Boolean(busy)} onClick={stopGateway}>{t("gateway.stop")}</button>}
          </div>

          <div className="companion-firewall-note">
            <span aria-hidden="true">!</span>
            <div><b>{t("firewall.title")}</b><small>{t("firewall.description")}</small></div>
          </div>
        </article>

        <article className="companion-card">
          <div className="companion-card-head"><div><span className="companion-kicker">TRUSTED DEVICES</span><h3>{t("devices.title")}</h3></div><span className="companion-count">{devices.length}</span></div>
          <div className="companion-device-list">
            {devices.length === 0 ? (
              <div className="companion-empty">{t("devices.empty")}</div>
            ) : devices.map((device) => {
              const deviceState = t(device.revokedAt ? "devices.revoked" : device.connected ? "devices.online" : "devices.offline");
              const services = serviceGrants[device.deviceId];
              const serviceOptions: Array<{
                key: keyof typeof COMPANION_COPY;
                grant: CompanionServiceGrantState["grants"][number]["grantClass"];
                scope: "catalog" | "vault";
                id: string;
              }> = services ? [
                { key: "devices.materialRead", grant: "content.read", scope: "catalog", id: "" },
                { key: "devices.materialWrite", grant: "content.write", scope: "catalog", id: "" },
                { key: "devices.materialIngest", grant: "ingest.write", scope: "catalog", id: "" },
                { key: "devices.materialOpen", grant: "desktop.open", scope: "catalog", id: "" },
                ...(services.currentVault ? ([
                  { key: "devices.vaultRead", grant: "content.read", scope: "vault", id: services.currentVault.vaultId },
                  { key: "devices.vaultWrite", grant: "content.write", scope: "vault", id: services.currentVault.vaultId },
                  { key: "devices.vaultIngest", grant: "ingest.write", scope: "vault", id: services.currentVault.vaultId },
                  { key: "devices.vaultOpen", grant: "desktop.open", scope: "vault", id: services.currentVault.vaultId },
                ] as Array<{ key: keyof typeof COMPANION_COPY; grant: CompanionServiceGrantState["grants"][number]["grantClass"]; scope: "vault"; id: string }>) : []),
              ] : [];
              return (
                <div className="companion-device" key={device.deviceId}>
                  <div className="companion-device-icon" aria-hidden="true"><span /></div>
                  <div className="companion-device-copy"><b>{companionDeviceDisplayLabel(device, state.devices)}</b><small title={t("devices.lshRemoteHint")}>{t("devices.lastSeen", { state: deviceState, time: formatTime(device.lastAuthenticatedAt, locale, t) })}</small></div>
                  {!device.revokedAt && (
                    <button
                      className={`settings-btn${state.lsh[device.deviceId]?.granted ? " settings-btn-primary" : ""}`}
                      type="button"
                      aria-pressed={state.lsh[device.deviceId] ? state.lsh[device.deviceId]?.granted : undefined}
                      title={t("devices.lshRemoteHint")}
                      disabled={Boolean(busy || !state.status || state.grantBusy[device.deviceId + ":lsh"] || state.grantBusy[device.deviceId + ":batch"] || state.grantLoading[device.deviceId] || !state.lsh[device.deviceId])}
                      onClick={() => void toggleLshRemote(device)}
                    >
                      {state.lsh[device.deviceId] ? t("devices.lshRemote") : t("state.loading")}
                    </button>
                  )}
                  {!device.revokedAt && <button className="settings-btn settings-btn-danger" type="button" disabled={Boolean(busy)} onClick={() => askToRevoke(device)}>{t("devices.revoke")}</button>}
                  {!device.revokedAt && state.lsh[device.deviceId]?.granted && !state.lsh[device.deviceId]?.runtimeAvailable
                    && <small>{t("devices.lshUnavailable")}</small>}
                  {!device.revokedAt && (state.grantErrors[device.deviceId] || state.grantErrors[device.deviceId + ":lsh"])
                    ? <small className="companion-inline-error" role="alert">{gatewayErrorMessage(state.grantErrors[device.deviceId] || state.grantErrors[device.deviceId + ":lsh"], t)}</small> : null}
                  {!device.revokedAt && services && (
                    <details className="companion-service-permissions"><summary>{t("devices.services")}</summary><PhoneAccessManager key={device.deviceId} store={store} deviceId={device.deviceId} />{!services.savedLibraries && services.authorizationMode !== "trusted" && <details>
                      <summary>{t("devices.services")}</summary>
                      <small>{t("devices.servicesHint")}</small>
                      <div className="companion-service-permission-list">
                        {serviceOptions.map((option) => {
                          const active = services.grants.some((item) => item.grantClass === option.grant && item.scopeKind === option.scope && item.scopeId === option.id);
                          return <button key={`${option.grant}:${option.scope}:${option.id}`} type="button"
                            className={`settings-btn${active ? " settings-btn-primary" : ""}`}
                            aria-pressed={active} disabled={Boolean(busy || !state.status || state.grantBusy[companionGrantKey(device.deviceId, { grantClass: option.grant, scopeKind: option.scope, scopeId: option.id })] || state.grantBusy[device.deviceId + ":batch"] || state.grantLoading[device.deviceId])}
                            onClick={() => void toggleServiceGrant(device, option.grant, option.scope, option.id)}>
                            {t(option.key, { name: services.currentVault?.label || "" })}
                            {state.grantErrors[companionGrantKey(device.deviceId, { grantClass: option.grant, scopeKind: option.scope, scopeId: option.id })] ? <small role="alert"> — {gatewayErrorMessage(state.grantErrors[companionGrantKey(device.deviceId, { grantClass: option.grant, scopeKind: option.scope, scopeId: option.id })], t)}</small> : null}
                          </button>;
                        })}
                      </div>
                    </details>}</details>
                  )}
                </div>
              );
            })}
          </div>
        </article>
      </div>

      <article className="companion-card companion-audit-card">
        <div className="companion-card-head"><div><span className="companion-kicker">RECENT SECURITY</span><h3>{t("security.title")}</h3></div><span className="companion-count">{t("security.limit")}</span></div>
        <div className="companion-audit-list">
          {audit.length === 0 ? <div className="companion-empty">{t("security.empty")}</div> : audit.map((entry, index) => (
            <div className="companion-audit-row" key={`${entry.occurredAt}-${index}`}>
              <span className={`companion-audit-mark ${entry.result.includes("fail") || entry.result.includes("reject") ? "warning" : ""}`} aria-hidden="true" />
              <b>{auditLabel(entry.action, t)}</b>
              <span>{entry.deviceId ? t("security.device", { id: `${entry.deviceId.slice(0, 12)}…` }) : t("security.desktop")}</span>
              <time dateTime={entry.occurredAt}>{formatTime(entry.occurredAt, locale, t)}</time>
            </div>
          ))}
        </div>
      </article>

      {pairViewOpen && (
        <div className="companion-pairing-overlay experience-dialog-backdrop" onPointerDown={pairingModal.onBackdropPointerDown}>
          <div ref={pairingModal.surfaceRef} onKeyDown={pairingModal.onSurfaceKeyDown} className="companion-pairing-dialog experience-dialog" role="dialog" aria-modal="true" aria-labelledby="companion-pair-title" tabIndex={-1}>
            <button autoFocus className="companion-dialog-close" type="button" disabled={closingPairing} aria-label={t("pair.close")} title={t("pair.close")} onClick={() => void closePairing()}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg>
            </button>
            <div className="companion-pairing-copy"><span className="companion-kicker">ONE-TIME PAIRING</span><h3 id="companion-pair-title">{t("pair.title")}</h3><p>{t("pair.description")}</p></div>
            {error && <div className="companion-inline-error" role="alert">{error}</div>}
            {!pairing && busy !== "pair" && <PhoneAuthorizationChoice value={authorizationMode} onChange={setAuthorizationMode} disabled={Boolean(busy) || closingPairing} />}
            {pairing ? <><div className="companion-qr-frame" aria-label={t("pair.qr")}>
              <svg viewBox={`-4 -4 ${pairing.qrSize + 8} ${pairing.qrSize + 8}`} role="img" aria-label={t("pair.qr")} shapeRendering="crispEdges">
                <rect x="-4" y="-4" width={pairing.qrSize + 8} height={pairing.qrSize + 8} rx="2" fill="white" />
                <path d={pairing.qrPath} fill="#0c0c10" />
              </svg>
            </div>
            <div className="companion-pairing-meta"><b>{pairing.ip}:{pairing.port}</b><span>{t("pair.expires", { seconds: secondsRemaining })}</span></div></> : busy === "pair" || closingPairing ? <p role="status">{t("state.loading")}</p> : null}
            {pairing && <p className="companion-pairing-hint">{t("pair.copyHint")}</p>}
            {pairing && copyState?.pairingId === pairing.pairingId && copyState.state === "copied" && (
              <p className="companion-pairing-copied" role="status">{t("pair.copied")}</p>
            )}
            {pairing && copyState?.pairingId === pairing.pairingId && copyState.state === "failed" && (
              <p className="companion-inline-error" role="alert">{t("pair.copyFailed")}</p>
            )}
            <div className="companion-dialog-actions">
              {pairing && <button className="settings-btn" type="button" disabled={Boolean(busy) || closingPairing || !pairing} onClick={() => void copyPairingInfo()}>{t("pair.copy")}</button>}
              <button className={`settings-btn${pairing ? "" : " settings-btn-primary"}`} type="button" disabled={Boolean(busy) || closingPairing || !authorizationMode} onClick={() => issuePairing(Boolean(pairing))}>{pairing ? t("pair.regenerate") : auth(authorizationMode === "trusted" ? "pairTrusted" : authorizationMode === "manual" ? "pairManual" : "pairChoose")}</button>
              <button className={`settings-btn${pairing ? " settings-btn-primary" : ""}`} type="button" disabled={closingPairing} onClick={() => void closePairing()}>{t(pairing ? "pair.done" : "revoke.cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {revokeTarget && (
        <div className="companion-pairing-overlay experience-dialog-backdrop" onPointerDown={revokeModal.onBackdropPointerDown}>
          <div ref={revokeModal.surfaceRef} onKeyDown={revokeModal.onSurfaceKeyDown} className="companion-revoke-dialog experience-dialog" role="dialog" aria-modal="true" aria-labelledby="companion-revoke-title" tabIndex={-1}>
            <button autoFocus className="companion-dialog-close" type="button" aria-label={t("revoke.close")} title={t("revoke.close")} onClick={() => setRevokeTarget(null)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg></button>
            <span className="companion-kicker">REVOKE DEVICE</span>
            <h3 id="companion-revoke-title">{t("revoke.title", { name: revokeTarget.label })}</h3>
            <p>{t("revoke.description")}</p>
            <div className="companion-dialog-actions"><button className="settings-btn" type="button" onClick={() => setRevokeTarget(null)}>{t("revoke.cancel")}</button><button className="settings-btn settings-btn-danger" type="button" disabled={Boolean(busy)} onClick={confirmRevoke}>{t("revoke.confirm")}</button></div>
          </div>
        </div>
      )}
    </section>
  );
}
