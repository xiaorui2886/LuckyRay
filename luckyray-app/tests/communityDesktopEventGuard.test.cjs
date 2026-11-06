const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('node:module').createRequire(require.resolve('vite/package.json'))('esbuild');

const source = path.resolve('src/core/extensions/desktop/eventGuard.ts');
const built = esbuild.buildSync({entryPoints:[source],bundle:true,platform:'node',format:'cjs',write:false});
const fixture = new Module(source, module);
fixture.filename = source;
fixture.paths = module.paths;
fixture._compile(built.outputFiles[0].text, source);
const {createDesktopEventGuard} = fixture.exports;
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

test('legacy synchronous event writes are guarded without blocking later independent writes', () => {
  const guard = createDesktopEventGuard('test.a', () => true);
  let deliveries = 0;
  const handler = payload => {
    deliveries++;
    guard.deliver({...payload,__luckyrayEventOrigins:guard.writeOrigins()}, handler);
  };
  guard.deliver({id:'user'}, handler);
  assert.equal(deliveries, 1);
  assert.deepEqual(guard.writeOrigins(), []);
  guard.deliver({id:'independent',__luckyrayEventOrigins:guard.writeOrigins()}, handler);
  assert.equal(deliveries, 2);
});

test('scoped writes retain event origins after await and cannot reenter themselves', async () => {
  const guard = createDesktopEventGuard('test.a', () => true);
  let deliveries = 0, writes = 0;
  assert.deepEqual(guard.writeOrigins(), []); // independent plugin action
  const onEvent = async (payload, scoped) => {
    deliveries++;
    assert.deepEqual(payload, {documentRef:{vaultId:'synthetic',relativePath:'note.md'}});
    assert.deepEqual(guard.writeOrigins(), ['test.a']); // synchronous legacy call
    await Promise.resolve();
    assert.deepEqual(guard.writeOrigins(), []); // pending callback does not taint unrelated work
    assert.deepEqual(scoped, ['test.a']);
    writes++;
    guard.deliver({...payload,__luckyrayEventOrigins:scoped}, onEvent);
  };
  guard.deliver({documentRef:{vaultId:'synthetic',relativePath:'note.md'}}, onEvent);
  await flush();
  assert.equal(deliveries, 1);
  assert.equal(writes, 1);
  assert.deepEqual(guard.writeOrigins(), []);
  // A later real user action is a fresh event, not permanently muted.
  guard.deliver({documentRef:{vaultId:'synthetic',relativePath:'note.md'}}, onEvent);
  await flush();
  assert.equal(deliveries, 2);
  assert.equal(writes, 2);
});

test('concurrent scoped callbacks preserve both independent event chains', async () => {
  const a = createDesktopEventGuard('test.a', () => true);
  const b = createDesktopEventGuard('test.b', () => true);
  const deliveries = {a:0,b:0}, writes = {a:0,b:0};
  const handlers = {
    a: async (_payload, scoped) => { deliveries.a++; await Promise.resolve(); writes.a++; emit(scoped); },
    b: async (_payload, scoped) => { deliveries.b++; await Promise.resolve(); writes.b++; emit(scoped); },
  };
  function emit(origins) {
    const payload = {libraryId:'synthetic',ids:['asset'],...(origins ? {__luckyrayEventOrigins:origins} : {})};
    a.deliver(payload, handlers.a);
    b.deliver(payload, handlers.b);
  }
  emit();
  for (let i=0; i<100 && writes.a+writes.b<4; i++) await flush();
  await flush();
  assert.deepEqual(deliveries, {a:2,b:2});
  assert.deepEqual(writes, deliveries);
  assert.deepEqual(a.writeOrigins(), []);
  assert.deepEqual(b.writeOrigins(), []);
});

test('two scoped detached timers cannot ping-pong but each receives the other initial write', async () => {
  const a = createDesktopEventGuard('test.a', () => true);
  const b = createDesktopEventGuard('test.b', () => true);
  const deliveries = {a:0,b:0}, writes = {a:0,b:0};
  const handlers = {
    a: (_payload, scoped) => { deliveries.a++; setTimeout(() => { writes.a++; emit(scoped); }, 1); },
    b: (_payload, scoped) => { deliveries.b++; setTimeout(() => { writes.b++; emit(scoped); }, 1); },
  };
  function emit(origins) {
    const payload = origins ? {__luckyrayEventOrigins:origins} : {};
    a.deliver(payload, handlers.a);
    b.deliver(payload, handlers.b);
  }
  emit();
  for (let i=0; i<100 && writes.a+writes.b<4; i++) await flush();
  await flush();
  assert.deepEqual(deliveries, {a:2,b:2});
  assert.deepEqual(writes, deliveries);
});

test('an oversized causal chain stops only its derived delivery, not a later user event', () => {
  const guard = createDesktopEventGuard('test.target', () => true);
  let deliveries=0, origins;
  guard.deliver({__luckyrayEventOrigins:Array.from({length:64},(_,i)=>`test.${i}`)},(_event,scoped)=>{deliveries++;origins=scoped;});
  assert.deepEqual(origins,['*']);
  guard.deliver({__luckyrayEventOrigins:origins},()=>deliveries++);
  guard.deliver({documentRef:{vaultId:'synthetic',relativePath:'note.md'}},()=>deliveries++);
  assert.equal(deliveries,2);
});

test('simultaneous user events are delivered, failures release context, and retirement suppresses delivery', async () => {
  let live = true, release, deliveries = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const guard = createDesktopEventGuard('test.a', () => live);
  const handler = async () => { deliveries++; await pending; };
  guard.deliver({id:'user-one'}, handler);
  const independentOrigins = guard.writeOrigins();
  assert.deepEqual(independentOrigins, []);
  guard.deliver({id:'independent-write',__luckyrayEventOrigins:independentOrigins}, handler);
  assert.equal(deliveries, 2);
  assert.deepEqual(guard.writeOrigins(), []);
  release(); await flush();
  assert.deepEqual(guard.writeOrigins(), []);
  const oldError = console.error; console.error = () => {};
  try { guard.deliver({}, () => { throw Error('synthetic'); }); } finally { console.error = oldError; }
  assert.deepEqual(guard.writeOrigins(), []);
  live = false;
  guard.deliver({id:'after-disable'}, handler);
  assert.equal(deliveries, 2);
});
