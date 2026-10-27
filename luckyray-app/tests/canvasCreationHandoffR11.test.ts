import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCreationHandoff } from '../src/core/canvas/agent/creationHandoff.ts';
import { creationRevision, type CreationState } from '../src/core/canvas/agent/creationEngine.ts';
const state:CreationState={canvasId:'canvas',nodes:[
 {id:'img',position:{x:0,y:0},data:{kind:'image',refMediaUrl:'private://original'}},
 {id:'text',position:{x:0,y:0},data:{kind:'text',label:'hello'}},
 {id:'board',position:{x:0,y:0},data:{kind:'group',storyboard:{version:1}}},
 {id:'empty',position:{x:0,y:0},data:{kind:'image'}},
],edges:[],history:[]};
test('image handoff targets existing original with bounded index and edit; no path accepted',()=>{
 const prepared=prepareCreationHandoff(state,{expectedRevision:creationRevision(state),panel:'imageTools',nodeIds:['img'],imageIndex:1,imageEdit:{turns:0,flipX:false,flipY:false,crop:{x:0,y:0,width:1,height:1},width:512,height:512}});
 assert.equal(prepared.completion,'awaiting-user');assert.equal(prepared.panel,'editImage');assert.equal(prepared.imageIndex,1);
 assert.ok(!JSON.stringify(prepared).includes('private://'));assert.match(prepared.summary,/No file/);
});
for(const request of [{panel:'imageTools',nodeIds:[]},{panel:'imageTools',nodeIds:['text']},{panel:'imageTools',nodeIds:['empty']},{panel:'imageTools',nodeIds:['missing']},{panel:'delivery',nodeIds:['img','text']},{panel:'templateExport',nodeIds:[]},{panel:'storyboardExport',objectId:'img'},{panel:'imageTools',nodeIds:['img'],path:'/etc/passwd'},{panel:'delivery',nodeIds:['img'],imageIndex:0}]){
 test('handoff rejects '+JSON.stringify(request),()=>assert.throws(()=>prepareCreationHandoff(state,{expectedRevision:creationRevision(state),...request} as any)));
}
test('storyboard export opens board only, does not mutate or export',()=>{
 const original=structuredClone(state), result=prepareCreationHandoff(state,{expectedRevision:creationRevision(state),panel:'storyboardExport',objectId:'board'});
 assert.equal(result.boardId,'board');assert.equal(result.panel,'storyboard');assert.equal(result.completion,'awaiting-user');assert.deepEqual(state,original);
});
test('template import is a declared user handoff, not an imported template',()=>{
 const result=prepareCreationHandoff(state,{expectedRevision:creationRevision(state),panel:'templateImport'});assert.equal(result.panel,'workflows');assert.equal(result.completion,'awaiting-user');
});

test('stale handoff refuses old crop on replacement image',()=>{
 const revision=creationRevision(state);const changed=structuredClone(state);changed.nodes[0].data.refMediaUrl='private://replacement';
 assert.throws(()=>prepareCreationHandoff(changed,{expectedRevision:revision,panel:'imageTools',nodeIds:['img']}),/context-stale/);
});
