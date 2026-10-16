import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {NativeHandoffRecovery} from '../src/workspace/nativeHandoff.ts';
const file=readFileSync(new URL('../src/workspace/WorkspaceProductionMain.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('main.tsx',file,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const variables=new Map<string,string>(),functions=new Map<string,string>();
const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.initializer)variables.set(node.name.getText(ast),node.initializer.getText(ast));if(ts.isFunctionDeclaration(node)&&node.name)functions.set(node.name.text,node.getText(ast));ts.forEachChild(node,visit);};visit(ast);
const compile=(source:string,env:Record<string,unknown>)=>{const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;return Function(...Object.keys(env),js)(...Object.values(env));};
test('actual Main recovery report survives effect unmount and clears every later consumer only after exact retry succeeds',async()=>{
 const mainRecoveries=new Map(),mainRecoveryListeners=new Set<()=>void>();
 const rememberMainRecovery=compile(`${functions.get('rememberMainRecovery')};return rememberMainRecovery;`,{mainRecoveries,mainRecoveryListeners});
 const report=compile(`return ${variables.get('report')};`,{NativeHandoffRecovery,rememberMainRecovery,alive:false,setError:()=>{throw Error('unmounted consumer must not update state');}});
 let attempts=0;const recovery=new NativeHandoffRecovery('exact-source-admission',null,async()=>{if(++attempts===1)throw Error('media still needs acknowledgement');},Error('initial local failure'));
 report(recovery);assert.equal(mainRecoveries.get(recovery.recoveryId),recovery);
 const snapshots:NativeHandoffRecovery[][]=[],recoveryHolds={current:new Set()};
 const recoveryChanged=compile(`return ${variables.get('recoveryChanged')};`,{alive:true,mainRecoveries,recoveryHolds,setRecoveries:(value:NativeHandoffRecovery[])=>snapshots.push(value)});mainRecoveryListeners.add(recoveryChanged);recoveryChanged();
 assert.deepEqual(snapshots,[[recovery]]);assert.equal(recoveryHolds.current.has(recovery.recoveryId),true);
 await assert.rejects(recovery.retry(),/acknowledgement/);assert.equal(mainRecoveries.get(recovery.recoveryId),recovery);await recovery.retry();
 assert.equal(mainRecoveries.size,0);assert.equal(recoveryHolds.current.size,0);assert.deepEqual(snapshots.at(-1),[]);assert.equal(attempts,2);
});
for(const kind of ['note','graph'] as const)test(`actual Main ${kind} source recovery cannot restore or retire a replacement adapter`,async()=>{
 const calls:string[]=[],binding={viewId:'view',vaultId:'vault',relativePath:'A.md',title:'A'};
 const adapter={binding:()=>binding,abort:async()=>{calls.push('old-abort');},activate:async()=>{calls.push('old-activate');},release:async()=>{calls.push('old-release');},commitRelease:async()=>{calls.push('old-destroy');}};let current:any=adapter;
 const registry={get:()=>current,registered:()=>current};
 const mainSource=compile(`${functions.get('mainSource')};return mainSource;`,{notesNativeViews:registry,graphNativeViews:registry,unwatchBoundNote:(_id:string,expected:any)=>{assert.equal(expected,adapter);calls.push('unwatch-exact');}});
 const source=mainSource(kind,'view');current={...adapter};await assert.rejects(source.abort(),/adapter-replaced/);await assert.rejects(source.activate(),/adapter-replaced/);await assert.rejects(source.release(),/adapter-replaced/);await source.commitRelease();
 assert.deepEqual(calls,kind==='note'?['unwatch-exact']:[]);
});
