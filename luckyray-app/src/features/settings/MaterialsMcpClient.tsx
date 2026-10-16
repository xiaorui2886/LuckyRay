import {useCallback, useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {defineMessages, useMessages} from "../../core/i18n/index";

const messages=defineMessages({
 title:{"zh-CN":"连接 AI 客户端","en-US":"Connect an AI client"},
 intro:{"zh-CN":"让本机 AI 客户端搜索素材、查看素材信息、读取文件夹及导入公网文件。无需命令、配对码或额外终端窗口。","en-US":"Let a local AI client search assets, inspect metadata, list folders and import public files. No commands, pairing codes or extra terminal windows."},
 client:{"zh-CN":"客户端","en-US":"Client"},library:{"zh-CN":"允许访问的素材库","en-US":"Authorized library"},choose:{"zh-CN":"选择素材库","en-US":"Choose a library"},
 support:{"zh-CN":"当前支持 Windows 本机 Codex（标准用户配置）。网页 ChatGPT、远程执行及其他客户端暂不支持此自动接入。","en-US":"Supports local Codex on Windows with standard user configuration. ChatGPT web, remote execution and other clients are not supported by this installer."},
 review:{"zh-CN":"查看连接设置","en-US":"Review connection"},
 permission:{"zh-CN":"授权固定绑定此素材库，有效期 30 天；切换当前素材库不会改变授权。权限仅限素材搜索、信息查询、文件夹读取和公网文件导入，不包括笔记、终端、Agent 或任意文件读取。可随时在此撤销。","en-US":"Access is fixed to this library for 30 days, regardless of the active library. Only asset search, metadata, folder listing and public file import are allowed. No notes, terminal, Agent or arbitrary file reads. Revoke here anytime."},
 change:{"zh-CN":"将向以下 Codex 配置新增一个 LuckyRay 条目。保留其他设置和私有回退副本；撤销时只移除此条目。访问凭据仅在本机以 Windows 用户加密保存，不写入客户端配置或剪贴板。","en-US":"Adds one LuckyRay entry to the Codex configuration below. Other settings and a private rollback copy are preserved. Disconnect removes only this entry. Windows encrypts the credential for this user; it is never put in client configuration or the clipboard."},
 consent:{"zh-CN":"我同意上述权限，并允许新增这项客户端连接配置","en-US":"I approve this access and the client configuration change"},
 confirm:{"zh-CN":"授权并连接","en-US":"Authorize and connect"},cancel:{"zh-CN":"取消","en-US":"Cancel"},
 busy:{"zh-CN":"正在处理…","en-US":"Working…"},
 configured:{"zh-CN":"客户端配置已保存","en-US":"Client configuration saved"},
 incomplete:{"zh-CN":"连接配置未完成，请撤销此连接后重新设置","en-US":"Connection setup incomplete; remove this connection and try again"},
 loaded:{"zh-CN":"先在 Codex 中请求“检查 LuckyRay 素材连接并搜索图片”。客户端可能已经自动加载；设置列表中未显示下方标识，不代表连接失败。只有提示工具不可用时，再重新打开 Codex 后重试，无需重复授权。此处的桌面接口检查不代表客户端已加载。","en-US":"First ask Codex to check the LuckyRay materials connection and search images. It may already have loaded automatically; an absent entry in Settings does not mean the connection failed. Only if the tool is unavailable, reopen Codex and retry without authorizing again. This desktop check alone does not confirm client loading."},
 test:{"zh-CN":"重新检查连接","en-US":"Check connection again"},
 ready:{"zh-CN":"桌面身份和素材接口验证通过；等待客户端使用","en-US":"Desktop identity and materials transport verified; awaiting client use"},
 revoke:{"zh-CN":"撤销授权并移除连接","en-US":"Revoke and remove connection"},
 revoked:{"zh-CN":"授权已撤销，客户端配置已移除","en-US":"Authorization revoked and client entry removed"},
 refresh:{"zh-CN":"重新检查","en-US":"Check again"},
 expires:{"zh-CN":"到期时间","en-US":"Expires"},
 example:{"zh-CN":"连接后可让客户端“搜索授权素材库里的图片”，或“将指定公网文件导入授权素材库并回查结果”。导入仍须遵守客户端自己的操作确认。","en-US":"Ask your client to search images in the authorized library, or import a public file and inspect the result. Imports remain subject to the client's own confirmations."},
 advanced:{"zh-CN":"实例信息（核对目标）","en-US":"Instance identity"},
 expired:{"zh-CN":"授权已到期。先移除此连接，再重新选择素材库并确认授权。","en-US":"Authorization expired. Remove this connection, then select a library and authorize again."},
 denied:{"zh-CN":"授权不可用或已撤销。移除此连接后重新授权；不会自动恢复旧授权。","en-US":"Authorization is unavailable or revoked. Remove the connection and authorize again; old grants are never silently restored."},
 stopped:{"zh-CN":"目标 LuckyRay 尚未就绪。保持对应桌面实例开启，再测试连接。","en-US":"The target LuckyRay is not ready. Keep that desktop instance open and test again."},
 mismatch:{"zh-CN":"无法验证目标实例或原数据目录。请使用授权时的 LuckyRay 实例；不会尝试其他实例或数据目录。","en-US":"The target instance or original profile cannot be verified. Use the authorized LuckyRay instance; other instances and profiles will not be tried."},
 changed:{"zh-CN":"客户端配置已有变动，未覆盖。请重新检查并审阅；若已撤销，需在 Codex 中移除对应条目。","en-US":"Client configuration changed and was preserved. Check and review again. If revoked, remove the matching entry in Codex."},
 runtime:{"zh-CN":"应用的素材连接组件缺失或完整性检查失败。请使用包含此功能的完整 LuckyRay 候选版本。","en-US":"The bundled connector is missing or failed integrity checks. Use the complete LuckyRay candidate with this feature."},
 failed:{"zh-CN":"连接操作未完成。请重新检查；已有授权可在下方高级授权管理中查看或撤销。","en-US":"Connection did not complete. Check again; existing grants can be reviewed or revoked under advanced authorization below."},
 unsupported:{"zh-CN":"当前客户端配置形式或桌面接口版本不受支持，已保留原配置。","en-US":"This client configuration shape or desktop interface version is unsupported. Original settings were preserved."},
 checkFailed:{"zh-CN":"连接检查失败或超时。保持 LuckyRay 开启，然后重试。","en-US":"Connection check failed or timed out. Keep LuckyRay open and retry."},
});
type Binding={clientId:string;libraryId:string;expiresAt:number;client:string;configPath:string;serverKey:string};
type Plan={client:string;configPath:string;configHash:string;serverKey:string;runtimeReady:boolean;binding:Binding|null;configPresent:boolean};
type Context={executable:string;profileRoot:string;libraries:{id:string;name:string}[]};
export default function MaterialsMcpClient(){
 const {t}=useMessages(messages);
 const [plan,setPlan]=useState<Plan|null>(null),[context,setContext]=useState<Context|null>(null);
 const [library,setLibrary]=useState(""),[review,setReview]=useState(false),[consent,setConsent]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState<""|"ready"|"revoked">("");
 const lock=useRef(false);
 const refresh=useCallback(async()=>{
  const c=await invoke<Context>("materials_mcp_pairing_context");setContext(c);
  const p=await invoke<Plan>("materials_mcp_client_prepare");setPlan(p);
 },[]);
 const act=async(work:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError("");try{await work();}catch(e){setError(typeof e==="string"?e:"operation-failed");setStatus("");}finally{lock.current=false;setBusy(false);}};
 useEffect(()=>{void act(refresh);},[refresh]);
 const errorKey=error==="pairing-expired"?"expired":/revoked|not-authorized|authorization-unavailable/.test(error)?"denied":/target-not-running|port-not-ready/.test(error)?"stopped":/instance|profile|target-ambiguous|target-changed|pairing-binding/.test(error)?"mismatch":/config-changed|config-busy|entry-exists|config-edited/.test(error)?"changed":/runtime/.test(error)?"runtime":/unsupported|config-invalid/.test(error)?"unsupported":/check|timeout|disconnected/.test(error)?"checkFailed":"failed";
 return <section className="setting-group" aria-labelledby="materials-mcp-gui-title">
  <h3 id="materials-mcp-gui-title">{t("title")}</h3><p className="settings-muted-text">{t("intro")}</p>
  <div className="settings-control-stack" style={{flexDirection:"column",alignItems:"stretch",gap:12,minWidth:0}}>
   <label>{t("client")}<select className="settings-input" value="codex" disabled={busy||review||!!plan?.binding} onChange={()=>{}}><option value="codex">Codex · Windows</option></select></label>
   <p className="settings-muted-text">{t("support")}</p>
   {!plan?.binding && <>
    <label>{t("library")}<select className="settings-input" value={library} disabled={busy||review} onChange={e=>{setLibrary(e.target.value);setStatus("");}}>
     <option value="">{t("choose")}</option>{context?.libraries.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
    </select></label>
    {!review && <button className="settings-btn settings-btn-primary" disabled={busy||!library||!plan} onClick={()=>void act(async()=>{await refresh();setStatus("");setConsent(false);setReview(true);})}>{t("review")}</button>}
    {review && plan && <div role="group" aria-label={t("confirm")} style={{padding:16,border:"1px solid var(--border-color, #333)",borderRadius:10}}>
     <strong>Codex · {context?.libraries.find(l=>l.id===library)?.name}</strong><p>{t("permission")}</p><p>{t("change")}</p>
     <p style={{overflowWrap:"anywhere"}}>{plan.configPath}<br/>{plan.serverKey}</p>
     <details><summary>{t("advanced")}</summary><p style={{overflowWrap:"anywhere"}}>{context?.executable}<br/>{context?.profileRoot}</p></details>
     <label style={{display:"flex",gap:8,margin:"16px 0"}}><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>{t("consent")}</label>
     <div className="settings-action-row"><button className="settings-btn settings-btn-primary" disabled={busy||!consent} onClick={()=>void act(async()=>{
      if(!consent||!review)return;
      await invoke("materials_mcp_client_connect",{libraryId:library,configHash:plan.configHash,confirmed:true});
      setReview(false);setConsent(false);setStatus("");await refresh();
      const checked=await invoke<{desktopReady:boolean}>("materials_mcp_client_test");
      if(!checked.desktopReady)throw "client-check-failed";setStatus("ready");
     })}>{busy?t("busy"):t("confirm")}</button><button className="settings-btn" disabled={busy} onClick={()=>{setReview(false);setConsent(false);}}>{t("cancel")}</button></div>
    </div>}
   </>}
   {plan?.binding && <div style={{padding:16,border:"1px solid var(--border-color, #333)",borderRadius:10}}>
    <strong>{t(plan.configPresent?"configured":"incomplete")}</strong><p>{context?.libraries.find(l=>l.id===plan.binding?.libraryId)?.name??plan.binding.libraryId} · {t("expires")} {new Date(plan.binding.expiresAt*1000).toLocaleString()}</p>
    <p>{t("loaded")}</p><code>{plan.serverKey}</code><p>{t("example")}</p>
    <div className="settings-action-row"><button className="settings-btn settings-btn-primary" disabled={busy} onClick={()=>void act(async()=>{const s=await invoke<{desktopReady:boolean}>("materials_mcp_client_test");if(!s.desktopReady)throw "client-check-failed";setStatus("ready");})}>{busy?t("busy"):t("test")}</button>
     <button className="settings-btn" disabled={busy} onClick={()=>void act(async()=>{await invoke("materials_mcp_client_disconnect");setStatus("revoked");await refresh();})}>{t("revoke")}</button></div>
   </div>}
   {status && <p role="status">{t(status)}</p>}
   {error && <div role="alert"><p>{t(errorKey)}</p><small>{error}</small></div>}
   <button className="settings-btn" disabled={busy} onClick={()=>void act(async()=>{setReview(false);setConsent(false);await refresh();})}>{t("refresh")}</button>
  </div>
 </section>;
}
