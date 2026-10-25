import PhoneAuthorizationChoice, { PHONE_AUTHORIZATION_COPY } from "./PhoneAuthorizationChoice";
import type { CompanionAuthorizationMode } from "../../core/services/companionGateway";
import PhoneAccessManager from "./PhoneAccessManager";
import { companionInterfaceHint, orderedCompanionInterfaces, selectedCompanionAddress } from "../../core/services/companionAccess";
import { useState } from "react";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { companionDeviceDisplayLabel, companionGrantKey, companionOnlineCount, type CompanionPresentationStore } from "../../core/services/companionPresentationStore";
import type { CompanionServiceGrantState, PairedCompanionDevice } from "../../core/services/companionGateway";
import { COMPANION_COPY, gatewayErrorMessage } from "./CompanionGatewayPanel";
import { useCompanionSnapshot, useCompanionStore, useCompanionView } from "./CompanionPresentation";
import "./phoneConnection.css";

const COPY = defineMessages({
  ...COMPANION_COPY,
  "quick.title": { "zh-CN": "手机连接", "en-US": "Phone connection" },
  "quick.entry": { "zh-CN": "手机", "en-US": "Phone" },
  "quick.networkHint": { "zh-CN": "手机与电脑需连接同一局域网", "en-US": "Use the same local network on your phone and desktop" },
  "quick.offline": { "zh-CN": "未连接", "en-US": "Not connected" },
  "quick.connected": { "zh-CN": "已连接", "en-US": "Connected" },
  "quick.online": { "zh-CN": "{count} 台在线", "en-US": "{count} online" },
  "quick.unknown": { "zh-CN": "状态未确认", "en-US": "Status unconfirmed" },
  "quick.close": { "zh-CN": "关闭手机连接", "en-US": "Close phone connection" },
  "quick.more": { "zh-CN": "更多连接设置", "en-US": "More connection settings" },
  "quick.permission": { "zh-CN": "当前设备权限", "en-US": "Selected device access" },
  "quick.materials": { "zh-CN": "素材库 · 全部管理记录", "en-US": "Materials · All managed records" },
  "quick.vault": { "zh-CN": "当前知识库 · {name}", "en-US": "Current vault · {name}" },
  "quick.noVault": { "zh-CN": "未打开知识库，知识权限暂不显示", "en-US": "No active vault; vault permissions are not shown" },
  "quick.local": { "zh-CN": "已授权；本机 LSH 暂不可用", "en-US": "Granted; desktop LSH is currently unavailable" },
  "quick.paired": { "zh-CN": "配对成功，已应用你确认的权限模式。可随时调整下方开关。", "en-US": "Paired with the access mode you confirmed. Adjust the switches below anytime." },
  "quick.expired": { "zh-CN": "配对码已过期，请重新生成", "en-US": "Pairing code expired. Generate a new one." },
  "quick.renewing": { "zh-CN": "正在更新配对码…", "en-US": "Renewing pairing code…" },
  "quick.switchOn": { "zh-CN": "已开启 · 点击关闭", "en-US": "On · Click to turn off" },
  "quick.switchOff": { "zh-CN": "已关闭 · 点击开启", "en-US": "Off · Click to turn on" },
  "quick.changed": { "zh-CN": "权限或当前库已变化，请核对后重试", "en-US": "Access or the current vault changed. Review and retry." },
  "quick.readback": { "zh-CN": "未能确认授权结果，请刷新后核对", "en-US": "Could not confirm the result. Refresh and review." },
});

export function PhoneIcon() {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="6" y="2.5" width="12" height="19" rx="3" /><path d="M10 5h4M11 18h2" />
  </svg>;
}
export function PhoneConnectionEntry({ onOpen }: { onOpen: () => void }) {
  const store = useCompanionStore();
  return <ConnectionEntry store={store} onOpen={onOpen} />;
}
function ConnectionEntry({ store, onOpen }: { store: CompanionPresentationStore | null; onOpen: () => void }) {
  return store ? <ConnectedEntry store={store} onOpen={onOpen} /> : <EntryButton count={null} onOpen={onOpen} />;
}
function ConnectedEntry({ store, onOpen }: { store: CompanionPresentationStore; onOpen: () => void }) {
  const state = useCompanionSnapshot(store);
  return <EntryButton count={companionOnlineCount(state)} onOpen={onOpen} />;
}
function EntryButton({ count, onOpen }: { count: number | null; onOpen: () => void }) {
  const { t } = useMessages(COPY);
  const status = count === null ? t("quick.unknown") : count ? t("quick.connected") : t("quick.offline");
  return <button type="button" className="nav-item phone-connection-entry" data-connected={Boolean(count)}
    title={t("quick.entry") + " · " + status} aria-label={t("quick.entry") + " · " + status} aria-haspopup="dialog" onClick={onOpen}>
    <span className="nav-icon"><PhoneIcon /></span><span className="nav-label">{t("quick.entry")}</span>
  </button>;
}

export default function PhoneConnectionDialog({ onClose, onMore }: { onClose: () => void; onMore: () => void }) {
  const store = useCompanionStore(), { t } = useMessages(COPY);
  const modal = useApplicationModalSurface<HTMLDivElement>(true, onClose);
  return <div className="phone-connection-backdrop experience-dialog-backdrop" onPointerDown={modal.onBackdropPointerDown}>
    <div ref={modal.surfaceRef} className="phone-connection-dialog experience-dialog" role="dialog" aria-modal="true"
      aria-label={t("quick.title")} tabIndex={-1} onKeyDown={modal.onSurfaceKeyDown}>
      <button type="button" data-modal-initial-focus className="phone-close" aria-label={t("quick.close")} onClick={onClose}>×</button>
      {store ? <PhoneConnectionContents store={store} /> : <div className="phone-connection-body phone-connection-loading"><p role="status">{t("state.loading")}</p></div>}
      <div className="phone-connection-aux"><button type="button" className="phone-link" onClick={onMore}>{t("quick.more")} ↗</button></div>
    </div>
  </div>;
}

function PhoneConnectionContents({ store }: { store: CompanionPresentationStore }) {
  const { state, owner, seconds } = useCompanionView(store);
  const { t } = useMessages(COPY);
  const { t: auth } = useMessages(PHONE_AUTHORIZATION_COPY);
  const [authorizationMode, setAuthorizationMode] = useState<CompanionAuthorizationMode | null>(null);
  const [address, setAddress] = useState("");
  const interfaces = orderedCompanionInterfaces(state.interfaces);
  const selectedAddress = selectedCompanionAddress(address, interfaces, state.status);
  const resumeFailed = state.status?.state === "resume-failed";
  const [revoke, setRevoke] = useState<PairedCompanionDevice | null>(null);
  const revokeModal = useApplicationModalSurface<HTMLDivElement>(Boolean(revoke), () => setRevoke(null));
  const running = state.status?.state === "running", pairing = state.pairingOwner === owner ? state.pairing : null;
  const device = state.devices.find(d => d.deviceId === state.selectedDeviceId && !d.revokedAt);
  const services = device ? state.services[device.deviceId] : undefined, lsh = device ? state.lsh[device.deviceId] : undefined;
  const count = companionOnlineCount(state);
  const presentationError = state.error || (state.pairingOwner === owner ? state.pairingError : null);
  const preparing = Boolean(state.pairingOwner === owner && state.pairingState === "waiting" && !pairing);
  const statusText = count === null ? t("quick.unknown") : count ? t("quick.online", { count }) : t("quick.offline");
  const localError = (error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    return code === "permission-state-changed" ? t("quick.changed") : code === "permission-readback-failed" ? t("quick.readback") : gatewayErrorMessage(error, t);
  };
  const permission = (grantClass: CompanionServiceGrantState["grants"][number]["grantClass"], scopeKind: "catalog" | "vault",
    scopeId: string, label: string) => {
    if (!device || !services) return null;
    const grant = { grantClass, scopeKind, scopeId }, key = companionGrantKey(device.deviceId, grant);
    const granted = services.grants.some(g => g.grantClass === grantClass && g.scopeKind === scopeKind && g.scopeId === scopeId);
    const busy = Boolean(state.grantBusy[key]);
    return <div className="phone-permission" key={key}><div><span>{label}</span>
      {state.grantErrors[key] ? <small className="phone-error" role="alert">{localError(state.grantErrors[key])}</small> : null}</div>
      <button type="button" role="switch" aria-checked={granted} aria-label={label} aria-busy={busy}
        title={t(granted ? "quick.switchOn" : "quick.switchOff")}
        disabled={busy || state.grantLoading[device.deviceId] || state.grantBusy[device.deviceId + ":batch"] || Boolean(state.busy) || !state.status} className="phone-permission-switch"
        onClick={() => void store.toggleService(device.deviceId, grant)}><i /></button></div>;
  };
  return <>
    <div className="phone-connection-body">
      <section className="phone-connection-left">
        <div className="phone-connection-status"><span data-online={Boolean(count)}>{statusText}</span>
          <button type="button" disabled={state.loading} onClick={() => { void store.refresh(); void store.refreshDetails(); }}>{t("action.refresh")}</button></div>
        {presentationError ? <p className="phone-error" role="alert">{localError(presentationError)}</p> : null}
        <div className="phone-pairing-area">
          {running && state.status?.state === "running" && <p className="phone-listening-address">{t("gateway.listen")}: {state.status.bindAddress}:{state.status.port}</p>}
          {running && <p>{t("gateway.reachability")}</p>}
          {running ? <>
            {pairing || preparing ? <><div className="phone-qr-frame" aria-busy={preparing}>{pairing ? <svg viewBox={`-4 -4 ${pairing.qrSize + 8} ${pairing.qrSize + 8}`}
              role="img" aria-label={t("pair.qr")} shapeRendering="crispEdges">
              <rect x="-4" y="-4" width={pairing.qrSize + 8} height={pairing.qrSize + 8} fill="white" />
              <path d={pairing.qrPath} fill="#101014" /></svg> : <span className="phone-qr-pending" aria-hidden="true">{t("quick.renewing")}</span>}</div>
              <b>{t("pair.title")}</b><p role="status">{preparing ? t("quick.renewing") : t("pair.expires", { seconds })}</p>
              <div className="phone-pairing-actions"><button type="button" disabled={preparing || Boolean(state.busy)} onClick={() => void store.issuePairing(owner, true, authorizationMode || "manual")}>{t("pair.regenerate")}</button>
                <button type="button" onClick={() => void store.releasePairing(owner)}>{t("pair.close")}</button></div></>
              : <><div className="phone-pairing-intro"><PhoneIcon /><h3>{auth("pairingTitle")}</h3><p>{auth("pairingHint")}</p></div>
                <PhoneAuthorizationChoice value={authorizationMode} onChange={setAuthorizationMode} disabled={Boolean(state.busy)} /><button type="button" className="primary phone-pair-button" disabled={Boolean(state.busy) || !authorizationMode} onClick={() => authorizationMode && void store.issuePairing(owner, false, authorizationMode)}>
                  <PhoneIcon />{state.busy === "pair" ? t("state.loading") : auth(authorizationMode === "trusted" ? "pairTrusted" : authorizationMode === "manual" ? "pairManual" : "pairChoose")}</button>
                {!state.devices.length && <p>{t("quick.networkHint")}</p>}
                {state.pairingState === "expired" && <p role="status">{t("quick.expired")}</p>}
                {state.pairingState === "paired" && <p role="status">{t("quick.paired")}</p>}</>}
          </> : <>
            <h3>{t("gateway.title")}</h3>
            {state.status?.state === "resume-failed" && <p className="phone-error">{t("gateway.resumeFailed")}</p>}
            <label>{t("gateway.interface")}<select value={selectedAddress} disabled={Boolean(state.busy) || resumeFailed}
              onChange={event => setAddress(event.target.value)}>
              {!interfaces.length && !resumeFailed && <option value="">{t("gateway.noInterface")}</option>}
              {resumeFailed && selectedAddress && !interfaces.some(item => item.address === selectedAddress) && <option value={selectedAddress}>{selectedAddress}</option>}
              {interfaces.map(item => <option key={item.interfaceId} value={item.address}>{item.name} · {item.address}{companionInterfaceHint(item) === "virtual" ? ` · ${t("gateway.virtual")}` : ""}</option>)}</select></label>
            <button type="button" className="primary" disabled={Boolean(state.busy) || !state.status || !selectedAddress || !(state.status.state === "disabled" || resumeFailed)}
              onClick={() => void store.run("start", client => client.start(selectedAddress))}>{t(resumeFailed ? "gateway.retry" : "gateway.start")}</button>
            {resumeFailed && <button type="button" disabled={Boolean(state.busy)} onClick={() => void store.run("stop", client => client.stop())}>{t("gateway.stop")}</button>}
            <p>{t("gateway.interfaceHint")}</p>
            <p>{t("quick.networkHint")}</p></>}
        </div>
        {state.devices.length > 0 && <h3 className="phone-device-list-title">{t("devices.title")}</h3>}
        <div className="phone-device-list" aria-label={t("devices.title")}>
          {!state.devices.length && <p>{state.loading ? t("state.loading") : t("devices.empty")}</p>}
          {state.devices.map(item => <button key={item.deviceId} type="button" aria-pressed={state.selectedDeviceId === item.deviceId}
            className="phone-device" disabled={Boolean(item.revokedAt)} onClick={() => store.selectDevice(item.deviceId)}>
            <PhoneIcon /><span><b>{companionDeviceDisplayLabel(item, state.devices)}</b><small>{item.revokedAt ? t("devices.revoked") :
              count === null ? t("quick.unknown") : running && item.connected ? t("devices.online") : t("devices.offline")}</small></span></button>)}
        </div>
      </section>
      {device && <section className="phone-connection-right" aria-busy={Boolean(state.grantLoading[device.deviceId])}><div className="phone-device-heading"><span className="phone-kicker">{t("quick.permission")}</span>
        <h3>{companionDeviceDisplayLabel(device, state.devices)}</h3></div>
        <PhoneAccessManager key={device.deviceId} store={store} deviceId={device.deviceId} />
        <>
          {/* Background checks retain confirmed controls; scope changes and read failures still clear them. */}
          {!services ? <p role="status">{state.grantErrors[device.deviceId] ? localError(state.grantErrors[device.deviceId]) : t("state.loading")}
            <button type="button" disabled={state.grantLoading[device.deviceId]} onClick={() => void store.readGrant(device.deviceId, true)}>{t("action.refresh")}</button></p>
            : !services.savedLibraries && services.authorizationMode !== "trusted" ? <><h4>{t("quick.materials")}</h4>
              {permission("content.read", "catalog", "", t("devices.materialRead"))}
              {permission("content.write", "catalog", "", t("devices.materialWrite"))}
              {permission("ingest.write", "catalog", "", t("devices.materialIngest"))}
              {permission("desktop.open", "catalog", "", t("devices.materialOpen"))}
              {services.currentVault ? <><h4>{t("quick.vault", { name: services.currentVault.label })}</h4>
                {permission("content.read", "vault", services.currentVault.vaultId, t("devices.vaultRead", { name: services.currentVault.label }))}
                {permission("content.write", "vault", services.currentVault.vaultId, t("devices.vaultWrite", { name: services.currentVault.label }))}
                {permission("ingest.write", "vault", services.currentVault.vaultId, t("devices.vaultIngest", { name: services.currentVault.label }))}
                {permission("desktop.open", "vault", services.currentVault.vaultId, t("devices.vaultOpen", { name: services.currentVault.label }))}</>
                : <p>{t("quick.noVault")}</p>}</> : null}
          {lsh ? <div className="phone-permission phone-lsh-permission"><div><span title={t("devices.lshRemoteHint")}>{t("devices.lshRemote")}</span>
            {lsh.granted && !lsh.runtimeAvailable && <small>{t("quick.local")}</small>}
            {state.grantErrors[device.deviceId + ":lsh"] ? <small className="phone-error" role="alert">{localError(state.grantErrors[device.deviceId + ":lsh"])}</small> : null}</div>
            <button type="button" role="switch" aria-checked={lsh.granted} aria-label={t("devices.lshRemote")} className="phone-permission-switch"
              title={t(lsh.granted ? "quick.switchOn" : "quick.switchOff")}
              disabled={Boolean(state.grantBusy[device.deviceId + ":lsh"] || state.grantBusy[device.deviceId + ":batch"] || state.grantLoading[device.deviceId] || state.busy || !state.status)}
              onClick={() => void store.toggleLsh(device.deviceId)}><i /></button></div> : <p role="status">
                {state.grantErrors[device.deviceId] ? localError(state.grantErrors[device.deviceId]) : t("state.loading")}
                <button type="button" disabled={state.grantLoading[device.deviceId]} onClick={() => void store.readGrant(device.deviceId, true)}>{t("action.refresh")}</button></p>}
          <button type="button" className="phone-revoke" disabled={Boolean(state.busy)} onClick={() => setRevoke(device)}>{t("revoke.confirm")}</button>
        </>
      </section>}
    </div>
    {revoke && <div className="phone-revoke-backdrop experience-dialog-backdrop" onPointerDown={revokeModal.onBackdropPointerDown}>
      <div className="phone-revoke-dialog experience-dialog" ref={revokeModal.surfaceRef} onKeyDown={revokeModal.onSurfaceKeyDown}
        role="dialog" aria-modal="true" aria-labelledby="phone-revoke-title" tabIndex={-1}>
        <h3 id="phone-revoke-title">{t("revoke.title", { name: companionDeviceDisplayLabel(revoke, state.devices) })}</h3><p>{t("revoke.description")}</p>
        <button type="button" data-modal-initial-focus onClick={() => setRevoke(null)}>{t("revoke.cancel")}</button>
        <button type="button" disabled={Boolean(state.busy)} onClick={() => void store.run("revoke", async client => {
          await client.revokeDevice(revoke.deviceId); setRevoke(null);
        })}>{t("revoke.confirm")}</button>
      </div></div>}
  </>;
}
