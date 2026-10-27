import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rememberCanvasEditor,rememberedCanvasRoute,clearRememberedCanvasEditor} from '../src/features/canvas/canvasNavigation.ts';
test('sidebar restores editor path until explicit home, not arbitrary stored route',()=>{
 const store=new Map<string,string>();
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>store.get(k)||null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)}});
 rememberCanvasEditor('canvas/main/first');assert.equal(rememberedCanvasRoute(),'canvas/main/first');
 rememberCanvasEditor('materials');assert.equal(rememberedCanvasRoute(),'canvas/main/first');
 clearRememberedCanvasEditor();assert.equal(rememberedCanvasRoute(),'canvas');
});
test('editor is retained without activity suspension, guarded from hidden shortcuts',()=>{
 const shell=readFileSync(new URL('../src/app/AppShell.tsx',import.meta.url),'utf8');
 const canvas=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 assert.match(shell,/<CanvasSpike key=\{canvasPath\} visible=\{route === "canvas"\}/);
 assert.match(shell,/key="retained-canvas" aria-hidden=\{route !== "canvas"\} inert=\{route !== "canvas"\}/);
 for(const handler of ['onDeleteKey','nudge','onCopyPasteKey','onUndoRedoKey'])assert.match(canvas,new RegExp(`const ${handler} = \\(event: KeyboardEvent\\) => \\{\\s+if \\(!canvasVisibleRef.current\\) return;`));
});
