import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceInvalidations} from '../src/workspace/nativeWorkspaceInvalidation.ts';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function harness(){let blocked=true,sequence=0;const frames=new Map<number,()=>void>(),calls:string[]=[],errors:unknown[]=[];
 const queue=createWorkspaceInvalidations({blocked:()=>blocked,notes:()=>{calls.push('notes');},graph:()=>{calls.push('graph');},failed:error=>errors.push(error),schedule:run=>{frames.set(++sequence,run);return sequence;},cancel:id=>{frames.delete(id as number);}});
 return {queue,calls,errors,set blocked(value:boolean){blocked=value;},tick:async()=>{const pending=[...frames.values()];frames.clear();pending.forEach(run=>run());await queue.settled();},frames};
}
test('coalesces bodyless note and graph hints through each action/transfer/IME guard',async()=>{
 for(const reason of ['action','transfer','frozen','recovery','IME']){const h=harness();for(let index=0;index<20;index++){h.queue.mark('note');h.queue.mark('graph');}assert.equal(h.frames.size,0,reason);assert.deepEqual(h.calls,[]);h.blocked=false;h.queue.kick();assert.equal(h.frames.size,1);await h.tick();assert.deepEqual(h.calls,['notes','graph']);h.queue.dispose();}
});
test('queued own-action hints drain on a later task after the correlated reply is applied',async()=>{
 const h=harness();h.queue.mark('note');h.queue.mark('graph');h.blocked=false;h.queue.kick();h.calls.push('apply-action-reply');assert.deepEqual(h.calls,['apply-action-reply']);await h.tick();assert.deepEqual(h.calls,['apply-action-reply','notes','graph']);
});
test('a guard acquired during a running note read defers the pending graph refresh',async()=>{
 let blocked=false,finish!:()=>void;const callbacks:Array<()=>void>=[],calls:string[]=[];const work=new Promise<void>(resolve=>finish=resolve);
 const queue=createWorkspaceInvalidations({blocked:()=>blocked,notes:async()=>{calls.push('note:start');await work;calls.push('note:end');},graph:()=>{calls.push('graph');},failed:()=>{},schedule:run=>{callbacks.push(run);return callbacks.length;},cancel:()=>{}});
 queue.mark('note');queue.mark('graph');callbacks.shift()!();blocked=true;finish();await queue.settled();assert.deepEqual(calls,['note:start','note:end']);assert.equal(callbacks.length,0);blocked=false;queue.kick();callbacks.shift()!();await queue.settled();assert.deepEqual(calls,['note:start','note:end','graph']);
});
test('disposing a host removes scheduled invalidations and ignores late hints',async()=>{const h=harness();h.blocked=false;h.queue.mark('note');assert.equal(h.frames.size,1);h.queue.dispose();h.queue.mark('graph');await h.tick();assert.deepEqual(h.calls,[]);});
test('actual Main KnowledgeStore observer emits only coalesced event names without source bodies',async()=>{
 const source=readFileSync(new URL('../src/workspace/WorkspaceProductionMain.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('main.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback='';
 const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='knowledgeStore.subscribe')callback=node.arguments[0].getText(ast);ts.forEachChild(node,visit);};visit(ast);assert.ok(callback);
 const base={version:1,markdownIndex:{privateBody:'never transmit'},attachmentChanges:null,attachmentResolutionRevision:0,vault:{rootPath:'/private'}};let snapshot:any=base;const timers:Array<()=>void>=[],emitted:unknown[][]=[];
 const env={knowledgeStore:{getSnapshot:()=>snapshot},observedKnowledge:base,hintTimer:undefined,alive:true,setTimeout:(run:()=>void)=>{timers.push(run);return timers.length;},emit:async(...args:unknown[])=>{emitted.push(args);},report:()=>{}};
 const js=ts.transpileModule(`const callback=${callback};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;const observe=Function(...Object.keys(env),`${js};return callback;`)(...Object.values(env));
 observe();assert.equal(timers.length,0);snapshot={...base,version:2};observe();snapshot={...snapshot,attachmentResolutionRevision:1};observe();assert.equal(timers.length,1);timers.shift()!();await Promise.resolve();assert.deepEqual(emitted,[['luckyray:workspace-note-changed'],['luckyray:workspace-graph-changed']]);
});
