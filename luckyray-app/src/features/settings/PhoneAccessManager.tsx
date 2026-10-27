import { companionGrantEnabled } from "../../core/services/companionAccess";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import PhoneAuthorizationChoice, { PHONE_AUTHORIZATION_COPY } from "./PhoneAuthorizationChoice";
import type { CompanionAuthorizationMode } from "../../core/services/companionGateway";
import type { CompanionServiceGrantState } from "../../core/services/companionGateway";
import { companionDeviceDisplayLabel, type CompanionPresentationStore } from "../../core/services/companionPresentationStore";
import { useCompanionSnapshot } from "./CompanionPresentation";
import "./phoneAccessManager.css";

const COPY = defineMessages({
  "legacy": { "zh-CN": "原有配对权限保持不变。先选择权限模式，再使用按库开关。无需重新配对。", "en-US": "Your existing pairing permissions are unchanged. Choose an access mode before using library switches. No re-pairing needed." },
  "legacyMode": { "zh-CN": "保留原有授权", "en-US": "Existing access preserved" },
  "changeMode": { "zh-CN": "更改模式…", "en-US": "Change mode…" },
  "allMaterials": { "zh-CN": "所有素材库", "en-US": "All material libraries" },
  "allVaults": { "zh-CN": "所有知识库", "en-US": "All knowledge libraries" },
  "chooseLibrary": { "zh-CN": "选择已保存的库", "en-US": "Choose a saved library" },
  "read": { "zh-CN": "读取", "en-US": "Read" },
  "write": { "zh-CN": "编辑与删除", "en-US": "Edit and delete" },
  "ingest": { "zh-CN": "导入", "en-US": "Import" },
  "desktop": { "zh-CN": "在桌面打开", "en-US": "Open on desktop" },
  "unavailable": { "zh-CN": "暂不可用", "en-US": "Unavailable" },
  "trust": { "zh-CN": "信任这台手机…", "en-US": "Trust this phone…" },
  "title": { "zh-CN": "授权给 {name}", "en-US": "Allow access for {name}" },
  "remember": { "zh-CN": "权限按手机和知识库保存，重连、重启及切回已授权库会沿用。首次使用其他库时，请打开该库后明确授权。", "en-US": "Access is saved per phone and vault, including reconnects, restarts and switching back. Open another vault to explicitly authorize it for the first time." },
  "scope": { "zh-CN": "选择本次授权范围", "en-US": "Choose the scopes to allow" },
  "catalog": { "zh-CN": "素材库 · 全部管理记录", "en-US": "Materials · All managed records" },
  "vault": { "zh-CN": "当前知识库 · {name}", "en-US": "Current vault · {name}" },
  "common": { "zh-CN": "所选范围开启：读取、导入、在桌面打开。", "en-US": "Selected scopes allow reading, importing and opening on desktop." },
  "extra": { "zh-CN": "编辑和删除权限（单独选择）", "en-US": "Editing and deletion (choose separately)" },
  "catalogWrite": { "zh-CN": "允许修改素材元数据、标签和整理位置，以及移除素材管理记录", "en-US": "Allow editing material metadata, tags and organization, and removing managed records" },
  "vaultWrite": { "zh-CN": "允许新建、修改、移动和删除所选库中的笔记，以及写入附件", "en-US": "Allow creating, editing, moving and deleting notes, and writing attachments in the selected vault" },
  "boundary": { "zh-CN": "仅对上面选中的现有范围生效。未来新库不会自动授权。LSH 远程仍由独立开关管理。未勾选项不会撤销已有权限。", "en-US": "Only the existing scopes selected above are included. Future vaults are not automatically granted. LSH remote has its own switch. Unchecked items leave existing access unchanged." },
  "confirm": { "zh-CN": "确认并开启所选权限", "en-US": "Confirm selected access" },
  "cancel": { "zh-CN": "取消", "en-US": "Cancel" },
  "saved": { "zh-CN": "其他知识库的已保存权限", "en-US": "Saved access for other vaults" },
  "savedVault": { "zh-CN": "知识库 · {id}", "en-US": "Vault · {id}" },
  "savedHint": { "zh-CN": "当前未打开的库以权限标识区分。这里可撤销，切回该库后可查看名称并重新授权。", "en-US": "Closed vaults are identified by their access ID. Revoke here, or open the vault to see its name and authorize it again." },
  "revokeScope": { "zh-CN": "撤销此库权限…", "en-US": "Revoke this vault…" },
  "revokeAll": { "zh-CN": "关闭全部素材/知识库权限…", "en-US": "Turn off all material/vault access…" },
  "revokeTitle": { "zh-CN": "关闭 {name} 的所列权限？", "en-US": "Turn off the listed access for {name}?" },
  "revokeHint": { "zh-CN": "关闭下列范围内已有的全部跨端服务权限，新请求会被拒绝。配对和独立的 LSH 远程开关保留；要断开整台设备，请使用“撤销设备”。", "en-US": "All existing service access in the scopes below will be turned off and new requests denied. Pairing and the separate LSH remote switch stay in place. Use Revoke device to disconnect the whole phone." },
  "revokeConfirm": { "zh-CN": "确认关闭所列权限", "en-US": "Confirm turning off listed access" },
  "changed": { "zh-CN": "当前库或权限已经变化。请取消后重新打开，核对最新范围。", "en-US": "The active vault or access changed. Cancel and reopen to review the latest scopes." },
  "failed": { "zh-CN": "未能确认权限更新，请刷新后核对，再重试。", "en-US": "Could not confirm the access update. Refresh, review and retry." },
  "nothing": { "zh-CN": "所选权限均已开启", "en-US": "All selected access is already on" },
});

type Review = { mode: "trust" | "revoke"; snapshot: CompanionServiceGrantState; scopeId?: string };
export default function PhoneAccessManager({ store, deviceId }: { store: CompanionPresentationStore; deviceId: string }) {
  const { t } = useMessages(COPY), { t: auth } = useMessages(PHONE_AUTHORIZATION_COPY), state = useCompanionSnapshot(store);
  const [selectedScope, setSelectedScope] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [selection, setSelection] = useState<CompanionAuthorizationMode | null>(null);
  const services = state.services[deviceId], device = state.devices.find(item => item.deviceId === deviceId && !item.revokedAt);
  const busy = Boolean(state.busy || state.grantLoading[deviceId] || Object.values(state.grantBusy).some(Boolean));
  const close = () => { if (!busy) setReview(null); };
  // Missing authoritative data must release focus/isolation immediately and
  // must not resurrect a previously reviewed consent when polling recovers.
  useEffect(() => { if (!device || !services) setReview(null); }, [Boolean(device), Boolean(services)]);
  const modal = useApplicationModalSurface<HTMLDivElement>(Boolean(review && device && services), close);
  if (!device || !services) return null;
  const name = companionDeviceDisplayLabel(device, state.devices);
  const otherVaults = [...new Set(services.grants.filter(grant => grant.scopeKind === "vault" && grant.scopeId !== services.currentVault?.vaultId).map(grant => grant.scopeId))];
  const open = (mode: Review["mode"], scopeId?: string) => {
    setSelection(null);
    setReview({ mode, snapshot: structuredClone(services), scopeId });
  };
  const changed = Boolean(review && (review.snapshot.permissionRevision !== services.permissionRevision || review.snapshot.currentVault?.vaultId !== services.currentVault?.vaultId));
  const changes = !review ? [] : review.mode === "trust" ? []
    : review.snapshot.grants.filter(grant => !review.scopeId || grant.scopeKind === "vault" && grant.scopeId === review.scopeId).map(grant => ({ ...grant, enabled: false }));
  const scopeLabel = (scopeId: string) => scopeId === review?.snapshot.currentVault?.vaultId
    ? t("vault", { name: review.snapshot.currentVault.label }) : t("savedVault", { id: scopeId.replace(/^vault-/, "").slice(0, 12) });
  const confirm = async () => {
    if (!review || changed || busy) return;
    const saved = review.mode === "trust" && selection
      ? await store.setAuthorizationMode(deviceId, selection, review.snapshot)
      : review.mode === "revoke" && await store.applyServiceChanges(deviceId, changes, review.snapshot);
    if (saved) setReview(null);
  };
  const scopes = services.authorizationMode === "trusted"
    ? [{ scopeKind: "catalog" as const, scopeId: "", label: t("allMaterials"), available: true }, { scopeKind: "vault" as const, scopeId: "", label: t("allVaults"), available: true }]
    : services.savedLibraries || [];
  const scopeKey = (scope: typeof scopes[number]) => scope.scopeKind + ":" + scope.scopeId;
  const selected = scopes.find(scope => scopeKey(scope) === selectedScope) || scopes[0];
  const visibleScopes = services.authorizationMode === "trusted" ? scopes : selected ? [selected] : [];
  return <div className="phone-access-manager">
    <div className="phone-access-mode"><span>{services.authorizationConfigured === false ? t("legacyMode") : auth(services.authorizationMode === "trusted" ? "trusted" : "manual")}</span>
      <button type="button" className="settings-btn" disabled={busy || !state.status} onClick={() => open("trust")}>{t("changeMode")}</button></div>
    <p className="phone-access-hint">{services.authorizationConfigured === false ? t("legacy") : services.authorizationMode === "trusted" ? auth("trustedHint") : auth("manualHint")}</p>
    <div className="phone-access-actions">
      {services.authorizationConfigured !== false && services.authorizationMode !== "trusted" && <button type="button" className="settings-btn" disabled={busy || !services.grants.length} onClick={() => open("revoke")}>{t("revokeAll")}</button>}</div>
    {services.authorizationConfigured !== false && services.authorizationMode !== "trusted" && otherVaults.length > 0 && <details className="phone-access-saved"><summary>{t("saved")} · {otherVaults.length}</summary><p>{t("savedHint")}</p>
      {otherVaults.map(scopeId => <div key={scopeId}><span title={scopeId}>{t("savedVault", { id: scopeId.replace(/^vault-/, "").slice(0, 12) })}</span>
        <button type="button" className="phone-link" disabled={busy} onClick={() => open("revoke", scopeId)}>{t("revokeScope")}</button></div>)}</details>}
    {services.authorizationMode !== "trusted" && scopes.length > 0 && <label className="phone-access-library-select">{t("chooseLibrary")}
      <select value={selected ? scopeKey(selected) : ""} disabled={busy} onChange={event => setSelectedScope(event.target.value)}>
        {scopes.map(scope => <option key={scopeKey(scope)} value={scopeKey(scope)}>{scope.label}{scope.available ? "" : ` · ${t("unavailable")}`}</option>)}
      </select></label>}
    {visibleScopes.map(scope => <section key={scopeKey(scope)} className="phone-access-services"><h4>{scope.label}</h4>
      {([["content.read", "read"], ["content.write", "write"], ["ingest.write", "ingest"], ["desktop.open", "desktop"]] as const).map(([grantClass, label]) => {
        const grant = { grantClass, scopeKind: scope.scopeKind, scopeId: scope.scopeId }, enabled = companionGrantEnabled(services, grant);
        return <div className="phone-access-service" key={grantClass}><span>{t(label)}</span>
          <button type="button" role="switch" aria-checked={enabled} aria-label={`${scope.label} · ${t(label)}`} className="phone-access-switch"
            disabled={busy || !state.status || services.authorizationConfigured === false || !scope.available && !enabled}
            onClick={() => void store.toggleService(deviceId, grant)}><i /></button></div>;
      })}
    </section>)}
    {Object.entries(state.grantErrors).some(([key, value]) => key.startsWith(deviceId + ":") && value) && !review && <p className="phone-error" role="alert">{t("failed")}</p>}
    {review && createPortal(<div className="phone-access-backdrop experience-dialog-backdrop" onPointerDown={modal.onBackdropPointerDown}>
      <div ref={modal.surfaceRef} onKeyDown={modal.onSurfaceKeyDown} className="phone-access-dialog experience-dialog" role="dialog" aria-modal="true" aria-label={t(review.mode === "trust" ? "title" : "revokeTitle", { name })} tabIndex={-1}>
        <h3>{t(review.mode === "trust" ? "title" : "revokeTitle", { name })}</h3>
        {review.mode === "trust" ? <><PhoneAuthorizationChoice value={selection} onChange={setSelection} disabled={busy || changed} />
          <p className="phone-access-hint">{auth("existingOff")}</p>
        </> : <><p>{t("revokeHint")}</p><ul>
          {changes.some(change => change.scopeKind === "catalog") && <li>{t("catalog")}</li>}
          {[...new Set(changes.filter(change => change.scopeKind === "vault").map(change => change.scopeId))].map(scopeId => <li key={scopeId} title={scopeId}>{scopeLabel(scopeId)}</li>)}
        </ul></>}
        {changed ? <p className="phone-error" role="alert">{t("changed")}</p> : state.grantErrors[deviceId + ":batch"] ? <p className="phone-error" role="alert">{t("failed")}</p> : null}
        <div className="phone-access-actions"><button type="button" data-modal-initial-focus className="settings-btn" disabled={busy} onClick={close}>{t("cancel")}</button>
          <button type="button" className="settings-btn settings-btn-primary" disabled={busy || changed || (review.mode === "trust" ? !selection : !changes.length)} onClick={() => void confirm()}>{review.mode === "trust" ? auth(selection === "trusted" ? "confirmTrusted" : selection === "manual" ? "confirmManual" : "confirm") : t("revokeConfirm")}</button></div>
      </div></div>, document.querySelector(".react-nav-shell") || document.body)}
  </div>;
}
