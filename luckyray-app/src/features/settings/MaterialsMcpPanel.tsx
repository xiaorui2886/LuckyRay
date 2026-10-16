import { useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { defineMessages, useMessages } from "../../core/i18n/index";
import MaterialsMcpClient from "./MaterialsMcpClient";

const messages = defineMessages({
  title: { "zh-CN":"素材 MCP 授权", "en-US":"Materials MCP access" },
  scope: { "zh-CN":"仅允许搜索、读取素材信息、列出分类和导入公网文件。绑定所选素材库，不跟随界面切库；不授予 Agent、终端、笔记或任意文件访问权限。有效期 30 天，可随时在此撤销。", "en-US":"Search and read asset metadata, list folders, and import public files only. Bound to the selected library, not the active UI library. No Agent, terminal, notes, or arbitrary file access. Expires in 30 days; revoke here anytime." },
  client: { "zh-CN":"客户端名称", "en-US":"Client name" },
  library: { "zh-CN":"授权素材库", "en-US":"Authorized library" },
  choose: { "zh-CN":"请选择素材库", "en-US":"Select a library" },
  review: { "zh-CN":"审阅并配对…", "en-US":"Review pairing…" },
  consent: { "zh-CN":"我确认向此客户端授予上面所列的访问权限", "en-US":"I authorize this client for the access listed above" },
  confirm: { "zh-CN":"确认创建授权", "en-US":"Confirm authorization" },
  cancel: { "zh-CN":"取消", "en-US":"Cancel" },
  revoke: { "zh-CN":"撤销", "en-US":"Revoke" },
  empty: { "zh-CN":"尚无素材专用授权。", "en-US":"No dedicated materials clients authorized." },
  secret: { "zh-CN":"配对信息仅显示这一次，包含访问凭据。仅交给你信任的素材 MCP 客户端，不要发到聊天或日志。桌面更新不会自动配置 Gateway。", "en-US":"Pairing data is shown once and contains a credential. Give it only to your trusted materials MCP client, never chats or logs. Updating the desktop does not configure a Gateway." },
  hide: { "zh-CN":"已保存，隐藏配对信息", "en-US":"Saved; hide pairing data" },
  error: { "zh-CN":"操作未完成，请核对当前实例和素材库后重试。未显示成功前不要重复创建授权。", "en-US":"The operation did not complete. Check this instance and library. Do not create another grant until you verify the result." },
  refresh: { "zh-CN":"刷新授权列表", "en-US":"Refresh authorizations" },
});
type Grant = { id: string; clientName: string; libraryId: string; expiresAt: number };
type Context = { baseUrl: string; executable: string; profileRoot: string; libraries: {id:string;name:string}[]; grants: Grant[] };

export default function MaterialsMcpPanel() {
  return <><MaterialsMcpClient /><details><summary>高级手动配对 / Advanced manual pairing</summary><AdvancedMaterialsMcpPanel /></details></>;
}
function AdvancedMaterialsMcpPanel() {
  const { t } = useMessages(messages);
  const id = useId();
  const [context, setContext] = useState<Context|null>(null);
  const [name, setName] = useState("");
  const [libraryId, setLibraryId] = useState("");
  const [review, setReview] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const [pairing, setPairing] = useState("");
  const refresh = useCallback(async () => {
    const value = await invoke<Context>("materials_mcp_pairing_context");
    setContext(value);
    return value;
  }, []);
  useEffect(() => { void refresh().catch(() => setFailed(true)); }, [refresh]);
  const action = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setFailed(false);
    try { await work(); } catch { setFailed(true); } finally { busyRef.current = false; setBusy(false); }
  };
  const create = () => action(async () => {
    if (!review || !consent || !context?.libraries.some(l => l.id === libraryId)) return;
    const result = await invoke("materials_mcp_confirm_pairing", {clientName:name, libraryId, confirmed:true});
    setPairing(JSON.stringify(result, null, 2));
    setReview(false); setConsent(false);
    await refresh();
  });
  return <section className="setting-group" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t("title")}</h3>
    <p className="settings-muted-text">{t("scope")}</p>
    {context && <p className="settings-muted-text" style={{overflowWrap:"anywhere"}}>
      {context.baseUrl}<br/>{context.executable}<br/>{context.profileRoot}
    </p>}
    <div className="settings-control-stack" style={{flexDirection:"column",alignItems:"stretch",minWidth:0}}>
      <label htmlFor={`${id}-client`}>{t("client")}</label>
      <input id={`${id}-client`} className="settings-input" value={name} maxLength={60}
        disabled={busy || review || !!pairing} onChange={e => setName(e.target.value)}/>
      <label htmlFor={`${id}-library`}>{t("library")}</label>
      <select id={`${id}-library`} className="settings-input" value={libraryId}
        disabled={busy || review || !!pairing} onChange={e => setLibraryId(e.target.value)}>
        <option value="">{t("choose")}</option>
        {context?.libraries.map(l => <option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
      </select>
      {!review && !pairing && <button type="button" className="settings-btn" disabled={busy || !context || !name.trim() || new TextEncoder().encode(name.trim()).length > 120 || !libraryId}
        onClick={() => {setConsent(false);setReview(true);}}>{t("review")}</button>}
      {review && <div role="group" aria-label={t("confirm")}>
        <label><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)}/>{t("consent")}</label>
        <div className="settings-action-row">
          <button type="button" className="settings-btn settings-btn-primary" disabled={busy || !consent} onClick={() => void create()}>{t("confirm")}</button>
          <button type="button" className="settings-btn" disabled={busy} onClick={() => {setReview(false);setConsent(false);}}>{t("cancel")}</button>
        </div>
      </div>}
      {pairing && <div>
        <p>{t("secret")}</p>
        <textarea className="settings-input" aria-label={t("secret")} readOnly rows={8} value={pairing}
          spellCheck={false} style={{width:"100%",boxSizing:"border-box"}}/>
        <button type="button" className="settings-btn" onClick={() => setPairing("")}>{t("hide")}</button>
      </div>}
      {failed && <p role="alert">{t("error")}</p>}
      <button type="button" className="settings-btn" disabled={busy} onClick={() => void action(async () => {await refresh();})}>{t("refresh")}</button>
      {context?.grants.length === 0 && <p>{t("empty")}</p>}
      {context?.grants.map(grant => <div key={grant.id} className="settings-action-row" style={{flexWrap:"wrap"}}>
        <span style={{overflowWrap:"anywhere"}}>{grant.clientName} · {grant.libraryId} · {new Date(grant.expiresAt*1000).toLocaleString()}</span>
        <button type="button" className="settings-btn" disabled={busy} onClick={() => void action(async () => {
          await invoke("materials_mcp_revoke_pairing", {clientId:grant.id});
          setPairing(""); await refresh();
        })}>{t("revoke")}</button>
      </div>)}
    </div>
  </section>;
}
