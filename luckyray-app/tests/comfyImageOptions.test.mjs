import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildWorkFisherImage,readWorkFisherImage,buildWorkFisherVideo} from '../src/core/canvas/workFisherPreset.ts';
import {parseComfyWorkflow,compileComfyWorkflow} from '../src/core/canvas/comfyWorkflow.ts';
import {captureWorkflow,instantiateWorkflow,validateWorkflow} from '../src/core/canvas/workflowTemplates.ts';
import {comfySeedForNewTask} from '../src/core/canvas/comfySeed.ts';

test('image upscale follows the actual SeedVR2 image branch, with one bound output and a legacy path',()=>{
  for(const [preset,out,decode] of [['work-fisher-character','241','236'],['work-fisher-scene','267','262'],['work-fisher-three-view','212','202']]){
    const options={preset,prompt:'Synthetic shape',referenceCount:preset==='work-fisher-three-view'?1:0,seed:17};
    const legacy=buildWorkFisherImage(options);assert.equal(legacy['231'],undefined);
    assert.equal(readWorkFisherImage(legacy).options.upscale,false);
    const scaled=buildWorkFisherImage({...options,upscale:true});
    assert.deepEqual(scaled['234'].inputs.image,[decode,0]);assert.deepEqual(scaled[out].inputs.images,['231',0]);
    assert.equal(scaled['234'].inputs.megapixels,.30000000000000004);
    assert.equal(scaled['237'].inputs.value,2560);assert.equal(scaled['231'].inputs.max_resolution,6000);
    assert.equal(scaled['233'].inputs.model,'seedvr2_ema_7b-Q8_0.gguf');assert.equal(scaled['233'].inputs.blocks_to_swap,32);
    assert.equal(scaled['233'].inputs.cache_model,false,'installed BOOL schema replaces obsolete UI text');
    assert.equal(Object.values(scaled).filter(n=>n.class_type==='SaveImage').length,1);
    assert(!Object.values(scaled).some(n=>/RAMCleanup|VRAMCleanup/.test(n.class_type)));
    assert.deepEqual(readWorkFisherImage(scaled).prompt,scaled);
    const random=comfySeedForNewTask('image',scaled),seed=readWorkFisherImage(random).options.seed;
    assert.equal(random['231'].inputs.seed,seed%4294967296);assert.deepEqual(scaled['231'].inputs.seed,17,'new seed does not mutate the frozen task');
    for(const mutate of [g=>g[out].inputs.images=[decode,0],g=>g['233'].inputs.model='another.gguf',g=>g['231'].inputs.offload_device='none',g=>g['237'].inputs.value=4097]){const bad=structuredClone(scaled);mutate(bad);assert.throws(()=>readWorkFisherImage(bad));}
  }
});

test('LoRA choice, weight and bypass bind in image, WorkFisher video and existing generic H3',()=>{
  const image=buildWorkFisherImage({preset:'work-fisher-character',prompt:'synthetic',referenceCount:0,loras:{'240':{enabled:false},'249':{name:'Synthetic.safetensors',strength:.25}}});
  assert.equal(image['240'].inputs.strength_model,0);assert.equal(image['249'].inputs.lora_name,'Synthetic.safetensors');assert.equal(image['249'].inputs.strength_model,.25);
  assert.deepEqual(readWorkFisherImage(image).prompt,image);
  for(const bad of [{'240':{name:'../bad'}},{'240':{strength:Infinity}},{'999':{enabled:false}},{'240':{enabled:'no'}}])assert.throws(()=>buildWorkFisherImage({preset:'work-fisher-character',prompt:'synthetic',referenceCount:0,loras:bad}));
  const video=parseComfyWorkflow(buildWorkFisherVideo({prompt:'',referenceCount:1}),{id:'wf',name:'WF'});
  const result=compileComfyWorkflow(video,{prompt:'synthetic',references:[{kind:'image',mediaUrl:'synthetic.png'}],loras:{'151':{enabled:false},'288':{enabled:true,name:'Synthetic.safetensors',strength:.2}}});
  assert.equal(result.prompt['151'],undefined);assert.equal(result.prompt['288'].inputs.strength_model,.2);
  assert.deepEqual(result.prompt['156'].inputs.audio,['121',0]);assert.equal(result.prompt['231'],undefined,'video never gains the image-only upscale branch');
  const general=parseComfyWorkflow(fs.readFileSync(new URL('./fixtures/comfy-h3-t2va.api.json',import.meta.url),'utf8'),{id:'h3',name:'H3'});
  const id=Object.keys(general.prompt).find(id=>general.prompt[id].class_type==='LoraLoaderModelOnly');
  const disabled=compileComfyWorkflow(general,{prompt:'synthetic',loras:{[id]:{enabled:false}}});assert.equal(disabled.prompt[id].inputs.strength_model,0);
});

test('saved drafts and portable templates retain options without exporting model names or tasks',()=>{
  const value={preset:'work-fisher-character',seedMode:'randomize',width:720,height:1280,sizePreset:'tall',upscale:true,upscaleResolution:2048,loras:{'240':{enabled:false,name:'private-model.safetensors',strength:.4}}};
  const data={kind:'generator',generationKind:'image',generationSource:'comfyui',generationPrompt:'Synthetic shape',generationComfy:value};
  assert.deepEqual(JSON.parse(JSON.stringify(data)).generationComfy,value);
  const {template}=captureWorkflow([{id:'n',position:{x:0,y:0},data}],[],['n'],'synthetic');
  assert.doesNotMatch(JSON.stringify(template),/private-model|safetensors|class_type|promptId/);
  let id=0;const restored=instantiateWorkflow(template,{x:0,y:0},()=>String(++id)).nodes[0].data.generationComfy;
  assert.equal(restored.upscale,true);assert.equal(restored.upscaleResolution,2048);assert.equal(restored.sizePreset,'tall');assert.deepEqual(restored.loras,{'240':{enabled:false,strength:.4}});
  const bad=structuredClone(template);bad.nodes[0].comfyParameters.loras['240'].name='injected.safetensors';assert.throws(()=>validateWorkflow(bad));
});
