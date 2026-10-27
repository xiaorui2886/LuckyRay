import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultShot, validShot, patchStoryboardShot, moveStoryboardShot, resolveStoryboardPosition, buildStoryboardPrompt, type StoryboardNode } from '../src/core/canvas/storyboard.ts';
import { reusableStoryboardDraft } from '../src/core/canvas/storyboardImport.ts';
import { parseStoryboardScript } from '../src/core/canvas/storyboardScript.ts';
import { buildStoryboardDeliveryPlan, serializeStoryboardScript } from '../src/core/canvas/storyboardDelivery.ts';
const board: StoryboardNode = {id:'board',data:{kind:'group',storyboard:{version:1}}};
const make = (): StoryboardNode => ({id:'shot',parentId:'board',data:{kind:'generator',generationKind:'image',generationPrompt:'original',storyboardShot:defaultShot(0)}});
test('legacy shots stay valid; patches preserve all existing metadata and validate optional fields',()=>{
 const node=make(); node.data.storyboardShot!.chosenResult={key:'image',kind:'image',url:'private://reference'};
 const result=patchStoryboardShot([board,node],'board','shot',{lighting:'soft',sound:'wind',cameraMovement:'pan'});
 assert.equal(validShot(defaultShot(0)),true); assert.equal(result[1].data.storyboardShot!.action,'');
 assert.deepEqual(result[1].data.storyboardShot!.chosenResult,node.data.storyboardShot!.chosenResult);
 assert.equal(node.data.storyboardShot!.lighting,undefined); assert.equal(result[1].data.generationPrompt,'original');
 assert.throws(()=>patchStoryboardShot(result,'board','shot',{lighting:'x'.repeat(2001)}));
 assert.equal(validShot({...defaultShot(0),sound:42}),false);
});
test('only lighting/sound/camera content must never be overwritten as an untouched import draft',()=>{
 for(const key of ['lighting','sound','cameraMovement'] as const){
  const node=make(); delete node.data.generationPrompt; node.data.storyboardShot![key]='keep me';
  assert.equal(reusableStoryboardDraft([board,node],[],'board'),undefined);
 }
});
test('import separates new planning fields and preserves legacy action notes',()=>{
 const {shots}=parseStoryboardScript('镜头1\n画面：山谷\n动作/运镜：人走动\n光影氛围：暮光\n音效：风声\n运镜：缓慢推进\n对白：你好');
 assert.equal(shots[0].description,'山谷');assert.equal(shots[0].action,'人走动');
 assert.equal(shots[0].lighting,'暮光');assert.equal(shots[0].sound,'风声');assert.equal(shots[0].cameraMovement,'缓慢推进');assert.equal(shots[0].dialogue,'你好');
 assert.equal(parseStoryboardScript('镜头1\n音效：风声').shots[0].sound,'风声');
});
test('delivery preserves new fields without leaking media URLs into the script',()=>{
 const node=make();node.data.storyboardShot={...defaultShot(0),description:'valley',lighting:'golden',sound:'wind',cameraMovement:'pan',chosenResult:{key:'one',kind:'image',url:'private://secret'}};
 const plan=buildStoryboardDeliveryPlan([board,node],'board');const script=serializeStoryboardScript(plan);
 assert.equal(plan.shots[0].script.lighting,'golden');assert.match(script,/Sound: wind/);assert.match(script,/Camera movement: pan/);assert.doesNotMatch(script,/private:\/\//);
 const prompt=buildStoryboardPrompt(node,true);assert.match(prompt,/Lighting：golden/);assert.match(prompt,/Camera movement：pan/);assert.doesNotMatch(prompt,/wind/);
});
test('table default and explicit legacy views survive reopening; reordering preserves fields',()=>{
 const node=make(), second={...make(),id:'second',data:{...make().data,storyboardShot:{...defaultShot(1),lighting:'blue'}}};
 assert.equal(resolveStoryboardPosition([board,node]).mode,'table');
 assert.equal(resolveStoryboardPosition([board,node],undefined,{boardId:'board',mode:'board'}).mode,'board');
 const moved=moveStoryboardShot([board,node,second],'board','second',-1);assert.equal(moved[2].data.storyboardShot!.lighting,'blue');assert.equal(moved[2].data.storyboardShot!.order,0);
});
