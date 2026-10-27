import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCanvasGenerationTask, canRetryCanvasGenerationTask, resumeCanvasVideoGenerationTask, type CanvasGenerationTask} from '../src/core/canvas/generationTasks.ts';
import {canvasGenerationTaskError} from '../src/core/canvas/generationErrors.ts';
import {createCanvasVideoGenerationAdapter, prepareCanvasVideoBridgeReferences} from '../src/core/canvas/videoGenerationAdapter.ts';
import {historyEntryFromTask, generationTaskFromHistory} from '../src/core/canvas/generationHistory.ts';
import {executeCanvasGenerationTask} from '../src/core/canvas/generationRunner.ts';
function failedVideo(): CanvasGenerationTask {
  return {...createCanvasGenerationTask({id:'task-stable',sourceNodeId:'n',resultNodeId:'n',createdAt:'2026-10-21T10:00:00Z',request:{kind:'video',prompt:'clouds',model:'cogvideox-flash',mediaProfileId:'zhipu-original',mediaProfileRevision:7,references:[{id:'r',label:'first',kind:'image',role:'firstFrame',mediaUrl:'local.png'}]}}),status:'failed',providerTaskId:'provider-42',error:canvasGenerationTaskError('video','timeout')};
}
test('poll retry keeps provider ID, client identity, original model and profile revision',()=>{
  const old=failedVideo();const retry=resumeCanvasVideoGenerationTask(old,'later')!;
  assert.equal(retry.id,old.id);assert.equal(retry.providerTaskId,'provider-42');assert.equal(retry.status,'queued');assert.equal(retry.error,null);
  assert.deepEqual(retry.request,old.request);assert.equal(retry.attempt,old.attempt);
  retry.request.references[0].label='changed';assert.equal(old.request.references[0].label,'first');
});
test('lost progress ID retains stable native ledger identity',()=>{
  const old=failedVideo();delete old.providerTaskId;
  assert.equal(resumeCanvasVideoGenerationTask(old,'later')?.id,'task-stable');
});
test('uncertain create is nonretryable and cannot become another generation',()=>{
  const old=failedVideo();old.error=canvasGenerationTaskError('video','submission_unknown');delete old.providerTaskId;
  assert.equal(old.error.retryable,false);assert.equal(canRetryCanvasGenerationTask(old),false);
  assert.equal(resumeCanvasVideoGenerationTask(old,'later'),null);
});
test('changed submission binding cannot be retried',()=>{
  const old=failedVideo();old.error=canvasGenerationTaskError('video','submission_binding_changed');
  assert.equal(old.error.retryable,false);assert.equal(resumeCanvasVideoGenerationTask(old,'later'),null);
});
test('resume helper excludes image, active and completed jobs',()=>{
  for (const status of ['queued','running','succeeded'] as const) assert.equal(resumeCanvasVideoGenerationTask({...failedVideo(),status},'later'),null);
  const image=failedVideo();image.request.kind='image';assert.equal(resumeCanvasVideoGenerationTask(image,'later'),null);
});
test('cancelled video resumes the original provider ID',()=>{
  const old={...failedVideo(),status:'cancelled' as const};const retry=resumeCanvasVideoGenerationTask(old,'later')!;
  assert.equal(retry.providerTaskId,old.providerTaskId);assert.equal(retry.id,old.id);
});
test('repeated timeout and resume polls same job without a second create',async()=>{
  let creates=0;let polls=0;let task=resumeCanvasVideoGenerationTask(failedVideo(),'later')!;
  for(let attempt=0;attempt<2;attempt++) {
    const adapter=createCanvasVideoGenerationAdapter(async request=>{
      assert.equal(request.mediaProfileId,'zhipu-original');
      if(task.providerTaskId)polls++;else creates++;
      return attempt===0?{success:false,error_kind:'timeout'}:{success:true,videoUrl:'file://video.mp4'};
    });
    const result=await executeCanvasGenerationTask({task,adapters:[adapter],now:()=> 'later',onTransition(){},isCancelled:()=>false});
    if(result.outcome==='failed') task=resumeCanvasVideoGenerationTask(result.task,'later')!;
    else assert.equal(result.outcome,'succeeded');
  }
  assert.equal(creates,0);assert.equal(polls,2);
});
test('empty response uses provider-neutral wording',async()=>{
  const result=await createCanvasVideoGenerationAdapter(async()=>({success:true})).execute(failedVideo().request);
  assert.equal(result.ok,false);if(!result.ok)assert.doesNotMatch(result.error.message,/Agnes/);
});
test('production bridge forwards durable identity and checkpoints accepted IDs',()=>{
  const canvas=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
  assert.match(canvas,/aiVideoGenerate!\(request, onProgress, task\.providerTaskId, task\.id\)/);
  assert.match(canvas,/resumeCanvasVideoGenerationTask\(task,/);
  assert.match(canvas,/resumeCanvasVideoGenerationTask\(historyTask,/);
  assert.match(canvas,/task\.providerTaskId !== previousTask\?\.providerTaskId[\s\S]{0,80}return flushPendingAutosave\(\)/);
  assert.match(app,/const clientTaskId = persistedClientTaskId \|\|/);
});

test('persisted history recovery retains original provider identity and nonretryable unknown outcome',()=>{
  const original=failedVideo();
  const restored=generationTaskFromHistory(JSON.parse(JSON.stringify(historyEntryFromTask(original))));
  const resumed=resumeCanvasVideoGenerationTask(restored,'later')!;
  assert.equal(resumed.id,original.id);assert.equal(resumed.providerTaskId,original.providerTaskId);
  assert.equal(resumed.request.mediaProfileRevision,7);
  original.error=canvasGenerationTaskError('video','submission_unknown');
  assert.equal(resumeCanvasVideoGenerationTask(generationTaskFromHistory(historyEntryFromTask(original)),'later'),null);
});
test('actual create versus resume bridge payload skips vanished local file reads',async()=>{
  const request=failedVideo().request;
  let reads=0;
  const created=await prepareCanvasVideoBridgeReferences(request,undefined,async()=>{reads++;return 'data:image/png;base64,aW1hZ2U=';});
  const resumed=await prepareCanvasVideoBridgeReferences(request,'provider-42',async()=>{throw Error('file removed');});
  assert.equal(reads,1);assert.equal(created[0].media_url,'data:image/png;base64,aW1hZ2U=');
  assert.equal(resumed[0].media_url,'local.png');assert.equal(created[0].id,resumed[0].id);assert.equal(created[0].role,resumed[0].role);
  assert.equal(request.references[0].mediaUrl,'local.png');
});
test('Flash prompt limit is actionable and nonretryable without exposing provider text',()=>{
  const error=canvasGenerationTaskError('video',{error_kind:'bigmodel_prompt_too_long',error_message:'secret provider body'});
  assert.equal(error.retryable,false);assert.match(error.message,/512/);assert.doesNotMatch(error.message,/secret/);
});
test('Flash invalid reference is actionable and nonretryable',()=>{
  const error=canvasGenerationTaskError('video','bigmodel_reference_invalid');
  assert.equal(error.retryable,false);assert.match(error.message,/PNG\/JPEG/);assert.match(error.message,/5 MB/);
});
