import test from 'node:test';
import assert from 'node:assert/strict';
import { historyEntryFromTask, toGenerationLibraryCandidate } from '../src/core/canvas/generationHistory.ts';
import { historyLibraryCandidates, buildHistoryDraft } from '../src/core/canvas/generationIteration.ts';
import { canvasNodeLibraryCandidates } from '../src/core/canvas/nodeSaving.ts';
import { materialProvenanceHistory, normalizeMaterialGenerationProvenance } from '../src/core/canvas/materialProvenance.ts';
import { createMaterialProvenanceStore } from '../src/core/canvas/materialProvenanceStore.ts';
import type { CanvasGenerationTask } from '../src/core/canvas/generationTasks.ts';
const task: CanvasGenerationTask = {version:1,id:'task-original',sourceNodeId:'source-original',resultNodeId:'result-original',status:'succeeded',attempt:1,adapter:null,error:null,createdAt:'2026-10-18T00:00:00Z',updatedAt:'2026-10-18T00:00:02Z',request:{kind:'image',prompt:'compiled prompt\noriginal note body',sourcePrompt:'original prompt',model:'original-model',aspect:'16:9',quality:'high',resolution:'2K',count:2,mediaProfileId:'do-not-copy',mediaProfileRevision:12,editor:{version:1,prompt:'original prompt',referenceKeys:['edge-original','stored-note']},references:[{id:'ref-image',sourceNodeId:'old-image',kind:'image',label:'Image1',role:'reference',mediaUrl:'/refs/a.png'},{id:'ref-note',kind:'note',label:'笔记正文',role:'promptContext',text:'original note body'}]}};
const entry=historyEntryFromTask(task,{mediaUrl:'/generated/one.png',mediaItems:[{url:'/generated/one.png'},{url:'/generated/two.png'}]});
test('generation → named material save candidate → durable reload → another canvas recovers immutable parameters and references',async()=>{
 const candidates=historyLibraryCandidates(entry);assert.equal(candidates.length,2);assert.equal(candidates[1].provenance?.request.model,'original-model');
 const files=new Map<string,string>();const storage={read:async(key:string)=>files.get(key)||null,write:async(key:string,value:string)=>{files.set(key,value);}};
 const store=createMaterialProvenanceStore(storage,'library-a');const asset={id:'material-1',libraryPath:'/library/one.png',contentHash:'sha256-exact-output'};
 await store.write(asset,candidates[1].provenance!);
 task.request.model='mutated-latest-model';task.request.references[0].mediaUrl='/refs/latest.png';
 const reopened=createMaterialProvenanceStore(storage,'library-a');const recovered=await reopened.read({...asset,libraryPath:'/library/renamed.png'});assert.ok(recovered);
 const importedHistory=materialProvenanceHistory(recovered,'new-canvas-node','/library/renamed.png');
 const draft=buildHistoryDraft(importedHistory,'parameters');assert.equal(draft?.generationModel,'original-model');assert.equal(draft?.generationPrompt,'original prompt');assert.equal(draft?.generationCount,2);assert.equal(draft?.generationAspect,'16:9');assert.equal(draft?.generationResolution,'2K');assert.equal(draft?.generationReferences[0].mediaUrl,'/refs/a.png');assert.equal(draft?.generationReferences[0].sourceNodeId,undefined);assert.equal(draft?.generationReferences[1].text,'original note body');
 assert.equal(importedHistory.outputMediaUrl,'/library/renamed.png');assert.equal(importedHistory.parentTaskId,'task-original');assert.equal(importedHistory.request.mediaProfileId,undefined);
 assert.equal(await createMaterialProvenanceStore(storage,'library-b').read(asset),undefined);
 assert.equal(await reopened.read({...asset,contentHash:'changed-file'}),undefined);
});
test('candidate seams capture selected immutable batch, not latest task',()=>{
 const latest={...task,id:'latest',request:{...task.request,prompt:'latest'}};
 const candidate=canvasNodeLibraryCandidates({kind:'generator',generationKind:'image',generationTask:latest,resultMediaItems:[{url:'/generated/two.png'}]},[entry])[0];
 assert.equal(candidate.provenance?.taskId,entry.taskId);assert.equal(candidate.provenance?.request.prompt,entry.request.prompt);assert.ok(toGenerationLibraryCandidate(entry)?.provenance);
});
test('strict metadata allowlist drops credentials, signed URLs and unknown fields; ordinary imported assets get no history',()=>{
 const provenance=normalizeMaterialGenerationProvenance({version:1,historyId:'h',taskId:'t',createdAt:'',kind:'image',apiKey:'secret',request:{...entry.request,apiKey:'secret',endpoint:'https://private.example',references:[{id:'signed',label:'signed',kind:'image',role:'reference',mediaUrl:'https://example.com/a.png?X-Amz-Signature=secret',apiKey:'secret'}]}});
 assert.ok(provenance);assert.equal(provenance.request.references[0].mediaUrl,undefined);assert.ok(!JSON.stringify(provenance).includes('secret'));assert.equal(provenance.request.mediaProfileId,undefined);assert.equal(provenance.request.editor,undefined);
 assert.equal(normalizeMaterialGenerationProvenance(undefined),undefined);assert.equal(normalizeMaterialGenerationProvenance({prompt:'invented'}),undefined);
});
test('storage failure is surfaced, not reported as a successful provenance save',async()=>{
 const store=createMaterialProvenanceStore({read:async()=>null,write:async()=>{throw Error('disk-full');}},'library-a');
 await assert.rejects(store.write({id:'a'},historyLibraryCandidates(entry)[0].provenance!),/disk-full/);
});
test('unknown older output never inherits the newest known generation request',()=>{
 const candidate=canvasNodeLibraryCandidates({kind:'generator',generationKind:'image',generationTask:task,resultMediaItems:[{url:'/unknown-older-output.png'}]},[entry])[0];
 assert.equal(candidate.provenance,undefined);
});
test('malformed reference arrays cannot shift editor token identity onto different references',()=>{
 const value=normalizeMaterialGenerationProvenance({version:1,historyId:'h',taskId:'t',createdAt:'',kind:'image',request:{kind:'image',prompt:'compiled',model:'m',editor:{version:1,prompt:'original',referenceKeys:['wrong']},references:[null,{id:'good',label:'good',kind:'image',role:'reference'}]}});
 assert.equal(value?.request.editor,undefined);
});
test('restored generator save follows second-image switcher, not stale initial source URL',()=>{
 const restored={kind:'generator' as const,generationKind:'image' as const,sourceGenerationTaskId:entry.taskId,sourceGenerationHistoryId:entry.id,sourceGenerationMediaUrl:'/generated/one.png',refMediaUrl:'/generated/one.png',resultMediaUrl:'/generated/two.png',resultMediaItems:entry.outputMediaItems};
 const candidates=canvasNodeLibraryCandidates(restored,[entry]);assert.equal(candidates.length,1);assert.equal(candidates[0].mediaUrl,'/generated/two.png');assert.equal(candidates[0].provenance?.request.prompt,entry.request.prompt);
 assert.deepEqual(canvasNodeLibraryCandidates({...restored,resultMediaUrl:'/unrelated-replacement.png'},[entry]),[]);
});
