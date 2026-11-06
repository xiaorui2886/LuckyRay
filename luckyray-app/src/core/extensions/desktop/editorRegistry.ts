import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
export const editorModules = Object.freeze({state,view,commands,language,autocomplete});
export type EditorContext = {id:string; view:view.EditorView; modules:typeof editorModules};
export type EditorExtensionFactory = (context:EditorContext)=>state.Extension;
const factories = new Map<symbol,EditorExtensionFactory>();
const attached = new Map<view.EditorView,{id:string; compartment:state.Compartment}>();
const listeners = new Set<(event:{type:'opened'|'closed'|'changed'|'selection';editor:EditorContext})=>void>();
function emit(type:'opened'|'closed'|'changed'|'selection', v:view.EditorView,id:string){for(const f of listeners)try{f({type,editor:{id,view:v,modules:editorModules}});}catch{}}
function extensions(v:view.EditorView,id:string):state.Extension[]{return [...factories.values()].flatMap(f=>{try{return [f({id,view:v,modules:editorModules})];}catch{return [];}});}
function all(v:view.EditorView,id:string):state.Extension[]{return [...extensions(v,id),view.EditorView.updateListener.of(u=>{if(u.docChanged)emit('changed',v,id);else if(u.selectionSet)emit('selection',v,id);})];}
export function refreshDesktopEditor(v:view.EditorView){const e=attached.get(v);if(!e)return;try{v.dispatch({effects:e.compartment.get(v.state)===undefined?state.StateEffect.appendConfig.of(e.compartment.of(all(v,e.id))):e.compartment.reconfigure(all(v,e.id))});}catch{}}
function refresh(){for(const v of attached.keys())refreshDesktopEditor(v);}
export function registerDesktopEditorExtension(factory:EditorExtensionFactory){const key=Symbol();factories.set(key,factory);refresh();return()=>{factories.delete(key);refresh();};}
export function attachDesktopEditor(v:view.EditorView,id:string){
 const previous=attached.get(v);const entry=previous??{id,compartment:new state.Compartment()};
 entry.id=id;attached.set(v,entry);refreshDesktopEditor(v);if(!previous)emit('opened',v,id);
 return()=>{if(attached.get(v)!==entry)return;attached.delete(v);try{v.dispatch({effects:entry.compartment.reconfigure([])});}catch{}emit('closed',v,entry.id);};
}
export function listDesktopEditors(){return [...attached].map(([v,e])=>({id:e.id,view:v,modules:editorModules}));}
export function onDesktopEditorEvent(fn:(event:{type:'opened'|'closed'|'changed'|'selection';editor:EditorContext})=>void){listeners.add(fn);return()=>{listeners.delete(fn);};}
export function currentDesktopEditor(){return listDesktopEditors().find(e=>e.view.hasFocus)??listDesktopEditors().find(e=>e.view.dom.isConnected)??null;}
