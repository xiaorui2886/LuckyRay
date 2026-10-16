import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAttachmentWorkflow } from "../src/core/services/vaultAttachmentWorkflow.ts";
import type { AttachmentWorkflowPort } from "../src/core/services/vaultAttachmentWorkflow.ts";
import type { AttachmentOperationPlan, AttachmentOperationResult } from "../src/core/services/vaultAttachments.ts";

const plan: AttachmentOperationPlan = { version:1, vaultId:"fixture", targetIdentity:"fixture", kind:"convert", attachmentDependencies:[], files:[{relativePath:"note.md",before:"old",after:"new",beforeRevision:"a",afterRevision:"b"}], issues:[], documentCount:1, attachmentCount:1, copyBytes:100, backupBytes:10 };
const result: AttachmentOperationResult = { operationId:"fixture-op", status:"complete", completedFiles:1,totalFiles:1,issues:[],recoveryPath:"fixture-receipt" };
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
function setup(overrides: Partial<AttachmentWorkflowPort> = {}) {
  const calls: string[]=[];
  const port: AttachmentWorkflowPort = { capture:async()=>7, collect:async(paths)=>{calls.push(`collect:${paths.join()}`);return plan;}, rename:async()=>plan, execute:async(epoch,p)=>{assert.equal(epoch,7);assert.equal(p,plan);calls.push("execute");return result;}, recover:async()=>result, cancel:async()=>{calls.push("cancel");},...overrides };
  return {calls, workflow:createAttachmentWorkflow(port)};
}
test("safe scoped collection finishes after one action without a preview screen", async()=>{
  const {workflow,calls}=setup(); await workflow.collect(["note.md"]);
  assert.deepEqual(calls,["collect:note.md","execute"]);assert.equal(workflow.getSnapshot().result,result);
});
test("ambiguous and costly batches wait for confirmation; cancelling review makes no write",async()=>{
  for(const changed of [{...plan,issues:[{document:"note.md",target:"x",status:"ambiguous"}]},{...plan,copyBytes:20*1048576}]) {
    let writes=0;const {workflow}=setup({collect:async()=>changed,execute:async()=>{writes++;return result;}});
    await workflow.collect(["note.md"]);assert.equal(workflow.getSnapshot().phase,"review");assert.equal(writes,0);
    workflow.reset();await workflow.confirm();assert.equal(writes,0);
    await workflow.collect(["note.md"]);await workflow.confirm();assert.equal(writes,1);
  }
});
test("rename always requires confirmation and double confirmation cannot duplicate writes",async()=>{
  const pending=deferred<AttachmentOperationResult>();let writes=0;
  const {workflow}=setup({execute:async()=>{writes++;return pending.promise;}});
  await workflow.rename("a","b");assert.equal(workflow.getSnapshot().phase,"review");
  const running=workflow.confirm();await workflow.confirm();assert.equal(writes,1);pending.resolve(result);await running;
});
test("closing settings preserves the in-flight operation and its receipt",async()=>{
  const pending=deferred<AttachmentOperationResult>(); const started=deferred<void>();let cancelled=0;
  const {workflow}=setup({execute:async()=>{started.resolve();return pending.promise;},cancel:async()=>{cancelled++;}});
  let notifications=0;const unsubscribe=workflow.subscribe(()=>notifications++);
  const running=workflow.collect(["note.md"]);await started.promise;unsubscribe();const before=notifications;
  assert.equal(workflow.getSnapshot().phase,"running");pending.resolve(result);await running;
  assert.equal(notifications,before);assert.equal(cancelled,0);assert.equal(workflow.getSnapshot().result,result);
});
test("review survives closing but refuses confirmation after unsaved edits",async()=>{
  const {workflow,calls}=setup();let dirty=false;
  const unsubscribe=workflow.subscribe(()=>{});
  await workflow.rename("old.png","new.png");unsubscribe();dirty=true;
  await workflow.confirm(()=>dirty);
  assert.equal(workflow.getSnapshot().phase,"review");assert.match(workflow.getSnapshot().error,/保存/);assert.deepEqual(calls,[]);
  dirty=false;await workflow.confirm(()=>dirty);assert.deepEqual(calls,["execute"]);assert.equal(workflow.getSnapshot().error,"");
});

test("diagnostic refresh reports current scope without capture or execution",async()=>{
  const {workflow,calls}=setup({capture:async()=>{throw Error("inspection must not activate a writer");}});
  await workflow.inspect(["note.md"]);assert.equal(workflow.getSnapshot().phase,"finished");assert.equal(workflow.getSnapshot().plan,plan);assert.deepEqual(calls,["collect:note.md"]);
  await workflow.confirm();assert.deepEqual(calls,["collect:note.md"]);
});

test("each execution and recovery gets a fresh request ID; delayed stop failure cannot alter the next job",async()=>{
  const ids:string[]=[];const stopped:string[]=[];const first=deferred<AttachmentOperationResult>();
  const started=deferred<void>();let rejectStop!:(reason:Error)=>void;
  const pendingStop=new Promise<void>((_resolve,reject)=>{rejectStop=reject;});
  const {workflow}=setup({execute:async(_epoch,_plan,id)=>{ids.push(id);started.resolve();return first.promise;},recover:async(_epoch,_id,_rollback,id)=>{ids.push(id);return result;},cancel:async(id)=>{stopped.push(id);return pendingStop;}});
  const running=workflow.collect(["note.md"]);await started.promise;const stopping=workflow.stop();
  first.resolve(result);await running;await workflow.recover(result.operationId,false);
  rejectStop(Error("late stop transport failure"));await stopping;
  assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);assert.deepEqual(stopped,[ids[0]]);
  assert.equal(workflow.getSnapshot().error,"");assert.equal(workflow.getSnapshot().result,result);
});
test("stop during planning prevents writes; execution stop retains actual partial completion",async()=>{
  const planning=deferred<AttachmentOperationPlan>();const first=setup({collect:()=>planning.promise});
  const preparing=first.workflow.collect(["note.md"]);await first.workflow.stop();planning.resolve(plan);await preparing;
  assert.equal(first.workflow.getSnapshot().phase,"cancelled");assert.ok(!first.calls.includes("execute"));
  const execution=deferred<AttachmentOperationResult>();const started=deferred<void>();
  const second=setup({execute:async()=>{started.resolve();return execution.promise;}});
  const running=second.workflow.collect(["note.md"]);await started.promise;await second.workflow.stop();
  assert.deepEqual(second.calls,["collect:note.md","cancel"]);assert.equal(second.workflow.getSnapshot().phase,"running");
  const partial={...result,status:"partial",completedFiles:1,totalFiles:3};execution.resolve(partial);await running;
  assert.equal(second.workflow.getSnapshot().result,partial);
});
test("failed stop request never claims termination; changed source fails without writing",async()=>{
  const pending=deferred<AttachmentOperationResult>();const started=deferred<void>();
  const {workflow}=setup({execute:async()=>{started.resolve();return pending.promise;},cancel:async()=>{throw Error("offline");}});
  const running=workflow.collect(["note.md"]);await started.promise;await workflow.stop();
  assert.equal(workflow.getSnapshot().phase,"running");assert.match(workflow.getSnapshot().error,/offline/);assert.equal(workflow.getSnapshot().cancelRequested,false);
  pending.resolve(result);await running;
  const switched=setup({capture:async()=>{throw Error("source changed");}});await switched.workflow.collect(["note.md"]);
  assert.equal(switched.workflow.getSnapshot().phase,"failed");assert.deepEqual(switched.calls,[]);
});
test("opening workflow does no IO; different Vaults retain separate import receipts",()=>{
  let reads=0;const a=setup({capture:async()=>{reads++;return 7;}}).workflow,b=setup().workflow;
  a.getSnapshot();const unsub=a.subscribe(()=>{});unsub();assert.equal(reads,0);
  const receipt={copiedCount:2,conflictRenamedCount:0,errors:[{sourcePath:"fixture.md",code:"missing",message:"fixture"}]};
  a.recordImport(receipt);assert.equal(b.getSnapshot().importReceipt,null);assert.equal(a.getSnapshot().importReceipt,receipt);
  a.reset();assert.equal(a.getSnapshot().importReceipt,receipt);a.clearImport();assert.equal(a.getSnapshot().importReceipt,null);
});
test("unresolvable collection retains diagnostics without executing an empty plan",async()=>{
  const {workflow,calls}=setup({collect:async()=>({...plan,files:[],issues:[{document:"note.md",target:"missing",status:"missing"}]})});
  await workflow.collect(["note.md"]);assert.equal(workflow.getSnapshot().phase,"finished");assert.equal(workflow.getSnapshot().plan?.issues.length,1);assert.deepEqual(calls,[]);
});

test("actual settings content renders without native IO or a nested dialog; only exceptions show receipts",async()=>{
  const {createServer}=await import("vite");
  const {createElement}=await import("react");
  const {renderToStaticMarkup}=await import("react-dom/server");
  const server=await createServer({root:fileURLToPath(new URL("..",import.meta.url)),server:{middlewareMode:true},appType:"custom"});
  try {
    const {VaultAttachmentsPanel}=await server.ssrLoadModule("/src/features/notes/VaultAttachmentsPanel.tsx");
    const {getVaultAttachmentWorkflow}=await server.ssrLoadModule("/src/core/services/vaultAttachments.ts");
    const props={vaultId:"synthetic-render-only",relativePath:"note.md",notePaths:["note.md"],hasUnsavedChanges:()=>false};
    const render=()=>renderToStaticMarkup(createElement(VaultAttachmentsPanel,props));
    const initial=render();assert.match(initial,/附件设置/);assert.match(initial,/attachments\//);assert.doesNotMatch(initial,/role="dialog"|aria-modal|<fieldset|<input/);
    assert.match(initial,/<details class="vault-attachment-maintenance">/);
    const workflow=getVaultAttachmentWorkflow(props.vaultId);
    workflow.recordImport({copiedCount:1,conflictRenamedCount:0,errors:[]});assert.doesNotMatch(render(),/导入结果/);
    workflow.recordImport({copiedCount:1,conflictRenamedCount:0,errors:[{sourcePath:"fixture.md",code:"missing",message:"fixture-only"}]});
    assert.match(render(),/导入结果/);assert.match(render(),/找不到引用的附件/);
    const {ImportResultNotice}=await server.ssrLoadModule("/src/features/notes/ImportResultNotice.tsx");
    const failed=renderToStaticMarkup(createElement(ImportResultNotice,{receipt:{copiedCount:0,failedCount:1,skippedCount:0,conflictRenamedCount:0,errors:[{sourcePath:"fixture.md",code:"import-incomplete",message:JSON.stringify({code:"knowledge-path-reparse-forbidden",message:"linked path"})}]},onClose:()=>{}}));
    assert.match(failed,/笔记未导入.*1 篇未完成/);assert.match(failed,/链接目录/);assert.doesNotMatch(failed,/正常附件已自动带入|import-incomplete|knowledge-path-reparse-forbidden/);
    const partial=renderToStaticMarkup(createElement(ImportResultNotice,{receipt:{copiedCount:1,failedCount:0,skippedCount:0,conflictRenamedCount:0,errors:[1,2,3,4,5].map(i=>({sourcePath:`Pasted image ${i}.png`,code:"source-inventory-incomplete",message:"unused"}))},onClose:()=>{}}));
    assert.match(partial,/笔记已导入，5 张图片未导入/);assert.equal((partial.match(/来源目录无法完整检查/g)||[]).length,1);assert.doesNotMatch(partial,/<details open/);assert.match(partial,/Pasted image 5.png/);
    const {summarizeImport}=await server.ssrLoadModule("/src/features/notes/ImportResultNotice.tsx");
    assert.match(summarizeImport({copiedCount:1,skippedCount:2,conflictRenamedCount:0,errors:["图.png#one","图.png#two"].map(sourcePath=>({sourcePath,code:"missing",message:""}))}).summary,/1 张图片未导入.*跳过 2 篇/);
    workflow.clearImport();assert.doesNotMatch(render(),/导入结果/);
  } finally {await server.close();}
});
