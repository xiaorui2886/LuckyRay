import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CANVAS_MEDIA_PRESETS, projectCanvasMediaProfiles } from '../src/core/services/canvasMediaProfiles.ts';
import { effectiveCanvasImageProtocol, mediaCapabilities } from '../src/core/canvas/mediaCapabilities.ts';
import { mediaParameterKind } from '../src/core/canvas/mediaOptionPresentation.ts';

const profile={...CANVAS_MEDIA_PRESETS.easycli,id:'existing-easy',revision:7,apiKeyConfigured:true};
test('same EasyCLI profile switches GPT/Gemini protocol and options by node model',()=>{
  for(const baseUrl of ['http://127.0.0.1:8317/v1','http://localhost:8317/v1beta','https://relay.example/prefix/v1']) {
    const p={...profile,baseUrl};
    assert.equal(effectiveCanvasImageProtocol(baseUrl,'gpt-image-2.5-sunburst',p.imageProtocol),'openai-image');
    assert.equal(effectiveCanvasImageProtocol(baseUrl,'account/gemini-3.1-flash-image',p.imageProtocol),'gemini-image');
    assert.equal(mediaParameterKind('image',p,'gpt-image-2.5-sunburst'),'quality');
    assert.equal(mediaParameterKind('image',p,'gemini-3.1-flash-image'),'resolution');
    assert.deepEqual(mediaCapabilities('image',p,'gemini-3.1-flash-image').qualities,['1K','2K','4K','512']);
    assert.ok(mediaCapabilities('image',p,'gpt-image-2.5-sunburst').qualities.includes('high'));
    assert.equal(p.id,'existing-easy');assert.equal(p.revision,7);assert.equal(p.apiKeyConfigured,true);
  }
});
test('explicit fixed adapters stay fixed and arbitrary aliases never fall back',()=>{
  for(const base of ['http://127.0.0.1:8317/v1','https://relay.example/v1']) {
    assert.equal(effectiveCanvasImageProtocol(base,'gemini-3.1-flash-image','openai-image'),'openai-image');
    assert.equal(effectiveCanvasImageProtocol(base,'gpt-image-2.5-sunburst','gemini-image'),'gemini-image');
    assert.equal(effectiveCanvasImageProtocol(base,'alias','easycli-auto'),'easycli-auto');
    assert.equal(mediaCapabilities('image',{...profile,baseUrl:base},'alias').promptOnly,true);
  }
});
test('saved auto profile projects while credentials remain native; legacy profiles retain explicit adapter',()=>{
  const result=projectCanvasMediaProfiles({version:1,activeProfileId:profile.id,profiles:[{...profile,apiKey:'DO-NOT-EXPOSE'}]});
  assert.equal(result.profiles[0].imageProtocol,'easycli-auto');
  assert.equal(JSON.stringify(result).includes('DO-NOT-EXPOSE'),false);
  assert.equal(projectCanvasMediaProfiles({version:1,activeProfileId:profile.id,profiles:[{...profile,imageProtocol:'openai-image'}]}).profiles[0].imageProtocol,'openai-image');
});
test('native validator and shared dispatch accept explicit auto mode; discovery reuses same base/key',()=>{
  const native=readFileSync('src-tauri/src/canvas_media_options.rs','utf8');
  assert.match(native,/configured=="easycli-auto"/);
  assert.match(native,/native_spec\(model,"gemini-image"\)/);
  assert.match(native,/native_spec\(model,"openai-image"\)/);
  assert.match(readFileSync('src-tauri/src/canvas_media_profiles.rs','utf8'),/"easycli-auto"\|"agnes"/);
  assert.match(readFileSync('src-tauri/src/lib.rs','utf8'),/easycli_base\(&base,&query.image_protocol\)/);
});
