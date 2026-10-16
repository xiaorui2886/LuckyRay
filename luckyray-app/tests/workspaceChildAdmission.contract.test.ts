import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {receiveNativePresentation,NativeHandoffAdmissions,type HandoffOffer} from '../src/workspace/nativeHandoff.ts';
const file=readFileSync(new URL('../src/workspace/IntegratedWorkspaceWindow.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('child.tsx',file,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const selected=new Map<string,string>();
const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&['bind','incoming','sync'].includes(node.name.getText(ast)))selected.set(node.name.getText(ast),node.initializer!.getText(ast));ts.forEachChild(node,visit);};visit(ast);
function compile(name:string,env:Record<string,unknown>){const js=ts.transpileModule(`const callback=${selected.get(name)};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;return Function(...Object.keys(env),`${js};return callback;`)(...Object.values(env));}
test('actual child incoming bind never joins or freezes a pre-existing dirty document owner',async()=>{
 const calls:string[]=[],draft={dirty:true,content:'existing unsaved draft'};const coordinator={getView:()=>undefined,documents:{get:()=>({isComposing:()=>false,session:{getSnapshot:()=>draft}})},bindNote:()=>calls.push('bound'),freezeView:()=>calls.push('frozen')};
 const bind=compile('bind',{coordinator,resources:{active:true,loading:new Map()},noteServices:async()=>({runtime:{},panels:{},dispose:()=>calls.push('disposed-new-service')}),viewRefFromGrant:()=>{},watchNote:()=>calls.push('watched')});
 await assert.rejects(bind({id:'incoming',kind:'note'},true),/target-has-existing-draft/);assert.deepEqual(calls,['disposed-new-service']);assert.equal(draft.content,'existing unsaved draft');assert.equal(draft.dirty,true);
});
test('actual child preparation error still observes exact cancellation without closing the existing draft',async()=>{
 const calls:string[]=[],offer:HandoffOffer={id:'offer',sourceWindow:'main',targetWindow:'workspace-target',sourceView:{id:'source',kind:'note',libraryId:'vault',resourceId:'A.md',title:'A'},targetViewId:'incoming',proof:{kind:'note',revision:'r1',identity:{sourceId:'scope',vaultId:'vault',documentId:'doc'},presentationHash:'a'.repeat(64)},phase:'pending',presentation:{state:'portable'},moveSource:true};
 const command=async(request:any)=>{calls.push(request.op);return {...offer,phase:'cancelled'};};const admissionOwner=new NativeHandoffAdmissions(command,'workspace-target');
 const incoming=compile('incoming',{admissions:{owns:(id:string)=>admissionOwner.owns(id),receive:(...args:Parameters<NativeHandoffAdmissions['receive']>)=>{calls.push('observer');return admissionOwner.receive(...args);},cancelled:(value:HandoffOffer)=>admissionOwner.cancelled(value)},initial:{label:'workspace-target'},resources:{active:true,receiving:new Set()},validateHandoff:(value:any)=>value,
  receiveNativePresentation:(...args:Parameters<typeof receiveNativePresentation>)=>{calls.push('observer');return receiveNativePresentation(...args);},readinessCommand:async(request:any)=>{calls.push(request.op);return {...offer,phase:'cancelled'};},bind:async()=>{calls.push('prepare');throw Error('existing dirty document');},
  coordinator:{cancelAdmission:(id:string)=>{assert.equal(id,'incoming');calls.push('cancel-own');},activateView:()=>{calls.push('activate');}},publishOpen:async()=>{calls.push('publish');},report:()=>calls.push('report'),validateGraphViewPresentation:()=>false});
 await incoming(offer);await Promise.resolve();assert.deepEqual(calls,['observer','prepare','report','handoffRead','handoffSettled','report']);assert.equal(calls.includes('activate'),false);
});
test('late child bootstrap handles a Cancelled-only poll without binding the removed native admission',async()=>{
 const calls:string[]=[],offer:HandoffOffer={id:'expired',sourceWindow:'main',targetWindow:'workspace-target',sourceView:{id:'source',kind:'note',libraryId:'vault',resourceId:'A.md',title:'A'},targetViewId:'removed',proof:{kind:'note',revision:'r1',identity:{sourceId:'scope',vaultId:'vault',documentId:'doc'},presentationHash:'a'.repeat(64)},phase:'cancelled',presentation:null,moveSource:true};
 const resources={active:true,receiving:new Set(),incomingTail:Promise.resolve(),busy:false};const coordinator={listViews:()=>[],hasFrozenViews:()=>false};
 const command=async(request:any)=>{calls.push(request.op);if(request.op==='handoffPending')return [offer];if(request.op==='bootstrap')return {integrated:true,label:'workspace-target',views:[]};};
 const admissions=new NativeHandoffAdmissions(command as any,'workspace-target');const report=(error:unknown)=>{throw error;};
 const incoming=compile('incoming',{initial:{label:'workspace-target'},resources,admissions,validateHandoff:(value:any)=>value,report});
 const sync=compile('sync',{workspaceCommand:command,resources,initial:{label:'workspace-target'},coordinator,bind:async()=>{calls.push('bind');},incoming,report,publishOpen:async()=>{calls.push('publish');}});
 await sync();await resources.incomingTail;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['handoffPending','bootstrap','handoffSettled']);
});
test('cancelled child admission cannot remove a later ordinary replacement under the same target ID',async()=>{
 const offer:HandoffOffer={id:'admission',sourceWindow:'main',targetWindow:'workspace-target',sourceView:{id:'source',kind:'note',libraryId:'vault',resourceId:'A.md',title:'A'},targetViewId:'target',proof:{kind:'note',revision:'r1',identity:{sourceId:'scope',vaultId:'vault',documentId:'doc'},presentationHash:'a'.repeat(64)},phase:'pending',presentation:{},moveSource:true};
 let current:any={kind:'note',frozen:true},cancel=0,settled=0;const admitted=current,resources={active:true,receiving:new Set()};
 const admissions=new NativeHandoffAdmissions(async(request:any)=>{if(request.op==='handoffSettled')settled++;return undefined as never;},'workspace-target');
 const coordinator={getView:()=>current,store:{dispatch:()=>{}},productionReady:async()=>{resources.active=false;throw Error('renderer stopped');},cancelAdmission:()=>{cancel++;},activateView:async()=>{}};
 const incoming=compile('incoming',{initial:{label:'workspace-target'},resources,admissions,validateHandoff:(value:any)=>value,bind:async()=>admitted,coordinator,report:()=>{},publishOpen:async()=>{throw Error('must not publish replacement cleanup');}});
 await incoming(offer);current={kind:'note',frozen:false,draft:'ordinary replacement'};resources.active=true;await incoming({...offer,phase:'cancelled',presentation:null});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cancel,0);assert.equal(current.draft,'ordinary replacement');assert.equal(settled,1);
});
