import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCanvasReference,hasInvalidCanvasReference} from '../src/core/canvas/referenceIdentity';
import {createImageUpgradeQueue} from '../src/core/canvas/imageUpgradeQueue';
import {mediaCapabilities,effectiveCanvasImageProtocol,twelveModelSpec} from '../src/core/canvas/mediaCapabilities';
import specs from '../src/core/canvas/twelveMediaSpecs.json' with {type:'json'};
const profile=(imageProtocol='openai-image',videoProtocol='12ai-task',baseUrl='https://new.12ai.org')=>({imageProtocol,videoProtocol,baseUrl}) as any;
test('reference validity does not depend on an empty cached summary',()=>{
 assert.equal(hasInvalidCanvasReference({kind:'noteRef',payload:'note:kdoc-123'}),false);
 assert.deepEqual(parseCanvasReference('note:vault:note'),{kind:'note',id:'vault:note'});
 assert.equal(hasInvalidCanvasReference({kind:'noteRef',payload:'asset:123'}),true);
 assert.equal(hasInvalidCanvasReference({kind:'noteRef',payload:'note:'}),true);
 assert.equal(parseCanvasReference('note:a\n'),null);
});
test('media without thumbnail and deliberate placeholders are not broken',()=>{
 assert.equal(hasInvalidCanvasReference({kind:'image',payload:'asset:a'}),false);
 assert.equal(hasInvalidCanvasReference({kind:'image',refMediaUrl:'asset://image'}),false);
 assert.equal(hasInvalidCanvasReference({kind:'image',_emptyMedia:true}),false);
 assert.equal(hasInvalidCanvasReference({kind:'image'}),true);
});
test('original decode queue bounds concurrency and ignores repeated completion',()=>{
 const q=createImageUpgradeQueue(2),done:Array<()=>void>=[];
 const add=()=>q.enqueue(finish=>{done.push(finish);return()=>{};});
 add();add();add();assert.deepEqual(q.pending(),{active:2,waiting:1});done[0]();assert.equal(done.length,3);done[0]();assert.equal(q.pending().active,2);done[1]();done[2]();assert.deepEqual(q.pending(),{active:0,waiting:0});
});
test('cancelled jobs free capacity once, queued priority starts before background',()=>{
 const q=createImageUpgradeQueue(1),order:string[]=[],done:Array<()=>void>=[];
 const add=(name:string,priority=false)=>q.enqueue(finish=>{order.push(name);done.push(finish);return()=>{};},priority);
 const cancel=add('active');const queued=add('cancelled');add('background');add('selected',true);queued();cancel();cancel();assert.deepEqual(order,['active','selected']);done[0]();assert.equal(q.pending().active,1);done[1]();assert.deepEqual(order,['active','selected','background']);done[2]();assert.equal(q.pending().active,0);
});
test('throwing decode does not strand subsequent work',()=>{
 const q=createImageUpgradeQueue(1);q.enqueue(()=>{throw Error('decode');});assert.equal(q.pending().active,0);
});
test('exact 12ai GPT models receive documented ratios and extra quality levels',()=>{
 const c=mediaCapabilities('image',profile(),'gpt-image-2.5-flare');assert.equal(c.aspects.length,13);assert.ok(c.aspects.includes('21:9'));assert.ok(c.qualities.includes('xhigh'));assert.ok(c.qualities.includes('max'));
 assert.ok(!mediaCapabilities('image',profile(),'gpt-image-2').qualities.includes('max'));
 // Native GPT capabilities now follow the documented model on any selected
 // OpenAI Images endpoint; this does not grant 12API routing to a lookalike host.
 assert.ok(mediaCapabilities('image',profile('openai-image','12ai-task','https://new.12ai.org.attacker.test'),'gpt-image-2.5-flare').aspects.includes('21:9'));
});
test('native Gemini and task Gemini expose only their documented combinations',()=>{
 const native=mediaCapabilities('image',profile('gemini-image'),'gemini-3.1-flash-image-preview');assert.ok(native.qualities.includes('512px'));assert.ok(!native.aspects.includes('4:5'));
 const task=mediaCapabilities('image',profile('12ai-task'),'gemini-3.1-flash-image-preview');assert.ok(task.aspects.includes('4:5'));
 assert.deepEqual(mediaCapabilities('image',profile('gemini-image'),'gemini-2.5-flash-image').qualities,[]);
});
test('video options retain case and unsupported controls stay absent',()=>{
 const c=mediaCapabilities('video',profile(),'MiniMax-H3');assert.deepEqual(c.qualities,['768P','2K']);assert.equal(c.sound,false);
 assert.ok(mediaCapabilities('video',profile(),'gemini-omni-1.1-flash').qualities.includes('4k'));
 assert.deepEqual(mediaCapabilities('video',profile(),'unknown-task-model').aspects,[]);
 assert.equal(mediaCapabilities('image',profile('agnes'),'agnes-image-test').qualities[0],'标准');
});
test('all public GPT size presets satisfy documented grid and area bounds',()=>{
 for(const s of Object.values(specs) as any[]){if(s.family!=='gpt')continue;for(const [ratio,size] of Object.entries(s.sizes)){if(ratio==='auto'){assert.equal(size,'auto');continue;}const [w,h]=String(size).split('x').map(Number);assert.equal(w%16,0);assert.equal(h%16,0);assert.ok(w*h>=655360&&w*h<=8294400);assert.ok(Math.max(w,h)/Math.min(w,h)<=3);}}
});

test('12API model switching aligns alias, protocol, ratios and quality without touching other relays',()=>{
 const selected='gemini-3.1-flash-image';
 for(const base of ['https://new.12ai.org/v1','https://cdn.12ai.org/v1']){
  assert.equal(effectiveCanvasImageProtocol(base,selected,'openai-image'),'gemini-image');
  const c=mediaCapabilities('image',profile('openai-image','12ai-task',base),selected);
  assert.ok(c.aspects.includes('16:9'));assert.ok(c.aspects.includes('21:9'));assert.ok(c.qualities.includes('512px'));assert.ok(c.qualities.includes('4K'));assert.deepEqual(c.counts,[1]);
  assert.equal(effectiveCanvasImageProtocol(base,'gpt-image-2.5-flare','gemini-image'),'openai-image');
  for(const protocol of ['12ai-task','agnes','disabled'])assert.equal(effectiveCanvasImageProtocol(base,selected,protocol),protocol);
 }
 for(const base of ['https://other.example/v1','https://new.12ai.org.attacker.example/v1'])assert.equal(effectiveCanvasImageProtocol(base,selected,'openai-image'),'openai-image');
 assert.equal(twelveModelSpec(selected),twelveModelSpec('gemini-3.1-flash-image-preview'));
 assert.equal(effectiveCanvasImageProtocol('https://new.12ai.org','unlisted-image','openai-image'),'openai-image');
});
