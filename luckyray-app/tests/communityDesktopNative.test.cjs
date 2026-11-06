const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckyray-desktop-native-test-'));
fs.writeFileSync(path.join(dir, 'core.cjs'), 'exports.invoke=(...args)=>globalThis.__desktopNativeInvoke(...args);');
fs.writeFileSync(path.join(dir, 'event.cjs'), 'exports.listen=(...args)=>globalThis.__desktopNativeListen(...args);');
const output = path.join(dir, 'native.cjs');
esbuild.buildSync({ stdin:{contents:"export * from './src/core/extensions/desktop/native';",resolveDir:process.cwd(),loader:'ts'},
  outfile:output, bundle:true, platform:'node', format:'cjs', alias:{
    '@tauri-apps/api/core':path.join(dir, 'core.cjs'), '@tauri-apps/api/event':path.join(dir, 'event.cjs')
  } });
const { createDesktopNativeApi } = require(output);

test('pre-aborted AI request does not invoke the native host', async () => {
  let calls = 0; globalThis.__desktopNativeInvoke = () => { calls++; };
  globalThis.__desktopNativeListen = () => { throw Error('unexpected listener'); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createDesktopNativeApi('synthetic', () => () => {}).ai.generate('synthetic', {signal:controller.signal}), {name:'AbortError'});
  assert.equal(calls, 0);
});

test('in-flight AI abort forwards request cancellation and suppresses late stream chunks', async () => {
  let listener, rejectNative, requestId, cancelId, unlistened = false;
  const chunks = [];
  globalThis.__desktopNativeListen = async (name, fn) => {
    assert.match(name, /^[a-zA-Z0-9_:/-]+$/, 'Tauri rejects invalid event names before a request starts');
    listener = fn; return () => { unlistened = true; };
  };
  globalThis.__desktopNativeInvoke = async (_command, input) => {
    const request = JSON.parse(input.request);
    if (request.op === 'aiGenerate') { requestId = request.requestId; return new Promise((_resolve, reject) => { rejectNative = reject; }); }
    if (request.op === 'cancelRequest') { cancelId = request.requestId; rejectNative(Error('desktop-extension-cancelled')); return; }
    throw Error('unexpected operation');
  };
  const controller = new AbortController();
  const promise = createDesktopNativeApi('synthetic', () => () => {}).ai.generate('synthetic', {signal:controller.signal, onChunk:chunk => chunks.push(chunk)});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(requestId); listener({payload:{requestId,delta:'before'}});
  controller.abort(); listener({payload:{requestId,delta:'late'}});
  await assert.rejects(promise, /desktop-extension-cancelled/);
  assert.equal(cancelId, requestId); assert.deepEqual(chunks, ['before']); assert.equal(unlistened, true);
});

test('stream listener uses a valid native event and receives only its own request before cleanup', async () => {
  let listener, eventName, unlistened = false;
  const chunks = [], calls = [];
  globalThis.__desktopNativeListen = async (name, fn) => {
    assert.match(name, /^[a-zA-Z0-9_:/-]+$/, 'same allowed characters as the installed Tauri event deserializer');
    eventName = name; listener = fn; return () => { unlistened = true; };
  };
  globalThis.__desktopNativeInvoke = async (_command, input) => {
    const request = JSON.parse(input.request); calls.push(request.op);
    assert.equal(request.op, 'aiGenerate'); assert.equal(request.stream, true);
    listener({payload:{requestId:'another-request', delta:'ignore'}});
    listener({payload:{requestId:request.requestId, delta:'synthetic chunk'}});
    return {text:'synthetic reply'};
  };
  const result = await createDesktopNativeApi('synthetic', () => () => {}).ai.generate('synthetic', {onChunk:chunk => chunks.push(chunk)});
  assert.deepEqual(result, {text:'synthetic reply'});
  assert.deepEqual(calls, ['aiGenerate']); assert.deepEqual(chunks, ['synthetic chunk']); assert.equal(unlistened, true);
  const native = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/desktop_extension_runtime.rs'), 'utf8');
  const emitted = [...native.matchAll(/app\.emit_to\("main","(luckyray:desktop:ai[^\"]+)"/g)].map(match => match[1]);
  assert.equal(emitted.length, 2, 'normal chunks and redactor tail must share the listener event');
  assert.deepEqual(emitted, [eventName, eventName]);
});

test('listener registration failure does not send an AI request', async () => {
  let calls = 0;
  globalThis.__desktopNativeListen = async () => { throw Error('synthetic listener failure'); };
  globalThis.__desktopNativeInvoke = async () => { calls++; };
  await assert.rejects(createDesktopNativeApi('synthetic', () => () => {}).ai.generate('synthetic', {onChunk:()=>{}}), /synthetic listener failure/);
  assert.equal(calls, 0);
});

test.after(() => {
  delete globalThis.__desktopNativeInvoke; delete globalThis.__desktopNativeListen;
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert(path.basename(dir).startsWith('luckyray-desktop-native-test-'));
  fs.rmSync(dir,{recursive:true,force:true});
});
