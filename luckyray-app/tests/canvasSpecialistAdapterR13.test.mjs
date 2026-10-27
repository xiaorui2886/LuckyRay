import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source=readFileSync(new URL('../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs',import.meta.url),'utf8').replaceAll('\r\n','\n');
test('specialist policy requires native artifacts and does not silently downgrade failed discovery',()=>{assert.match(source,/text node containing a script\/table\/guide is not an editable storyboard/);assert.match(source,/Do not silently downgrade to ordinary text/);assert.match(source,/targeted fresh read/);assert.match(source,/missing target means rediscover/);assert.match(source,/never authorize extra generation/);});
test('Main adapter pin matches the Rust-normalized semantic merge bytes',()=>{const rust=readFileSync(new URL('../src-tauri/src/dsh_host.rs',import.meta.url),'utf8');const pin=rust.match(/const CANVAS_AGENT_SHA256: &str =\s*"([a-f0-9]{64})"/)[1];assert.equal(pin,createHash('sha256').update(source).digest('hex'));});
