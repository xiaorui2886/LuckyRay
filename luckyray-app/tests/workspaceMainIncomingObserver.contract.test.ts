import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {receiveNativePresentation,NativeHandoffAdmissions,type HandoffOffer} from '../src/workspace/nativeHandoff.ts';
const file=readFileSync(new URL('../src/workspace/WorkspaceProductionMain.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('main.tsx',file,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declaration=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='receiveMain')!;assert.ok(declaration);
const offer=(kind:'note'|'graph'):HandoffOffer=>({id:'admission',sourceWindow:'workspace-source',targetWindow:'main',sourceView:{id:'source',kind,libraryId:'vault',resourceId:'A.md',title:'A'},targetViewId:'exact-incoming',proof:{kind,revision:'r1',identity:{sourceId:'source-id',vaultId:'vault',documentId:kind==='note'?'doc':null},presentationHash:'a'.repeat(64)},phase:'pending',presentation:kind==='note'?{authority:{sourceId:'source-id',documentId:'doc'},revision:'r1'}:{source:{viewId:'source',sourceId:'source-id'}},moveSource:true});
for(const kind of ['note','graph'] as const)test(`actual Main ${kind} preparation failure stays inside exact terminal observation`,async()=>{
 const calls:string[]=[],initial=offer(kind);let cancelAttempts=0;
 const command=async(request:any)=>{calls.push(request.op);return {...initial,phase:'cancelled',presentation:null};};const admissions=new NativeHandoffAdmissions(command,'main');const token=Symbol('admission');let reserved=false;
 const env={mainAdmissions:{receive:(...args:Parameters<NativeHandoffAdmissions['receive']>)=>{calls.push('observer-installed');return admissions.receive(...args);}},
  workspaceCommand:async(request:any)=>{calls.push(request.op);return {...initial,phase:'cancelled',presentation:null};},navigateAdmission:(route:string)=>calls.push(`route:${route}`),withReceiver:(get:()=>Promise<unknown>)=>get(),
  notesNativeViews:{incomingToken:()=>reserved?token:undefined,prepareIncoming:async(input:any)=>{reserved=true;calls.push(`prepare:${input.viewId}`);throw Error('delayed note renderer did not mount');},cancelIncoming:async(viewId:string,expected:symbol)=>{assert.equal(expected,token);assert.equal(viewId,initial.targetViewId);cancelAttempts++;calls.push('cancel-reservation');},list:()=>[]},
  graphNativeViews:{prepareIncoming:async(input:any)=>{calls.push(`prepare:${input.viewId}`);throw Error('graph renderer did not mount');},list:()=>[]},
  validateGraphViewPresentation:()=>true,unwatchBoundNote:()=>{},mainViewCommand:()=>{throw Error('read before preparation succeeded');},watchBoundNote:()=>{},sameRegistration:()=>true};
 const js=ts.transpileModule(declaration.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 const receiveMain=Function(...Object.keys(env),`${js};return receiveMain;`)(...Object.values(env));
 await assert.rejects(receiveMain(initial,()=>true,()=>calls.push('report')),/renderer did not mount/);await Promise.resolve();
 assert.equal(calls[0],'observer-installed');assert.ok(calls.indexOf('handoffRead')>calls.indexOf(`prepare:${initial.targetViewId}`));assert.equal(calls.includes('integratedReady'),false);assert.equal(calls.includes('handoffApplied'),false);assert.equal(calls.at(-1),'handoffSettled');assert.equal(cancelAttempts,kind==='note'?1:0);
});
test('actual Main pre-adapter reservation cleanup failure exposes terminal local retry',async()=>{
 const initial=offer('note');let cancels=0,settled=0;
 const command=async(request:any)=>{if(request.op==='handoffSettled')settled++;return {...initial,phase:'cancelled',presentation:null};};const token=Symbol('admission');let reserved=false;
 const env={mainAdmissions:new NativeHandoffAdmissions(command,'main'),workspaceCommand:command,navigateAdmission:()=>{},withReceiver:(get:()=>Promise<unknown>)=>get(),
  notesNativeViews:{incomingToken:()=>reserved?token:undefined,prepareIncoming:async()=>{reserved=true;throw Error('late note renderer');},cancelIncoming:async()=>{if(++cancels===1)throw Error('late layout removal not yet acknowledged');}},graphNativeViews:{},validateGraphViewPresentation:()=>false,unwatchBoundNote:()=>{},mainViewCommand:()=>{},watchBoundNote:()=>{},sameRegistration:()=>true};
 const js=ts.transpileModule(declaration.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;const receiveMain=Function(...Object.keys(env),`${js};return receiveMain;`)(...Object.values(env));
 const recovery=await receiveMain(initial,()=>true,()=>{}).catch((error:unknown)=>error);assert.equal(recovery.name,'NativeHandoffRecovery');assert.equal(recovery.receipt.id,initial.id);assert.equal(settled,0);await recovery.retry();await Promise.resolve();assert.equal(cancels,2);assert.equal(settled,1);
});
test('actual Main poll settles a lost Pending reply that next appears Cancelled without preparing a view',async()=>{
 let drainNode:ts.Expression|undefined;
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='drain')drainNode=node.initializer;ts.forEachChild(node,visit);};visit(ast);assert.ok(drainNode);
 const initial={...offer('note'),phase:'cancelled' as const,presentation:null},calls:string[]=[];let reads=0;
 const command=async(request:any)=>{calls.push(request.op);if(request.op==='handoffPending'){if(++reads===1)throw Error('lost pending reply');return [initial];}return undefined;};
 const mainAdmissions=new NativeHandoffAdmissions(command as any,'main');
 const env={alive:true,reading:false,received:new Set(),mainAdmissions,workspaceCommand:command,validateHandoff:(value:unknown)=>value,activeTransactions:0,incomingTail:Promise.resolve(),report:()=>calls.push('report'),receiveMain:async()=>{throw Error('Cancelled must not prepare Main');}};
 const js=ts.transpileModule(`const drain=${drainNode.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 const run=Function(...Object.keys(env),`${js};return async()=>{await drain();await incomingTail;};`)(...Object.values(env));await run();await run();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['handoffPending','report','handoffPending','handoffSettled']);assert.equal(mainAdmissions.owns(initial.id),true);
});
test('actual Main rejected preparation never adopts an existing unrelated reservation token',async()=>{
 const initial=offer('note'),existing=Symbol('another-admission');let cancels=0,settled=0;
 const command=async(request:any)=>{if(request.op==='handoffSettled')settled++;return {...initial,phase:'cancelled',presentation:null};};
 const env={mainAdmissions:new NativeHandoffAdmissions(command as any,'main'),navigateAdmission:()=>{},withReceiver:(get:()=>Promise<unknown>)=>get(),
  notesNativeViews:{incomingToken:()=>existing,prepareIncoming:async()=>{throw Error('must not prepare over another reservation');},cancelIncoming:async()=>{cancels++;}},graphNativeViews:{},unwatchBoundNote:()=>{throw Error('must not unwatch another admission');}};
 const js=ts.transpileModule(declaration.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;const receiveMain=Function(...Object.keys(env),`${js};return receiveMain;`)(...Object.values(env));
 await assert.rejects(receiveMain(initial,()=>true,()=>{}),/already-reserved/);await new Promise(resolve=>setImmediate(resolve));assert.equal(cancels,0);assert.equal(settled,1);
});
test('actual Main consumer unmount during cleanup preserves retry for the next Cancelled poll',async()=>{
 const initial=offer('note'),token=Symbol('admission');let alive=true,reserved=false,cancels=0,settled=0,rejectCleanup!:(error:Error)=>void;const visible:unknown[]=[];
 const command=async(request:any)=>{if(request.op==='handoffSettled')settled++;return {...initial,phase:'cancelled',presentation:null};};const mainAdmissions=new NativeHandoffAdmissions(command as any,'main');
 const env={mainAdmissions,navigateAdmission:()=>{},withReceiver:(get:()=>Promise<unknown>)=>get(),notesNativeViews:{incomingToken:()=>reserved?token:undefined,prepareIncoming:async()=>{reserved=true;throw Error('late renderer');},cancelIncoming:async(_id:string,expected:symbol)=>{assert.equal(expected,token);if(++cancels===1)await new Promise<void>((_,reject)=>{rejectCleanup=reject;});reserved=false;}},graphNativeViews:{}};
 const js=ts.transpileModule(declaration.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;const receiveMain=Function(...Object.keys(env),`${js};return receiveMain;`)(...Object.values(env));
 const receiving=receiveMain(initial,()=>alive,()=>{}).catch((error:unknown)=>{if(alive)visible.push(error);});await new Promise(resolve=>setImmediate(resolve));alive=false;rejectCleanup(Error('cancel frame failed'));await receiving;
 assert.equal(visible.length,0);assert.equal(mainAdmissions.owns(initial.id),false);assert.equal(settled,0);await mainAdmissions.cancelled({...initial,phase:'cancelled',presentation:null},()=>true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cancels,2);assert.equal(reserved,false);assert.equal(settled,1);
});
