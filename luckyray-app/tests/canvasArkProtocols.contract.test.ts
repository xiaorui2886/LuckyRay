import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mediaCapabilities } from '../src/core/canvas/mediaCapabilities.ts';
const native=readFileSync(new URL('../src-tauri/src/canvas_media_protocols.rs',import.meta.url),'utf8');
const profile={baseUrl:'https://ark.cn-beijing.volces.com/api/plan/v3',imageProtocol:'ark-image',videoProtocol:'ark-video'} as any;
test('Ark capabilities expose only implemented fields and single output',()=>{
  assert.deepEqual(mediaCapabilities('image',profile,'exact-model-id'),{aspects:[],qualities:['2K','4K'],durations:[],counts:[1],sound:false,camera:false,promptOnly:false});
  const video=mediaCapabilities('video',profile,'exact-video-id');
  assert.deepEqual(video.counts,[1]);assert.deepEqual(video.qualities,[]);assert.equal(video.camera,false);assert.equal(video.sound,true);
});
test('Ark native dispatch has JSON references rather than multipart edits',()=>{
  const branch=native.slice(native.indexOf('"ark-image" => {'),native.indexOf('"openai-image" => {'));
  assert.match(branch,/ark_image_body/);assert.match(branch,/images\/generations/);assert.match(branch,/bearer_auth/);assert.match(branch,/\.json\(&body\)/);assert.doesNotMatch(branch,/multipart|images\/edits/);
});
test('Ark submit preserves durable receipt before poll and no cross billing fallback',()=>{
  assert.match(native,/"https:\/\/ark.cn-beijing.volces.com\/api\/plan\/v3" \| "https:\/\/ark.cn-beijing.volces.com\/api\/v3"=>Ok/);
  assert.match(native,/ledger\.begin\(\)\?;\s*diagnostic.begin\("submit"\)/);
  assert.ok(native.indexOf('ledger.record(&id)?')<native.indexOf('let mut transient_query_failures'));
  assert.match(native,/contents\/generations\/tasks/);assert.match(native,/\/content\/video_url/);
  assert.match(native,/protocol=="ark-video" && matches!\(e,"rate_limited"\|"timeout"\|"connection"\) && transient_query_failures<3/);
  assert.doesNotMatch(native,/\.delete\(/);
  assert.match(native,/"QuotaExceeded.AgentPlanQuotaExceeded" => Some\("usage_limit"\)/);
});
test('Retired Doubao profiles expose no controls and never inherit API defaults',()=>{
  for(const kind of ['image','video'] as const) {
    const p={...profile,imageProtocol:'doubao-image',videoProtocol:'doubao-video'};
    assert.deepEqual(mediaCapabilities(kind,p as any,'exact visible model'),{aspects:[],qualities:[],durations:[],counts:[],sound:false,camera:false,promptOnly:false});
  }
});
