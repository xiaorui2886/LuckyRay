import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nextComfySeed, comfySeedAfterQueued, comfySeedForNewTask} from '../src/core/canvas/comfySeed.ts';
import {buildWorkFisherImage, buildWorkFisherVideo} from '../src/core/canvas/workFisherPreset.ts';
import {parseComfyWorkflow, compileComfyWorkflow} from '../src/core/canvas/comfyWorkflow.ts';
import {captureWorkflow, instantiateWorkflow, validateWorkflow} from '../src/core/canvas/workflowTemplates.ts';

test('seed modes keep safe integer boundaries and do not randomize fixed/increment/decrement', () => {
  const unused = () => {throw Error('unexpected entropy');};
  assert.equal(nextComfySeed(42, 'fixed', unused), 42);
  assert.equal(nextComfySeed(42, 'increment', unused), 43);
  assert.equal(nextComfySeed(42, 'decrement', unused), 41);
  assert.equal(nextComfySeed(Number.MAX_SAFE_INTEGER, 'increment'), 0);
  assert.equal(nextComfySeed(0, 'decrement'), Number.MAX_SAFE_INTEGER);
  assert.equal(nextComfySeed(42, 'randomize', () => 123456), 123456);
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) assert.throws(() => nextComfySeed(invalid, 'fixed'));
  assert.throws(() => nextComfySeed(42, 'invalid'));
  assert.throws(() => nextComfySeed(42, 'randomize', () => -1));
});

test('new queued seeds follow the actual image/video graph without mutating immutable task inputs', () => {
  const graphs = [
    ['image', buildWorkFisherImage({preset:'work-fisher-character', prompt:'synthetic', referenceCount:0, seed:71})],
    ['image', buildWorkFisherImage({preset:'work-fisher-three-view', prompt:'synthetic', referenceCount:1, seed:71})],
    ['video', buildWorkFisherVideo({prompt:'synthetic', referenceCount:1, seed:71})],
  ];
  const parsed = parseComfyWorkflow(readFileSync(new URL('./fixtures/comfy-h3-t2va.api.json', import.meta.url), 'utf8'), {id:'test', name:'Synthetic H3'});
  graphs.push(['video', compileComfyWorkflow(parsed, {prompt:'synthetic', references:[], seed:71}).prompt]);
  for (const [kind, graph] of graphs) {
    const before = JSON.stringify(graph);
    assert(Number.isSafeInteger(comfySeedAfterQueued(kind, graph, undefined)), 'unspecified policy now defaults to random');
    const fresh=comfySeedForNewTask(kind,graph);
    const freshSeed=kind==='image'?fresh['235']?.inputs.seed??fresh['211']?.inputs.seed:fresh['129']?.inputs.noise_seed??fresh[parsed.bindings.seed.nodeId]?.inputs[parsed.bindings.seed.input];
    assert(Number.isSafeInteger(freshSeed)&&freshSeed>=0);assert.notEqual(freshSeed,71,'the first new random request gets fresh entropy');
    assert.equal(comfySeedForNewTask(kind,graph,'fixed'),graph,'explicit fixed seed remains unchanged');
    assert.equal(comfySeedAfterQueued(kind, graph, 'fixed'), undefined);
    assert.equal(comfySeedAfterQueued(kind, graph, 'increment'), 72);
    assert.equal(comfySeedAfterQueued(kind, graph, 'decrement'), 70);
    const random = comfySeedAfterQueued(kind, graph, 'randomize');
    assert(Number.isSafeInteger(random) && random >= 0);
    assert.equal(JSON.stringify(graph), before, 'frozen graph and retry seed are unchanged');
  }
});

test('saved templates retain seed mode, reject unknown modes, and restore it without generating', () => {
  const node={id:'n',position:{x:0,y:0},data:{kind:'generator',label:'Synthetic character',generationKind:'image',generationSource:'comfyui',generationPrompt:'synthetic',generationComfy:{preset:'work-fisher-character',seed:42,seedMode:'randomize',width:512,height:768}}};
  const {template}=captureWorkflow([node],[],['n'],'seed-mode');
  assert.equal(template.nodes[0].comfyParameters.seedMode,'randomize');
  const reloaded=JSON.parse(JSON.stringify(template));let n=0;
  const restored=instantiateWorkflow(reloaded,{x:0,y:0},()=>String(++n)).nodes[0].data.generationComfy;
  assert.equal(restored.seed,42);assert.equal(restored.seedMode,'randomize');
  reloaded.nodes[0].comfyParameters.seedMode='unknown';assert.throws(()=>validateWorkflow(reloaded));
});
