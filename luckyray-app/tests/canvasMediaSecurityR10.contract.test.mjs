// Source-shape regression checks only. These do NOT execute Rust, DNS or HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const comfy = read('src-tauri/src/canvas_comfyui.rs');
const protocol = read('src-tauri/src/canvas_media_protocols.rs');
const lib = read('src-tauri/src/lib.rs');
const profiles = read('src-tauri/src/canvas_media_profiles.rs');
test('SOURCE CONTRACT: ComfyUI is loopback stats-only, bounded and not a generation transport', () => {
  assert.match(comfy, /"localhost" \| "127\.0\.0\.1" \| "\[::1\]"/);
  assert.match(comfy, /client\.get\(format!\("\{base\}\/system_stats"\)\)/);
  assert.doesNotMatch(comfy, /client\.(post|put|patch|delete)\(/);
  assert.match(comfy, /\.no_proxy\(\)/);
  assert.match(comfy, /Policy::none\(\)/);
  assert.match(comfy, /64 \* 1024/);
  assert.match(comfy, /url\.query\(\)\.is_some\(\)/);
  assert.match(comfy, /url\.password\(\)\.is_some\(\)/);
  for (const command of ['get_config','set_config','test_connection']) {
    assert.match(lib, new RegExp(`fn canvas_comfyui_${command}[^]*?require_main_caller\\(&caller\\)\\?;`));
  }
});
test('SOURCE CONTRACT: provider transport pins all checked DNS answers and disables redirects/proxies', () => {
  assert.match(protocol, /addresses\.iter\(\)\.any\(\|address\|!public_provider_ip\(address\.ip\(\)\)\)/);
  assert.match(protocol, /\.resolve_to_addrs\(host,&addresses\)/);
  assert.match(protocol, /\.no_proxy\(\)\.redirect\(reqwest::redirect::Policy::none\(\)\)/);
});
test('SOURCE CONTRACT: generic video uses multipart and bounded authenticated content download', () => {
  assert.match(protocol, /image_multipart\(&fields,&references,"input_reference"\)/);
  const videoBranch = protocol.split('else if protocol=="openai-video"')[1].split('        }else{')[0];
  assert.doesNotMatch(videoBranch, /\.json\(/);
  assert.match(videoBranch, /image_multipart/);
  assert.match(protocol, /CANVAS_GENERATION_MAX_VIDEO_BYTES/);
  assert.match(protocol, /prefix\[4\.\.8\]!=b"ftyp"/);
});
test('SOURCE CONTRACT: Flash has exact free-model allowlist, rejects unverified controls and explicit async routes', () => {
  assert.match(protocol, /model!="cogvideox-flash"/);
  for (const field of ['duration','aspect','quality','sound']) assert.match(protocol, new RegExp(`request\\.${field}\\.is_some\\(\\)`));
  assert.match(protocol, /"videos\/generations"/);
  assert.match(protocol, /"async-result"/);
  assert.match(protocol, /"PROCESSING"/);
  assert.match(protocol, /"SUCCESS"/);
});
test('SOURCE CONTRACT: submission ledger is claimed before POST and recorded before progress publication', () => {
  assert.match(protocol, /ledger\.begin\(\)\?;\s*diagnostic\.begin\("submit"\);\s*crate::emit_canvas_video_progress\(app,request\.client_task_id\.as_deref\(\),None,"submitting",None\);\s*parsed=match response_json_observed\(builder/);
  assert.match(protocol, /ledger\.record\(&id\)\?;/);
  assert.ok(protocol.indexOf('ledger.record(&id)?;') < protocol.indexOf('Some(&id),"queued",Some(0)'));
  assert.match(protocol, /create_new\(true\)/);
  assert.match(protocol, /submission_unknown/);
  assert.match(profiles, /id\.is_some\(\) != revision\.is_some\(\)/);
  assert.match(profiles, /revision\.is_some_and\(\|r\|r != profile\.revision\)/);
  assert.match(lib, /provider_task_id[^]*?profile_id\.is_none\(\)[^]*?ai_video_failure\("profile_changed"\)/);
});
