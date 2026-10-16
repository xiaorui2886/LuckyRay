import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {listen} from '@tauri-apps/api/event';
import {I18nProvider} from '../core/i18n/index';
import {useSavedLocale} from '../features/settings/useSettings';
import {LayoutStore} from './layoutStore';
import {WorkspaceHost} from './WorkspaceHost';
import {DocumentSession,DocumentSessions} from './documentSession';
import {WorkspaceNoteView} from './NoteView';
import {workspaceCommand,noteTransport,viewRefFromGrant,type NativeWindowSession} from './nativeClient';
import {groups,reduceLayout,type ViewRef} from './layout';
import {registerWorkspaceFlush,installWorkspaceLifecycle,workspaceCompositionActive} from './windowLifecycle';
import type {MergeOffer} from './mergeReceiver';
import {trackWorkspaceWindowPlacement} from './nativeWindowPlacement';
import {ToolRegistry,WorkspaceToolsContext} from './toolRegistry';
import {ToolDeck} from './ToolDeck';
import {emptyTools,moveTool,toolNames,type ToolKind} from './toolLayout';
import {LayoutLibrary} from './LayoutLibrary';
import {transferNativeNote} from './nativeTransfer';
import {WindowChooser} from './WindowChooser';
import {useWindowDrag} from './windowDrag';
import {IntegratedWorkspaceWindow} from './IntegratedWorkspaceWindow';

export default function WorkspaceWindow(){
 const locale=useSavedLocale();const [initial,setInitial]=useState<NativeWindowSession|null>(null);const [error,setError]=useState('');
 useEffect(()=>{void workspaceCommand<NativeWindowSession>({op:'bootstrap'}).then(setInitial).catch(error=>setError(String(error)));},[]);
 return <I18nProvider locale={locale}>{initial?(initial.integrated?<IntegratedWorkspaceWindow initial={initial}/>:<WorkspaceWindowContent initial={initial}/>):<div className="workspace-missing">{error||'正在打开工作区…'}</div>}</I18nProvider>;
}
export function WorkspaceWindowContent({initial,documentSession}:{initial:NativeWindowSession;documentSession?:DocumentSession}){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[layoutsOpen,setLayoutsOpen]=useState(false);
 const [windowChooser,setWindowChooser]=useState<ViewRef|null>(null);
 const element=useRef<HTMLDivElement>(null);const [tools]=useState(()=>new ToolRegistry());
 const {store,sessions,grants}=useMemo(()=>{
  const store=new LayoutStore(initial.label,localStorage),sessions=new DocumentSessions(),grants=new Map<string,ViewRef>();
  const entries=initial.views??[{view:initial.view,open:true}];
  for(const entry of entries){const view=viewRefFromGrant(entry.view);grants.set(view.id,view);if(entry.open&&!store.getSnapshot().views[view.id])store.dispatch({type:'open',view,groupId:store.getSnapshot().focusedGroup});}
  if(documentSession)sessions.seed({libraryId:initial.view.libraryId,resourceId:initial.view.resourceId!},documentSession);
  return {store,sessions,grants};
 },[initial,documentSession]);
 const layout=useSyncExternalStore(store.subscribe,store.getSnapshot);
 const sessionFor=(view:ViewRef)=>sessions.get({libraryId:view.library.id,resourceId:view.resourceId!},()=>noteTransport(view,true));
 const publishOpen=()=>workspaceCommand({op:'setOpenViews',ids:Object.keys(store.getSnapshot().views).filter(id=>grants.has(id)),known:store.retainedViews().map(view=>view.id).filter(id=>grants.has(id))});
 const clean=async()=>{if(!await sessions.flushAll())return false;await Promise.all([...grants.keys()].map(viewId=>workspaceCommand({op:'dirty',viewId,dirty:false})));return true;};
 useEffect(()=>{let disposed=false;let stop:(()=>void)|undefined;void trackWorkspaceWindowPlacement(viewRefFromGrant(initial.view),setError).then(cleanup=>{if(disposed)cleanup();else stop=cleanup;}).catch(error=>setError('窗口位置恢复失败：'+String(error)));return()=>{disposed=true;stop?.();};},[initial]);
 useEffect(()=>{
  let disposed=false;const stops:(()=>void)[]=[];const subscriptions=new Map<string,()=>void>();let updating=Promise.resolve();
  const local={target:{kind:'WebviewWindow' as const,label:getCurrentWindow().label}};
  const watch=()=>{
   for(const view of store.retainedViews()){
    if(!grants.has(view.id)||subscriptions.has(view.id))continue;const session=sessionFor(view);
    let dirty:boolean|undefined;const publish=()=>{const next=session.getSnapshot().dirty;if(next===dirty)return;dirty=next;void workspaceCommand({op:'dirty',viewId:view.id,dirty:next}).catch(error=>setError(String(error)));};
    subscriptions.set(view.id,session.subscribe(publish));publish();
   }
   updating=updating.then(async()=>{if(!disposed)await publishOpen();}).catch(error=>setError(String(error)));
  };
  const receive=async(activateId?:string)=>{
   const native=await workspaceCommand<NativeWindowSession>({op:'bootstrap'});if(disposed)return;
   let next=store.getSnapshot();
   for(const entry of native.views??[{view:native.view,open:true}]){const view=viewRefFromGrant(entry.view);grants.set(view.id,view);if(entry.open&&!next.views[view.id])next=reduceLayout(next,{type:'open',view,groupId:next.focusedGroup});}
   if(activateId&&next.views[activateId])next=reduceLayout(next,{type:'activate',viewId:activateId});
   if(next!==store.getSnapshot())store.restore(next);watch();
  };
  const attach=async()=>{
   await installWorkspaceLifecycle();
   const changed=await listen('luckyray:workspace-note-changed',()=>{for(const view of store.retainedViews())if(grants.has(view.id))void sessionFor(view).refresh();},local);
   const views=await listen<{viewId?:string}>('luckyray:workspace-views-changed',event=>{void receive(event.payload?.viewId).catch(error=>setError(String(error)));},local);
   const close=await listen('luckyray:workspace-close-requested',async()=>{
    if(workspaceCompositionActive()){setError('请先完成当前输入法文字，再关闭窗口。');return;}
    if(await clean())await workspaceCommand({op:'close',label:null});else setError('未保存的输入仍在此窗口，请先处理保存或版本冲突。');
   },local);
   if(disposed){changed();views();close();return;}stops.push(changed,views,close);await receive();
  };
  stops.push(registerWorkspaceFlush(clean),store.subscribe(watch));watch();void attach().catch(error=>setError(String(error)));
  return()=>{disposed=true;for(const stop of stops)stop();for(const stop of subscriptions.values())stop();};
 },[store,sessions,grants]);
 const releaseView=async(view:ViewRef)=>{
  if(Object.keys(store.getSnapshot().views).length===1){if(!await clean())throw Error('窗口仍有未保存的输入，原标签已保留。');await workspaceCommand({op:'close',label:null});return;}
  store.dispatch({type:'close',viewId:view.id});await publishOpen();
 };
 const locked=async(action:()=>Promise<void>)=>{
  if(busy)return;if(workspaceCompositionActive()){setError('请先完成当前输入法文字，再移动窗口。');return;}
  const root=element.current,previous=root?.inert??false;if(root)root.inert=true;setBusy(true);setError('');
  try{await action();}catch(error){setError(String(error));}finally{if(root)root.inert=previous;setBusy(false);}
 };
 const activeId=groups(layout.root).find(group=>group.id===layout.focusedGroup)?.active;
 const merge=(selected?:ViewRef)=>locked(async()=>{
  if(!activeId&&!selected)return;const view=selected??store.getSnapshot().views[activeId!],session=sessionFor(view);let offer:MergeOffer|undefined;
  try{
   if(!await session.flush())throw Error('当前笔记尚未保存，请先处理版本冲突。');
   await workspaceCommand({op:'dirty',viewId:view.id,dirty:false});offer=await workspaceCommand<MergeOffer>({op:'offerToMain',viewId:view.id});
   for(let attempt=0;attempt<160;attempt++){const current=await workspaceCommand<MergeOffer>({op:'mergeStatus',id:offer.id});if(current.accepted){await releaseView(view);return;}await new Promise(resolve=>setTimeout(resolve,100));}
   throw Error('主窗口未确认接收，当前窗口和输入已保留。');
  }catch(error){if(offer)try{await workspaceCommand({op:'cancelMerge',id:offer.id});}catch{/* Never remove an accepted target. */}throw error;}
 });
 const windowDrag=useWindowDrag(store,(view,label)=>label==='main'?merge(view):locked(async()=>{const result=await transferNativeNote(view,sessionFor(view),true,()=>releaseView(view),label);if(!result.ok)throw Error(result.error);}),setError);
 return <div ref={element} className="workspace-window" aria-busy={busy}><div className="workspace-toolbar"><strong>工作区窗口</strong><button onClick={()=>void merge()} disabled={busy||!activeId}>合并到主窗口</button><button onClick={()=>setLayoutsOpen(true)}>命名布局</button><select aria-label="打开工具面板" value="" onChange={event=>{if(event.target.value)store.dispatch({type:'tools',tools:moveTool(layout.tools??emptyTools(),event.target.value as ToolKind,'right')});}}><option value="">工具面板…</option>{Object.entries(toolNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></div>
  {error&&<div role="alert" className="workspace-conflict">{error}<button onClick={()=>setError('')}>关闭提示</button></div>}
  <WorkspaceToolsContext.Provider value={tools}><ToolDeck store={store} registry={tools}><WorkspaceHost store={store} nativeDrag={windowDrag.controller}
   onWindow={(view,move)=>void locked(async()=>{const result=await transferNativeNote(view,sessionFor(view),move,()=>releaseView(view));if(!result.ok)throw Error(result.error);})}
   onChooseWindow={setWindowChooser}
   beforeClose={async view=>{if(workspaceCompositionActive()||!await sessionFor(view).flushForClose())return false;await workspaceCommand({op:'dirty',viewId:view.id,dirty:false});await releaseView(view);return false;}}
   renderView={(view,context)=><WorkspaceNoteView view={view} session={sessionFor(view)} child visible={context.visible} onFocus={()=>store.dispatch({type:'activate',viewId:view.id})} onRevisionReady={revision=>{void workspaceCommand({op:'ready',viewId:view.id,revision}).catch(()=>{void sessionFor(view).refresh();});}}/>}
  /></ToolDeck></WorkspaceToolsContext.Provider>
  {layoutsOpen&&<LayoutLibrary store={store} beforeRestore={()=>workspaceCompositionActive()?Promise.resolve(false):clean()} onClose={()=>setLayoutsOpen(false)}/>}
  {windowChooser&&<WindowChooser current={initial.label} onClose={()=>setWindowChooser(null)} onMain={()=>{const view=windowChooser;setWindowChooser(null);void merge(view);}} onChoose={label=>{const view=windowChooser;setWindowChooser(null);void locked(async()=>{const result=await transferNativeNote(view,sessionFor(view),true,()=>releaseView(view),label);if(!result.ok)throw Error(result.error);});}}/>}
 </div>;
}
