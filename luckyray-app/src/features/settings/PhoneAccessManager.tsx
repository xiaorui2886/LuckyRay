import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { companionTrustChanges, type CompanionTrustSelection } from "../../core/services/companionAccess";
import type { CompanionServiceGrantState } from "../../core/services/companionGateway";
import { companionDeviceDisplayLabel, type CompanionPresentationStore } from "../../core/services/companionPresentationStore";
import { useCompanionSnapshot } from "./CompanionPresentation";
import "./phoneAccessManager.css";

const COPY = defineMessages({
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
  const { t } = useMessages(COPY), state = useCompanionSnapshot(store);
  const [review, setReview] = useState<Review | null>(null);
  const [selection, setSelection] = useState<CompanionTrustSelection>({ catalog: true, vault: true, catalogWrite: false, vaultWrite: false });
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
    setSelection({ catalog: true, vault: Boolean(services.currentVault), catalogWrite: false, vaultWrite: false });
    setReview({ mode, snapshot: structuredClone(services), scopeId });
  };
  const changed = Boolean(review && (review.snapshot.permissionRevision !== services.permissionRevision || review.snapshot.currentVault?.vaultId !== services.currentVault?.vaultId));
  const changes = !review ? [] : review.mode === "trust" ? companionTrustChanges(review.snapshot, selection)
    : review.snapshot.grants.filter(grant => !review.scopeId || grant.scopeKind === "vault" && grant.scopeId === review.scopeId).map(grant => ({ ...grant, enabled: false }));
  const scopeLabel = (scopeId: string) => scopeId === review?.snapshot.currentVault?.vaultId
    ? t("vault", { name: review.snapshot.currentVault.label }) : t("savedVault", { id: scopeId.replace(/^vault-/, "").slice(0, 12) });
  const confirm = async () => { if (!review || changed || busy) return; if (await store.applyServiceChanges(deviceId, changes, review.snapshot)) setReview(null); };
  const check = (key: keyof CompanionTrustSelection, label: string, disabled = false) => <label className="phone-access-choice">
    <input type="checkbox" checked={selection[key]} disabled={busy || changed || disabled} onChange={event => setSelection(current => ({ ...current, [key]: event.target.checked }))} />
    <span>{label}</span></label>;
  return <div className="phone-access-manager">
    <p className="phone-access-hint">{t("remember")}</p>
    <div className="phone-access-actions"><button type="button" className="settings-btn settings-btn-primary" disabled={busy || !state.status} onClick={() => open("trust")}>{t("trust")}</button>
      <button type="button" className="settings-btn" disabled={busy || !services.grants.length} onClick={() => open("revoke")}>{t("revokeAll")}</button></div>
    {otherVaults.length > 0 && <details className="phone-access-saved"><summary>{t("saved")} · {otherVaults.length}</summary><p>{t("savedHint")}</p>
      {otherVaults.map(scopeId => <div key={scopeId}><span title={scopeId}>{t("savedVault", { id: scopeId.replace(/^vault-/, "").slice(0, 12) })}</span>
        <button type="button" className="phone-link" disabled={busy} onClick={() => open("revoke", scopeId)}>{t("revokeScope")}</button></div>)}</details>}
    {review && createPortal(<div className="phone-access-backdrop experience-dialog-backdrop" onPointerDown={modal.onBackdropPointerDown}>
      <div ref={modal.surfaceRef} onKeyDown={modal.onSurfaceKeyDown} className="phone-access-dialog experience-dialog" role="dialog" aria-modal="true" aria-label={t(review.mode === "trust" ? "title" : "revokeTitle", { name })} tabIndex={-1}>
        <h3>{t(review.mode === "trust" ? "title" : "revokeTitle", { name })}</h3>
        {review.mode === "trust" ? <><h4>{t("scope")}</h4>{check("catalog", t("catalog"))}
          {review.snapshot.currentVault && check("vault", t("vault", { name: review.snapshot.currentVault.label }))}
          <p>{t("common")}</p><h4>{t("extra")}</h4>
          {check("catalogWrite", t("catalogWrite"), !selection.catalog)}
          {review.snapshot.currentVault && check("vaultWrite", t("vaultWrite"), !selection.vault)}
          <p className="phone-access-hint">{t("boundary")}</p>
          {!changes.length && (selection.catalog || selection.vault && review.snapshot.currentVault) && <p role="status">{t("nothing")}</p>}
        </> : <><p>{t("revokeHint")}</p><ul>
          {changes.some(change => change.scopeKind === "catalog") && <li>{t("catalog")}</li>}
          {[...new Set(changes.filter(change => change.scopeKind === "vault").map(change => change.scopeId))].map(scopeId => <li key={scopeId} title={scopeId}>{scopeLabel(scopeId)}</li>)}
        </ul></>}
        {changed ? <p className="phone-error" role="alert">{t("changed")}</p> : state.grantErrors[deviceId + ":batch"] ? <p className="phone-error" role="alert">{t("failed")}</p> : null}
        <div className="phone-access-actions"><button type="button" data-modal-initial-focus className="settings-btn" disabled={busy} onClick={close}>{t("cancel")}</button>
          <button type="button" className="settings-btn settings-btn-primary" disabled={busy || changed || !changes.length} onClick={() => void confirm()}>{t(review.mode === "trust" ? "confirm" : "revokeConfirm")}</button></div>
      </div></div>, document.querySelector(".react-nav-shell") || document.body)}
  </div>;
}
