import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadReadonlyCanvasSnapshot, watchReadonlyCanvas, readonlyCanvasMediaUrl, type CanvasRemoteReadBridge } from '../src/core/canvas/readonlyCanvasRuntime.ts';

const entry = { id: 'desktop', name: 'Desktop', createdAt: '1', updatedAt: '2', nodeCount: 1, edgeCount: 0, coverVersion: 0, coverKind: null, coverUrl: null, coverPoster: null, revision: 1, contentDigest: 'a'.repeat(64) };
const document = { schemaVersion: 2, canvasId: 'desktop', name: 'Desktop', createdAt: '1', updatedAt: '2', viewport: { x: 10, y: 20, zoom: .8 }, revision: 1, contentDigest: 'a'.repeat(64), nodes: [{ id: 'running', type: 'spike', position: { x: 0, y: 0 }, data: { kind: 'generator', label: 'Running', generationTask: { id: 'desktop-job', status: 'running', providerTaskId: 'already-accepted', request: { kind: 'image', model: 'desktop-model', prompt: 'do not restart', references: [] } } } }], edges: [], generationHistory: [{ taskId: 'desktop-job', status: 'running' }] };

test('actual remote loader reads existing running state without accessing any desktop write/native capability', async () => {
  const before = structuredClone(document), calls: string[] = [];
  const bridge = new Proxy({
    listCanvases: async () => { calls.push('list'); return [entry]; },
    loadCanvas: async (id: string) => { calls.push(`load:${id}`); return document; },
  }, { get(target, key, receiver) { assert.ok(key === 'listCanvases' || key === 'loadCanvas', `forbidden capability: ${String(key)}`); return Reflect.get(target, key, receiver); } }) as CanvasRemoteReadBridge;
  const loaded = await loadReadonlyCanvasSnapshot(bridge, null, new AbortController().signal);
  assert.deepEqual(calls, ['list', 'load:desktop']);
  assert.deepEqual(loaded.document, before);
  assert.deepEqual(document, before);
  (loaded.document!.nodes as typeof document.nodes)[0].data.generationTask.status = 'failed';
  assert.equal(document.nodes[0].data.generationTask.status, 'running', 'presentation copy cannot mutate server state');
});

test('empty list never creates or loads a default; revoked selection fails rather than switching documents', async () => {
  let loads = 0;
  const bridge = { listCanvases: async () => [], loadCanvas: async () => { loads++; return document; } };
  assert.deepEqual(await loadReadonlyCanvasSnapshot(bridge, null, new AbortController().signal), { canvases: [], document: null });
  await assert.rejects(loadReadonlyCanvasSnapshot(bridge, 'revoked', new AbortController().signal), /unavailable/);
  assert.equal(loads, 0);
});

test('aborted and stale reads cannot complete or start a subsequent document request', async () => {
  const controller = new AbortController();
  let loads = 0;
  const bridge = { listCanvases: async () => { controller.abort(); return [entry]; }, loadCanvas: async () => { loads++; return document; } };
  await assert.rejects(loadReadonlyCanvasSnapshot(bridge, null, controller.signal), { name: 'AbortError' });
  assert.equal(loads, 0);
});

test('remote media resolution accepts only opaque same-origin paths, never local files or arbitrary URLs', () => {
  assert.equal(readonlyCanvasMediaUrl('/canvas/media/' + 'a'.repeat(64)), '/canvas/media/' + 'a'.repeat(64));
  for (const value of ['/canvas/media/opaque_123', '/canvas/media/' + 'A'.repeat(64), 'C:\\private\\comfy-' + 'a'.repeat(64) + '.mp4', '/tmp/movie.mp4', 'asset://localhost/private', 'file:///private', 'https://example.com/image.png', 'http://localhost:8188/view', '//evil.test/a', '/canvas/media/id?secret=value', '/canvas/media/../private', 'data:image/png;base64,AQ==', 'blob:https://example.test/id']) {
    assert.equal(readonlyCanvasMediaUrl(value), '', value);
  }
});

test('production boundary excludes desktop hooks and shared node native/editable children', async () => {
  const source = await readFile(new URL('../src/CanvasSpike.tsx', import.meta.url), 'utf8');
  const remote = source.slice(source.indexOf('function CanvasReadonlyView('), source.indexOf('// The shell retains this workspace'));
  assert.match(remote, /loadReadonlyCanvasSnapshot\(bridge, requestedCanvasId \?\? currentCanvasId\.current, signal, \{ document: lastSnapshot\.current, force \}\)/);
  assert.match(remote, /if \(props\.remote === true\)[\s\S]*<CanvasReadonlyView bridge=\{props\.bridge\}/);
  assert.match(remote, /return <DesktopCanvasSpike visible=\{props\.visible\}/);
  assert.doesNotMatch(remote, /(?:useCanvasAgent|useCanvasComfyConfig|useSavedLocale|getLuckyRayBridgeSync|generationOwner|generationRuntime|pendingGenerationCoordinator|localStorage|sessionStorage|saveCanvas|writeFile|writeTextFile|\.enqueue)\s*\(/);
  assert.match(source, /useComfyVideoCover\(source, canvasVisible && !readOnly\)/);
  assert.match(source, /if \(!readOnly && nativeResult\) return <CanvasNativeVideoPreview/);
  assert.equal((source.match(/const result = readOnly \? null : comfyVideoResultName\(source\);/g) || []).length, 2);
  assert.match(source, /!readOnly && isFreeformResizable/);
  assert.match(source, /kind === "text" \? readOnly \? <CanvasTextPreview/);
  assert.match(remote, /deleteKeyCode=\{null\}/);
  assert.match(remote, /nodeTypes=\{nodeTypes\}/);
});

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test('visible polling is serialized, begins after settlement, and forces initial/manual/resumed rechecks', async () => {
  let callback: (() => void) | undefined, requestCount = 0, active = 0, peak = 0;
  let finish: ((value: string) => void) | undefined;
  const snapshots: string[] = [], forces: boolean[] = [], signals: AbortSignal[] = [], delays: number[] = [];
  const watcher = watchReadonlyCanvas({
    read: (signal, force) => { requestCount++; active++; peak = Math.max(peak, active); signals.push(signal); forces.push(force); return new Promise<string>(resolve => { finish = value => { active--; resolve(value); }; }); },
    onSnapshot: value => snapshots.push(value), onError: () => assert.fail('unexpected error'), onLoading: () => {},
  }, { set: (fn, delay) => { callback = fn; delays.push(delay); return 1; }, clear: () => { callback = undefined; } });
  watcher.setVisible(true); await settle(); assert.equal(requestCount, 1); assert.equal(callback, undefined);
  watcher.refresh(); watcher.refresh(); await settle(); assert.equal(requestCount, 1);
  finish!('first'); await settle(); assert.equal(requestCount, 2, 'coalesced manual refresh starts only after prior settlement');
  finish!('second'); await settle(); assert.deepEqual(delays, [2000]);
  callback!(); await settle(); assert.equal(requestCount, 3); assert.deepEqual(forces, [true, true, false]);
  watcher.setVisible(false); assert.equal(signals.at(-1)?.aborted, true); assert.equal(callback, undefined);
  watcher.setVisible(true); await settle(); assert.equal(requestCount, 3, 'hidden request must settle before a resumed request starts');
  finish!('obsolete-hidden-result'); await settle(); assert.equal(requestCount, 4); assert.equal(forces.at(-1), true);
  assert.deepEqual(snapshots, ['first', 'second']);
  finish!('resumed'); await settle(); watcher.dispose(); assert.equal(callback, undefined); assert.equal(peak, 1);
});

test('hidden/disposed readers ignore late successes and errors and never schedule again', async () => {
  let resolve!: (value: string) => void, calls = 0, snapshots = 0, errors = 0, timers = 0;
  const watcher = watchReadonlyCanvas({read: () => { calls++; return new Promise<string>(r => resolve = r); }, onSnapshot: () => snapshots++, onError: () => errors++, onLoading: () => {}}, {set: () => {timers++; return 1;}, clear: () => {}});
  watcher.setVisible(true); await settle(); watcher.setVisible(false); resolve('late'); await settle();
  assert.equal(calls,1);assert.equal(snapshots,0);assert.equal(errors,0);assert.equal(timers,0);
  watcher.setVisible(true);await settle();watcher.dispose();resolve('after-unmount');await settle();
  assert.equal(snapshots,0);assert.equal(errors,0);assert.equal(timers,0);
});

test('unchanged revision and digest reuse the same document; manual refresh and changed revision reload', async () => {
  let loads = 0, revision = 1;
  const bridge = {listCanvases: async () => [{...entry,revision}],loadCanvas: async () => { loads++; return {...document,revision}; }};
  const first = await loadReadonlyCanvasSnapshot(bridge,null,new AbortController().signal);
  const unchanged = await loadReadonlyCanvasSnapshot(bridge,'desktop',new AbortController().signal,{document:first.document});
  assert.equal(unchanged.document, first.document);assert.equal(loads,1);
  const forced = await loadReadonlyCanvasSnapshot(bridge,'desktop',new AbortController().signal,{document:first.document,force:true});
  assert.notEqual(forced.document,first.document);assert.equal(loads,2);
  revision++;const changed=await loadReadonlyCanvasSnapshot(bridge,'desktop',new AbortController().signal,{document:first.document});
  assert.equal(changed.document?.revision,2);assert.equal(loads,3);
  assert.equal((changed.document!.nodes as typeof document.nodes)[0].data.generationTask.status,'running');
});
