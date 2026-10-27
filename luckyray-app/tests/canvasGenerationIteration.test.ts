import test from 'node:test';import assert from 'node:assert/strict';
import {buildHistoryDraft,historyHasResult,historyLibraryCandidates,resultEntryForNode} from '../src/core/canvas/generationIteration.ts';
import type {CanvasGenerationHistoryEntry} from '../src/core/canvas/generationHistory.ts';
const entry=(kind:'text'|'image'|'video'='image'):CanvasGenerationHistoryEntry=>({version:1,id:'h',taskId:'t',sourceNodeId:'src',resultNodeId:'src',kind,status:'succeeded',attempt:1,prompt:'P with compiled context',model:'model',createdAt:'2026-10-17',updatedAt:'2026-10-17',request:{kind,prompt:'P with compiled context',model:'model',count:4,references:[{id:'node:text',sourceNodeId:'text',label:'Text',kind:'text',role:'promptContext',text:'context'},{id:'node:image',sourceNodeId:'image',label:'Image',kind:'image',role:'reference',mediaUrl:'/input.png'}]},outputText:kind==='text'?'Result text':undefined,outputMediaUrl:kind==='text'?undefined:'/result.png',outputMediaItems:kind==='image'?[{url:'/result.png'},{url:'/second.png'}]:undefined});
test('image continuation is an unstarted new draft using selected result only',()=>{const e=entry(),before=structuredClone(e);const d=buildHistoryDraft(e,'result',1)!;assert.equal(d.generationPrompt,'');assert.equal(d.generationReferences.length,1);assert.equal(d.generationReferences[0].mediaUrl,'/second.png');assert.equal(d.generationCount,1);assert.equal('generationTask' in d,false);assert.equal('resultMediaUrl' in d,false);assert.deepEqual(e,before);});
test('parameter draft avoids compiling historical text context a second time',()=>{const e=entry();const d=buildHistoryDraft(e,'parameters')!;assert.equal(d.generationPrompt,e.request.prompt);assert.equal(d.generationReferences.length,1);assert.equal(d.generationReferences[0].kind,'image');assert.equal(d.generationReferences[0].sourceNodeId,undefined);assert.ok(d.generationReferences[0].id.startsWith('history:'));});
test('text continuation copies the result without reusing task or output objects',()=>{const d=buildHistoryDraft(entry('text'),'result')!;assert.equal(d.kind,'text');assert.equal(d.label,'Result text');assert.equal(d.generationPrompt,'');assert.deepEqual(d.generationReferences,[]);});
test('active jobs cannot become another editable task implicitly',()=>{assert.equal(buildHistoryDraft({...entry(),status:'running'},'parameters'),null);assert.equal(buildHistoryDraft({...entry(),status:'queued'},'result'),null);});
test('batch library save retains every unique generated image',()=>{const e=entry();e.outputMediaItems!.push({url:'/second.png'});assert.deepEqual(historyLibraryCandidates(e).map(c=>c.mediaUrl),['/result.png','/second.png']);assert.deepEqual(historyLibraryCandidates({...e,status:'failed'}),[]);});
test('video presence requires video URL rather than stray image batch',()=>{const e={...entry('video'),outputMediaUrl:undefined,outputMediaItems:[{url:'/image.png'}]};assert.equal(historyHasResult(e),false);});
test('draft provenance is not an already-generated result',()=>{assert.equal(resultEntryForNode({id:'draft',data:{kind:'generator',sourceGenerationHistoryId:'h'}},[entry()]),undefined);assert.equal(resultEntryForNode({id:'draft',data:{kind:'text',sourceGenerationHistoryId:'h'}},[entry('text')]),undefined);});
test('current task identity takes precedence over source provenance',()=>{const old=entry(),current={...entry(),id:'new-h',taskId:'new-t',status:'running' as const};assert.equal(resultEntryForNode({id:'new',data:{kind:'generator',generationTask:{id:'new-t'},sourceGenerationHistoryId:'h'}},[old,current]),undefined);});
test('restored single image uses exact chosen batch member; replaced media loses stale actions',()=>{const node={id:'restored',data:{kind:'image',sourceGenerationHistoryId:'h',refMediaUrl:'asset:/second.png'}};const found=resultEntryForNode(node,[entry()],url=>'asset:'+url)!;assert.deepEqual(found.outputMediaItems,[{url:'/second.png'}]);assert.equal(resultEntryForNode({...node,data:{...node.data,refMediaUrl:'/replacement.png'}},[entry()]),undefined);});

test('older same-node primary image resolves its own immutable generation record',()=>{
 const old=entry(),latest={...entry(),id:'latest-history',taskId:'latest',outputMediaUrl:'/latest.png',outputMediaItems:[{url:'/latest.png'}]};
 const node={id:'src',data:{kind:'generator',generationTask:{id:'latest'},resultMediaUrl:'/second.png'}};
 assert.equal(resultEntryForNode(node,[latest,old])?.taskId,'t');
 assert.equal(resultEntryForNode({...node,data:{...node.data,resultMediaUrl:'/latest.png'}},[latest,old])?.taskId,'latest');
 const other={...old,sourceNodeId:'other',resultNodeId:'other'};
 assert.notEqual(resultEntryForNode(node,[latest,other])?.taskId,'t');
});

test('restored generator discovers only exact linked original result without a current task',()=>{
 const entry:any={id:'original-history',taskId:'original-task',sourceNodeId:'old',resultNodeId:'old',kind:'image',status:'succeeded',outputMediaUrl:'/original.png'};
 const node:any={id:'restored',data:{kind:'generator',sourceGenerationHistoryId:'original-history',resultMediaUrl:'/original.png'}};
 assert.equal(resultEntryForNode(node,[entry])?.id,'original-history');
 assert.equal(resultEntryForNode({...node,data:{...node.data,resultMediaUrl:'/replacement.png'}},[entry]),undefined);
 assert.equal(resultEntryForNode({...node,data:{...node.data,generationTask:{id:'new-current'}}},[entry]),undefined);
});
test('restored generator history remains discoverable after switching to second batch image',()=>{
 const entry:any={id:'batch-history',taskId:'batch-task',sourceNodeId:'old',resultNodeId:'old',kind:'image',status:'succeeded',outputMediaUrl:'/one.png',outputMediaItems:[{url:'/one.png'},{url:'/two.png'}]};
 const node:any={id:'restored',data:{kind:'generator',sourceGenerationHistoryId:'batch-history',sourceGenerationMediaUrl:'/one.png',refMediaUrl:'/one.png',resultMediaUrl:'/two.png'}};
 assert.equal(resultEntryForNode(node,[entry])?.id,'batch-history');assert.equal(resultEntryForNode({...node,data:{...node.data,resultMediaUrl:'/unrelated.png'}},[entry]),undefined);
});
