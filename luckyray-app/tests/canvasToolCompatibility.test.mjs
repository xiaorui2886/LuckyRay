import test from 'node:test';
import assert from 'node:assert/strict';
import {validCreationPayload,validateCanvasCreationPayload,creationValidationIssues,assertCanvasToolBusinessResult,normalizeCanvasToolStatuses} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs';
const revision='0123456789abcdef';
const shot=()=>({expectedRevision:revision,operation:{op:'shot.update',boardId:'board-1',shotId:'shot-1',fields:{lighting:'private light',sound:'private sound',durationSeconds:5}}});
test('official valid writes stay strict-compatible; lighting and sound allowed',()=>{
 for(const args of [{expectedRevision:revision,operation:{op:'storyboard.create',name:'Synthetic',nodeIds:[]}},shot()])assert.deepEqual(validateCanvasCreationPayload(args,'edit'),args);
});
test('Gemini missing/wrong op gets protocol-only allowed operations, not guessed or edited',()=>{
 for(const op of [{type:'SECRET',title:'SECRET'},{op:'create_storyboard',title:'SECRET'}]){
  const args={expectedRevision:revision,operation:op},before=JSON.stringify(args);
  assert.equal(validCreationPayload(args,'edit'),false);
  assert.throws(()=>validateCanvasCreationPayload(args,'edit'),e=>{assert.equal(e.code,'canvas-agent-creation-invalid');assert.match(e.message,/\$\.operation\.op/);assert.match(e.message,/storyboard.create/);assert.ok(!e.message.includes('SECRET'));return true;});
  assert.equal(JSON.stringify(args),before);
 }
});
test('DeepSeek extra kind points to safe field and lists legal keys; no silent stripping',()=>{
 const args=shot();args.operation.kind='PRIVATE';
 const issues=creationValidationIssues(args,'edit');assert.equal(issues[0].path,'$.operation.kind');assert.equal(issues[0].rule,'additionalProperties');assert.ok(issues[0].expected.includes('fields'));
 assert.throws(()=>validateCanvasCreationPayload(args,'edit'));assert.equal(args.operation.kind,'PRIVATE');
});
test('unknown keys and user values never appear in feedback; field errors bounded',()=>{
 const args=shot();args.operation['SECRET_API_KEY']= 'secret';args.operation.fields.durationSeconds='private';
 const issues=creationValidationIssues(args,'edit'),json=JSON.stringify(issues);
 assert.ok(!/SECRET|secret|private/.test(json));assert.ok(issues.some(i=>i.path==='$.operation.*'));assert.ok(issues.some(i=>i.path==='$.operation.fields.durationSeconds'&&i.rule==='type'));
 assert.ok(issues.length<=8);
});
test('failed is an error, applied-unconfirmed stops; awaiting-user remains a handoff',()=>{
 for(const summary of ['canvas-agent-creation-select-media','private user text'])assert.throws(()=>assertCanvasToolBusinessResult({status:'failed',summary}),e=>{assert.ok(!e.message.includes('private user text'));return true;});
 const waiting={status:'completed',creation:{completion:'awaiting-user'}};assert.equal(assertCanvasToolBusinessResult(waiting),waiting);
 assert.throws(()=>assertCanvasToolBusinessResult({status:'failed',creation:{completion:'applied-unconfirmed'}}),/stop-await-user/);
});

test('legacy completed snapshots only correct exact known failure, not awaiting-user or prose',()=>{
 const snapshot={tools:[
  {name:'canvas_read_creation',status:'completed',summary:'canvas-agent-creation-missing-board'},
  {name:'canvas_open_creation',status:'completed',summary:'canvas-agent-creation-select-media'},
  {name:'canvas_open_creation',status:'completed',summary:'Panel prepared; awaiting-user'},
  {name:'canvas_edit_creation',status:'completed',summary:'The model said failed in a title'},
  {name:'unrelated',status:'completed',summary:'canvas-agent-creation-missing-board'},
 ]};
 assert.deepEqual(normalizeCanvasToolStatuses(snapshot).tools.map(t=>t.status),['failed','failed','completed','completed','completed']);
});
