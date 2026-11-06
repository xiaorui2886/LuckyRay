import test from "node:test";
import assert from "node:assert/strict";
import { canvasApiModelChoices, canvasGenerationProfile, canvasProfileModelIds } from "../src/core/canvas/apiModelLibrary.ts";
import type { CanvasMediaProfile } from "../src/core/services/canvasMediaProfiles.ts";
import { buildHistoryDraft } from "../src/core/canvas/generationIteration.ts";

const a: CanvasMediaProfile = {id:"a",name:"Connection A",baseUrl:"https://a.invalid/v1",imageModel:"same-model",imageModels:["same-model","image-a"],videoModel:"video-a",videoModels:["video-a"],textModel:"text-a",textModels:["text-a"],textProtocol:"openai-chat",imageProtocol:"openai-image",videoProtocol:"openai-video",revision:3,apiKeyConfigured:true};
const b: CanvasMediaProfile = {...a,id:"b",name:"Connection B",baseUrl:"https://b.invalid/v1",imageModels:["same-model","image-b"],revision:7};

test("all saved models are listed, while identical IDs retain distinct connection identities",()=>{
  assert.deepEqual(canvasApiModelChoices([a,b],"image",a,[]).map(({profileId,model})=>[profileId,model]),[["a","same-model"],["a","image-a"],["b","same-model"],["b","image-b"]]);
  assert.equal(canvasGenerationProfile([a,b],a,"b"),b);
  assert.equal(a.id,"a");
});
test("old default-only profiles remain available without inventing or enabling models",()=>{
  assert.deepEqual(canvasProfileModelIds({...a,imageModels:undefined},"image"),["same-model"]);
  assert.deepEqual(canvasProfileModelIds({...a,imageProtocol:"disabled"},"image"),[]);
  assert.deepEqual(canvasProfileModelIds({...a,id:"doubao-default"},"image"),[]);
  assert.deepEqual(canvasProfileModelIds({...a,videoProtocol:"doubao-video"},"text"),[]);
});
test("removed selected connections do not fall back to another connection",()=>{
  assert.equal(canvasGenerationProfile([a],a,"deleted"),null);
  assert.equal(canvasGenerationProfile([a,b],a),a);
  assert.equal(canvasGenerationProfile(undefined,a,"a"),a);
});
test("catalog respects media kinds and lists shared legacy text only once",()=>{
  const legacy={...a,textProtocol:"legacy" as const};
  const options=canvasApiModelChoices([legacy,b],"text",legacy,[],{models:["app-text"],providerLabel:"App provider"});
  assert.deepEqual(options.map(({profileId,model})=>[profileId,model]),[["a","app-text"],["b","text-a"]]);
  assert.deepEqual(canvasApiModelChoices([a,b],"video",a,[]).map(c=>c.model),["video-a","video-a"]);
});

test("restoring historical parameters keeps their connection instead of the active default",()=>{
  const entry:any={id:"history-b",status:"succeeded",kind:"image",request:{kind:"image",model:"same-model",mediaProfileId:"b",mediaProfileRevision:7,prompt:"Synthetic",references:[]},outputMediaUrl:"https://synthetic.invalid/result.png"};
  const draft=buildHistoryDraft(entry,"parameters");
  assert.equal(draft?.generationProfileId,"b");assert.equal(draft?.generationModel,"same-model");
  assert.equal(canvasGenerationProfile([a,b],a,draft?.generationProfileId),b);
});
