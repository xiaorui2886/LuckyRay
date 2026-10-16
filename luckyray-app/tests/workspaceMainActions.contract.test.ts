import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createWorkspaceMainActionConsumer,type WorkspaceActionClaim,type WorkspaceMainActionServices,type WorkspaceMainActionTransport,type WorkspaceMainAction} from '../src/workspace/mainActionProtocol.ts';
const id='a'.repeat(32),claimToken='b'.repeat(32);
function fixture(action:WorkspaceMainAction){
 const calls:string[]=[];let alive=true,now=0;
 let source:{vaultId:string}|null={vaultId:'vault-a'};
 const claim:WorkspaceActionClaim={id,claimToken,remainingMs:120_000,action};
 const transport:WorkspaceMainActionTransport={
  pending:async()=>[{id,title:'origin',viewId:'child-view'}],claim:async()=>{calls.push('claim');return claim;},
  validate:async()=>{calls.push('validate');return 120_000;},
  execute:async(_id,_token,confirmed)=>{calls.push(`execute:${confirmed}`);return action.kind==='fileOperation'?{kind:'acknowledged'}:{kind:'openView',view:{id:'new-main-view',kind:'note',libraryId:'vault-a',resourceId:'A.md',title:'A'}};},
  complete:async(_id,_token,result)=>{calls.push(`complete:${result}`);},cancel:async()=>{calls.push('cancel');},
 };
 const services:WorkspaceMainActionServices={now:()=>now,alive:()=>alive,knowledgeSource:()=>source,confirmCreate:()=>{calls.push('confirm');return true;},openBoundNote:()=>{calls.push('openBound');},openTag:()=>{calls.push('openTag');},compose:()=>{calls.push('compose');}};
 return {calls,transport,services,claim,create:()=>createWorkspaceMainActionConsumer(transport,services),setAlive:(next:boolean)=>{alive=next;},setNow:(next:number)=>{now=next;},setSource:(next:{vaultId:string}|null)=>{source=next;}};
}
test('AI handoff stages existing composer once without calling execute or a send API',async()=>{
 const f=fixture({kind:'composeAi',source:'notes',text:'backend-bound context'});const consumer=f.create();
 await Promise.all([consumer.drain(),consumer.drain()]);await consumer.drain();
 assert.deepEqual(f.calls,['claim','validate','compose','complete:performed']);
});
test('only an explicit Main create confirmation allows create execution',async()=>{
 const f=fixture({kind:'createMissing',vaultId:'vault-a',relativePath:'Folder/New.md',title:'New'});
 f.services.confirmCreate=()=>{f.calls.push('confirm');return false;};await f.create().drain();
 assert.deepEqual(f.calls,['claim','confirm','complete:cancelled']);
 const g=fixture({kind:'createMissing',vaultId:'vault-a',relativePath:'New.md',title:'New'});await g.create().drain();
 assert.deepEqual(g.calls,['claim','confirm','execute:true','openBound','complete:performed']);
});
test('closing or expiry during confirmation never executes or opens anything',async()=>{
 for(const condition of ['close','expire']){
  const f=fixture({kind:'createMissing',vaultId:'vault-a',relativePath:'New.md',title:'New'});
  f.services.confirmCreate=async()=>{if(condition==='close')f.setAlive(false);else f.setNow(120_001);return true;};
  const failures:unknown[]=[];await f.create().drain(error=>failures.push(error));
  assert.equal(failures.length,1);assert.deepEqual(f.calls,['claim','complete:failed']);
 }
});
test('global Tags navigation rejects a switched source including same-ID reopened sources',async()=>{
 for(const vaultId of ['vault-a','vault-b']){
  const f=fixture({kind:'openTag',vaultId:'vault-a',name:'bound-tag'});
  f.transport.validate=async()=>{f.setSource({vaultId});return 120_000;};await f.create().drain();
  assert.deepEqual(f.calls,['claim','complete:failed']);
 }
});
test('open document uses only returned captured Main binding, never global note navigation',async()=>{
 const f=fixture({kind:'openDocument',vaultId:'vault-a',title:'A'});await f.create().drain();
 assert.deepEqual(f.calls,['claim','execute:false','openBound','complete:performed']);
 const g=fixture({kind:'openDocument',vaultId:'vault-a',title:'A'});
 g.transport.execute=async()=>({kind:'openView',view:{id:'foreign',kind:'note',libraryId:'vault-b',resourceId:'private.md',title:'Private'}});
 await g.create().drain();assert.deepEqual(g.calls,['claim','complete:failed']);
});
test('uncertain composer/execute responses are never retried by a later drain',async()=>{
 const f=fixture({kind:'composeAi',source:'graph',text:'bound node'});
 f.services.compose=()=>{f.calls.push('compose');throw Error('uncertain');};const c=f.create();await c.drain();await c.drain();
 assert.deepEqual(f.calls,['claim','validate','compose','complete:failed']);
});
test('oversized context, foreign claim and expired claim fail before staging',async()=>{
 for(const kind of ['text','identity','expiry']){
  const f=fixture({kind:'composeAi',source:'notes',text:kind==='text'?'x'.repeat(12*1024+1):'context'});
  if(kind==='identity')f.claim.id='c'.repeat(32);if(kind==='expiry')f.claim.remainingMs=0;
  await f.create().drain();assert.ok(!f.calls.includes('compose'));assert.ok(!f.calls.some(call=>call.startsWith('execute')));
 }
});
test('Main consumer calls existing composer, remains outside child, and native broker is bounded',()=>{
 const main=readFileSync(new URL('../src/workspace/WorkspaceMainActions.tsx',import.meta.url),'utf8');
 assert.match(main,/openInLightSeek\(request\)/);assert.match(main,/waitForOpenInLightSeekIntent\(intent.intentId\)/);assert.match(main,/windowLayoutStore\('main'\)/);
 for(const forbidden of ['aiChatComplete','getLuckyRayBridgeSync','activateKnowledge','registerCurrentVault'])assert.ok(!main.includes(forbidden));
 const backend=readFileSync(new URL('../src-tauri/src/workspace_actions.rs',import.meta.url),'utf8');
 for(const required of ['MAX_PENDING','MAX_PER_WINDOW','Duration::from_secs(120)','node_for_scope','read_document_for_target','create_document_for_target','workspace-action-confirmation-required','entry.view == *view','entry.correlation == *correlation','entry.execution_succeeded','workspace-action-library-item-adapter-required'])assert.ok(backend.includes(required),required);
 const production=backend.split('#[cfg(test)]')[0];assert.ok(!production.includes('std::fs::write'));assert.ok(!production.includes('register_current_vault'));
 const helper=readFileSync(new URL('../src-tauri/src/knowledge/workspace_action_paths.rs',import.meta.url),'utf8');
 for(const required of ['workspace_recovery_record','safe_existing_file','knowledge_target_identity','snapshot.revision != revision','assert_expected_target_unlocked'])assert.ok(helper.includes(required),required);
});
test('backend-confirmed origin destination leaves Main route and layout untouched',async()=>{
 const f=fixture({kind:'openDocument',vaultId:'vault-a',title:'A'});
 f.transport.execute=async()=>({kind:'openedInOrigin',viewId:'new-origin-view'});
 await f.create().drain();assert.deepEqual(f.calls,['claim','complete:performed']);
});

test('composer completion waits for real existing-coordinator delivery acknowledgment',async()=>{
 const f=fixture({kind:'composeAi',source:'notes',text:'bound context'});let acknowledge:()=>void=()=>{};
 f.services.compose=()=>new Promise<void>(resolve=>{f.calls.push('compose');acknowledge=resolve;});
 const pending=f.create().drain();await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(f.calls,['claim','validate','compose']);acknowledge();await pending;
 assert.equal(f.calls.at(-1),'complete:performed');
});
