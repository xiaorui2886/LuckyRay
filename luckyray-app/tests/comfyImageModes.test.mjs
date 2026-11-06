import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseComfyWorkflow,compileComfyWorkflow,getComfyWorkflowDefaults} from '../src/core/canvas/comfyWorkflow.ts';
const base=()=>parseComfyWorkflow(JSON.parse(readFileSync(new URL('./fixtures/comfy-h3-t2va.api.json',import.meta.url),'utf8')),{id:'h3',name:'H3'});
const refs=count=>Array.from({length:count},(_,i)=>({kind:'image',mediaUrl:`C:/synthetic/${i}.png`}));
const edits=(count)=>({mode:count===1?'single-image':'multi-image',referenceModel:'minimax_h3_ref2va_int8_convrot.safetensors',prompt:'A red sphere moves.',references:refs(count)});
test('one to nine images compile one automatic reference branch in input order',()=>{
 for(const count of [1,2,3,9]) {
  const original=base(),before=JSON.stringify(original),out=compileComfyWorkflow(original,edits(count));
  assert.equal(JSON.stringify(original),before);
  const parsed=parseComfyWorkflow(out.prompt,{id:'r',name:'Ref'}),b=parsed.bindings,c=out.prompt[b.conditioningNodeId].inputs;
  assert.equal(c.task_type,'auto');assert.equal(c.ref_image_size,count===1?'max':'match');assert.equal(c.first_frame,undefined);assert.equal(c.last_frame,undefined);
  assert.equal(Object.values(out.prompt).filter(n=>n.class_type==='VHS_VideoCombine').length,1);
  assert.equal(Object.keys(out.prompt).length,18+count);
  b.images.forEach((binding,i)=>{assert.equal(out.prompt[binding.nodeId].inputs.image,`luckyray-ref-${i}.png`);assert.deepEqual(c[`ref_images.ref_image_${i}`],[binding.nodeId,0]);});
  assert.equal(out.summary.durationSeconds,10.125);assert.equal(getComfyWorkflowDefaults(parsed).megapixels,.6);
 }
});
test('explicit low-load parameters and image processing size override original defaults only when set',()=>{
 const out=compileComfyWorkflow(base(),{...edits(1),megapixels:.2,duration:4,refImageSize:'match'});
 assert.equal(out.summary.width,608);assert.equal(out.summary.height,352);assert.equal(out.prompt['307'].inputs.ref_image_size,'match');
 assert.equal(getComfyWorkflowDefaults(base(),'text').megapixels,.6);
 const imported=base();imported.prompt[imported.bindings.duration.nodeId].inputs.value=4;imported.prompt[imported.bindings.megapixels.nodeId].inputs.megapixels=.2;
 for(const count of [0,1,2,9,0]) {
  const result=compileComfyWorkflow(imported,{prompt:'Synthetic',references:refs(count)});
  assert.equal(result.summary.width,608);assert.equal(result.summary.height,352);assert.equal(result.summary.frames,107);
  const defaults=getComfyWorkflowDefaults(imported,count===0?'text':count===1?'single-image':'multi-image');
  assert.equal(defaults.duration,4);assert.equal(defaults.megapixels,.2);assert.equal(result.summary.videoSteps,10);assert.equal(result.summary.audioSteps,10);
 }
});
test('preserve the working model, apply current selection, and never infer compatibility from filename',()=>{
 for(const referenceModel of [undefined,'minimax_h3_fl2va_int8_convrot.safetensors','minimax_h3_fl2va_pruned_int8_convrot.safetensors','minimax_h3_ref2va_int8_convrot.safetensors']) {
  const out=compileComfyWorkflow(base(),{...edits(1),referenceModel});
  assert.equal(out.summary.model,referenceModel || base().summary.model);
 }
 assert.throws(()=>compileComfyWorkflow(base(),{...edits(1),referenceModel:'../model.safetensors'}));
});
test('actual images override legacy tabs, reject excess/media/missing originals without dropping them',()=>{
 for(const mode of ['text','single-image','multi-image'])for(const count of [0,1,2,9]) {
  const out=compileComfyWorkflow(base(),{...edits(count),mode});
  assert.equal(out.prompt['307'].inputs.task_type,'auto');
  assert.equal(Object.values(out.prompt).filter(n=>n.class_type==='LoadImage').length,count);
 }
 assert.throws(()=>compileComfyWorkflow(base(),edits(10)),e=>e.code==='COMFY_IMAGE_COUNT_INVALID');
 assert.throws(()=>compileComfyWorkflow(base(),{...edits(1),references:[{kind:'image'}]}),e=>e.code==='COMFY_IMAGE_MISSING');
 assert.throws(()=>compileComfyWorkflow(base(),{...edits(1),references:[...refs(1),{kind:'video'}]}),e=>e.code==='COMFY_REFERENCE_UNSUPPORTED');
});
test('Ref2VA import refuses sparse/shared images, arbitrary loaders and extra output branches',()=>{
 const out=compileComfyWorkflow(base(),edits(3)).prompt;
 const parse=x=>parseComfyWorkflow(x,{id:'x',name:'x'});
 for(const mutate of [x=>delete x['307'].inputs['ref_images.ref_image_1'],x=>{const c=x['307'].inputs;c['ref_images.ref_image_1']=c['ref_images.ref_image_0'];},x=>x['999']={class_type:'LoadImage',inputs:{image:'extra.png'}},x=>x['999']={...x['303']},x=>{const id=Object.keys(x).find(id=>x[id].class_type==='LoadImage');x[id].inputs.image='../private.png';}]){
  const changed=structuredClone(out);mutate(changed);if(JSON.stringify(changed)!==JSON.stringify(out))assert.throws(()=>parse(changed));
 }
});
test('new draft rebuilds 9→2→0→1 without stale loaders; accepted graph stays unchanged',()=>{
 const first=compileComfyWorkflow(base(),edits(9));const frozen=JSON.stringify(first);const restored=parseComfyWorkflow(JSON.parse(JSON.stringify(first.prompt)),{id:'r',name:'Ref'});
 assert.equal(restored.mode,'multi-image');const reduced=compileComfyWorkflow(restored,edits(2));
 assert.equal(Object.values(reduced.prompt).filter(n=>n.class_type==='LoadImage').length,2);
 assert.equal(reduced.prompt['307'].inputs['ref_images.ref_image_2'],undefined);
 const empty=compileComfyWorkflow(restored,{...edits(0),mode:'multi-image'});
 assert.equal(Object.values(empty.prompt).filter(n=>n.class_type==='LoadImage').length,0);
 assert.ok(!Object.keys(empty.prompt['307'].inputs).some(k=>k.startsWith('ref_images.')));
 const one=compileComfyWorkflow(parseComfyWorkflow(empty.prompt,{id:'empty',name:'Empty'}),edits(1));
 assert.equal(Object.values(one.prompt).filter(n=>n.class_type==='LoadImage').length,1);
 assert.equal(JSON.stringify(first),frozen);
});

import {createCanvasReferencePlan,canvasReferenceSnapshots} from '../src/core/canvas/referencePlan.ts';
import {compileMentionedPrompt,encodeReferenceMention} from '../src/core/canvas/referenceMentions.ts';
import {compileCanvasGenerationInputs} from '../src/core/canvas/generationInputCompiler.ts';
test('Comfy connected/stored images share reorder, visible numbering and canonical typed tags; API unchanged',()=>{
 const connected=[{edgeId:'edge-a',sourceNodeId:'a',role:'firstFrame',reference:{id:'a',kind:'image',label:'A',mediaUrl:'C:/a.png'}}];
 const stored=[{id:'b',kind:'image',label:'B',mediaUrl:'C:/b.png',role:'lastFrame',mentionKey:'stored-b'}];
 const plan=createCanvasReferencePlan('video',connected,stored,'openai-video',['stored-b','edge-a'],true);
 assert.deepEqual(plan.map(e=>e.key),['stored-b','edge-a']);assert.ok(plan.every(e=>!e.issue&&e.role==='reference'));
 const typed=`Use ${encodeReferenceMention('edge-a')} beside ${encodeReferenceMention('stored-b')}. Keep literal @图1 unchanged.`;
 const result=compileMentionedPrompt(typed,plan,{kind:'video',imageTagStyle:'comfy'});
 assert.match(result.prompt,/Use <Picture 2> beside <Picture 1>/);assert.match(result.prompt,/literal @图1 unchanged/);
 const compiled=compileCanvasGenerationInputs({kind:'video',prompt:result.prompt,references:canvasReferenceSnapshots(plan),referenceAliases:result.referenceAliases});
 assert.deepEqual(compiled.references.map(r=>r.id),['b','a']);
 assert.match(compileMentionedPrompt(typed,plan,{kind:'video'}).prompt,/Use @图2 beside @图1/);
 assert.throws(()=>compileMentionedPrompt(typed,plan.slice(1),{kind:'video',imageTagStyle:'comfy'}),e=>e.code==='invalid-reference-mention');
});
