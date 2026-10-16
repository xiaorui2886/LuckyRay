import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/workspace/WorkspaceProductionMain.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('WorkspaceProductionMain.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=new Set(['mainViewCommand','retireScoped','watchBoundNote','unwatchBoundNote','bindMainNote','sameRegistration']);
const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&names.has(node.name.text)).map(node=>node.getText(ast));
let identity='',unregister='';
const walk=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='noteIdentity')identity=node.initializer!.getText(ast);
 if(ts.isCallExpression(node)&&node.expression.getText(ast)==='notesNativeViews.onUnregister')unregister=node.arguments[0].getText(ast);ts.forEachChild(node,walk);};walk(ast);
assert.equal(functions.length,names.size);assert.ok(identity&&unregister);
const vault={id:'vault',rootPath:'/vault',createdAt:'created',mode:'local',schemaVersion:1};
const binding=(generation=1)=>({viewId:'notes-view-test',generation,documentId:'doc',workspaceSourceId:'source',vaultId:'vault',relativePath:'A.md',title:'A',vault});
const adapter=(generation=1)=>({binding:()=>binding(generation),isDirty:()=>false});
const baseline=()=>({view:{id:'notes-view-test'},registration:vault,note:{authority:{sourceId:'source',documentId:'doc'}}});
async function harness(){
 const calls:string[]=[];let current:any=adapter(),backendOpen=false,resolveFirst!:(value:any)=>void;const first=new Promise(resolve=>resolveFirst=resolve);let binds=0;
 const env:any={viewOperations:new Map(),noteBindings:new Map(),graphBindings:new Map(),retirements:new Map(),noteBindingOperations:new Map(),pendingNoteBindings:new Map(),report:()=>{},window:{dispatchEvent:()=>{}},
  notesNativeViews:{get:()=>{if(!current)throw Error('Exact note view is not mounted');return current;},subscribeDirty:()=>()=>{}},
  workspaceCommand:async(request:any)=>{calls.push(request.op);if(request.op==='bindScoped'){backendOpen=true;if(++binds===1)return first;return baseline();}if(request.op==='releaseScoped')backendOpen=false;return null;}};
 const js=ts.transpileModule(`${functions.join('\n')}\nconst noteIdentity=${identity};const unregister=${unregister};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 const api=Function(...Object.keys(env),`${js};return {bindMainNote,unregister};`)(...Object.values(env));
 return {api,calls,env,firstAdapter:current,resolveFirst,get backendOpen(){return backendOpen;},get current(){return current;},set current(value:any){current=value;}};
}
async function until(test:()=>boolean){for(let n=0;n<30&&!test();n++)await Promise.resolve();assert.ok(test(),'expected asynchronous boundary was reached');}
test('actual first-bind closure retires a native scope when its adapter unregisters during the reply',async()=>{
 const h=await harness(),work=h.api.bindMainNote(binding(),h.firstAdapter);await until(()=>h.calls.includes('bindScoped'));assert.equal(h.backendOpen,true);
 h.current=null;h.api.unregister(binding().viewId,h.firstAdapter);h.resolveFirst(baseline());await assert.rejects(work,/captured-binding-changed/);
 assert.deepEqual(h.calls,['bindScoped','integratedNotReady','releaseScoped']);assert.equal(h.backendOpen,false);assert.equal(h.env.noteBindings.size,0);
});
test('actual ownership queue cleans abandoned bind before same-ID replacement, never after it',async()=>{
 const h=await harness(),first=h.api.bindMainNote(binding(),h.firstAdapter);const rejected=assert.rejects(first,/captured-binding-changed/);await until(()=>h.calls.includes('bindScoped'));
 h.current=null;h.api.unregister(binding().viewId,h.firstAdapter);const replacement=adapter(2);h.current=replacement;const second=h.api.bindMainNote(binding(2),replacement);
 await Promise.resolve();assert.deepEqual(h.calls,['bindScoped','integratedNotReady']);h.resolveFirst(baseline());await rejected;await second;await until(()=>h.calls.includes('boundDirty'));
 assert.deepEqual(h.calls,['bindScoped','integratedNotReady','releaseScoped','bindScoped','boundDirty']);assert.equal(h.backendOpen,true);assert.equal(h.env.noteBindings.get(binding().viewId).adapter,replacement);
});
