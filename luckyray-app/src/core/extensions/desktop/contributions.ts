import type {EditorContext} from './editorRegistry';
export type Dispose=()=>void;
export type ViewDefinition={id:string;title:string;mount:(container:HTMLElement)=>void|Dispose|Promise<void|Dispose>};
export type CommandDefinition={id:string;name:string;shortcut?:string;allowInEditor?:boolean;run:()=>unknown};
export type MenuDefinition={id:string;label:string;when?:(context:unknown)=>boolean;run:(context:unknown)=>unknown};
export type CodeRenderer=(container:HTMLElement,source:string,context:{noteId:string|null;language:string})=>void|Dispose;
export const desktopViews=new Map<string,ViewDefinition>();
export const desktopCommands=new Map<string,CommandDefinition>();
export const desktopMenus=new Map<string,MenuDefinition & {target:'editor'|'materials'}>();
export const desktopRenderers=new Map<string,CodeRenderer>();
let revision=0;const listeners=new Set<()=>void>();
export function changed(){revision++;for(const fn of listeners)fn();}
export const contributionSnapshot=()=>revision;
export function subscribeContributions(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};}
export const panels:{key:string;placement:'left'|'right'|'modal'}[]=[];
export function openDesktopView(key:string,placement:'main'|'left'|'right'|'modal'='main'){
 if(!desktopViews.has(key))throw Error('extension-view-unavailable');
 if(placement==='main'){const split=key.indexOf('/');window.location.hash=`#plugins/${encodeURIComponent(key.slice(0,split))}/${encodeURIComponent(key.slice(split+1))}`;return;}
 const old=panels.findIndex(p=>p.key===key);if(old>=0)panels.splice(old,1);panels.push({key,placement});changed();
}
export function closeDesktopView(key:string){const split=key.indexOf('/');const expected=`#plugins/${encodeURIComponent(key.slice(0,split))}/${encodeURIComponent(key.slice(split+1))}`;if(location.hash.split('?')[0]===expected)location.hash='#community';for(let i=panels.length-1;i>=0;i--)if(panels[i].key===key)panels.splice(i,1);changed();}
export function menuEntries(target:'editor'|'materials',context:unknown){return [...desktopMenus.values()].filter(e=>{try{return e.target===target&&(!e.when||e.when(context));}catch{return false;}});}
export function runDesktopCommand(id:string){const c=desktopCommands.get(id);if(!c)throw Error('extension-command-unavailable');return c.run();}
/** Called by the ordinary host key handler after built-in shortcuts. No OS-global hook. */
export function dispatchDesktopShortcut(event:KeyboardEvent,blocked=false){
 if(blocked||event.defaultPrevented||event.isComposing||event.repeat)return false;
 const target=event.target instanceof Element?event.target:null;
 const editing=!!target?.closest('input,textarea,[contenteditable=true],.cm-editor');
 for(const c of desktopCommands.values()){
  if(!c.shortcut||editing&&!c.allowInEditor)continue;
  const p=c.shortcut.toLowerCase().split('+').map(s=>s.trim());const key=p.pop();
  const mod=p.includes('mod');const apple=/Mac|iPhone|iPad/.test(navigator.platform);
  if(event.ctrlKey!==(p.includes('ctrl')||(mod&&!apple))||event.metaKey!==(p.includes('meta')||(mod&&apple))||event.altKey!==p.includes('alt')||event.shiftKey!==p.includes('shift')||event.key.toLowerCase()!==key)continue;
  event.preventDefault();Promise.resolve().then(()=>c.run()).catch(console.error);return true;
 }
 return false;
}
export type DesktopEditorContext=EditorContext;

let hostCommands:((id:string)=>Promise<void>)|null=null;
export function bindDesktopHostCommands(run:(id:string)=>Promise<void>){hostCommands=run;return()=>{if(hostCommands===run)hostCommands=null;};}
export function executeDesktopHostCommand(id:string){if(!hostCommands)return Promise.reject(Error('extension-host-command-not-ready'));return hostCommands(id);}
