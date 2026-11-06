import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const exists=path=>existsSync(new URL(`../${path}`,import.meta.url));
test('connector source modules and helper preparation scripts are retired, not bundled',()=>{
 for(const path of ['src/core/services/doubaoConnector.ts','src/features/canvas/DoubaoConnectionPanel.tsx','src-tauri/src/doubao_connector.rs','scripts/prepare-doubao-connector.mjs','scripts/prepare-doubao-connector.ps1','scripts/test-doubao-native-portable.mjs']) assert.equal(exists(path),false,path);
 if(exists('doubao-connector')) assert.deepEqual(readdirSync(new URL('../doubao-connector',import.meta.url),{recursive:true}).filter(path=>/\.(mjs|json|md)$/.test(path)),[]);
 const config=JSON.parse(read('src-tauri/tauri.conf.json'));
 assert.equal(Object.keys(config.bundle.resources).some(key=>key.includes('doubao')),false);
 for(const path of ['scripts/prepare-dev-startup.mjs','scripts/prepare-tauri-build.ps1','scripts/assert-package-readiness.ps1']) assert.doesNotMatch(read(path),/doubao/i,path);
});
test('app routes, account events, native command registration and lifecycle hooks are absent',()=>{
 const app=read('src/App.tsx'),canvas=read('src/CanvasSpike.tsx'),native=read('src-tauri/src/lib.rs');
 assert.doesNotMatch(app,/doubaoConnector|runDoubaoCanvasTask|doubao_connector_/);
 assert.doesNotMatch(canvas,/doubaoConnector|DOUBAO_RESUME_TASK_EVENT|subscribeDoubaoAccounts|getDoubaoAccountCapabilities/);
 assert.doesNotMatch(native,/mod doubao_connector|doubao_connector::/);
 assert.match(canvas,/reserve\(slot, generationConcurrencyPolicy\)/);
 assert.match(canvas,/Existing results are retained/);
});
test('legacy metadata stays loadable but native runtime rejects it before credentials or dispatch',()=>{
 const profiles=read('src-tauri/src/canvas_media_profiles.rs');
 const resolve=profiles.slice(profiles.indexOf('pub(crate) fn resolve('),profiles.indexOf('pub(crate) fn text_runtime_config('));
 assert.match(profiles,/"doubao-image"\|"ark-image"/); // read-only schema compatibility, no migration
 assert.match(resolve,/profile\.id == "doubao-default" \|\| profile\.image_protocol == "doubao-image" \|\| profile\.video_protocol == "doubao-video"/);
 assert.ok(resolve.indexOf('return Err("canvas-media-provider-removed")')<resolve.indexOf('let api_key ='));
 assert.doesNotMatch(resolve,/upsert|activate|save_catalog|https:\/\//);
 assert.match(profiles,/retired_doubao_catalog_stays_readable_and_cannot_dispatch_or_be_recreated/);
 const native=read('src-tauri/src/lib.rs');
 for(const kind of ['image','video']){
  const start=native.indexOf(`async fn ai_${kind}_generate_with_binding(`);
  const body=native.slice(start,native.indexOf(`if runtime.profile.${kind}_protocol == "disabled"`,start));
  assert.match(body,new RegExp(`Err\\("canvas-media-provider-removed"\\) => return Ok\\(ai_${kind}_failure\\("canvas-media-provider-removed"\\)\\)`));
 }
});
test('Ark remains an explicit official API path, never a retirement fallback',()=>{
 const protocols=read('src-tauri/src/canvas_media_protocols.rs');
 assert.match(protocols,/"ark-image" =>/);assert.match(protocols,/"ark-video"/);
 assert.match(protocols,/https:\/\/ark.cn-beijing.volces.com\/api\/plan\/v3/);
 assert.match(protocols,/https:\/\/ark.cn-beijing.volces.com\/api\/v3/);
 assert.doesNotMatch(protocols,/doubao-(?:image|video)|doubao-default/);
});
