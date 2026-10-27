// Synthetic regression only. Never calls a provider or reads user configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {videoParameterSummary} from '../src/core/canvas/mediaOptionPresentation';
import {canvasGenerationSubmissionLabel,createCanvasGenerationTask} from '../src/core/canvas/generationTasks';
import {canvasGenerationFailure,canvasGenerationTaskError} from '../src/core/canvas/generationErrors';
import {historyEntryFromTask,generationTaskFromHistory} from '../src/core/canvas/generationHistory';
import {createCanvasVideoGenerationAdapter} from '../src/core/canvas/videoGenerationAdapter';
import {executeCanvasGenerationTask} from '../src/core/canvas/generationRunner';

const task=()=>createCanvasGenerationTask({id:'synthetic',sourceNodeId:'n',resultNodeId:'n',createdAt:'now',request:{kind:'video',prompt:'synthetic shapes',model:'cogvideox-flash',references:[]}});
test('empty and partial video options have no undefined units or empty separators',()=>{
  assert.equal(videoParameterSummary({}), '');
  assert.equal(videoParameterSummary({aspect:'',quality:'',duration:undefined,sound:''}), '');
  assert.equal(videoParameterSummary({aspect:'16:9'}), '16:9');
  assert.equal(videoParameterSummary({quality:'720p',duration:5}), '720p · 5s');
  assert.equal(videoParameterSummary({aspect:'9:16',quality:'720p',duration:12,sound:'声音'}),'9:16 · 720p · 12s · 声音');
  for(const duration of [NaN,Infinity,0,-1]) assert.equal(videoParameterSummary({duration}),'');
});
test('local queue and submission are not supplier acceptance without an ID',()=>{
  const t=task();assert.equal(canvasGenerationSubmissionLabel(t,false),'本地排队');
  assert.equal(canvasGenerationSubmissionLabel({...t,status:'running'},false),'提交中');
  assert.equal(canvasGenerationSubmissionLabel({...t,status:'running',providerStage:'queued'},false),'提交中');
  assert.equal(canvasGenerationSubmissionLabel({...t,status:'running',providerStage:'generating'},false),'提交中');
  assert.equal(canvasGenerationSubmissionLabel({...t,status:'running',providerTaskId:'supplier-123'},false),'供应商已受理');
});
test('failure/cancellation always replace acceptance and success is complete',()=>{
  const t={...task(),providerTaskId:'supplier-123'};
  assert.equal(canvasGenerationSubmissionLabel({...t,status:'failed'},false),'提交失败');
  assert.equal(canvasGenerationSubmissionLabel({...t,status:'cancelled'},false),'已取消');
  assert.equal(canvasGenerationSubmissionLabel({...t,status:'succeeded'},false),'已完成');
  assert.equal(canvasGenerationSubmissionLabel(undefined,false),'');
});
test('diagnostics persist only the four allowlisted fields; no message/header/body/key/content',()=>{
  const raw={error_kind:'account_rate_limited',error_detail:JSON.stringify({stage:'submit',httpStatus:429,vendorCode:'1302',requestId:'req-synthetic-42',authorization:'Bearer TEST_SECRET',headers:{key:'TEST_SECRET'},body:'private synthetic text',message:'private synthetic text'})};
  const failure=canvasGenerationFailure(raw),error=canvasGenerationTaskError('video',failure);
  assert.deepEqual(JSON.parse(error.detail!),{stage:'submit',httpStatus:429,vendorCode:'1302',requestId:'req-synthetic-42'});
  assert.doesNotMatch(JSON.stringify(error),/TEST_SECRET|private synthetic|authorization|headers|body/);
  const saved=historyEntryFromTask({...task(),status:'failed',error});
  assert.equal(generationTaskFromHistory(saved).error?.detail,error.detail);
});
test('diagnostic boundary rejects arbitrary prose, URLs, bearer values, JWT-like keys and invalid stages',()=>{
  for(const detail of ['Bearer TEST_SECRET','private synthetic prompt',JSON.stringify({stage:'prompt text',httpStatus:'429',vendorCode:'Bearer TEST_SECRET',requestId:'https://secret.invalid/key'})]){
    assert.equal(canvasGenerationTaskError('video',{error_detail:detail}).detail,undefined);
  }
  const error=canvasGenerationTaskError('video',{error_detail:JSON.stringify({stage:'submit',httpStatus:429,vendorCode:'secret.key.token',requestId:'secret.key.token'})});
  assert.deepEqual(JSON.parse(error.detail!),{stage:'submit',httpStatus:429,vendorCode:null,requestId:null});
});
test('account rate, platform overload, permission, balance and unknown remain distinct',()=>{
  const kinds=['account_rate_limited','provider_overloaded','permission_denied','insufficient_balance','account_restricted','usage_limit','provider_error'];
  const messages=kinds.map(error_kind=>canvasGenerationFailure({error_kind}).error_message);
  assert.equal(new Set(messages).size,kinds.length);
  const unknown=canvasGenerationTaskError('video',{error_kind:'not_a_known_kind',error_detail:JSON.stringify({stage:'submit',httpStatus:429,vendorCode:'9999',requestId:null})});
  assert.equal(unknown.code,'VIDEO_PROVIDER_ERROR');assert.match(unknown.message,/未知|未明确/);assert.doesNotMatch(unknown.message,/余额|权限|过载|账户/);
});
test('one failed submission becomes failed once, never retries, and preserves safe diagnostics',async()=>{
  let calls=0;const transitions:any[]=[];
  const adapter=createCanvasVideoGenerationAdapter(async()=>{calls++;return {success:false,error_kind:'provider_overloaded',error_detail:JSON.stringify({stage:'submit',httpStatus:429,vendorCode:'1305',requestId:'req-synthetic-42'})};});
  const result=await executeCanvasGenerationTask({task:task(),adapters:[adapter],now:()=> 'later',onTransition:t=>transitions.push(t),isCancelled:()=>false});
  assert.equal(calls,1);assert.equal(result.outcome,'failed');assert.deepEqual(transitions.map(t=>t.status),['running','failed']);
  const failed=transitions.at(-1);assert.equal(failed.providerTaskId,undefined);assert.equal(canvasGenerationSubmissionLabel(failed,false),'提交失败');
  assert.equal(JSON.parse(failed.error.detail).vendorCode,'1305');
});
test('composer uses task state, not a latched created hint; settings depend on real choices',()=>{
  const source=readFileSync('src/CanvasSpike.tsx','utf8');
  const composer=source.slice(source.indexOf('function MaterialCompactComposer('),source.indexOf('function MaterialGenerationInspector('));
  assert.match(composer,/videoParameterSummary\(/);assert.match(composer,/canvasGenerationSubmissionLabel\(node\.data\.generationTask/);
  assert.doesNotMatch(composer,/setShowHint|generation\.taskCreated|\$\{duration\}s/);
  assert.match(composer,/hasComposerSettings/);
});
