import {useApplicationModalSurface} from "../../app/applicationModalIsolation";
import {communityMatchesStatus,type CommunityStatusFilter} from "./CommunityPresentation";
import {pageVisibleInSidebar,writeSidebarPref,pageKey} from "./pluginPages";
import {useEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {confirm} from '@tauri-apps/plugin-dialog';
import {extensionPackages,type InstalledPackage,type DesktopResource} from '../../core/extensions/packages';
import {desktopStatus,desktopNeedsRestart} from '../../core/extensions/desktop/runtime';
import {desktopViews,desktopRenderers,panels,closeDesktopView,contributionSnapshot,subscribeContributions,menuEntries,type Dispose} from '../../core/extensions/desktop/contributions';
import {currentDesktopEditor} from '../../core/extensions/desktop/editorRegistry';
import './desktopExtensions.css';
export function useDesktopContributions(){return useSyncExternalStore(subscribeContributions,contributionSnapshot,contributionSnapshot);}
export function DesktopViewHost({viewKey}:{viewKey:string}){
 const revision=useDesktopContributions();const container=useRef<HTMLDivElement>(null);const [error,setError]=useState('');
 const definition=desktopViews.get(viewKey);
 useEffect(()=>{
  const host=container.current;if(!host||!definition)return;let live=true;let dispose:Dispose|void;setError('');const el=document.createElement('div');el.className='desktop-extension-mount';host.replaceChildren(el);
  Promise.resolve().then(()=>live?definition.mount(el):undefined).then(result=>{if(!live){result?.();el.remove();return;}dispose=result;}).catch(error=>{if(live)setError(error instanceof Error?error.message:String(error));});
  return()=>{live=false;try{dispose?.();}catch(error){console.error("[desktop-extension] view cleanup",error);}finally{el.remove();}};
 },[definition,viewKey]);
 void revision;
 return <section className="desktop-extension-view">{!definition&&<p role="status">扩展尚未就绪或已停用。</p>}{error&&<p role="alert">扩展页面未能打开：{error}</p>}<div ref={container} className="desktop-extension-content"/></section>;
}
function DesktopPanel({panel}:{panel:{key:string;placement:'left'|'right'|'modal'}}){
 const close=()=>closeDesktopView(panel.key);const modal=panel.placement==='modal';
 const surface=useApplicationModalSurface<HTMLElement>(modal,close);
 return <aside ref={surface.surfaceRef} tabIndex={-1} className={`desktop-extension-panel desktop-extension-panel--${panel.placement}`} role={modal?'dialog':'complementary'} aria-modal={modal||undefined} aria-label={desktopViews.get(panel.key)?.title} onKeyDown={event=>{if(modal)surface.onSurfaceKeyDown(event);else if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();close();}}}>
 <header><strong>{desktopViews.get(panel.key)?.title}</strong><button type="button" aria-label="关闭扩展面板" onClick={close}>×</button></header><DesktopViewHost viewKey={panel.key}/></aside>;
}
export function DesktopPanels(){useDesktopContributions();return <>{panels.map(panel=><DesktopPanel key={panel.key} panel={panel}/>)}</>;}
export function DesktopCodeBlock({language,source,noteId,fallback}:{language:string;source:string;noteId:string|null;fallback:ReactNode}){
 useDesktopContributions();const renderer=desktopRenderers.get(language);const ref=useRef<HTMLDivElement>(null);const [failed,setFailed]=useState(false);
 useEffect(()=>{setFailed(false);const el=ref.current;if(!renderer||!el)return;let dispose:Dispose|void;try{dispose=renderer(el,source,{noteId,language});}catch{setFailed(true);}return()=>{try{dispose?.();}catch(error){console.error("[desktop-extension] renderer cleanup",error);}finally{el.replaceChildren();}};},[renderer,source,noteId,language]);
 return <><div ref={ref} hidden={!renderer||failed} className="desktop-extension-code"/>{(!renderer||failed)&&fallback}</>;
}
export function DesktopMenuItems({target,context,onClose}:{target:'editor'|'materials';context?:unknown;onClose:()=>void}){
 useDesktopContributions();const actual=context??currentDesktopEditor();const items=menuEntries(target,actual);if(!items.length)return null;
 return <div className="desktop-extension-menu" role="group" aria-label="社区扩展">{items.map(item=><button type="button" role="menuitem" data-material-context-level={target==="materials"?"main":undefined} key={item.id} onClick={()=>{onClose();Promise.resolve().then(()=>item.run(actual)).catch(console.error);}}>{item.label}</button>)}</div>;
}
export function DesktopPackagesPanel({search='',statusFilter='all'}:{search?:string;statusFilter?:CommunityStatusFilter}){
 const [state,setState]=useState(()=>extensionPackages.snapshot());const [busy,setBusy]=useState(false);const busyRef=useRef(false);const [error,setError]=useState('');const [reload,setReload]=useState(false);const [,setTick]=useState(0);useDesktopContributions();
 useEffect(()=>extensionPackages.subscribe(()=>setState(extensionPackages.snapshot())),[]);
 const run=async(fn:()=>Promise<void>)=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{busyRef.current=false;setBusy(false);}};
 const fresh=async(entry:InstalledPackage)=>{const s=await extensionPackages.refresh();const e=s.packages.find(p=>p.package.manifest.id===entry.package.manifest.id);if(!e||e.digest!==entry.digest)throw Error('扩展已变化，请重新选择。');return s;};
 const toggle=(entry:InstalledPackage)=>run(async()=>{
  let s=await fresh(entry);const id=entry.package.manifest.id;
  if(entry.enabled){await extensionPackages.disable(id,s.revision);setReload(true);return;}
  const message=`信任并启用“${entry.package.manifest.name}”？\n\n完整桌面扩展可运行自定义界面和后台代码，访问资料、联网、运行本机程序、调用已配置的模型（可能产生费用），并影响软件行为。它与应用拥有相同信任级别，不是受限沙箱。请仅启用你信任的来源。\n\n每次更新需重新信任。停用会清理标准接口注册的资源；彻底结束未知代码需要保存工作后重启软件。`;
  const approved='__TAURI_INTERNALS__' in window?await confirm(message,{title:'信任完整扩展',kind:'warning'}):window.confirm(message);
  if(!approved)return;s=await fresh(entry);s=await extensionPackages.grant(id,['desktop.fullTrust'],s.revision);await extensionPackages.enable(id,s.revision);
 });
 const remove=(entry:InstalledPackage)=>run(async()=>{const s=await fresh(entry);await extensionPackages.uninstall(entry.package.manifest.id,s.revision);if(entry.enabled)setReload(true);});
 const packages=state.packages.filter(p=>p.package.manifest.type==='desktop'&&communityMatchesStatus(p.enabled,statusFilter)&&`${p.package.manifest.name} ${p.package.manifest.id}`.toLowerCase().includes(search.toLowerCase()));
 if(!packages.length&&!reload&&!desktopNeedsRestart())return null;
 return <section className="desktop-extension-packages"><header><h3>完整扩展</h3></header>{error&&<p role="alert">{error}</p>}{(reload||desktopNeedsRestart())&&<p role="status">扩展已停用。请先保存工作，再正常退出并重开软件，以彻底结束第三方代码。</p>}
 {packages.map(entry=>{const m=entry.package.manifest;const s=desktopStatus(m.id);return <article key={m.id}><div><strong>{m.name}</strong><small>v{m.version} · {entry.enabled?(s?.state==='failed'?'启动失败':s?.state==='active'?'已启用':'正在启动'):'已停用'}</small>{s?.state==='failed'&&<p role="alert">{s.message}</p>}</div><div className="desktop-extension-actions">{entry.enabled&&(entry.package.resource as DesktopResource).contributions.filter(c=>c.kind==='page'||c.kind==='settings').map(c=><span key={c.id}><button disabled={busy||s?.state!=='active'} onClick={()=>{window.location.hash=`#plugins/${encodeURIComponent(m.id)}/${encodeURIComponent(c.id)}`;}}>{c.label}</button>{c.kind==='page'&&<label><input type="checkbox" aria-label={`在导航栏显示${c.label}`} checked={pageVisibleInSidebar(pageKey(m.id,c.id))} onChange={e=>{writeSidebarPref(pageKey(m.id,c.id),e.target.checked);setTick(t=>t+1);}}/>导航栏</label>}</span>)}<button disabled={busy} onClick={()=>void toggle(entry)}>{entry.enabled?'停用':'信任并启用'}</button><button disabled={busy} onClick={()=>void remove(entry)}>卸载</button></div></article>;})}</section>;
}
