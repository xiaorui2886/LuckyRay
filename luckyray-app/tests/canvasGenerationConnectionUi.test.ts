import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {CANVAS_MEDIA_PRESETS, createCanvasMediaProfilesClient, projectCanvasMediaProfiles} from '../src/core/services/canvasMediaProfiles.ts';
test('Ark presets retain independent exact billing URLs, no assumed model and no text proxy',()=>{
 assert.equal(CANVAS_MEDIA_PRESETS.arkPlan.baseUrl,'https://ark.cn-beijing.volces.com/api/plan/v3');
 assert.equal(CANVAS_MEDIA_PRESETS.arkPaygo.baseUrl,'https://ark.cn-beijing.volces.com/api/v3');
 for(const p of [CANVAS_MEDIA_PRESETS.arkPlan,CANVAS_MEDIA_PRESETS.arkPaygo]){assert.equal(p.textProtocol,'disabled');assert.equal(p.imageModel,'');assert.equal(p.imageProtocol,'ark-image');assert.equal(p.videoProtocol,'ark-video');}
 assert.equal('doubao' in CANVAS_MEDIA_PRESETS,false);
});
test('Agent Plan and retired connector discovery fail closed before IPC',async()=>{let calls=0;const c=createCanvasMediaProfilesClient(async()=>{calls++;return [] as any;});await assert.rejects(c.listModels(CANVAS_MEDIA_PRESETS.arkPlan.baseUrl,'key','ark-image'));await assert.rejects(c.listModels('https://www.doubao.com','','doubao-image'));assert.equal(calls,0);});
test('legacy Doubao projection preserves metadata without rewriting protocol or exposing credentials',()=>{
 const row={name:'Saved account',baseUrl:'https://www.doubao.com',imageModel:'Saved image',videoModel:'Saved video',imageProtocol:'doubao-image',videoProtocol:'doubao-video',textProtocol:'disabled',id:'doubao-default',revision:1,apiKey:'secret',apiKeyConfigured:false};
 const p=projectCanvasMediaProfiles({version:1,activeProfileId:'doubao-default',profiles:[row]});
 assert.equal(p.activeProfileId,'doubao-default');assert.equal(p.profiles[0].imageProtocol,'doubao-image');assert.equal(p.profiles[0].imageModel,'Saved image');assert.ok(!JSON.stringify(p).includes('secret'));
});
test('generic canvas bridge identity and concurrency scheduling remain without account routing',()=>{
 const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 assert.ok(source.includes('bridge.aiImageGenerate!(request, task.id)'));assert.ok(source.includes('reserve(slot, generationConcurrencyPolicy)'));
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');assert.doesNotMatch(app,/doubaoConnector|runDoubaoCanvasTask/);
});

test('saved Doubao image/video history and media results remain readable and retain their original binding',async()=>{
 const {normalizeGenerationHistory,generationTaskFromHistory,toGenerationLibraryCandidate}=await import('../src/core/canvas/generationHistory.ts');
 for(const kind of ['image','video'] as const){
  const mediaUrl=`/existing/result.${kind==='image'?'png':'mp4'}`;
  const saved={version:4,id:`history:old-${kind}`,taskId:`old-${kind}`,sourceNodeId:'original',resultNodeId:'original',kind,status:'succeeded',request:{kind,prompt:'Saved prompt',model:'Saved model',mediaProfileId:'doubao-default',mediaProfileRevision:7,doubaoAccountIds:['default'],references:[]},attempt:1,prompt:'Saved prompt',model:'Saved model',createdAt:'2026-10-27',updatedAt:'2026-10-27',outputMediaUrl:mediaUrl};
  const [entry]=normalizeGenerationHistory([saved]);
  assert.equal(entry.outputMediaUrl,mediaUrl);assert.equal(entry.request.mediaProfileId,'doubao-default');
  assert.equal(generationTaskFromHistory(entry).request.mediaProfileId,'doubao-default');
  assert.equal(toGenerationLibraryCandidate(entry)?.mediaUrl,mediaUrl);
  assert.deepEqual(saved.request.doubaoAccountIds,['default']);
 }
});
