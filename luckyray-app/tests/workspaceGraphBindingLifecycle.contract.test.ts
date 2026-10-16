import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const file=readFileSync(new URL('../src/workspace/WorkspaceProductionMain.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('main.tsx',file,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=new Set(['mainViewCommand','retireScoped','sameRegistration','installWorkspaceProductionMain']);
const declarations=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&names.has(node.name.text)).map(node=>node.getText(ast).replace(/^export /,''));let removed='';
const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='graphNativeViews.onUnregister')removed=node.arguments[0].getText(ast);ts.forEachChild(node,visit);};visit(ast);assert.equal(declarations.length,4);assert.ok(removed);
const vault={id:'vault',rootPath:'/vault',createdAt:'created',mode:'local',schemaVersion:1};
const binding=(generation=1)=>({viewId:'graph-test',vaultId:'vault',generation,vault,materialLibraryId:'materials',title:'Graph'});
const dto=()=>({view:{id:'graph-test',libraryId:'vault'},registration:vault,materialLibraryId:'materials',snapshot:{vaultId:'vault',sourceId:'source'}});
async function harness(){let current:any={binding:()=>binding()},backendOpen=false,resolve!:(dto:unknown)=>void,verifier:any,binds=0;const calls:string[]=[],first=new Promise(done=>resolve=done);
 const env:any={installed:false,isTauri:()=>true,viewOperations:new Map(),retirements:new Map(),graphBindings:new Map(),graphBindingOperations:new Map(),pendingGraphBindings:new Map(),report:()=>{},graphNativeViews:{registered:()=>current,installSourceVerifier:(callback:any)=>verifier=callback},workspaceCommand:async(request:any)=>{calls.push(request.op);if(request.op==='bindScoped'){backendOpen=true;if(++binds===1)return first;return dto();}if(request.op==='releaseScoped')backendOpen=false;return null;}};
 const js=ts.transpileModule(`${declarations.join('\n')}\nconst removed=${removed};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;const api=Function(...Object.keys(env),`${js};return {installWorkspaceProductionMain,removed};`)(...Object.values(env));api.installWorkspaceProductionMain();
 return {api,calls,env,verify:(value:any)=>verifier(value),resolve,firstAdapter:current,get current(){return current;},set current(value:any){current=value;},get backendOpen(){return backendOpen;}};
}
async function until(check:()=>boolean){for(let n=0;n<30&&!check();n++)await Promise.resolve();assert.ok(check());}
test('actual Graph verifier retires an abandoned first native binding before accepting any scope',async()=>{
 const h=await harness(),work=h.verify(binding());await until(()=>h.calls.includes('bindScoped'));h.current=null;h.api.removed('graph-test',h.firstAdapter);h.resolve(dto());await assert.rejects(work,/captured-source-mismatch/);
 assert.deepEqual(h.calls,['bindScoped','integratedNotReady','releaseScoped']);assert.equal(h.backendOpen,false);assert.equal(h.env.graphBindings.size,0);
});
test('actual Graph verifier serializes abandoned cleanup before same-ID replacement',async()=>{
 const h=await harness(),old=h.verify(binding()),oldRejected=assert.rejects(old,/captured-source-mismatch/);await until(()=>h.calls.includes('bindScoped'));h.current=null;h.api.removed('graph-test',h.firstAdapter);h.current={binding:()=>binding(2)};const next=h.verify(binding(2));await Promise.resolve();assert.deepEqual(h.calls,['bindScoped','integratedNotReady']);h.resolve(dto());await oldRejected;await next;
 assert.deepEqual(h.calls,['bindScoped','integratedNotReady','releaseScoped','bindScoped']);assert.equal(h.backendOpen,true);assert.equal(h.env.graphBindings.get('graph-test'),JSON.stringify(['vault',2,'/vault','created','materials']));
});
