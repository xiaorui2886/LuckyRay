import { useState } from "react";
import { createPortal } from "react-dom";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { useMessages } from "../../core/i18n/index";
import type { EndpointRecoveryPresentation } from "../../core/services/companionGateway";
import type { CompanionPresentationStore } from "../../core/services/companionPresentationStore";
import { COMPANION_COPY, gatewayErrorMessage } from "./CompanionGatewayPanel";
import { useCompanionSnapshot } from "./CompanionPresentation";

/** Uses the same explicit native recovery as Settings; opening never changes an endpoint. */
export default function PhoneEndpointRecovery({ store }: { store: CompanionPresentationStore }) {
  const state = useCompanionSnapshot(store), status = state.status, busy = Boolean(state.busy);
  const { t } = useMessages(COMPANION_COPY);
  const [target, setTarget] = useState<{ address: string; port: number } | null>(null);
  const [info, setInfo] = useState<EndpointRecoveryPresentation | null>(null);
  const [copy, setCopy] = useState<{ info: EndpointRecoveryPresentation; ok: boolean } | null>(null);
  const recoverable = status?.state === "resume-failed" && status.bindAddress && status.port
    && ["gateway-bind-conflict", "gateway-bind-access-denied", "firewall/manual-permission-required", "gateway-local-transport-port-reserved"].includes(status.code)
    ? { address: status.bindAddress, port: status.port } : null;
  const available = Boolean(recoverable && state.interfaces.some(item => item.address === recoverable.address));
  const targetCurrent = available && target?.address === recoverable?.address && target?.port === recoverable?.port;
  const liveInfo = status?.state === "running" && info?.envelope.baseUrl === `https://${status.bindAddress}:${status.port}`
    && info.envelope.desktopInstanceId === status.desktopInstanceId && info.envelope.certificateFingerprint === status.certificateFingerprint ? info : null;
  const closeTarget = () => { if (!busy) setTarget(null); };
  const confirmModal = useApplicationModalSurface<HTMLDivElement>(Boolean(target), closeTarget);
  const infoModal = useApplicationModalSurface<HTMLDivElement>(Boolean(liveInfo), () => setInfo(null));
  const portal = document.querySelector(".react-nav-shell") || document.body;
  const confirm = () => {
    if (!target || !targetCurrent || busy) return;
    void store.run("recover", async client => {
      await client.recoverEndpoint(target.address, target.port); setTarget(null);
    });
  };
  const share = () => void store.run("recovery-info", async client => {
    const result = await client.endpointRecoveryPresentation(); setCopy(null); setInfo(result);
  });
  return <>
    {(recoverable || status?.state === "running" && state.devices.some(device => !device.revokedAt)) && <div className="phone-endpoint-actions">
      {recoverable && <button type="button" disabled={busy || !available} onClick={() => setTarget(recoverable)}>{t("recovery.select")}</button>}
      {status?.state === "running" && state.devices.some(device => !device.revokedAt) && <button type="button" disabled={busy} onClick={share}>{t("recovery.share")}</button>}
    </div>}
    {target && createPortal(<div className="phone-endpoint-backdrop experience-dialog-backdrop" onPointerDown={confirmModal.onBackdropPointerDown}>
      <div className="phone-endpoint-dialog experience-dialog" ref={confirmModal.surfaceRef} onKeyDown={confirmModal.onSurfaceKeyDown} role="dialog" aria-modal="true" aria-labelledby="phone-endpoint-recover-title" tabIndex={-1}>
        <h3 id="phone-endpoint-recover-title">{t("recovery.confirmTitle")}</h3>
        <p>{t("recovery.confirmBody")}</p><p className="phone-endpoint-address">{target.address}:{target.port}</p>
        {!targetCurrent && <p role="alert">{t("error.permissionChanged")}</p>}
        {Boolean(state.error) && <p className="phone-error" role="alert">{gatewayErrorMessage(state.error, t)}</p>}
        <div className="phone-endpoint-dialog-actions"><button type="button" data-modal-initial-focus disabled={busy} onClick={closeTarget}>{t("revoke.cancel")}</button>
          <button type="button" className="primary" disabled={busy || !targetCurrent} onClick={confirm}>{t("recovery.confirm")}</button></div>
      </div></div>, portal)}
    {liveInfo && createPortal(<div className="phone-endpoint-backdrop experience-dialog-backdrop" onPointerDown={infoModal.onBackdropPointerDown}>
      <div className="phone-endpoint-dialog experience-dialog" ref={infoModal.surfaceRef} onKeyDown={infoModal.onSurfaceKeyDown} role="dialog" aria-modal="true" aria-labelledby="phone-endpoint-info-title" tabIndex={-1}>
        <h3 id="phone-endpoint-info-title">{t("recovery.share")}</h3><p>{t("recovery.shareBody")}</p>
        <div className="phone-qr-frame"><svg viewBox={`-4 -4 ${liveInfo.qrSize + 8} ${liveInfo.qrSize + 8}`} role="img" aria-label={t("recovery.share")} shapeRendering="crispEdges">
          <rect x="-4" y="-4" width={liveInfo.qrSize + 8} height={liveInfo.qrSize + 8} fill="white" /><path d={liveInfo.qrPath} fill="#101014" /></svg></div>
        <p className="phone-endpoint-address">{liveInfo.envelope.baseUrl}</p>
        {copy?.info === liveInfo && <p role="status">{t(copy.ok ? "recovery.copied" : "recovery.copyFailed")}</p>}
        <div className="phone-endpoint-dialog-actions"><button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(liveInfo.envelope)).then(() => setCopy({ info: liveInfo, ok: true }), () => setCopy({ info: liveInfo, ok: false }))}>{t("recovery.copy")}</button>
          <button type="button" data-modal-initial-focus className="primary" onClick={() => setInfo(null)}>{t("pair.done")}</button></div>
      </div></div>, portal)}
  </>;
}
