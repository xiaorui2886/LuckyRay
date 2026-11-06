import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkFisherVideo,readWorkFisherVideo,summarizeWorkFisherVideo} from '../src/core/canvas/workFisherPreset.ts';
import {parseComfyWorkflow,compileComfyWorkflow} from '../src/core/canvas/comfyWorkflow.ts';

const draft=()=>parseComfyWorkflow(buildWorkFisherVideo({prompt:'',referenceCount:1}),{id:'short-drama',name:'Short drama'});
const refs=n=>Array.from({length:n},(_,i)=>({kind:'image',mediaUrl:`asset-${i}`}));
test('ordered references become only the corresponding input ports and preserve the authored sound chain',()=>{
  for(const n of [1,2,6,9]) {
    const result=compileComfyWorkflow(draft(),{prompt:'镜头向前。',references:refs(n),megapixels:.2,duration:4});
    const g=result.prompt;
    assert.equal(Object.values(g).filter(node=>node.class_type==='LoadImage').length,n);
    for(let i=0;i<n;i++)assert.deepEqual(g['136'].inputs[`ref_images.ref_image_${i}`],[String(9000+i),0]);
    assert.deepEqual(g['156'].inputs.audio,['121',0]);assert.deepEqual(g['156'].inputs.images,['122',0]);
    assert.equal(g['156'].inputs.format,'video/h265-mp4');assert.equal(g['156'].inputs.pix_fmt,'yuv420p10le');
    assert.deepEqual(g['121'].inputs.vae,['150',0]);assert.deepEqual(g['122'].inputs.vae,['149',0]);
    assert.equal(result.summary.frames,107);assert.equal(readWorkFisherVideo(g).options.referenceCount,n);
    assert.ok(!Object.values(g).some(node=>['RAMCleanup','VRAMCleanup'].includes(node.class_type)));
    assert.doesNotMatch(JSON.stringify(g),/https?:\/\/|Work-Fisher_\d|20261012_/);
  }
  assert.throws(()=>compileComfyWorkflow(draft(),{prompt:'x',references:[]}),/至少一张/);
  assert.throws(()=>compileComfyWorkflow(draft(),{prompt:'x',references:refs(10)}));
});
test('defaults and opt-in LoRA switches do not alter the original draft or legacy recipe',()=>{
  const original=draft(),before=JSON.stringify(original);
  assert.equal(original.summary.frames,192);assert.equal(original.summary.videoSteps,12);
  for(const turbo of [true,false])for(const mystic of [true,false])for(const solAttention of [true,false]) {
    const out=compileComfyWorkflow(original,{prompt:'x',references:refs(1),turbo,mystic,solAttention});
    assert.equal(!!out.prompt['151'],turbo);assert.equal(!!out.prompt['288'],mystic);assert.equal(!!out.prompt['155'],solAttention);
    assert.equal(readWorkFisherVideo(out.prompt).options.mystic,mystic);
  }
  assert.equal(JSON.stringify(original),before);
});
test('rejects altered wiring, unexpected nodes, stale loaders, unsafe model paths and missing reference bytes',()=>{
  const valid=buildWorkFisherVideo({prompt:'x',referenceCount:2});
  for(const mutate of [g=>g['156'].inputs.audio=['122',0],g=>g['9001'].inputs.image='author.png',g=>g['42']={class_type:'RAMCleanup',inputs:{}},g=>g['136'].inputs['ref_images.ref_image_1']=['9000',0],g=>g['157'].inputs.unet_name='../unsafe']) {
    const changed=structuredClone(valid);mutate(changed);assert.throws(()=>readWorkFisherVideo(changed));
  }
  assert.throws(()=>compileComfyWorkflow(draft(),{prompt:'x',references:[{kind:'image'}]}));
  assert.throws(()=>compileComfyWorkflow(draft(),{prompt:'x',references:[{kind:'video',mediaUrl:'x'}]}));
  assert.throws(()=>compileComfyWorkflow(draft(),{prompt:'x',references:refs(1),duration:16}));
  assert.equal(summarizeWorkFisherVideo({prompt:'',referenceCount:1}).durationSeconds,8);
});
