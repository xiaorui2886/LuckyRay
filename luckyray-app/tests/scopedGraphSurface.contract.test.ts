import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isCurrentGraphDataProof, type GraphRuntimeFeature } from '../src/features/graph/GraphRuntime.ts';
import { createScopedGraphRuntime, type ScopedGraphSnapshot, type ScopedGraphTransport } from '../src/workspace/scopedGraphRuntime.ts';

function snapshot(id = 'snapshot-a', revision = 'revision-a'): ScopedGraphSnapshot {
  return { snapshotId: id, revision, vaultId: 'vault-a', version: 1, generatedAt: '2026-10-06T00:00:00Z',
    documents: [{ relativePath: 'A.md', fileName: 'A.md', title: 'A', revision: 'doc-a', wikiLinks: [], embeds: [], frontmatterTags: [], mtime: '2026-10-05T00:00:00Z' }],
    embeds: [], grants: [{ kind: 'document', token: 'ticket-a', relativePath: 'A.md' }], completeness: { complete: true, missing: [] } };
}
function fixture() {
  let value = snapshot();
  let invalidate = () => {};
  const transport: ScopedGraphTransport = {
    actions: { open: true, openDefault: true, reveal: true, askAi: true, createMissing: true },
    // Explicit synthetic services, never an implicit production-route claim.
    mutateTag: async () => ({ changed: true, message: 'fixture changed' }),
    exportScreenshot: async () => 'copied',
    request: async <T>() => structuredClone(value) as T,
    subscribe: (_id, listener) => { invalidate = listener; return () => { invalidate = () => {}; }; },
  };
  const runtime = createScopedGraphRuntime('graph-view', 'vault-a', transport);
  return { runtime, transport, change: (next: ScopedGraphSnapshot) => { value = next; invalidate(); } };
}

test('complete current proof requires all supported effects, with Main body-link restriction preserved', async () => {
  const { runtime, transport } = fixture();
  assert.equal(isCurrentGraphDataProof(runtime, null), false);
  await runtime.readSeed();
  const proof = runtime.dataProof()!;
  assert.equal(isCurrentGraphDataProof(runtime, proof), true);
  assert.equal(runtime.capability('bodyRelation').available, false);
  for (const action of ['open', 'openDefault', 'reveal', 'askAi', 'createMissing'] as const) {
    delete transport.actions[action];
    assert.equal(isCurrentGraphDataProof(runtime, proof), false, action);
    transport.actions[action] = true;
  }
  for (const feature of ['read', 'tagRelation'] as GraphRuntimeFeature[]) {
    const original = runtime.capability;
    runtime.capability = (candidate, node) => candidate === feature ? { available: false, reason: 'fixture missing' } : original(candidate, node);
    assert.equal(isCurrentGraphDataProof(runtime, proof), false, feature);
    runtime.capability = original;
  }
});

test('same-revision/different-snapshot and same-snapshot/different-revision cannot acknowledge', async () => {
  const { runtime } = fixture(); await runtime.readSeed();
  const proof = runtime.dataProof()!;
  assert.equal(isCurrentGraphDataProof(runtime, { ...proof, snapshotId: 'other-snapshot' }), false);
  assert.equal(isCurrentGraphDataProof(runtime, { ...proof, revision: 'other-revision' }), false);
  assert.equal(isCurrentGraphDataProof(runtime, { ...proof, snapshotId: '' }), false);
  assert.equal(isCurrentGraphDataProof(runtime, { ...proof, revision: '' }), false);
});

test('invalidation and incomplete refresh revoke old loaded proof immediately', async () => {
  const value = fixture(); const release = value.runtime.subscribe(() => {});
  await value.runtime.readSeed(); const old = value.runtime.dataProof()!;
  const incomplete = snapshot('next', 'next-revision');
  incomplete.completeness = { complete: false, missing: ['fixture-incomplete'] };
  value.change(incomplete);
  assert.equal(isCurrentGraphDataProof(value.runtime, old), false);
  await assert.rejects(value.runtime.readSeed(), /graph-incomplete/);
  assert.equal(isCurrentGraphDataProof(value.runtime, old), false);
  value.change(snapshot('latest', 'latest-revision'));
  await value.runtime.readSeed();
  assert.equal(isCurrentGraphDataProof(value.runtime, old), false);
  assert.equal(isCurrentGraphDataProof(value.runtime, value.runtime.dataProof()), true);
  release();
});

test('late replies cannot restore readiness for a superseded snapshot', async () => {
  const replies: Array<(value: ScopedGraphSnapshot) => void> = [];
  const services = fixture().transport;
  const runtime = createScopedGraphRuntime('view', 'vault-a', { actions: services.actions, mutateTag: services.mutateTag, exportScreenshot: services.exportScreenshot,
    request: <T>() => new Promise<T>(resolve => replies.push(value => resolve(value as T))) });
  const oldRead = runtime.readSeed();
  const newRead = runtime.readSeed({ refresh: true });
  replies[1](snapshot('new', 'new-revision')); await newRead;
  const proof = runtime.dataProof()!;
  replies[0](snapshot()); await assert.rejects(oldRead, /superseded/);
  assert.equal(isCurrentGraphDataProof(runtime, proof), true);
  assert.equal(isCurrentGraphDataProof(runtime, { kind: 'graph', snapshotId: 'snapshot-a', revision: 'revision-a' }), false);
});

test('surface uses one production GraphViewport, explicit runtime and no Main identity', () => {
  const source = readFileSync(new URL('../src/workspace/ScopedGraphDocumentSurface.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ GraphViewport \} from '..\/features\/graph\/GraphPage'/);
  assert.equal((source.match(/<GraphViewport\b/g) || []).length, 1);
  assert.match(source, /<GraphViewport key=\{viewId\} paneId=\{viewId\} runtime=\{runtime\} visible=\{visible\}/);
  assert.match(source, /active=\{visible && focused\}/);
  assert.match(source, /if \(runtime\?\.kind !== 'scoped' \|\| runtime\.allowWorker !== false\)/);
  assert.match(source, /layoutRevision=\{layoutRevision\}/);
  assert.match(source, /live\.runtime !== runtime \|\| !live\.visible/);
  assert.match(source, /!isCurrentGraphDataProof\(runtime, proof\)/);
  assert.match(source, /inert=\{!visible\}/);
  for (const forbidden of ['sessionId=', 'graphSessionStore', 'knowledgeStore', 'materialStore', 'getLuckyRayBridgeSync', 'window.location', 'registerIntegratedLayout', 'requestAnimationFrame', 'onSplit={() =>']) assert.ok(!source.includes(forbidden), forbidden);
});

test('canvas readiness originates after actual drawing and revalidates live scene and geometry', () => {
  const source = readFileSync(new URL('../src/features/graph/GraphPage.tsx', import.meta.url), 'utf8');
  const draw = source.slice(source.indexOf('  const draw = useCallback'), source.indexOf('  const loadGraphData = useCallback'));
  assert.ok(draw.indexOf('ctx.fillText') < draw.indexOf('reportGraphPaint();'));
  assert.ok(draw.indexOf('ctx.clearRect') < draw.indexOf('reportGraphPaint();'));
  assert.equal((source.match(/reportGraphPaint\(\);/g) || []).length, 1);
  const report = source.slice(source.indexOf('  const reportGraphPaint = useCallback'), source.indexOf('  const draw = useCallback'));
  for (const guard of ['sceneSeedRef.current !== loaded.seed', 'currentRuntimeRef.current !== loaded.runtime', 'loadedGraphProofRef.current !== loaded', 'loaded.requestId !== graphLoadSequenceRef.current', '!workspaceVisibleRef.current', '!isCurrentGraphDataProof(loaded.runtime, loaded.proof, loaded.seed)', '!canvas.isConnected', 'currentLayoutRevisionRef.current !== layout', 'rect.left !== geometry.left', 'rect.top !== geometry.top', 'rect.width !== geometry.width', 'rect.height !== geometry.height']) assert.ok(report.includes(guard), guard);
  assert.match(report, /geometry\.width > 0 && geometry\.height > 0/);
  assert.match(report, /window\.requestAnimationFrame/);
  const load = source.slice(source.indexOf('  const loadGraphData = useCallback'), source.indexOf('  const selectRelationStart = useCallback'));
  assert.match(load, /invalidatePaintReadiness\(\);\s*loadedGraphProofRef.current = null/);
  assert.ok(!load.includes('revisionReadyRef.current?.'));
  assert.match(source, /if \(!sessionId \|\| runtime\) return;\s*return graphSessionStore.registerView/);
  assert.match(source, /\{onSplit && <>/);
});

// Execute the exact production draw/readiness callbacks with an injected canvas
// and frame queue. This checks control flow; it is not browser/pixel evidence.
async function paintHarness() {
  const { default: ts } = await import('typescript');
  const f = fixture(); const seed = await f.runtime.readSeed();
  const proof = f.runtime.dataProof()!;
  const queued = new Map<number, () => void>(); let nextFrame = 0;
  const ready: unknown[] = [], painted: string[] = [], invalidated: string[] = [];
  const geometry = { width: 500.5, height: 300.5, left: 15, top: 20, dpr: 1 };
  const rect = { ...geometry };
  const ctx = Object.fromEntries(['setTransform', 'clearRect', 'save', 'translate', 'scale', 'restore']
    .map(name => [name, () => painted.push(name)]));
  const canvas = { isConnected: true, width: 0, height: 0, style: {}, getContext: () => ctx };
  const ref = <T>(current: T) => ({ current });
  const env: Record<string, any> = {
    useCallback: (callback: unknown) => callback, isCurrentGraphDataProof, paneId: 'graph-view', sessionId: undefined,
    loadedGraphProofRef: ref({ runtime: f.runtime, proof, seed, requestId: 1 }),
    canvasRef: ref(canvas), containerRef: ref({ getBoundingClientRect: () => rect }),
    revisionReadyRef: ref((value: unknown) => ready.push(value)), revisionInvalidatedRef: ref(() => invalidated.push('revoked')), workspaceVisibleRef: ref(true),
    presentationRef: ref(undefined), presentationCommitRef: ref(true), mainGraphPaintedSeedRef: ref(null), mainGraphApplyRef: ref(null),
    currentRuntimeRef: ref(f.runtime), graphSeedRef: ref(seed), sceneSeedRef: ref(seed),
    graphLoadSequenceRef: ref(1), viewportRef: ref(geometry), paintReadinessEpochRef: ref(1),
    currentLayoutRevisionRef: ref('layout-1'), pendingPaintReadyRef: ref(null), lastPaintReadyRef: ref(null),
    window: { devicePixelRatio: 1, requestAnimationFrame: (callback: () => void) => { const id = ++nextFrame; queued.set(id, callback); return id; }, cancelAnimationFrame: (id: number) => queued.delete(id) },
    canvasContextRef: ref(null), paramsRef: ref({ scale: 1, panX: 0, panY: 0, showLabels: false }),
    sceneCacheRef: ref({ activeFocusId: null, visibleNodes: [], visibleEdges: [] }),
    graphThemeAccentRef: ref('#aaa'), graphPaletteRef: ref({}), graphLabelDetail: () => ({}),
    revealTimelineRef: ref(null), labelsAnimatingRef: ref(false), labelMemoryRef: ref(new Map()), drawArrow: () => {},
  };
  const source = readFileSync(new URL('../src/features/graph/GraphPage.tsx', import.meta.url), 'utf8');
  const compile = (name: string) => {
    const ast = ts.createSourceFile('GraphPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback = '';
    const visit = (node: import('typescript').Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) callback = `const ${node.getText(ast)};`;
      ts.forEachChild(node, visit);
    };
    visit(ast); assert.ok(callback, name);
    const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    return Function(...Object.keys(env), `${js}\nreturn ${name};`)(...Object.values(env));
  };
  env.invalidatePaintReadiness = compile('invalidatePaintReadiness');
  env.reportGraphPaint = compile('reportGraphPaint');
  const draw = compile('draw');
  return { ...f, env, rect, canvas, ready, painted, invalidated, queued, compile, draw: () => draw(100),
    present: () => { const callbacks = [...queued.values()]; queued.clear(); for (const callback of callbacks) callback(); } };
}

test('load or an animation frame alone is not ready: actual canvas commands must precede presentation', async () => {
  const h = await paintHarness();
  assert.equal(h.ready.length, 0); h.present(); assert.equal(h.ready.length, 0);
  h.env.canvasRef.current = null; h.draw(); assert.equal(h.queued.size, 0);
  h.env.canvasRef.current = h.canvas;
  h.draw(); assert.ok(h.painted.includes('clearRect')); assert.ok(h.painted.includes('restore'));
  assert.equal(h.ready.length, 0); assert.equal(h.queued.size, 1);
  assert.equal(h.canvas.width, 501); assert.equal(h.canvas.height, 301);
  h.present(); assert.deepEqual(h.ready, [h.runtime.dataProof()]);
  h.draw(); h.present(); assert.equal(h.ready.length, 1, 'same paint identity is acknowledged only once');
});

test('zero geometry, unavailable canvas, or a scene from another seed never schedule readiness', async () => {
  for (const mode of ['zero-width', 'zero-height', 'no-context', 'wrong-scene', 'missing-route']) {
    const h = await paintHarness();
    if (mode === 'zero-width') h.env.viewportRef.current.width = 0;
    if (mode === 'zero-height') h.env.viewportRef.current.height = 0;
    if (mode === 'no-context') h.canvas.getContext = () => null as any;
    if (mode === 'wrong-scene') h.env.sceneSeedRef.current = {};
    if (mode === 'missing-route') delete h.transport.actions.askAi;
    h.draw(); h.present(); assert.equal(h.ready.length, 0, mode); assert.equal(h.queued.size, 0, mode);
  }
});

test('post-draw invalidation, replacement, hiding and layout changes reject queued readiness', async () => {
  for (const mode of ['runtime', 'visibility', 'loaded-reply', 'request', 'scene', 'layout', 'epoch', 'origin', 'size', 'dpr', 'detached', 'actions']) {
    const h = await paintHarness(); h.draw(); assert.equal(h.queued.size, 1);
    if (mode === 'runtime') h.env.currentRuntimeRef.current = fixture().runtime;
    if (mode === 'visibility') h.env.workspaceVisibleRef.current = false;
    if (mode === 'loaded-reply') h.env.loadedGraphProofRef.current = null;
    if (mode === 'request') h.env.graphLoadSequenceRef.current++;
    if (mode === 'scene') h.env.sceneSeedRef.current = {};
    if (mode === 'layout') h.env.currentLayoutRevisionRef.current = 'layout-2';
    if (mode === 'epoch') h.env.paintReadinessEpochRef.current++;
    if (mode === 'origin') h.rect.left++;
    if (mode === 'size') h.rect.width++;
    if (mode === 'dpr') h.env.window.devicePixelRatio = 2;
    if (mode === 'detached') h.canvas.isConnected = false;
    if (mode === 'actions') delete h.transport.actions.open;
    h.present(); assert.equal(h.ready.length, 0, mode);
  }
});


test('proof capture binds the exact returned seed even when refresh repeats snapshot and revision', async () => {
  const { runtime } = fixture();
  const before = await runtime.readSeed(); const proof = runtime.dataProof(before)!;
  const after = await runtime.readSeed({ refresh: true });
  assert.notEqual(before, after);
  assert.deepEqual(runtime.dataProof(after), proof);
  assert.equal(runtime.dataProof(before), null);
  assert.equal(isCurrentGraphDataProof(runtime, proof, before), false);
  assert.equal(isCurrentGraphDataProof(runtime, proof, after), true);
});

test('a refresh between actual draw and presentation rejects the old scene even for an identical proof', async () => {
  const h = await paintHarness(); h.draw(); assert.equal(h.queued.size, 1);
  const before = h.runtime.dataProof();
  await h.runtime.readSeed({ refresh: true });
  assert.deepEqual(h.runtime.dataProof(), before);
  h.present(); assert.equal(h.ready.length, 0);
});

test('read transport and node-action flags do not advertise mutation or screenshot services', async () => {
  for (const missing of ['mutateTag', 'exportScreenshot'] as const) {
    const h = fixture(); delete h.transport[missing];
    const seed = await h.runtime.readSeed();
    assert.equal(h.runtime.completeness().complete, false);
    assert.ok(h.runtime.completeness().missing.includes(missing === 'mutateTag' ? 'parent-route:tagRelation' : 'parent-route:screenshot'));
    assert.equal(isCurrentGraphDataProof(h.runtime, h.runtime.dataProof(seed), seed), false);
    assert.equal(h.runtime.capability(missing === 'mutateTag' ? 'tagRelation' : 'screenshot').available, false);
    if (missing === 'mutateTag') await assert.rejects(h.runtime.mutateRelation('tag', 'connect', seed.nodes[0], seed.nodes[0]), /tag-route-unavailable/);
    else await assert.rejects(h.runtime.exportScreenshot!(new Blob(['fixture'])), /screenshot-route-unavailable/);
  }
});

test('all document and tag nodes require grants before a complete graph can be ready', async () => {
  const h = fixture();
  const dto = snapshot(); dto.documents[0].frontmatterTags = ['x']; dto.grants = [];
  h.change(dto);
  const seed = await h.runtime.readSeed();
  assert.equal(seed.nodes.length, 2);
  assert.equal(h.runtime.completeness().complete, false);
  for (const node of seed.nodes) assert.ok(h.runtime.completeness().missing.includes(`node-ticket:${node.key}`));
  assert.equal(isCurrentGraphDataProof(h.runtime, h.runtime.dataProof(seed), seed), false);
  assert.equal(h.runtime.capability('tagRelation', seed.nodes[0]).available, false);
  dto.grants = [{ kind: 'document', token: 'document-ticket', relativePath: 'A.md' }, { kind: 'tag', token: 'tag-ticket', tag: 'x' }];
  h.change(dto); const granted = await h.runtime.readSeed({ refresh: true });
  assert.equal(isCurrentGraphDataProof(h.runtime, h.runtime.dataProof(granted), granted), true);
});

test('screenshot service must return a confirmed copied or saved result', async () => {
  const h = fixture(); const image = new Blob(['fixture'], { type: 'image/png' });
  let received: Blob | undefined;
  h.transport.exportScreenshot = async blob => { received = blob; return 'saved'; };
  assert.equal(await h.runtime.exportScreenshot!(image), 'saved'); assert.equal(received, image);
  h.transport.exportScreenshot = (async () => 'accepted') as any;
  await assert.rejects(h.runtime.exportScreenshot!(image), /screenshot-unconfirmed/);
});

test('scoped screenshot command never reaches clipboard or download fallback on denied service', async () => {
  for (const outcome of ['copied', 'saved', 'denied', 'unconfirmed', 'absent']) {
    const h = await paintHarness(); const notices: string[] = [];
    let exports = 0, fallbacks = 0;
    if (outcome === 'absent') delete h.transport.exportScreenshot;
    else h.transport.exportScreenshot = (async () => { exports++; if (outcome === 'denied') throw Error('fixture-denied'); return outcome; }) as any;
    Object.assign(h.env, { runtime: h.runtime, setMoreOpen: () => {}, showNotice: (value: string) => notices.push(value),
      t: (key: string) => key, graphText: (key: string) => key, downloadGraphScreenshot: () => { fallbacks++; }, navigator: { clipboard: { write: () => { fallbacks++; throw Error('ambient clipboard'); } } } });
    (h.canvas as any).toBlob = (reply: (blob: Blob) => void) => reply(new Blob(['fixture'], { type: 'image/png' }));
    await h.compile('copyCurrentView')();
    assert.equal(fallbacks, 0, outcome); assert.equal(exports, outcome === 'absent' ? 0 : 1, outcome);
    if (outcome === 'copied') assert.deepEqual(notices, ['editor.graph.status.screenshotCopied']);
    else if (outcome === 'saved') assert.deepEqual(notices, ['screenshotSaved']);
    else assert.ok(!notices.some(notice => /screenshotCopied|screenshotDownloaded|screenshotSaved/.test(notice)), outcome);
  }
});

test('refresh revokes the published paint synchronously before read and requires a new draw for identical proof', async () => {
  const h = await paintHarness(); h.draw(); h.present(); assert.equal(h.ready.length, 1);
  const order: string[] = []; let resolve!: (value: ScopedGraphSnapshot) => void;
  h.env.revisionInvalidatedRef.current = () => { order.push('invalidated'); };
  h.transport.request = <T>() => { order.push('read'); return new Promise<T>(done => { resolve = value => done(value as T); }); };
  Object.assign(h.env, { runtime: h.runtime, scopeVaultId: undefined, cancelGraphReveal: () => {},
    setGraphStatus: () => {}, setRelationSource: () => {}, showNotice: () => {}, t: (key: string) => key,
    resetNodes: () => { h.env.sceneSeedRef.current = h.env.graphSeedRef.current; } });
  const pending = h.compile('loadGraphData')({ refresh: true });
  assert.deepEqual(order, ['invalidated', 'read']);
  assert.equal(h.env.loadedGraphProofRef.current, null); assert.equal(h.env.lastPaintReadyRef.current, null);
  resolve(snapshot()); await pending;
  assert.equal(h.ready.length, 1, 'read completion does not restore paint authority');
  h.draw(); h.present(); assert.equal(h.ready.length, 2);
});

test('failed or invalid scenes revoke previously acknowledged paint, but superseded callbacks do not revoke newer paint', async () => {
  for (const mode of ['geometry', 'actions', 'scene', 'no-context', 'read-failure']) {
    const h = await paintHarness(); h.draw(); h.present(); assert.equal(h.ready.length, 1);
    if (mode === 'geometry') h.env.viewportRef.current.width = 0;
    if (mode === 'actions') delete h.transport.actions.open;
    if (mode === 'scene') h.env.sceneSeedRef.current = null;
    if (mode === 'no-context') { h.env.canvasContextRef.current = null; h.canvas.getContext = () => null as any; }
    if (mode === 'read-failure') {
      h.transport.request = async () => { throw Error('fixture-read-failure'); };
      Object.assign(h.env, { runtime: h.runtime, scopeVaultId: undefined, cancelGraphReveal: () => {},
        setGraphStatus: () => {}, setRelationSource: () => {}, showNotice: () => {}, t: (key: string) => key,
        resetNodes: () => {}, console: { warn: () => {} } });
      await h.compile('loadGraphData')({ refresh: true });
    } else h.draw();
    assert.ok(h.invalidated.length > 0, mode); assert.equal(h.env.lastPaintReadyRef.current, null, mode);
  }
  const h = await paintHarness(); h.draw(); h.env.paintReadinessEpochRef.current++;
  h.present(); assert.equal(h.invalidated.length, 0, 'old callback cannot revoke replacement lease');
});

test('lifecycle revocation callbacks are stable across callback-only host rerenders', () => {
  const source = readFileSync(new URL('../src/workspace/ScopedGraphDocumentSurface.tsx', import.meta.url), 'utf8');
  assert.match(source, /onRevisionInvalidated=\{revisionInvalidated\}/);
  assert.match(source, /const revisionInvalidated = useCallback\([\s\S]*?\}, \[viewId, runtime\]\)/);
  assert.match(source, /const invalidate = current.current.onRevisionInvalidated;\s*invalidate\?\.\(\);\s*return \(\) => invalidate\?\.\(\);\s*\}, \[viewId, runtime, visible, layoutRevision\]\)/);
});

test('measuring changed geometry revokes paint before the resized canvas can acknowledge again', async () => {
  const h = await paintHarness(); h.draw(); h.present();
  const measure = h.compile('measureViewport');
  assert.equal(measure(), false); assert.equal(h.invalidated.length, 0);
  h.rect.left += 80; h.rect.width = 712.25;
  assert.equal(measure(), true); assert.equal(h.invalidated.length, 1);
  assert.equal(h.env.lastPaintReadyRef.current, null); assert.equal(h.env.viewportRef.current.left, h.rect.left);
  h.draw(); assert.equal(h.ready.length, 1); h.present(); assert.equal(h.ready.length, 2);
});

test('grant coverage includes missing documents and both material kinds', async () => {
  const h = fixture(); const dto = snapshot(); dto.grants = [];
  dto.documents[0].wikiLinks = [{ raw: '[[Missing]]', target: 'Missing', alias: null, line: 1 }];
  dto.embeds = [{ sourceRelativePath: 'A.md', resolutions: [
    { kind: 'library-asset', assetId: 'asset-1', assetName: 'Image' },
    { kind: 'vault-asset', relativePath: 'assets/a.png', label: 'a.png' },
  ] }];
  h.change(dto); const seed = await h.runtime.readSeed();
  assert.ok(seed.nodes.some(node => node.status === 'missing'));
  assert.equal(seed.nodes.filter(node => node.type === 'material').length, 2);
  for (const node of seed.nodes) assert.ok(h.runtime.completeness().missing.includes(`node-ticket:${node.key}`));
  assert.equal(isCurrentGraphDataProof(h.runtime, h.runtime.dataProof(seed), seed), false);
});
