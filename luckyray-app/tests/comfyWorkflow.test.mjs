import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseComfyWorkflow,compileComfyWorkflow,getComfyWorkflowDefaults,summarizeComfyWorkflow,checkComfyWorkflowDependencies,ComfyWorkflowError,COMFY_ASPECTS} from '../src/core/canvas/comfyWorkflow.ts';
const input=()=>JSON.parse(readFileSync(new URL('./fixtures/comfy-h3-t2va.api.json',import.meta.url),'utf8'));
const parse=(value=input())=>parseComfyWorkflow(value,{id:'local-h3',name:'H3 本地文生音视频'});
const mutate=(fn)=>{const x=input();fn(x);return x;};
test('sanitized real API binds by topology, reports actual 243 frames and dimensions',()=>{
 const w=parse();assert.equal(w.bindings.prompt.nodeId,'234');assert.equal(w.bindings.duration.nodeId,'236');assert.equal(w.bindings.seed.nodeId,'306');
 assert.deepEqual(w.summary,{model:'minimax_h3_fl2va_int8_convrot.safetensors',width:1056,height:608,frames:243,fps:24,durationSeconds:10.125,videoSteps:10,audioSteps:10});
});
test('round-trips API export without embedding metadata or executing source',()=>{
 const x=input();x['234']._meta={title:'untrusted display metadata'};
 const w=parse(JSON.stringify(x));assert.equal(w.prompt['234']._meta,undefined);assert.equal(getComfyWorkflowDefaults(w).seed,123456789);
});
test('renumbered graph imports correctly; bindings do not depend on magic node IDs',()=>{
 const x=input(),map=Object.fromEntries(Object.keys(x).map((id,i)=>[id,String(i+1)]));
 const y=Object.fromEntries(Object.entries(x).map(([id,n])=>[map[id],{...n,inputs:Object.fromEntries(Object.entries(n.inputs).map(([k,v])=>[k,Array.isArray(v)?[map[v[0]],v[1]]:v]))}]));
 const w=parse(y);assert.equal(w.bindings.prompt.nodeId,map['234']);assert.equal(w.summary.width,1056);
});
test('compile edits only declared fields and leaves original immutable',()=>{
 const w=parse(),before=JSON.stringify(w);const out=compileComfyWorkflow(w,{prompt:'A sailboat.',duration:8,seed:42,aspect:'9:16 (Portrait Widescreen)',megapixels:.4});
 assert.equal(JSON.stringify(w),before);assert.equal(out.prompt['234'].inputs.value,'A sailboat.');assert.equal(out.prompt['236'].inputs.value,8);assert.equal(out.prompt['306'].inputs.noise_seed,42);
 assert.equal(out.summary.width,480);assert.equal(out.summary.height,864);assert.equal(out.summary.frames,192);assert.equal(out.summary.durationSeconds,8);
 for(const id of Object.keys(w.prompt))if(!['234','235','236','306','307'].includes(id))assert.deepEqual(out.prompt[id],w.prompt[id]);
});
test('empty saved imported prompt is allowed but generation requires a prompt',()=>{
 const w=parse(mutate(x=>x['234'].inputs.value=''));assert.equal(summarizeComfyWorkflow(w).frames,243);
 assert.throws(()=>compileComfyWorkflow(w,{prompt:''}),e=>e.code==='COMFY_PROMPT_REQUIRED');
});

test('final prompt rejects unfinished template fields from connected context as well as the editor',()=>{
 const w=parse();
 for(const placeholder of ['<填写主体、动作、场景和镜头>','<填写环境与动作声音>','<填写配乐，或 N/A>','<Describe the subject, action, scene and camera>','<Describe ambient and action sounds>','<Describe music, or N/A>']) {
  assert.throws(()=>compileComfyWorkflow(w,{prompt:`A paper boat.\nConnected note: ${placeholder}`,references:[{kind:'note'}]}),e=>e.code==='COMFY_PROMPT_TEMPLATE_INCOMPLETE');
 }
 assert.doesNotThrow(()=>compileComfyWorkflow(w,{prompt:'A paper boat on calm water.\noverall_soundscape: Gentle water.\nnon_diegetic_music: N/A'}));
});
test('UI graph JSON gives actionable API export error',()=>assert.throws(()=>parse({nodes:[],links:[]}),e=>e instanceof ComfyWorkflowError&&e.code==='COMFY_API_EXPORT_REQUIRED'&&e.message.includes('导出（API）')));
test('rejects malformed and oversized JSON',()=>{
 assert.throws(()=>parse('{'),e=>e.code==='COMFY_WORKFLOW_JSON_INVALID');
 assert.throws(()=>parse(' '.repeat(262145)),e=>e.code==='COMFY_WORKFLOW_TOO_LARGE');
});
test('rejects remote nodes, unknown inputs, nested objects and dangling links',()=>{
 for(const fn of [x=>x['227'].class_type='RemoteAPICall',x=>x['307'].inputs.ref_image_0=['234',0],x=>x['234'].inputs.value={url:'https://example.test'},x=>x['303'].inputs.audio=['999',0]])assert.throws(()=>parse(mutate(fn)));
});
test('rejects arbitrary math or altered wiring, including injected model links',()=>{
 for(const fn of [x=>x['308'].inputs.expression='__import__("os").system("anything")',x=>x['308'].inputs.expression='a*24',x=>x['307'].inputs.width=['235',1],x=>x['305'].inputs.model=['227',0]])assert.throws(()=>parse(mutate(fn)));
});
test('supports whitespace-only math formatting changes without evaluating expressions',()=>{
 assert.equal(parse(mutate(x=>x['308'].inputs.expression=x['308'].inputs.expression.replaceAll(' ',''))).summary.frames,243);
});
test('rejects Ref2VA, absent audio, non-MP4 and unsafe output/model paths',()=>{
 for(const fn of [x=>x['307'].inputs.task_type='Ref2VA',x=>delete x['303'].inputs.audio,x=>x['303'].inputs.format='video/webm',x=>x['303'].inputs.filename_prefix='../escape',x=>x['227'].inputs.unet_name='https://example.test/model'])assert.throws(()=>parse(mutate(fn)));
});
test('rejects unsupported reference media instead of silently ignoring it',()=>{
 for(const kind of ['video','audio'])assert.throws(()=>compileComfyWorkflow(parse(),{prompt:'test',references:[{kind}]}),e=>e.code==='COMFY_REFERENCE_UNSUPPORTED');
 assert.doesNotThrow(()=>compileComfyWorkflow(parse(),{prompt:'already compiled text',references:[{kind:'text'},{kind:'note'}]}));
});
test('validates changed parameter ranges, numeric seeds and finite values',()=>{
 for(const edits of [{duration:0},{duration:16},{duration:NaN},{seed:-1},{seed:Number.MAX_SAFE_INTEGER+1},{seed:1.5},{megapixels:0},{megapixels:3},{aspect:'16:9'}])assert.throws(()=>compileComfyWorkflow(parse(),{prompt:'test',...edits}));
});
test('ignores caller-provided forged bindings and summary; derives from original graph again',()=>{
 const w=parse();w.bindings.prompt={nodeId:'303',input:'filename_prefix'};w.summary.width=9999;
 const out=compileComfyWorkflow(w,{prompt:'safe'});assert.equal(out.prompt['234'].inputs.value,'safe');assert.equal(out.prompt['303'].inputs.filename_prefix,'MiniMaxH3/exp_4v10a');assert.equal(out.summary.width,1056);
});
test('preflight differentiates missing nodes, absent model and unverified list',()=>{
 const w=parse(),info={};
 for(const n of Object.values(w.prompt))info[n.class_type]={input:{required:{}}};
 const fields={UNETLoader:'unet_name',CLIPLoader:'clip_name',VAELoader:'vae_name',LoraLoaderModelOnly:'lora_name'};
 for(const n of Object.values(w.prompt)){const f=fields[n.class_type];if(f){info[n.class_type].input.required[f]??=[[]];info[n.class_type].input.required[f][0].push(n.inputs[f]);}}
 assert.equal(checkComfyWorkflowDependencies(w,info).ready,true);
 delete info.UNETLoader;assert.deepEqual(checkComfyWorkflowDependencies(w,info).missingNodes,['UNETLoader']);
 info.UNETLoader={input:{required:{unet_name:[[]]}}};assert.equal(checkComfyWorkflowDependencies(w,info).missingModels[0].name,w.summary.model);
 info.UNETLoader={input:{required:{unet_name:['STRING']}}};assert.deepEqual(checkComfyWorkflowDependencies(w,info).unverifiedModels,[w.summary.model]);
});
test('optional disconnected swap cannot alter model path or execute links',()=>{
 assert.equal(parse(mutate(x=>delete x['309'])).summary.width,1056);
 assert.throws(()=>parse(mutate(x=>x['309'].inputs.model=['227',0])));
});

// Exact enum audited against Comfy-Org/ComfyUI v0.31.1 comfy_extras/nodes_resolution.py, lines 6–14.
test('all supported aspect strings match the pinned ComfyUI enum, including portrait labels',()=>{
 assert.deepEqual([...COMFY_ASPECTS],['1:1 (Square)','2:3 (Portrait Photo)','3:2 (Photo)','3:4 (Portrait Standard)','4:3 (Standard)','9:16 (Portrait Widescreen)','16:9 (Widescreen)','21:9 (Ultrawide)']);
 for(const aspect of COMFY_ASPECTS){const out=compileComfyWorkflow(parse(),{prompt:'test',aspect});assert.equal(out.prompt['235'].inputs.aspect_ratio,aspect);assert.ok(out.summary.width%32===0&&out.summary.height%32===0);}
});


test('advanced steps preserve imported values until explicitly changed, without mutating other fields',()=>{
 const w=parse(mutate(x=>{x['304'].inputs.video_steps=12;x['304'].inputs.audio_steps=9;}));
 const before=JSON.stringify(w), defaults=getComfyWorkflowDefaults(w);
 assert.equal(defaults.videoSteps,12);assert.equal(defaults.audioSteps,9);
 const unchanged=compileComfyWorkflow(w,{prompt:'test'});
 assert.equal(unchanged.summary.videoSteps,12);assert.equal(unchanged.summary.audioSteps,9);
 const out=compileComfyWorkflow(w,{prompt:'test',videoSteps:15,audioSteps:8});
 assert.equal(JSON.stringify(w),before);assert.equal(out.summary.videoSteps,15);assert.equal(out.summary.audioSteps,8);
 assert.equal(out.prompt['304'].inputs.video_steps,15);assert.equal(out.prompt['304'].inputs.audio_steps,8);
 const expected=structuredClone(w.prompt);expected['307'].inputs.task_type='auto';expected['234'].inputs.value='test';expected['304'].inputs.video_steps=15;expected['304'].inputs.audio_steps=8;
 assert.equal(JSON.stringify(out.prompt),JSON.stringify(expected));
 assert.equal(summarizeComfyWorkflow(w,{videoSteps:11}).videoSteps,11);
});
test('advanced steps use verified graph bindings, including renumbered graphs and forged bindings',()=>{
 const x=input(),map=Object.fromEntries(Object.keys(x).map((id,i)=>[id,String(i+1000)]));
 const y=Object.fromEntries(Object.entries(x).map(([id,n])=>[map[id],{...n,inputs:Object.fromEntries(Object.entries(n.inputs).map(([k,v])=>[k,Array.isArray(v)?[map[v[0]],v[1]]:v]))}]));
 const w=parse(y);assert.equal(w.bindings.videoSteps.nodeId,map['304']);assert.equal(w.bindings.audioSteps.nodeId,map['304']);
 w.bindings.videoSteps={nodeId:map['303'],input:'crf'};
 const out=compileComfyWorkflow(w,{prompt:'test',videoSteps:1,audioSteps:100});
 assert.equal(out.prompt[map['304']].inputs.video_steps,1);assert.equal(out.prompt[map['304']].inputs.audio_steps,100);
 assert.equal(out.prompt[map['303']].inputs.crf,w.prompt[map['303']].inputs.crf);
});
test('advanced step edits reject invalid numbers and coercion instead of clamping silently',()=>{
 for(const key of ['videoSteps','audioSteps'])for(const value of [0,-1,101,1.5,NaN,Infinity,'10',null]){
  assert.throws(()=>compileComfyWorkflow(parse(),{prompt:'test',[key]:value}),e=>e.code==='COMFY_WORKFLOW_UNSUPPORTED');
 }
});
