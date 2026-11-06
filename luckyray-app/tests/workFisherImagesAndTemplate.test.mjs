import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkFisherImage,readWorkFisherImage,buildWorkFisherVideo,suggestedWorkFisherPrompt} from '../src/core/canvas/workFisherPreset.ts';
import {builtinWorkflows,instantiateWorkflow,validateWorkflow,captureWorkflow} from '../src/core/canvas/workflowTemplates.ts';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

test('character, scene and optional three-view stay separate and use real generated reference input',()=>{
  for(const [preset,count,id,text,output] of [
    ['work-fisher-character',0,'248','text','241'],['work-fisher-scene',0,'277','text','267'],['work-fisher-three-view',1,'214','prompt','212'],
  ]) {
    const graph=buildWorkFisherImage({preset,prompt:'测试内容',referenceCount:count,seed:42});
    assert.equal(readWorkFisherImage(graph).options.preset,preset);assert.equal(graph[id].inputs[text],'测试内容');
    assert.equal(graph[output].class_type,'SaveImage');
    assert.ok(!Object.values(graph).some(n=>['RAMCleanup','VRAMCleanup','SeedVR2VideoUpscaler'].includes(n.class_type)));
    assert.doesNotMatch(JSON.stringify(graph),/https?:\/\/|Work-Fisher_\d|20261012_/);
    const forged=structuredClone(graph);forged[output].inputs.filename_prefix='../private';assert.throws(()=>readWorkFisherImage(forged));
    if(count)assert.deepEqual(graph['206'].inputs['images.image_1'],['9000',0]);
  }
  assert.throws(()=>buildWorkFisherImage({preset:'work-fisher-character',prompt:'x',referenceCount:1}),/不使用参考图/);
  assert.throws(()=>buildWorkFisherImage({preset:'work-fisher-three-view',prompt:'x',referenceCount:0}),/一张/);
  assert.throws(()=>buildWorkFisherImage({preset:'work-fisher-scene',prompt:'x',referenceCount:0,width:257}),/倍数/);
});
test('templates round-trip only validated portable Work-Fisher settings',()=>{
  const short=builtinWorkflows().find(t=>t.name==='短剧制作');let next=0;
  const instance=instantiateWorkflow(short,{x:0,y:0},()=>`item-${++next}`);
  const video=instance.nodes.find(n=>n.data.generationComfy?.preset==='work-fisher-video');
  const character=instance.nodes.find(n=>n.data.generationComfy?.preset==='work-fisher-character');
  const views=instance.nodes.find(n=>n.data.generationComfy?.preset==='work-fisher-three-view');
  video.data.generationComfy={preset:'work-fisher-video',megapixels:.2,duration:4,videoSteps:6,seed:123,aspect:'9:16 (Portrait Widescreen)',refImageSize:'max',turbo:false,mystic:true,solAttention:false,referenceModel:'private/model.safetensors'};
  video.data.generationTask={secret:'private-task'};
  character.data.generationComfy={preset:'work-fisher-character',width:512,height:768,seed:99};
  views.data.generationComfy={preset:'work-fisher-three-view',aspect:'1:1 (Square)',megapixels:.3,seed:44};
  const portable=captureWorkflow(instance.nodes,instance.edges,instance.nodes.map(n=>n.id),'safe').template;
  const serialized=JSON.stringify(portable);assert.doesNotMatch(serialized,/private-task|private\/model|referenceModel|generationTask|baseUrl|workflowJson/);
  let id=100;const restored=instantiateWorkflow(JSON.parse(serialized),{x:0,y:0},()=>`copy-${++id}`);
  const find=p=>restored.nodes.find(n=>n.data.generationComfy?.preset===p).data.generationComfy;
  assert.deepEqual(find('work-fisher-video'),{preset:'work-fisher-video',seed:123,aspect:'9:16 (Portrait Widescreen)',megapixels:.2,duration:4,videoSteps:6,refImageSize:'max',turbo:false,mystic:true,solAttention:false});
  assert.deepEqual(find('work-fisher-character'),{preset:'work-fisher-character',seed:99,width:512,height:768});
  assert.deepEqual(find('work-fisher-three-view'),{preset:'work-fisher-three-view',seed:44,aspect:'1:1 (Square)',megapixels:.3});
  for(const mutate of [n=>n.comfyParameters.duration=16,n=>n.comfyParameters.seed=-1,n=>n.comfyParameters.turbo='yes',n=>n.comfyParameters.baseUrl='http://private',n=>n.comfyParameters.referenceModel='private/model']) {
    const bad=structuredClone(portable);mutate(bad.nodes.find(n=>n.comfyPreset==='work-fisher-video'));assert.throws(()=>validateWorkflow(bad));
  }
  const bad=structuredClone(portable);bad.nodes.find(n=>n.comfyPreset==='work-fisher-character').comfyParameters.width=257;assert.throws(()=>validateWorkflow(bad));
});
test('templates extract settings from a frozen Work-Fisher graph without exporting its address or snapshot',()=>{
  const graph=buildWorkFisherVideo({prompt:'test',referenceCount:1,megapixels:.2,duration:4,steps:7,seed:42,mystic:true,turbo:false,solAttention:false});
  const node={id:'n',position:{x:0,y:0},data:{kind:'generator',label:'video',generationKind:'video',generationSource:'comfyui',generationPrompt:'test',generationComfyWorkflow:{baseUrl:'http://private',workflowName:'private name',workflow:graph},generationComfy:{videoSteps:8}}};
  const portable=captureWorkflow([node],[],['n'],'frozen').template;
  const saved=portable.nodes[0];assert.equal(saved.comfyPreset,'work-fisher-video');assert.equal(saved.comfyParameters.megapixels,.2);assert.equal(saved.comfyParameters.duration,4);assert.equal(saved.comfyParameters.videoSteps,8);assert.equal(saved.comfyParameters.seed,42);assert.equal(saved.comfyParameters.mystic,true);assert.equal(saved.comfyParameters.turbo,false);
  assert.doesNotMatch(JSON.stringify(portable),/http:\/\/private|private name|class_type|unet_name|generationComfyWorkflow/);
  for(const preset of ['work-fisher-character','work-fisher-three-view']) {
    const options=preset==='work-fisher-three-view'?{aspect:'1:1 (Square)',megapixels:.3}:{width:512,height:768};
    const image=buildWorkFisherImage({preset,prompt:'test',referenceCount:preset==='work-fisher-three-view'?1:0,seed:17,...options});
    const data={...node.data,generationKind:'image',generationComfy:{},generationComfyWorkflow:{baseUrl:'http://private',workflowName:'private name',workflow:image}};
    const savedImage=captureWorkflow([{...node,data}],[],['n'],'image').template.nodes[0];
    assert.equal(savedImage.comfyPreset,preset);assert.equal(savedImage.comfyParameters.seed,17);
    for(const [key,value] of Object.entries(options))assert.equal(savedImage.comfyParameters[key],value);
  }
});
test('three-view instructions are visible and never replace an existing prompt',()=>{
  const prompt=suggestedWorkFisherPrompt('work-fisher-three-view','');
  for(const term of ['正面','侧面','背面','纯白','一致'])assert.ok(prompt.includes(term));
  assert.equal(suggestedWorkFisherPrompt('work-fisher-three-view','我自己写的'),undefined);
  assert.equal(suggestedWorkFisherPrompt('work-fisher-three-view','  '),undefined);
  assert.equal(suggestedWorkFisherPrompt('work-fisher-character',''),undefined);
  const template=builtinWorkflows().find(t=>t.name==='短剧制作'),views=template.nodes.find(n=>n.comfyPreset==='work-fisher-three-view');assert.equal(views.prompt,prompt);
  let id=0;const draft=instantiateWorkflow(template,{x:0,y:0},()=>`view-${++id}`).nodes.find(n=>n.data.generationComfy?.preset==='work-fisher-three-view');
  assert.equal(draft.data.generationPrompt,prompt);
});
test('the production preset-selection handler fills only an actually empty prompt',()=>{
  const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8'),start=source.indexOf('        const update=({source: _source,...parameters}'),end=source.indexOf('\n        return isImage&&isWorkFisherImagePreset',start);assert.ok(start>=0&&end>start);
  const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');const code=transformSync(source.slice(start,end),{loader:'ts',target:'es2022'}).code;
  for(const existing of ['',undefined,'我写的内容','  ']) {
    let patch;const env={node:{data:{generationPrompt:existing}},lockedComfyKind:undefined,comfyPresetMatchesResult:()=>true,suggestedWorkFisherPrompt,isWorkFisherImagePreset:p=>p==='work-fisher-three-view',locale:'zh-CN',commit:value=>{patch=value;}};
    const update=Function('env',`const {${Object.keys(env).join(',')}}=env;${code};return update;`)(env);update({preset:'work-fisher-three-view'});
    if(existing===''||existing===undefined)assert.equal(patch.generationPrompt,suggestedWorkFisherPrompt('work-fisher-three-view',''));
    else assert.equal(Object.hasOwn(patch,'generationPrompt'),false);
  }
});
test('built-in template preserves existing IDs and creates editable cards, connections and presets',()=>{
  const templates=builtinWorkflows(),short=templates.find(t=>t.name==='短剧制作');
  assert.deepEqual(templates.slice(0,4).map(t=>t.name),['产品主图','海报双方案','角色双镜头','图片转短片']);
  assert.equal(short.nodes.length,4);assert.equal(short.edges.length,3);
  let next=0;const instance=instantiateWorkflow(short,{x:0,y:0},()=>`generated-${++next}`);
  const byLabel=Object.fromEntries(instance.nodes.map(n=>[n.data.label,n]));
  assert.equal(byLabel['角色参考'].data.generationComfy.preset,'work-fisher-character');
  assert.equal(byLabel['场景参考'].data.generationComfy.preset,'work-fisher-scene');
  assert.equal(byLabel['角色三视图（可选）'].data.generationComfy.preset,'work-fisher-three-view');
  assert.equal(byLabel['有声视频'].data.generationComfy.preset,'work-fisher-video');
  assert.equal(byLabel['有声视频'].data.generationSource,'comfyui');
  assert.deepEqual(instance.edges.filter(e=>e.target===byLabel['有声视频'].id).map(e=>e.data.order),[0,1]);
  assert.equal(instance.edges.some(e=>e.source===byLabel['角色三视图（可选）'].id&&e.target===byLabel['有声视频'].id),false);
  const exported=captureWorkflow(instance.nodes,instance.edges,instance.nodes.map(n=>n.id),'copy').template;
  assert.equal(validateWorkflow(exported).nodes.filter(n=>n.comfyPreset).length,4);
  const invalid=structuredClone(short);invalid.nodes[0].comfyPreset='work-fisher-video';assert.throws(()=>validateWorkflow(invalid));
});
