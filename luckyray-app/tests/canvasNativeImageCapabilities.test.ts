import assert from 'node:assert/strict';
import test from 'node:test';
import {mediaCapabilities,nativeImageSpec,mediaQualityOption,effectiveCanvasImageProtocol} from '../src/core/canvas/mediaCapabilities';
import {mediaPixelSize,mediaParameterLabel,mediaParameterKind,aspectFrame} from '../src/core/canvas/mediaOptionPresentation';
import specs from '../src/core/canvas/nativeImageSpecs.json' with {type:'json'};
const profile=(imageProtocol='openai-image',baseUrl='http://127.0.0.1:8317/v1')=>({imageProtocol,baseUrl}) as any;

test('GPT 2 and named 2.5 variants expose full sizes independently of provider hostname',()=>{
 for(const model of ['gpt-image-2','gpt-image-2.5','gpt-image-2.5-flare','gpt-image-2.5-sunburst']) {
  for(const host of ['http://127.0.0.1:8317/v1','http://localhost:9000/v1','https://proxy.example/v1']) {
   const caps=mediaCapabilities('image',profile('openai-image',host),model);
   assert.equal(caps.aspects.length,16);assert.ok(caps.aspects.includes('21:9'));
   assert.deepEqual(caps.resolutions,['1K','2K','4K']);assert.ok(caps.qualities.includes('auto'));
   assert.equal(mediaPixelSize('image',profile('openai-image',host),model,'16:9','4K'),'3840 × 2160');
  }
 }
 assert.deepEqual(mediaCapabilities('image',profile(),'gpt-image-2.5-flare').qualities,['low','medium','high','auto','xhigh','max']);
 assert.ok(!mediaCapabilities('image',profile(),'gpt-image-2').qualities.includes('max'));
 assert.ok(!mediaCapabilities('image',profile(),'gpt-image-2.5').qualities.includes('max'));
});
test('GPT 1.5 retains its real size limits and gains auto without fictitious 4K',()=>{
 const caps=mediaCapabilities('image',profile(),'gpt-image-1.5');
 assert.deepEqual(caps.aspects,['1:1','3:2','2:3','auto']);assert.equal(caps.resolutions,undefined);
 assert.equal(mediaPixelSize('image',profile(),'gpt-image-1.5','3:2'),'1536 × 1024');
 assert.equal(mediaPixelSize('image',profile(),'gpt-image-1.5','auto'),'自动');
});
test('Gemini ratios and resolution depend on the actual model, not a five-ratio adapter default',()=>{
 const p=profile('gemini-image');
 for(const model of ['gemini-2.5-flash-image','gemini-2.5-flash-image-preview','gemini-3-pro-image','gemini-3-pro-image-preview']) {
  const caps=mediaCapabilities('image',p,model);assert.equal(caps.aspects.length,10);
  assert.ok(caps.aspects.includes('4:5'));assert.ok(caps.aspects.includes('21:9'));assert.deepEqual(caps.counts,[1]);
 }
 assert.deepEqual(mediaCapabilities('image',p,'gemini-2.5-flash-image').qualities,[]);
 assert.deepEqual(mediaCapabilities('image',p,'gemini-3-pro-image').qualities,['1K','2K','4K']);
 for(const model of ['gemini-3.1-flash-image','gemini-3.1-flash-image-preview']) {
  const caps=mediaCapabilities('image',p,model);assert.equal(caps.aspects.length,14);
  for(const ratio of ['1:4','4:1','1:8','8:1'])assert.ok(caps.aspects.includes(ratio));
  assert.deepEqual(caps.qualities,['1K','2K','4K','512']);
 }
 assert.equal(mediaParameterKind('image',p,'gemini-3.1-flash-image'),'resolution');
 assert.equal(mediaParameterLabel('512','resolution'),'512px');
 assert.equal(mediaQualityOption(['1K','2K','4K','512'],'512px'),'512');
});
test('prefixes recognize capabilities without modifying route or inventing aliases',()=>{
 assert.deepEqual(nativeImageSpec('team/GPT-Image-2','openai-image'),nativeImageSpec('gpt-image-2','openai-image'));
 assert.deepEqual(nativeImageSpec('models/gemini-3.1-flash-image-preview','gemini-image'),nativeImageSpec('gemini-3.1-flash-image','gemini-image'));
 for(const name of ['my-private-alias','gpt-image-200','gpt-image-2-unknown','gemini-3.1-flash','gpt-image-2(extra)'])assert.equal(nativeImageSpec(name,'openai-image'),undefined);
 assert.equal(nativeImageSpec('gpt-image-2','gemini-image'),undefined);
 assert.equal(nativeImageSpec('gemini-3.1-flash-image','openai-image'),undefined);
 assert.equal(effectiveCanvasImageProtocol('http://127.0.0.1:8317','gemini-3.1-flash-image','openai-image'),'openai-image');
});
test('12API and video keep provider-specific semantics',()=>{
 const p=profile('gemini-image','https://new.12ai.org/v1');
 assert.deepEqual(mediaCapabilities('image',p,'gemini-3.1-flash-image').qualities,['1K','2K','4K','512px']);
 assert.equal(mediaCapabilities('image',p,'gemini-3.1-flash-image').aspects.length,8);
 assert.deepEqual(mediaCapabilities('video',{...profile(),videoProtocol:'openai-video'} as any,'sora-2').aspects,['16:9','9:16']);
});
test('every advanced GPT preset satisfies native size constraints',()=>{
 for(const s of Object.values(specs) as any[])for(const row of Object.values(s.resolutionSizes||{}) as any[])for(const size of Object.values(row) as string[]) {
  const [w,h]=size.split('x').map(Number);assert.equal(w%16,0);assert.equal(h%16,0);
  assert.ok(Math.max(w,h)<=3840);assert.ok(Math.max(w,h)/Math.min(w,h)<=3);
  assert.ok(w*h>=655360&&w*h<=8294400);
 }
});
test('extended Gemini line icons fit the existing option glyph viewport',()=>{
 for(const ratio of ['1:8','8:1','1:4','4:1']) {
  const f=aspectFrame(ratio);assert.ok(f.width>0&&f.height>0);assert.ok(f.x>=0&&f.y>=0&&f.x+f.width<=36&&f.y+f.height<=28);
 }
});
