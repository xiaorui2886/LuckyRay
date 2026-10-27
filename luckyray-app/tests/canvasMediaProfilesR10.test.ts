import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CANVAS_MEDIA_PRESETS,projectCanvasMediaProfiles,createCanvasMediaProfilesClient,createCanvasComfyUiClient} from '../src/core/services/canvasMediaProfiles.ts';
import {mediaCapabilities} from '../src/core/canvas/mediaCapabilities.ts';
import {createCanvasReferencePlan} from '../src/core/canvas/referencePlan.ts';
const profile={...CANVAS_MEDIA_PRESETS.bigmodel,id:'flash',revision:1,apiKeyConfigured:true};
const snapshot={version:1,activeProfileId:'flash',profiles:[profile]};
test('fallback presets are explicit, unconfigured and cannot select a paid model automatically',()=>{
 for(const key of ['genericImage','genericVideo'] as const){
  assert.equal(CANVAS_MEDIA_PRESETS[key].baseUrl,'');
  assert.equal(CANVAS_MEDIA_PRESETS[key].imageModel,'');
  assert.equal(CANVAS_MEDIA_PRESETS[key].videoModel,'');
 }
 assert.equal(CANVAS_MEDIA_PRESETS.genericImage.videoProtocol,'disabled');
 assert.equal(CANVAS_MEDIA_PRESETS.genericVideo.imageProtocol,'disabled');
 assert.equal(profile.videoModel,'cogvideox-flash');
});
test('dedicated profile projects and round-trips without secrets; legacy text defaults preserved',async()=>{
 const projected=projectCanvasMediaProfiles({...snapshot,profiles:[{...profile,apiKey:'must-not-leak'}]});
 assert.equal(projected.profiles[0].videoProtocol,'bigmodel-video');
 assert.equal(projected.profiles[0].textProtocol,'legacy');
 assert.equal('apiKey' in projected.profiles[0],false);
 const calls:unknown[]=[];
 const client=createCanvasMediaProfilesClient((async(command:string,args:unknown)=>{calls.push([command,args]);return snapshot;}) as never);
 const input={...CANVAS_MEDIA_PRESETS.bigmodel,id:'flash',expectedRevision:1,apiKey:''};
 assert.equal((await client.save(input)).profiles[0].videoModel,'cogvideox-flash');
 assert.deepEqual(calls,[['canvas_media_profile_upsert',{profile:input}]]);
 assert.throws(()=>projectCanvasMediaProfiles({...snapshot,profiles:[{...profile,videoProtocol:'comfyui'}]}));
});
test('Flash exposes no unverified options and only accepts one image, never silently accepts tails or videos',()=>{
 assert.deepEqual(mediaCapabilities('video',profile,'cogvideox-flash'),{aspects:[],qualities:[],durations:[],counts:[1],sound:false,camera:false,promptOnly:false});
 const image=(id:string,role:'firstFrame'|'lastFrame'|'reference')=>({id,label:id,kind:'image' as const,role,mediaUrl:'https://example.com/'+id+'.png'});
 assert.equal(createCanvasReferencePlan('video',[],[image('a','firstFrame')],'bigmodel-video')[0].issue,undefined);
 assert.equal(createCanvasReferencePlan('video',[],[image('a','reference')],'bigmodel-video')[0].issue,undefined);
 assert.equal(createCanvasReferencePlan('video',[],[image('a','lastFrame')],'bigmodel-video')[0].issue,'unsupported-frame');
 assert.equal(createCanvasReferencePlan('video',[],[image('a','firstFrame'),image('b','reference')],'bigmodel-video')[1].issue,'image-limit');
 assert.equal(createCanvasReferencePlan('video',[],[{id:'v',label:'v',kind:'video',mediaUrl:'https://example.com/v.mp4'}],'bigmodel-video')[0].issue,'unsupported-video');
});
test('existing vendor presets and generic OpenAI video limits remain unchanged',()=>{
 assert.equal(CANVAS_MEDIA_PRESETS.agnes.videoProtocol,'agnes');
 assert.equal(CANVAS_MEDIA_PRESETS.twelve.videoProtocol,'12ai-task');
 assert.equal(CANVAS_MEDIA_PRESETS.easycli.imageProtocol,'easycli-auto');
 assert.deepEqual(mediaCapabilities('video',{...profile,videoProtocol:'openai-video'},'custom-video').durations,[4,8,12]);
});
test('ComfyUI preparation sends only native config and read-only connection commands',async()=>{
 const calls:unknown[]=[];
 const client=createCanvasComfyUiClient((async(command:string,args:unknown)=>{calls.push([command,args]);return command==='canvas_comfyui_test_connection'?{reachable:true,version:'1',secret:'omit'}:{baseUrl:'http://127.0.0.1:8188',secret:'omit'};}) as never);
 assert.deepEqual(await client.get(),{baseUrl:'http://127.0.0.1:8188'});
 assert.deepEqual(await client.save('http://127.0.0.1:8188'),{baseUrl:'http://127.0.0.1:8188'});
 assert.deepEqual(await client.test('http://127.0.0.1:8188'),{reachable:true,version:'1',error:undefined});
 assert.deepEqual(calls.map((v:any)=>v[0]),['canvas_comfyui_get_config','canvas_comfyui_set_config','canvas_comfyui_test_connection']);
});

test('ComfyUI Rust null optionals are projected safely and malformed replies rejected',async()=>{
 const client=createCanvasComfyUiClient((async()=>({reachable:false,version:null,error:null})) as never);
 assert.deepEqual(await client.test('http://127.0.0.1:8188'),{reachable:false,version:undefined,error:undefined});
 const invalid=createCanvasComfyUiClient((async()=>({reachable:'yes'})) as never);
 await assert.rejects(invalid.test('http://127.0.0.1:8188'),/canvas-comfyui-response-invalid/);
});

test('ComfyUI load failure leaves explicit recovery controls available without auto-save',()=>{
 const source=readFileSync(new URL('../src/features/canvas/CanvasMediaProfilesPanel.tsx',import.meta.url),'utf8');
 const catchBlock=source.slice(source.indexOf('}).catch(()=>{'),source.indexOf('return ()=>{epoch.current++;};'));
 assert.match(catchBlock,/setLoaded\(true\)/);
 assert.match(catchBlock,/不会自动覆盖/);
 assert.doesNotMatch(catchBlock,/canvasComfyUiClient\.save/);
});
