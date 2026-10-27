const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the real lifetime module; only the native transport, clock and DOM
// are controlled. There is no alternate quit/save implementation in this test.
async function harness({initialInert = false, ack} = {}) {
  const native = new Map(), domEvents = new Map(), timers = new Map();
  const root = {inert: initialInert}, statuses = [], history = [], acknowledgements = [], errors = [];
  let now = 0, sequence = 0;
  const document = {
    getElementById: () => root,
    addEventListener: (name, callback) => domEvents.set(name, callback),
    createElement: () => ({style: {}, attributes: {}, textContent: '',
      setAttribute(name, value) {this.attributes[name] = value;},
      remove() {const i = statuses.indexOf(this); if (i >= 0) statuses.splice(i, 1);}}),
    body: {append(node) {statuses.push(node); history.push({at: now, text: node.textContent, style: node.style});}},
  };
  const window = {dispatchEvent(event) {errors.push(event);},
    setTimeout(callback, delay) {const id = ++sequence; timers.set(id, {at: now + delay, callback}); return id;},
    clearTimeout(id) {timers.delete(id);}};
  const module = {exports: {}};
  const source = fs.readFileSync(path.join(__dirname, '../src/workspace/windowLifecycle.ts'), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(js, {exports: module.exports, module, document, window,
    CustomEvent: class {constructor(type, options) {this.type = type; this.detail = options.detail;}},
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    require(name) {
      if (name === '@tauri-apps/api/event') return {listen: async (name, callback, options) => {
        assert.equal(options.target.label, 'main'); native.set(name, callback); return () => native.delete(name);
      }};
      if (name === '@tauri-apps/api/window') return {getCurrentWindow: () => ({label: 'main'})};
      if (name === './nativeClient') return {workspaceCommand: async command => {
        acknowledgements.push({...command}); if (ack) await ack(command);
      }};
      throw Error(`Unexpected dependency ${name}`);
    },
  }, {filename: 'windowLifecycle.ts'});
  await module.exports.installWorkspaceLifecycle();
  const settle = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
  return {...module.exports, root, statuses, history, acknowledgements, errors, timers, settle,
    event: (name, id) => native.get(`luckyray:workspace-quit-${name}`)?.({payload: {id}}),
    composition: active => domEvents.get(active ? 'compositionstart' : 'compositionend')(),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      now = end; await settle();
    },
  };
}
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}

for (const route of ['materials', 'canvas', 'LSH', 'notes']) {
  test(`clean ${route} exit is silent but still runs the hidden editor barrier`, async () => {
    const h = await harness(); let flushes = 0;
    h.registerWorkspaceFlush(async () => {flushes++; return true;}, () => false);
    await h.event('prepare', route); await h.advance(1000);
    assert.equal(flushes, 1); assert.equal(h.history.length, 0);
    assert.deepEqual(h.acknowledgements, [{op: 'quitAck', id: route, saved: true}]);
  });
}
test('fast pending save does not flash and slow save clears before ACK returns', async () => {
  const ack = deferred(), h = await harness({ack: () => ack.promise}), save = deferred(); let dirty = true;
  h.registerWorkspaceFlush(async () => {await save.promise; dirty = false; return true;}, () => dirty);
  const quit = h.event('prepare', 'slow'); await h.settle();
  await h.advance(100); assert.equal(h.history.length, 0);
  await h.advance(500); assert.equal(h.statuses.length, 1); assert.equal(h.statuses[0].textContent, '正在保存笔记…');
  assert.notEqual(h.statuses[0].style.inset, '0', 'save status must not obscure the whole app');
  save.resolve(); await h.settle(); assert.equal(h.statuses.length, 0, 'completion clears saving even during a slow native ACK');
  await h.advance(1000); assert.equal(h.statuses.length, 0, 'ACK is not evidence of service draining');
  ack.resolve(); await quit;
  const fast = await harness(), completion = deferred();
  fast.registerWorkspaceFlush(async () => {await completion.promise; return true;}, () => true);
  const quick = fast.event('prepare', 'fast'); await fast.settle(); await fast.advance(100); completion.resolve(); await quick;
  await fast.advance(1000); assert.equal(fast.history.length, 0);
});
test('only the exact native saved barrier can start a truthful delayed exiting phase', async () => {
  const h = await harness(); h.registerWorkspaceFlush(async () => true, () => false);
  h.event('draining', 'old'); await h.event('prepare', 'current');
  h.event('draining', 'old'); await h.advance(1000); assert.equal(h.history.length, 0);
  h.event('draining', 'current'); await h.advance(100); assert.equal(h.statuses.length, 0);
  await h.advance(500); assert.equal(h.statuses[0].textContent, '正在退出…');
  h.event('cancelled', 'current'); assert.equal(h.statuses.length, 0); assert.equal(h.root.inert, false);
  await h.advance(1000); assert.equal(h.statuses.length, 0); assert.equal(h.timers.size, 0);
});
for (const result of ['false', 'reject', 'ack-reject']) {
  test(`${result} does not leave a shield/inert root and a retry is a fresh save`, async () => {
    let fail = true, calls = 0;
    const h = await harness({ack: async () => {if (fail && result === 'ack-reject') throw Error('transport');}});
    h.registerWorkspaceFlush(async () => {calls++; if (fail && result === 'reject') throw Error('controlled write failure'); return !fail || result === 'ack-reject';}, () => fail);
    await h.event('prepare', 'first'); await h.advance(1000);
    assert.equal(h.root.inert, false); assert.equal(h.statuses.length, 0); assert.equal(h.timers.size, 0);
    fail = false; await h.event('prepare', 'retry'); assert.equal(calls, 2);
    assert.equal(h.acknowledgements.at(-1).saved, true); assert.equal(h.root.inert, true);
  });
}
test('IME blocks quit without ending composition or flushing, then committed input can save', async () => {
  const h = await harness(); let calls = 0;
  h.registerWorkspaceFlush(async () => {calls++; return true;}, () => true);
  h.composition(true); await h.event('prepare', 'ime'); await h.advance(1000);
  assert.equal(calls, 0); assert.equal(h.workspaceCompositionActive(), true);
  assert.equal(h.root.inert, false); assert.equal(h.history.length, 0); assert.equal(h.acknowledgements.at(-1).saved, false);
  h.event('cancelled', 'ime'); h.composition(false); await h.event('prepare', 'committed'); assert.equal(calls, 1);
  assert.equal(h.acknowledgements.at(-1).saved, true);
});
test('repeated close requests coalesce and a cancelled slow save cannot ACK or clear its successor', async () => {
  const h = await harness(), old = deferred(), next = deferred(); let calls = 0, active = 0, peak = 0;
  h.registerWorkspaceFlush(async () => {active++; peak = Math.max(peak, active); const n = ++calls; await (n === 1 ? old.promise : next.promise); active--; return true;}, () => true);
  const first = h.event('prepare', 'old'); await h.settle();
  h.event('prepare', 'old'); h.event('prepare', 'repeated'); await h.settle(); assert.equal(calls, 1);
  h.event('cancelled', 'old'); assert.equal(h.root.inert, false);
  const retry = h.event('prepare', 'new'); await h.settle(); assert.equal(calls, 1, 'retry must not run parallel flushers after native timeout');
  old.resolve(); await first; await h.settle(); assert.equal(calls, 2); assert.equal(peak, 1); assert.equal(h.root.inert, true);
  assert.equal(h.acknowledgements.length, 0, 'old completion must not ACK a cancelled round');
  h.event('cancelled', 'old'); assert.equal(h.root.inert, true);
  next.resolve(); await retry; assert.deepEqual(h.acknowledgements, [{op: 'quitAck', id: 'new', saved: true}]);
});
test('native timeout removes status immediately and an initial inert root is preserved', async () => {
  const h = await harness({initialInert: true}), save = deferred();
  h.registerWorkspaceFlush(async () => {await save.promise; return true;}, () => true);
  const quit = h.event('prepare', 'timeout'); await h.settle(); await h.advance(16000);
  assert.equal(h.statuses.length, 1); h.event('cancelled', 'timeout');
  assert.equal(h.statuses.length, 0); assert.equal(h.root.inert, true);
  save.resolve(); await quit; await h.advance(20000);
  assert.equal(h.timers.size, 0); assert.equal(h.acknowledgements.length, 0);
});
test('removing a registration removes both save work and pending-status ownership', async () => {
  const h = await harness(); const remove = h.registerWorkspaceFlush(async () => {throw Error('unmounted');}, () => true);
  remove(); await h.event('prepare', 'none'); await h.advance(1000);
  assert.equal(h.history.length, 0); assert.equal(h.acknowledgements.at(-1).saved, true);
});
test('a generic non-save blocker never gets labelled as saving notes', async () => {
  const h = await harness(), work = deferred();
  h.registerWorkspaceFlush(() => work.promise);
  const quit = h.event('prepare', 'generic'); await h.advance(5000);
  assert.equal(h.history.length, 0); work.resolve(false); await quit;
  assert.equal(h.root.inert, false); assert.equal(h.acknowledgements.at(-1).saved, false);
});
test('native draining can arrive before ACK returns, but repeated phase events cannot postpone it', async () => {
  const ack = deferred(), h = await harness({ack: () => ack.promise});
  h.registerWorkspaceFlush(async () => true, () => false);
  const quit = h.event('prepare', 'drain'); await h.settle();
  h.event('draining', 'drain'); await h.advance(200); h.event('draining', 'drain');
  await h.advance(150); assert.equal(h.statuses[0].textContent, '正在退出…');
  ack.resolve(); await quit; assert.equal(h.statuses[0].textContent, '正在退出…');
});
test('one failed flusher releases UI promptly while other IO remains serialized for a retry', async () => {
  const h = await harness(), io = deferred(); let failed = true, writes = 0;
  h.registerWorkspaceFlush(async () => !failed);
  h.registerWorkspaceFlush(async () => {writes++; if (writes === 1) await io.promise; return true;}, () => true);
  const first = h.event('prepare', 'fail'); await first;
  assert.equal(h.root.inert, false); assert.equal(writes, 1);
  failed = false; const retry = h.event('prepare', 'retry'); await h.settle(); assert.equal(writes, 1);
  io.resolve(); await retry; assert.equal(writes, 2); assert.equal(h.acknowledgements.at(-1).saved, true);
});
test('IME beginning while a retry waits on cancelled IO still blocks the fresh save', async () => {
  const h = await harness(), io = deferred(); let calls = 0;
  h.registerWorkspaceFlush(async () => {calls++; await io.promise; return true;}, () => true);
  const old = h.event('prepare', 'old'); await h.settle(); h.event('cancelled', 'old');
  const retry = h.event('prepare', 'retry'); await h.settle(); h.composition(true);
  io.resolve(); await old; await retry;
  assert.equal(calls, 1); assert.equal(h.acknowledgements.at(-1).saved, false); assert.equal(h.root.inert, false);
});
test('native draining publication follows the exact all-saved gate and precedes service shutdown', () => {
  const native = fs.readFileSync(path.join(__dirname, '../src-tauri/src/workspace_windows.rs'), 'utf8');
  const body = native.slice(native.indexOf('pub(crate) fn prepare_application_quit'), native.indexOf('pub(crate) fn finish_quit_probe'));
  assert.match(body, /round\.responses\.values\(\)\.all\(\|value\|\*value==Some\(true\)\)/);
  assert.match(body, /if saved \{"luckyray:workspace-quit-draining"\} else \{"luckyray:workspace-quit-cancelled"\}/);
  assert.ok(body.indexOf('let saved=') < body.indexOf('luckyray:workspace-quit-draining'));
  assert.match(body, /emit_to\(&label,phase,serde_json::json!\(\{"id":id\}\)/);
  const product = fs.readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
  const gate = product.slice(product.indexOf('fn with_saved_application_quit('), product.indexOf('fn request_normal_quit('));
  assert.ok(gate.indexOf('prepare_application_quit') >= 0 && gate.indexOf('prepare_application_quit') < gate.indexOf('continuation()'));
  assert.match(gate, /cancel_prepared_application_quit/);
  const quit = product.slice(product.indexOf('fn request_normal_quit('), product.indexOf('fn show_main_window('));
  assert.ok(quit.indexOf('with_saved_application_quit') < quit.indexOf('drain_application_services'));
  const drain = product.slice(product.indexOf('fn drain_application_services('), product.indexOf('fn with_saved_application_quit('));
  assert.match(drain,/COMPANION_GATEWAY/); assert.match(drain,/DSH_HOST_SERVICE/);
  assert.match(product, /"quit" => request_normal_quit\(app\.clone\(\), false\)/);
  assert.match(product, /api\.prevent_close\(\);\s*request_normal_quit\(window\.app_handle\(\)\.clone\(\), false\)/);
});
