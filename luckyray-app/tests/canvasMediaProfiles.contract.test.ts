import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { projectCanvasMediaProfiles, createCanvasMediaProfilesClient, CANVAS_MEDIA_PRESETS } from "../src/core/services/canvasMediaProfiles.ts";
import { createCanvasGenerationTask } from "../src/core/canvas/generationTasks.ts";
import { historyEntryFromTask, normalizeGenerationHistory, generationTaskFromHistory } from "../src/core/canvas/generationHistory.ts";
import { resolveAiProviderPreset } from "../src/core/services/aiProviders.ts";
import { projectAiModelProfilesSnapshot } from "../src/core/services/aiModelProfiles.ts";
import { mediaCapabilities, mediaOption } from "../src/core/canvas/mediaCapabilities.ts";
const profile = {id:"media-a",name:"A",baseUrl:"https://example.test/v1",imageModel:"image-model",videoModel:"video-model",imageProtocol:"openai-image",videoProtocol:"openai-video",revision:1,apiKeyConfigured:true};
const snapshot = {version:1,activeProfileId:"media-a",profiles:[profile]};

test("Sora UI and request options share supported duration and dimensions",()=>{
  const caps=mediaCapabilities("video",projectCanvasMediaProfiles(snapshot).profiles[0],"sora-2");
  assert.deepEqual(caps.durations,[4,8,12]);assert.deepEqual(caps.aspects,["16:9","9:16"]);
  assert.deepEqual(caps.qualities,["720p"]);assert.equal(caps.sound,false);assert.equal(caps.camera,false);
  assert.equal(mediaOption(caps.durations,5),4);assert.equal(mediaOption(caps.durations,12),12);
});
test("Seedance channels do not inherit another model's quality or length",()=>{
  const p=projectCanvasMediaProfiles({...snapshot,profiles:[{...profile,videoProtocol:"12ai-task"}]}).profiles[0];
  assert.deepEqual(mediaCapabilities("video",p,"seedance-2.0").qualities,["720p"]);
  assert.equal(mediaCapabilities("video",p,"seedance-2.0").durations.includes(30),false);
  assert.equal(mediaCapabilities("video",p,"seedance-2.5").durations.includes(30),true);
  assert.deepEqual(mediaCapabilities("video",p,"seedance-2.0-fast").qualities,["720p","480p"]);
});
test("unknown task model uses prompt only instead of silently dropping exposed controls",()=>{
  const p=projectCanvasMediaProfiles({...snapshot,profiles:[{...profile,imageProtocol:"12ai-task",videoProtocol:"12ai-task"}]}).profiles[0];
  for(const kind of ["image","video"] as const) {
    const caps=mediaCapabilities(kind,p,"unknown-model");
    assert.equal(caps.promptOnly,true);assert.deepEqual(caps.aspects,[]);assert.deepEqual(caps.qualities,[]);
    assert.equal(mediaOption(caps.durations,10),undefined);assert.equal(caps.sound,false);
  }
});
test("native Gemini only offers one output and legacy Agnes keeps single image behavior",()=>{
  const p=projectCanvasMediaProfiles({...snapshot,profiles:[{...profile,imageProtocol:"gemini-image"}]}).profiles[0];
  assert.deepEqual(mediaCapabilities("image",p,"gemini-3-pro-image-preview").counts,[1]);
  assert.deepEqual(mediaCapabilities("image",p,"gemini-2.5-flash-image").qualities,[]);
  assert.deepEqual(mediaCapabilities("image",null,"agnes-image-2.1-flash").counts,[1]);
});
test("IPC preserves absent provider options and both profile binding fields",()=>{
  const app=readFileSync(new URL("../src/App.tsx",import.meta.url),"utf8");
  const video=app.slice(app.indexOf("async function aiVideoGenerate("),app.indexOf("async function prepareCanvasMediaReference("));
  assert.ok(video.includes("duration: request.duration ?? null"));
  assert.ok(video.includes("sound: request.sound ?? null"));
  assert.ok(video.includes("mediaProfileId: request.mediaProfileId ?? null"));
  assert.ok(video.includes("mediaProfileRevision: request.mediaProfileRevision ?? null"));
});

test("media snapshots only expose explicit metadata, never supplied secrets",()=>{
  const result=projectCanvasMediaProfiles({...snapshot,apiKey:"PRIVATE",profiles:[{...profile,apiKey:"PRIVATE",nested:{secret:"PRIVATE"}}]});
  assert.equal(JSON.stringify(result).includes("PRIVATE"),false);
  assert.equal(result.profiles[0].apiKeyConfigured,true);
});
for(const change of [{revision:0},{revision:1.5},{id:"../escape"},{imageProtocol:"anything"},{videoProtocol:"openai-image"},{name:"bad\nname"}]) {
  test(`invalid profile rejects ${JSON.stringify(change)}`,()=>assert.throws(()=>projectCanvasMediaProfiles({...snapshot,profiles:[{...profile,...change}]})));
}
test("unknown active ID and duplicate profiles fail closed",()=>{
  assert.throws(()=>projectCanvasMediaProfiles({...snapshot,activeProfileId:"missing"}));
  assert.throws(()=>projectCanvasMediaProfiles({...snapshot,profiles:[profile,profile]}));
});
test("editing and selecting a profile uses separate bounded commands",async()=>{
  const calls:any[]=[];
  const client=createCanvasMediaProfilesClient(async (command:any,args:any)=>{calls.push({command,args});return snapshot as any;});
  await client.list();await client.activate("media-a");
  await client.save({...profile,expectedRevision:1,apiKey:"",clearApiKey:true} as any);
  await client.remove("media-a",1);
  assert.deepEqual(calls.map(c=>c.command),["canvas_media_profiles_list","canvas_media_profile_activate","canvas_media_profile_upsert","canvas_media_profile_delete"]);
  assert.deepEqual(calls[1].args,{profileId:"media-a"});assert.deepEqual(calls[3].args,{profileId:"media-a",revision:1});
});
test("mutations stay ordered across card mounts and failure does not poison the queue",async()=>{
  const calls:string[]=[];let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const client=createCanvasMediaProfilesClient(async (command:any)=>{
    calls.push(command);
    if(calls.length===1){await held;throw new Error("synthetic failure");}
    return snapshot as any;
  });
  const first=client.activate("media-a").catch(()=>null);
  const second=client.remove("media-a",1);
  await Promise.resolve();assert.deepEqual(calls,["canvas_media_profile_activate"]);
  release();await first;await second;
  assert.deepEqual(calls,["canvas_media_profile_activate","canvas_media_profile_delete"]);
});
test("persisted task/history keeps original profile and revision across retries",()=>{
  const task=createCanvasGenerationTask({id:"t",sourceNodeId:"n",resultNodeId:"n",createdAt:"2026-01-01",request:{kind:"video",prompt:"synthetic",model:"video-model",references:[],mediaProfileId:"media-a",mediaProfileRevision:7}});
  task.providerTaskId="provider-job";
  const entries=normalizeGenerationHistory(JSON.parse(JSON.stringify([historyEntryFromTask(task)])));
  const restored=generationTaskFromHistory(entries[0]);
  assert.equal(restored.request.mediaProfileId,"media-a");assert.equal(restored.request.mediaProfileRevision,7);
  assert.equal(restored.providerTaskId,"provider-job");
});
test("media presets never copy credentials and model support is explicit",()=>{
  for(const preset of Object.values(CANVAS_MEDIA_PRESETS)) assert.equal(Object.hasOwn(preset,"apiKey"),false);
  assert.equal(CANVAS_MEDIA_PRESETS.twelve.imageModel,"");
  assert.equal(CANVAS_MEDIA_PRESETS.custom.videoProtocol,"disabled");
});
for(const provider of ["twelveai","gemini","zhipu","qwen"]) {
  test(`new text provider ${provider} is accepted without inventing model IDs`,()=>{
    const preset=resolveAiProviderPreset(provider);
    assert.equal(preset.model,"");assert.ok(preset.baseUrl.startsWith("https://"));
    const projected=projectAiModelProfilesSnapshot({version:1,activeProfileId:"p",profiles:[{id:"p",name:"P",provider,protocol:preset.protocol,baseUrl:preset.baseUrl,model:"manual-id",availableModels:["manual-id"],enabled:true,apiKeyConfigured:true,agentCompatible:true}]});
    assert.equal(projected.profiles.length,1);assert.equal(projected.profiles[0].provider,provider);
  });
}
