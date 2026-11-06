import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationScheduler, getRuntimeGenerationScheduler, generationSlot, queuedGenerationTasks, normalizeGenerationConcurrencyPolicy, DEFAULT_GENERATION_CONCURRENCY_POLICY as defaults } from '../src/core/canvas/generationScheduler.ts';
import { createCanvasGenerationTask } from '../src/core/canvas/generationTasks.ts';
const profiles = [{id:'a',imageProtocol:'openai-image',videoProtocol:'openai-video'}, {id:'b',imageProtocol:'gemini-image'}, {id:'doubao',videoProtocol:'doubao-video'}, {id:'ark',imageProtocol:'ark-image',videoProtocol:'ark-video'}];
function task(id: string, kind: 'image'|'video'|'text' = 'image', connection = 'a', node = id) {
  return createCanvasGenerationTask({id,sourceNodeId:node,resultNodeId:node,request:{kind,prompt:'test',model:'model',mediaProfileId:connection,textProfileId:connection,references:[]},createdAt:`2026-01-01T00:00:${id.padStart(2,'0')}Z`});
}
const slot = (id: string, kind: 'image'|'video'|'text' = 'image', connection = 'a', canvas = 'canvas-a', node = id) => generationSlot(task(id,kind,connection,node),canvas,profiles);
test('defaults permit image+image, video+video and mixed work for every configured API',()=>{
  for(const kinds of [['image','image'],['video','video'],['image','video']] as const){
    for(const connection of ['a','b','ark']){
      const scheduler=new GenerationScheduler();
      assert.equal(scheduler.reserve(slot('1',kinds[0],connection),defaults),true);
      assert.equal(scheduler.reserve(slot('2',kinds[1],connection),defaults),true);
    }
  }
});
test('global, kind and shared connection caps apply across canvases and kinds',()=>{
  const s=new GenerationScheduler();
  assert.ok(s.reserve(slot('1','image','a'),defaults));
  assert.ok(s.reserve(slot('2','video','a','canvas-b'),defaults));
  assert.equal(s.reserve(slot('3','image','a','canvas-c'),defaults),false);
  assert.ok(s.reserve(slot('4','image','b'),defaults));
  assert.ok(s.reserve(slot('5','video','b'),defaults));
  assert.equal(s.reserve(slot('6','text','other'),defaults),false);
  const images=new GenerationScheduler();
  assert.ok(images.reserve(slot('1','image','a'),defaults));assert.ok(images.reserve(slot('2','image','a'),defaults));assert.ok(images.reserve(slot('3','image','b'),defaults));
  assert.equal(images.reserve(slot('4','image','b'),defaults),false);
});
test('duplicate tasks and same-canvas node reservations fail; same node on another canvas is independent',()=>{
  const s=new GenerationScheduler();assert.ok(s.reserve(slot('1','image','a','first','node'),defaults));
  assert.equal(s.reserve(slot('1','image','a','second','other'),defaults),false);
  assert.equal(s.reserve(slot('2','image','b','first','node'),defaults),false);
  assert.ok(s.reserve(slot('3','image','b','second','node'),defaults));
});
test('unknown connections and Doubao remain conservative; revisions do not create new lanes',()=>{
  for(const connection of ['missing','doubao']){
    const s=new GenerationScheduler();assert.ok(s.reserve(slot('1','image',connection),defaults));assert.equal(s.reserve(slot('2','video',connection),defaults),false);
  }
  const t=task('1'); const before=generationSlot(t,'c',profiles);t.request.mediaProfileRevision=999;
  assert.equal(generationSlot(t,'c',profiles).connectionId,before.connectionId);
  assert.deepEqual(Object.keys(before).sort(),['canvasId','connectionId','conservative','doubao','kind','nodeId','taskId']);
});
test('FIFO eligible jobs bypass blocked lanes, deduplicate, and exclude uncertain failed tasks',()=>{
  const s=new GenerationScheduler();s.reserve(slot('running1'),defaults);s.reserve(slot('running2'),defaults);
  const failed={...task('0'),status:'failed' as const,error:{code:'SUBMISSION_UNKNOWN',message:'unknown',retryable:false}};
  const resumed={...task('4','video','b'),providerTaskId:'accepted-job'};
  const queue=queuedGenerationTasks([task('3','image','b'),task('1'),task('2','image','b'),task('2','image','b'),failed,resumed]);
  assert.deepEqual(queue.map(t=>t.id),['1','2','3','4']);
  const selected=queue.filter(t=>s.reserve(generationSlot(t,'c',profiles),defaults));
  assert.deepEqual(selected.map(t=>t.id),['2','4']);
  assert.equal(resumed.providerTaskId,'accepted-job');
});
test('failure/cancellation release slots only after worker finally, including thrown work',async()=>{
  const s=new GenerationScheduler();const policy={...defaults,global:1};
  let settle!:()=>void;const pending=new Promise<void>(resolve=>{settle=resolve;});
  assert.ok(s.reserve(slot('1'),policy));
  const worker=(async()=>{try{await pending;throw Error('cancelled or failed');}catch{}finally{s.release('1');}})();
  assert.equal(s.reserve(slot('2'),policy),false);settle();await worker;
  assert.ok(s.reserve(slot('2'),policy));s.release('2');s.release('2');assert.equal(s.size,0);
});
test('backpressure pauses only its connection, resumes queued jobs, never retries failed submissions',()=>{
  const s=new GenerationScheduler();s.reserve(slot('1'),defaults,0);s.backpressure('1','RATE_LIMITED',100);s.release('1');
  assert.equal(s.reserve(slot('2'),defaults,101),false);assert.ok(s.reserve(slot('3','video','b'),defaults,101));
  assert.equal(s.nextWakeDelay(101),29999);assert.ok(s.reserve(slot('2'),defaults,30100));assert.equal(s.nextWakeDelay(30100),undefined);
});
test('invalid persisted values normalize safely and capacity reductions do not evict work',()=>{
  assert.deepEqual(normalizeGenerationConcurrencyPolicy({global:Infinity,image:0,video:1.5,text:'8',perConnection:-1}),defaults);
  assert.equal(normalizeGenerationConcurrencyPolicy({global:999}).global,8);
  const s=new GenerationScheduler();s.reserve(slot('1'),defaults);s.reserve(slot('2'),defaults);
  assert.equal(s.reserve(slot('3','video','b'),{...defaults,global:1}),false);assert.equal(s.size,2);
});

test('Canvas runtime uses reservation accounting rather than foreground node lookup and wakes after settlement',async()=>{
  const {readFileSync}=await import('node:fs');const source=readFileSync('src/CanvasSpike.tsx','utf8');
  const execution=source.slice(source.indexOf('  const executeGenerationTask ='),source.indexOf('  const submitGenerationFromNode ='));
  const scheduling=source.slice(source.indexOf('    const queuedTasks = queuedGenerationTasks('),source.indexOf('  const openNodeReference ='));
  assert.match(execution,/finally\s*\{\s*generationSchedulerRef\.current\.release\(task\.id\)/);
  assert.match(source,/scheduler\.subscribe\(wake\)/);
  assert.match(source,/useRef\(getRuntimeGenerationScheduler\(\)\)/);
  assert.match(scheduling,/generationSchedulerRef\.current\.reserve\(slot,/);
  assert.doesNotMatch(scheduling,/runningByKind|generationHistoryRef/);
  assert.match(scheduling,/nextWakeDelay/);
  const cancel=source.slice(source.indexOf('  const cancelGenerationTask ='),source.indexOf('  const retryGeneration ='));
  assert.doesNotMatch(cancel,/\.release\(/);
});


test('legacy no-ID jobs retain image1 plus video1 plus text2 without fabricated account identity',()=>{
  const s=new GenerationScheduler();
  assert.ok(s.reserve(slot('1','image',''),defaults));
  assert.equal(s.reserve(slot('2','image',''),defaults),false);
  assert.ok(s.reserve(slot('3','video',''),defaults));
  assert.equal(s.reserve(slot('4','video',''),defaults),false);
  assert.ok(s.reserve(slot('5','text',''),defaults));
  assert.ok(s.reserve(slot('6','text',''),defaults));
  assert.equal(s.size,4);
});
test('text profile absent from media catalog is not downgraded below text budget',()=>{
  const s=new GenerationScheduler();
  assert.ok(s.reserve(slot('1','text','text-catalog-id'),defaults));
  assert.ok(s.reserve(slot('2','text','text-catalog-id'),defaults));
  assert.equal(s.reserve(slot('3','text','text-catalog-id'),defaults),false);
});


test('remounted consumers share in-flight budget and settlement wakes the new consumer only',()=>{
  const first=getRuntimeGenerationScheduler();const second=getRuntimeGenerationScheduler();
  assert.equal(first,second);let oldWakes=0,newWakes=0;
  const unmount=first.subscribe(()=>oldWakes++);
  assert.ok(first.reserve(slot('runtime-old'),{...defaults,global:1}));
  unmount();const unsubscribe=second.subscribe(()=>newWakes++);
  assert.ok(second.has('runtime-old'));assert.equal(second.reserve(slot('runtime-new','video','b'),{...defaults,global:1}),false);
  const previous=second.version;first.release('runtime-old');
  assert.equal(oldWakes,0);assert.equal(newWakes,1);assert.equal(second.version,previous+1);
  assert.ok(second.reserve(slot('runtime-new','video','b'),{...defaults,global:1}));
  unsubscribe();second.release('runtime-new');assert.equal(newWakes,1);assert.equal(first.size,0);
});


test('Doubao opt-in two admits image/image, video/video and mixed, never a third',()=>{
  for(const kinds of [['image','image'],['video','video'],['image','video']] as const){
    const s=new GenerationScheduler();const policy={...defaults,doubao:2};
    assert.ok(s.reserve(slot('1',kinds[0],'doubao'),policy));
    assert.ok(s.reserve(slot('2',kinds[1],'doubao'),policy));
    assert.equal(s.reserve(slot('3','image','doubao'),policy),false);
  }
});
test('Doubao opt-in remains bound by every enclosing policy and unknown profiles stay conservative',()=>{
  for(const policy of [{...defaults,doubao:1},{...defaults,doubao:2,perConnection:1},{...defaults,doubao:2,global:1},{...defaults,doubao:2,image:1}]){
    const s=new GenerationScheduler();assert.ok(s.reserve(slot('1','image','doubao'),policy));assert.equal(s.reserve(slot('2','image','doubao'),policy),false);
  }
  const s=new GenerationScheduler();assert.ok(s.reserve(slot('1','image','missing'),{...defaults,doubao:2}));assert.equal(s.reserve(slot('2','video','missing'),{...defaults,doubao:2}),false);
  assert.equal(normalizeGenerationConcurrencyPolicy({doubao:99}).doubao,2);
  for(const invalid of [0,-1,1.5,'2',NaN,null]) assert.equal(normalizeGenerationConcurrencyPolicy({doubao:invalid}).doubao,1);
  assert.equal(normalizeGenerationConcurrencyPolicy({}).doubao,1);
});

// Exercise the adapter's real error contract, rather than only synthetic bare codes.
test('image and video adapter throttling pauses only the affected connection', async () => {
  const { createCanvasImageGenerationAdapter } = await import('../src/core/canvas/imageGenerationAdapter.ts');
  const { createCanvasVideoGenerationAdapter } = await import('../src/core/canvas/videoGenerationAdapter.ts');
  for (const kind of ['image', 'video'] as const) {
    for (const error_kind of ['rate_limited', 'account_rate_limited', 'provider_overloaded']) {
      const scheduler = new GenerationScheduler();
      scheduler.reserve(slot('1', kind), defaults, 0);
      const generate = async () => ({ success: false, error_kind });
      const adapter = kind === 'image' ? createCanvasImageGenerationAdapter(generate) : createCanvasVideoGenerationAdapter(generate);
      const result = await adapter.execute(task('1', kind).request);
      assert.equal(result.ok, false);
      if (result.ok) throw Error('expected provider failure');
      scheduler.backpressure('1', result.error.code, 100);
      scheduler.release('1');
      assert.equal(scheduler.reserve(slot('2', kind), defaults, 101), false);
      assert.equal(scheduler.reserve(slot('3', kind, 'b'), defaults, 101), true);
      assert.equal(scheduler.nextWakeDelay(101), 29999);
      assert.equal(scheduler.reserve(slot('2', kind), defaults, 30100), true);
    }
  }
});

test('ordinary failures do not create a connection cooldown', () => {
  for (const code of ['IMAGE_REQUEST_INVALID', 'VIDEO_PROVIDER_ERROR', 'IMAGE_RATE_LIMITED_EXTRA']) {
    const scheduler = new GenerationScheduler();
    scheduler.reserve(slot('1'), defaults, 0);
    scheduler.backpressure('1', code, 100);
    scheduler.release('1');
    assert.equal(scheduler.nextWakeDelay(101), undefined);
    assert.equal(scheduler.reserve(slot('2'), defaults, 101), true);
  }
});
