import {createMaterialLibraryAdapter} from "../../services/materialLibraryAdapter";
import {getLuckyRayBridgeSync} from "../../bridge/luckyRayBridge";
import type {MaterialCatalogAdapter} from "../../services/materialCatalog";
import { desktopCanvas } from "./canvas";
import {SHORTCUT_COMMANDS,getShortcutValue,normalizeShortcutForConflict} from "../../../app/shortcuts";
/** Fully trusted desktop extensions run as application code. This is not a sandbox. */
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import {listen} from '@tauri-apps/api/event';
import {extensionPackages,packageCompatibility,type InstalledPackage,type DesktopResource} from '../packages';
import * as knowledge from '../../services/knowledge';
import * as materials from '../../services/materials';
import {materialLibrarySession} from '../../services/materialLibraryContext';
import {THEME_TOKEN_KEYS} from '../packages';
import {type LuckyRayCommandId} from '../../commands/appCommands';
import {editorModules,registerDesktopEditorExtension,currentDesktopEditor,listDesktopEditors,onDesktopEditorEvent,type EditorExtensionFactory} from './editorRegistry';
import {desktopViews,desktopCommands,desktopMenus,desktopRenderers,executeDesktopHostCommand,changed,openDesktopView,closeDesktopView,type Dispose,type ViewDefinition,type CommandDefinition,type MenuDefinition,type CodeRenderer} from './contributions';
import {openDesktopLease,desktopNative,createDesktopNativeApi} from './native';
import {createDesktopEventGuard} from './eventGuard';
export type DesktopStatus={state:'loading'|'active'|'failed'|'stopped';message?:string};
const status=new Map<string,DesktopStatus>();
let restartRequired=false;
export function desktopNeedsRestart(){return restartRequired;}
export function desktopStatus(id:string){return status.get(id);}
function setStatus(id:string,value:DesktopStatus){status.set(id,value);changed();}
type Instance={identity:string;live:boolean;executed?:boolean;resources:Set<Dispose>;lease?:string;deactivate?:Dispose|(()=>Promise<void>)};
const running=new Map<string,Instance>();
const identity=(e:InstalledPackage)=>`${e.digest}:${e.epoch??0}`;
const trusted=(e:InstalledPackage,host:string)=>e.package.manifest.type==='desktop'&&e.enabled&&e.grants?.includes('desktop.fullTrust')&&packageCompatibility(e.package,host).compatible;
const validId=(id:string)=>/^[a-zA-Z0-9._-]{1,80}$/.test(id);
function close(instance:Instance){
 if(!instance.live)return;instance.live=false;if(instance.executed){restartRequired=true;changed();}
 // Revoke native resources first; don't await arbitrary extension teardown.
 if(instance.lease)void desktopNative(instance.lease,'close').catch(()=>{});
 for(const dispose of [...instance.resources].reverse())try{dispose();}catch{}instance.resources.clear();
 try{Promise.resolve(instance.deactivate?.()).catch(console.error);}catch{}
}
function ensureLive(instance:Instance){if(!instance.live)throw Error('extension-retired');}
function createApi(entry:InstalledPackage,instance:Instance){
 const id=entry.package.manifest.id;
 const own=(dispose:Dispose)=>{if(!instance.live){try{dispose();}catch{}throw Error("extension-retired");}instance.resources.add(dispose);return()=>{instance.resources.delete(dispose);};};
 const tracked=(dispose:Dispose)=>{let done=false;const once=()=>{if(done)return;done=true;instance.resources.delete(once);dispose();};own(once);return once;};
 const eventGuard=createDesktopEventGuard(id,()=>instance.live);own(()=>eventGuard.clear());
 const key=(local:string)=>{if(!validId(local))throw Error('extension-invalid-contribution');return `${id}/${local}`;};
 const resource=entry.package.resource as DesktopResource;
 const register=<T>(map:Map<string,T>,local:string,value:T)=>{ensureLive(instance);const k=key(local);if(map.has(k))throw Error('extension-duplicate-contribution');map.set(k,value);changed();return tracked(()=>{if(map.get(k)!==value)return;map.delete(k);if((map as unknown)===desktopViews)closeDesktopView(k);changed();});};
 const native=createDesktopNativeApi(instance.lease!,dispose=>own(dispose));
 const assets=new Map<string,string>();
 for(const [name,asset] of Object.entries(resource.assets??{})){
  const bytes=Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:asset.mimeType}));assets.set(name,url);own(()=>URL.revokeObjectURL(url));
 }
 const guarded=<T extends object>(value:T):T=>Object.fromEntries(Object.entries(value).map(([key,fn])=>[key,typeof fn==="function"?(...args:unknown[])=>{ensureLive(instance);return fn(...args);}:fn])) as T;
 const knowledgeWrites=(origins:()=>string[])=>({
  create:(input:Parameters<typeof knowledge.createKnowledgeDocument>[0])=>knowledge.createKnowledgeDocument(input,origins()),
  append:(ref:Parameters<typeof knowledge.appendKnowledgeDocument>[0],content:string,revision?:string|null)=>knowledge.appendKnowledgeDocument(ref,content,revision,origins()),
  insert:(ref:Parameters<typeof knowledge.insertKnowledgeDocument>[0],offset:number,text:string,revision?:string|null)=>knowledge.insertKnowledgeDocument(ref,offset,text,revision,origins()),
  replace:(ref:Parameters<typeof knowledge.replaceKnowledgeDocument>[0],content:string,revision?:string|null)=>knowledge.replaceKnowledgeDocument(ref,content,revision,origins()),
 });
 const materialWrites=(origins:()=>string[])=>({
  library:(libraryId:string)=>{const bridge=getLuckyRayBridgeSync();if(!bridge)throw Error("extension-host-not-ready");if(!libraryId)throw Error("extension-library-required");return guarded(createMaterialLibraryAdapter(bridge as MaterialCatalogAdapter,libraryId,origins));},
  importFiles:(folderId?:string|null,options?:Parameters<typeof materials.importMaterialAssets>[1])=>materials.importMaterialAssets(folderId,options,origins()),
  importFolder:(path:string,options?:Parameters<typeof materials.importMaterialFolder>[1],libraryId?:string|null)=>materials.importMaterialFolder(path,options,libraryId,origins()),
 });
 // The opaque chain is captured per delivery, not shared with other callbacks.
 const eventWrites=(chain:readonly string[])=>{const origins=()=>[...chain];return {knowledge:guarded(knowledgeWrites(origins)),materials:guarded(materialWrites(origins))};};
 type EventWrites=ReturnType<typeof eventWrites>;
 function onEvent<T>(name:'knowledge.saved'|'materials.imported',handler:(payload:T,scope:EventWrites)=>void|Promise<void>):Promise<Dispose>;
 function onEvent<T>(name:string,handler:(payload:T,scope?:EventWrites)=>void|Promise<void>):Promise<Dispose>;
 async function onEvent<T>(name:string,handler:((payload:T,scope:EventWrites)=>void|Promise<void>)|((payload:T,scope?:EventWrites)=>void|Promise<void>)):Promise<Dispose>{
  ensureLive(instance);
  const nativeName=name==='knowledge.saved'?'luckyray:desktop:knowledge-saved':name==='materials.imported'?'luckyray:desktop:materials-imported':name;
  const guardedEvent=nativeName==='luckyray:desktop:knowledge-saved'||nativeName==='luckyray:desktop:materials-imported';
  const dispose=await listen<T>(nativeName,event=>{
   if(guardedEvent)eventGuard.deliver(event.payload,(payload,chain)=>handler(payload,eventWrites(chain)));
   else if(instance.live)(handler as (payload:T)=>void|Promise<void>)(event.payload);
  });
  if(!instance.live){dispose();throw Error('extension-retired');}return tracked(dispose);
 }
 const api={
  apiVersion:2 as const,id,version:entry.package.manifest.version,
  modules:Object.freeze({React,ReactDOM,codeMirror:editorModules}),
  lifecycle:{add:tracked,setInterval:(fn:()=>void,ms:number)=>{if(!Number.isFinite(ms)||ms<16)throw Error('extension-interval');const timer=window.setInterval(()=>{if(instance.live)fn();},ms);return tracked(()=>window.clearInterval(timer));}},
  workspace:{
   registerView:(definition:ViewDefinition)=>register(desktopViews,definition.id,{...definition,id:key(definition.id)}),
   openView:(local:string,placement:'main'|'left'|'right'|'modal'='main')=>{ensureLive(instance);openDesktopView(key(local),placement);},
   closeView:(local:string)=>{ensureLive(instance);closeDesktopView(key(local));},
   onRouteChange:(handler:(path:string)=>void)=>{const fn=()=>handler(location.hash);window.addEventListener('hashchange',fn);return tracked(()=>window.removeEventListener('hashchange',fn));},
   getRoute:()=>location.hash,
  },
  commands:{register:(command:CommandDefinition)=>{
   if(command.shortcut){const normalized=normalizeShortcutForConflict(command.shortcut.replace(/\bMod\b/gi,'Ctrl'));if(!normalized||SHORTCUT_COMMANDS.some(c=>normalizeShortcutForConflict(getShortcutValue(c.id))===normalized)||[...desktopCommands.values()].some(c=>c.shortcut&&normalizeShortcutForConflict(c.shortcut.replace(/\bMod\b/gi,'Ctrl'))===normalized))throw Error('extension-shortcut-conflict');}
   return register(desktopCommands,command.id,{...command,id:key(command.id)});
  },executeHost:(command:LuckyRayCommandId)=>{ensureLive(instance);return executeDesktopHostCommand(command);}},
  menus:{register:(target:'editor'|'materials',item:MenuDefinition)=>register(desktopMenus,item.id,{...item,id:key(item.id),target})},
  editor:{modules:editorModules,current:currentDesktopEditor,list:listDesktopEditors,registerExtension:(factory:EditorExtensionFactory)=>tracked(registerDesktopEditorExtension(factory)),onChange:(handler:Parameters<typeof onDesktopEditorEvent>[0])=>tracked(onDesktopEditorEvent(handler))},
  markdown:{registerCodeBlock:(language:string,render:CodeRenderer)=>{ensureLive(instance);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(language)||desktopRenderers.has(language))throw Error('extension-renderer-conflict');desktopRenderers.set(language,render);changed();return tracked(()=>{desktopRenderers.delete(language);changed();});}},
  theme:{get:()=>({mode:document.documentElement.dataset.theme??'',tokens:Object.fromEntries(THEME_TOKEN_KEYS.map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue(k)]))}),addStyle:(css:string)=>{ensureLive(instance);const sheet=document.createElement('style');sheet.dataset.extension=id;sheet.textContent=css;document.head.appendChild(sheet);return tracked(()=>sheet.remove());}},
  assets:{url:(name:string)=>{ensureLive(instance);const url=assets.get(name);if(!url)throw Error('extension-asset-not-found');return url;}},
  // Same source-bound service authorities as the host UI; no second catalog or vault.
  knowledge:guarded({list:knowledge.listKnowledgeDocuments,search:knowledge.searchKnowledgeDocuments,read:knowledge.readKnowledgeDocument,
   ...knowledgeWrites(eventGuard.writeOrigins),
   move:knowledge.moveKnowledgeDocument,delete:knowledge.deleteKnowledgeDocument,context:knowledge.getCurrentKnowledgeContext,index:knowledge.readKnowledgeIndexSnapshot,backlinks:knowledge.readKnowledgeBacklinks,tags:knowledge.readKnowledgeTagSummary}),
  materials:guarded({...materialWrites(eventGuard.writeOrigins),list:materials.listMaterialAssets,readMany:materials.getMaterialAssetsByIds,query:materials.listFilteredMaterialAssets,
   update:materials.updateMaterialAsset,rename:materials.renameMaterialAsset,delete:materials.deleteMaterialAsset,tags:materials.listMaterialTags,setTags:materials.setMaterialAssetTags,move:materials.moveMaterialAssetsToFolder,libraries:()=>materialLibrarySession.getSnapshot()}),
  canvas:desktopCanvas(()=>ensureLive(instance)),
  storage:{read:async()=>{ensureLive(instance);const s=await extensionPackages.refresh();ensureLive(instance);const current=s.packages.find(p=>p.package.manifest.id===id);if(!current||identity(current)!==instance.identity)throw Error("extension-changed");return current.data??{schemaVersion:resource.dataVersion,revision:0,settings:{},cache:{}};},write:async(data:NonNullable<InstalledPackage['data']>)=>{ensureLive(instance);const s=await extensionPackages.refresh();const e=s.packages.find(p=>p.package.manifest.id===id);if(!e||identity(e)!==instance.identity)throw Error('extension-changed');await extensionPackages.saveData(id,data,s.revision);}},
  events:{on:onEvent},
  ...native,
 };
 if(resource.css)api.theme.addStyle(resource.css);
 return api;
}
export type DesktopExtensionApi=ReturnType<typeof createApi>;
export type DesktopExtensionModule={activate:(api:DesktopExtensionApi)=>void|Dispose|Promise<void|Dispose>;deactivate?:()=>void|Promise<void>};
export async function startDesktopExtensionHost(options:{importModule?:(code:string)=>Promise<DesktopExtensionModule>}={}){
 const load=options.importModule??(async(code:string)=>{const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));try{return await import(/* @vite-ignore */url) as DesktopExtensionModule;}finally{URL.revokeObjectURL(url);}});
 let disposed=false;
 const reconcile=()=>{
  const state=extensionPackages.snapshot();
  for(const [id,instance] of running){const e=state.packages.find(p=>p.package.manifest.id===id);if(!e||!trusted(e,state.hostVersion)||identity(e)!==instance.identity){close(instance);running.delete(id);setStatus(id,{state:'stopped'});}}
  if(disposed||!state.ready||!getLuckyRayBridgeSync())return;
  for(const entry of state.packages){
   const id=entry.package.manifest.id;if(!trusted(entry,state.hostVersion)||running.has(id))continue;
   const instance:Instance={identity:identity(entry),live:true,resources:new Set()};running.set(id,instance);setStatus(id,{state:'loading'});
   void(async()=>{
    try{
     instance.lease=await openDesktopLease({id,digest:entry.digest,epoch:entry.epoch??0});
     if(!instance.live){await desktopNative(instance.lease,'close');return;}
     instance.executed=true;
     const module=await load((entry.package.resource as DesktopResource).code);ensureLive(instance);
     if(typeof module.activate!=='function')throw Error('extension-activate-required');
     const cleanup=await module.activate(createApi(entry,instance));
     if(!instance.live){if(typeof cleanup==='function')cleanup();await module.deactivate?.();return;}
     instance.deactivate=async()=>{if(typeof cleanup==='function')cleanup();await module.deactivate?.();};setStatus(id,{state:'active'});
    }catch(error){close(instance);if(running.get(id)===instance)setStatus(id,{state:'failed',message:error instanceof Error?error.message:String(error)});}
   })();
  }
 };
 await desktopNative("","resetMain");
 const unsubscribe=extensionPackages.subscribe(reconcile);
 window.addEventListener("luckyray:bridge-ready",reconcile);
 await extensionPackages.refresh();reconcile();
 const dispose=()=>{disposed=true;unsubscribe();window.removeEventListener("luckyray:bridge-ready",reconcile);for(const instance of running.values())close(instance);running.clear();};
 window.addEventListener('pagehide',dispose,{once:true});
 return()=>{window.removeEventListener('pagehide',dispose);dispose();};
}
