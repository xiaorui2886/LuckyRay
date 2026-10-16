import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { buildGraphPlaybackPlan, graphPlaybackNodeVisual } from '../src/core/services/graphPlayback.ts';
import { captureGraphPlayback, createGraphPlaybackClock, graphPlaybackActivationNodes, restoreGraphPlayback, validateGraphPlaybackSnapshot } from '../src/features/graph/graphPlaybackSession.ts';
import { sameGraphSessionSnapshot, validateGraphSessionSnapshot } from '../src/features/graph/graphSessionStore.ts';
import { createGraphViewPresentation } from '../src/workspace/graphViewPresentation.ts';

const sourceNodes = [
  { id: 11, key: 'note:b', type: 'note', label: 'B', links: 1, x: 70, y: 20, vx: .2, vy: -.1, hidden: false },
  { id: 2, key: 'note:a', type: 'note', label: 'A', links: 2, x: -10, y: 40, vx: .4, vy: .3, hidden: false },
  { id: 8, key: 'note:c', type: 'note', label: 'C', links: 1, x: 10, y: -20, vx: -.2, vy: .1, hidden: false },
];
const sourceEdges: [number, number][] = [[11, 2], [2, 8]];
const plan = () => buildGraphPlaybackPlan({ nodes: sourceNodes, edges: sourceEdges.map(([a, b]) => ({ a, b })), startedAt: 1000 })!;
const defaults = {
  nodes: sourceNodes, activatedIds: new Set<number>(), activationIds: new Map<number, number>(), activationOrder: new Map<number, number>(),
  cameraFollow: true, cameraTarget: { scale: 1.2, panX: 30, panY: 70 }, cameraVelocity: { panX: .3, panY: -.1 }, cameraZoomAnchor: { x: 11, y: 21 }, alpha: .37,
};
const snapshot = () => captureGraphPlayback({ ...defaults, timeline: plan(), elapsedMs: 350 });
const targetNodes = [sourceNodes[2], sourceNodes[0], sourceNodes[1]].map((node, index) => ({ ...node, id: [7, 41, 19][index] }));
const targetSeed = { nodes: targetNodes, edges: [[41, 19], [19, 7]] as [number, number][] };

test('portable plan retains every visual at the same elapsed time across numeric IDs and node ordering', () => {
  const captured = snapshot(), source = plan();
  const restored = restoreGraphPlayback(captured, targetSeed, 99000);
  for (const node of sourceNodes) {
    const target = targetNodes.find(candidate => candidate.key === node.key)!;
    assert.deepEqual(graphPlaybackNodeVisual(source.nodes.get(node.id)!, captured.elapsedMs), graphPlaybackNodeVisual(restored.timeline.nodes.get(target.id)!, captured.elapsedMs));
  }
  assert.deepEqual(graphPlaybackActivationNodes(targetNodes, restored.activationOrder).map(node => node.key), sourceNodes.map(node => node.key));
  assert.deepEqual(captureGraphPlayback({ ...defaults, timeline: restored.timeline, elapsedMs: captured.elapsedMs, nodes: targetNodes,
    activatedIds: restored.activatedIds, activationIds: restored.activationIds, activationOrder: restored.activationOrder }), captured);
});

test('overlapping hidden and presentation holds exclude their union exactly once and preserve sub-millisecond elapsed values', () => {
  const clock = createGraphPlaybackClock(), timeline = plan();
  clock.hold('hidden', true, 1350, timeline);
  clock.hold('presentation', true, 1800, timeline);
  assert.equal(clock.elapsed(timeline, 5000), 350);
  clock.hold('hidden', false, 6000, timeline);
  assert.equal(clock.elapsed(timeline, 7000), 350);
  clock.hold('presentation', true, 7500, timeline); // duplicate freeze
  clock.hold('presentation', false, 9000, timeline);
  assert.equal(clock.elapsed(timeline, 9000), 350);
  assert.equal(clock.elapsed(timeline, 9150), 500);
  clock.hold('presentation', false, 9300, timeline); // duplicate abort
  assert.equal(clock.elapsed(timeline, 9400), 750);
  clock.hold('presentation', true, 9500.314159, timeline);
  const exact = 350.123456789;
  clock.restored(timeline, exact, 9500.314159);
  assert.equal(clock.elapsed(timeline, 100000), exact);
  clock.hold('presentation', false, 105000.271828, timeline);
  assert.equal(clock.elapsed(timeline, 105000.271828), exact);
});

test('all nested playback fields and structural corruption reject before current scene remapping', () => {
  const valid = snapshot(); assert.equal(validateGraphPlaybackSnapshot(valid), true);
  const mutate: ((value: any) => void)[] = [
    value => { value.version = 2; }, value => { value.extra = true; }, value => { value.elapsedMs = Infinity; },
    value => { value.elapsedMs = value.totalDuration + 1; }, value => { value.totalDuration = 3_600_001; },
    value => { value.nodes[0].targetX = NaN; }, value => { value.nodes[0].spawnY = 1e9; },
    value => { value.nodes[0].duration = 0; }, value => { value.nodes[0].startAt = -1; },
    value => { value.nodes[0].curve = Infinity; }, value => { value.nodes[0].layer = .5; },
    value => { value.nodes[0].activationId = -1; }, value => { value.nodes[0].activationOrder = -1; },
    value => { value.nodes[1].activationId = value.nodes[0].activationId; }, value => { value.nodes[1].activationOrder = value.nodes[0].activationOrder; },
    value => { value.nodes[0].unexpected = true; }, value => { value.nodes.push(value.nodes[0]); },
    value => { value.nodes[0].parentKey = value.nodes[0].key; }, value => { value.nodes[0].parentKey = 'missing'; },
    value => { value.rootKeys.push(value.rootKeys[0]); }, value => { value.rootKeys = []; },
    value => { value.activatedKeys = ['missing']; }, value => { value.activatedKeys = [value.nodes.find((node: any) => node.startAt > value.elapsedMs).key]; },
    value => { value.edges[0].toKey = 'missing'; }, value => { value.edges[0].treeEdge = !value.edges[0].treeEdge; },
    value => { value.edges[0].duration = 0; }, value => { value.edges[0].startAt = value.totalDuration; },
    value => { value.edges.push(value.edges[0]); }, value => { value.edges[0].extra = true; },
    value => { value.cameraTarget.scale = 0; }, value => { value.cameraTarget.panX = Infinity; }, value => { value.cameraTarget.extra = true; },
    value => { value.cameraVelocity.panY = NaN; }, value => { value.cameraVelocity.extra = true; },
    value => { value.cameraZoomAnchor.x = Infinity; }, value => { value.cameraZoomAnchor.extra = true; },
    value => { value.cameraFollow = 1; }, value => { value.alpha = 1.1; },
  ];
  for (const change of mutate) { const next = structuredClone(valid); change(next); assert.equal(validateGraphPlaybackSnapshot(next), false, change.toString()); assert.throws(() => restoreGraphPlayback(next, targetSeed, 0), /invalid/); }
  assert.throws(() => restoreGraphPlayback(valid, { ...targetSeed, nodes: targetNodes.slice(1) }, 0), /node-mismatch/);
  assert.throws(() => restoreGraphPlayback(valid, { ...targetSeed, edges: [] }, 0), /edge-mismatch/);
});

// Execute the actual production closures with deterministic time and React state
// setters. This is renderer control-flow coverage, not browser/native acceptance.
const page = readFileSync(new URL('../src/features/graph/GraphPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('GraphPage.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, string>();
const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node.getText(ast)); ts.forEachChild(node, visit); }; visit(ast);
function harness(nodes = sourceNodes, edges = sourceEdges) {
  let now = 1350, playing = true, requestedPaints = 0;
  const ref = <T>(current: T) => ({ current });
  const env: Record<string, any> = {
    useCallback: (callback: unknown) => callback, performance: { now: () => now },
    captureGraphPlayback, restoreGraphPlayback, graphPlaybackActivationNodes, validateGraphSessionSnapshot,
    nodesRef: ref(structuredClone(nodes)), edgesRef: ref(edges), revealTimelineRef: ref(plan()), revealActiveRef: ref(true),
    revealActivatedNodeIdsRef: ref(new Set()), playbackActivationRef: ref(null), playbackCameraFollowRef: ref(true), playbackClockRef: ref(createGraphPlaybackClock()),
    presentationFrozenRef: ref(false), physicsGenerationRef: ref(1), physicsMutationRevisionRef: ref(1), physicsInFlightRef: ref({ requestId: 1 }),
    cameraTargetRef: ref({ ...defaults.cameraTarget }), cameraVelocityRef: ref({ ...defaults.cameraVelocity }), cameraZoomAnchorRef: ref({ ...defaults.cameraZoomAnchor }),
    lastCameraFrameAtRef: ref(1300), lastSimulationAtRef: ref(1300), paramsRef: ref({ ...defaults.cameraTarget, alpha: defaults.alpha }),
    pendingPointerRef: ref({ x: 1 }), pendingWheelRef: ref({ delta: 3 }), hoveredRef: ref(null), hoverPointerRef: ref(null),
    panningRef: ref(null), draggingNodeRef: ref(null), mouseDownNodeRef: ref(null), mouseDownPointRef: ref(null), activePointerIdRef: ref(null),
    focusedNodeRef: ref(null), pendingSelectionRef: ref(null), pendingRelationRef: ref(null), searchScopeNodeKeysRef: ref(null),
    relationSource: null, graphSearchScope: null, nodeQuery: '', sideOpen: false,
    colorGroupsRef: ref([]), sectionsRef: ref({}), initialPositionsRef: ref(new Map()), needsInitialFitRef: ref(false), settledFitRef: ref(false),
    setPlaying: (value: boolean) => { playing = value; }, setPresentationFrozen: () => {},
    requestGraphFrame: () => { requestedPaints++; }, invalidatePaintReadiness: () => {}, markGraphDirty: () => {},
    currentGraphView: () => ({ spatialVersion: 3 }),
    setCameraImmediately: (camera: any) => { Object.assign(env.paramsRef.current, camera); env.cameraTargetRef.current = { ...camera }; },
    normalizeGraphFilters: (value: any) => value, normalizeGraphColorGroups: (value: any) => value || [], normalizeGraphSections: (value: any) => value || {},
    readSavedLabelReveal: () => .25, readSavedForceControl: () => 50, clampGraphNumber: (value: any, fallback: any) => value ?? fallback,
    GRAPH_REST_LENGTH: 100, GRAPH_LINK_LENGTH_MIN: 64, GRAPH_LINK_LENGTH_MAX: 360, GRAPH_FORCE_CONTROL_MIN: 0, GRAPH_FORCE_CONTROL_MAX: 100, INITIAL_PARAMS: { nodeSpacing: 50 },
  };
  for (const key of ['Filters', 'ShowIsolated', 'NearbyFilter', 'NearbyDepth', 'ColorModeState', 'ShowArrows', 'ShowLabels', 'LabelReveal', 'NodeSize', 'EdgeWidth', 'CenterForce', 'RepulsionForce', 'LinkAttraction', 'LinkLength', 'NodeSpacing', 'ColorGroups']) env[`set${key}`] = () => {};
  for (const [setter, field] of [['setSideOpen', 'sideOpen'], ['setNodeQuery', 'nodeQuery'], ['setGraphSearchScope', 'graphSearchScope'], ['setRelationSource', 'relationSource']]) env[setter] = (value: any) => { env[field] = value; };
  env.sceneCacheRef = ref({ visibleNodes: env.nodesRef.current });
  const compile = (name: string) => {
    const declaration = declarations.get(name); assert.ok(declaration, name);
    const js = ts.transpileModule(`const ${declaration};`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    return Function(...Object.keys(env), `${js}\nreturn ${name};`)(...Object.values(env));
  };
  for (const name of ['cancelGraphReveal', 'installPlaybackSession', 'setGraphPresentationFrozen', 'activateGraphRevealNodes']) env[name] = compile(name);
  return { env, compile, setNow: (value: number) => { now = value; }, get now() { return now; }, get playing() { return playing; }, get requestedPaints() { return requestedPaints; },
    freeze: (value: boolean) => env.setGraphPresentationFrozen(value), capture: () => compile('captureSession')(), restore: (value: any) => compile('restoreSession')(value) };
}

test('production freeze/capture/abort closures preserve playing source, pause physics/input and resume after failed transfer', () => {
  const h = harness(), timeline = h.env.revealTimelineRef.current;
  h.env.activateGraphRevealNodes(1350);
  h.env.playbackClockRef.current.hold('hidden', true, 1350, timeline);
  h.setNow(1600); h.freeze(true);
  const captured = h.capture();
  assert.equal(captured.playback.elapsedMs, 350); assert.equal(h.playing, true);
  assert.equal(h.env.revealTimelineRef.current, timeline);
  assert.equal(h.env.physicsInFlightRef.current, null); assert.equal(h.env.pendingPointerRef.current, null); assert.equal(h.env.pendingWheelRef.current, null);
  h.setNow(10000); h.env.playbackClockRef.current.hold('hidden', false, h.now, timeline);
  assert.deepEqual(h.capture(), captured);
  h.freeze(false); // production Main abort / scoped release uses this closure
  assert.equal(h.playing, true); assert.equal(h.requestedPaints, 1);
  assert.deepEqual(h.capture(), captured);
  h.setNow(10200); assert.equal(h.capture().playback.elapsedMs, 550);
});

test('production restore and later activation retain original order, spawn angles, velocities and plan on a reordered target', () => {
  const source = harness(); source.env.activateGraphRevealNodes(1350); source.freeze(true);
  const captured = source.capture(), target = harness(targetNodes, targetSeed.edges);
  target.setNow(80000.123); target.freeze(true); target.restore(captured);
  assert.equal(target.playing, true); assert.ok(sameGraphSessionSnapshot(target.capture(), captured));
  target.setNow(90000); assert.ok(sameGraphSessionSnapshot(target.capture(), captured));
  source.freeze(false); target.freeze(false);
  source.env.activateGraphRevealNodes(source.env.revealTimelineRef.current.startedAt + 1800);
  target.env.activateGraphRevealNodes(target.env.revealTimelineRef.current.startedAt + 1800);
  const positions = (h: ReturnType<typeof harness>) => h.env.nodesRef.current.map(({ key, x, y, vx, vy }: any) => ({ key, x, y, vx, vy })).sort((a: any, b: any) => a.key.localeCompare(b.key));
  assert.deepEqual(positions(target), positions(source));
  for (const node of sourceNodes) {
    const sourcePlan = source.env.revealTimelineRef.current.nodes.get(node.id), targetPlan = target.env.revealTimelineRef.current.nodes.get(targetNodes.find(candidate => candidate.key === node.key)!.id);
    assert.equal(targetPlan.spawnX, sourcePlan.spawnX); assert.equal(targetPlan.spawnY, sourcePlan.spawnY);
  }
});

test('old session snapshots keep default non-playing layout restoration and invalid plans never mutate current state', () => {
  const h = harness(); h.freeze(true); const before = h.capture();
  const corrupt = structuredClone(before); corrupt.playback.nodes[0].targetX = Infinity;
  assert.throws(() => h.restore(corrupt), /invalid/); assert.ok(sameGraphSessionSnapshot(h.capture(), before)); assert.equal(h.playing, true);
  const missing = structuredClone(before); missing.positions[0].key = 'missing'; missing.playback.nodes.find((node: any) => node.key === before.positions[0].key).key = 'missing';
  assert.throws(() => h.restore(missing)); assert.ok(sameGraphSessionSnapshot(h.capture(), before));
  const legacy = structuredClone(before); delete legacy.playback;
  h.restore(legacy); assert.equal(h.playing, false); assert.equal(h.env.revealTimelineRef.current, null); assert.equal('playback' in h.capture(), false);
});

test('scoped controller ACK requires the applied frozen playback state and exact capture/hash after paint', async () => {
  const source = harness(); source.env.activateGraphRevealNodes(1350); source.freeze(true);
  const identity = { viewId: 'source', vaultId: 'vault', sourceId: 'source-id', generation: 4 };
  const proof = { kind: 'graph' as const, snapshotId: 'snapshot', revision: 'revision', sourceId: identity.sourceId };
  const seed = { source: 'real' as const, ...targetSeed };
  const runtime: any = { vaultId: identity.vaultId, renderedRevision: () => proof.revision, dataProof: (value: any) => !value || value === seed ? proof : null,
    completeness: () => ({ complete: true, missing: [] }), capability: () => ({ available: true }), exportScreenshot: async () => 'saved' };
  const target = harness(targetNodes, targetSeed.edges); target.setNow(10000);
  const controller = createGraphViewPresentation({ ...identity, viewId: 'target', generation: 5 }, runtime);
  let paints = 0;
  controller.attach({ scene: () => ({ seed, proof }), capture: target.capture, restore: target.restore, freeze: target.freeze, flush: () => true, requestPaint: () => { paints++; } });
  const presentation = { version: 1, kind: 'graph', captureId: 'source:4:1', source: identity, proof, state: source.capture() };
  const applied = controller.apply(presentation, identity, 'handoff-v1:exact');
  let acked = false; void applied.then(() => { acked = true; }); await Promise.resolve(); assert.equal(acked, false); assert.equal(paints, 1);
  target.setNow(90000); assert.ok(sameGraphSessionSnapshot(target.capture(), presentation.state));
  assert.equal(controller.painted({ ...seed }, proof), false); assert.equal(controller.painted(seed, { ...proof, revision: 'other' }), false);
  assert.equal(controller.painted(seed, proof), true);
  const ack = await applied; assert.equal(ack.captureId, presentation.captureId); assert.equal(ack.presentationHash, 'handoff-v1:exact'); assert.equal(ack.source.generation, 4); assert.equal(ack.target.generation, 5);
  assert.equal(target.env.presentationFrozenRef.current, true); controller.release(); assert.equal(target.env.presentationFrozenRef.current, false);
  target.setNow(90200); assert.equal(target.capture().playback.elapsedMs, 550);
  const second = controller.apply(presentation, identity, 'handoff-v1:second');
  const rejected = assert.rejects(second, /apply-mismatch/);
  target.env.revealTimelineRef.current.nodes.values().next().value.spawnX += 1;
  assert.equal(controller.painted(seed, proof), false); await rejected; controller.abort();
});

test('frozen production frame draws at held time and never advances physics or activation', () => {
  const h = harness(); h.freeze(true); let paintedAt = -1;
  Object.assign(h.env, { workspaceVisibleRef: { current: true }, presentationCommitRef: { current: true },
    rebuildSceneCache: () => {}, dirtyRef: { current: {} }, draw: (timestamp: number) => { paintedAt = timestamp; },
    applyPendingInputs: () => assert.fail('input advanced while frozen'), advanceGraphReveal: () => assert.fail('playback advanced while frozen'),
    findNodeAt: () => {}, flushGraphView: () => {}, getCanvasPoint: () => {}, screenToWorld: () => {},
    simulate: () => assert.fail('physics advanced while frozen'), updateCamera: () => assert.fail('camera advanced while frozen'), updatePlaybackCamera: () => assert.fail('follow advanced while frozen'),
  });
  h.compile('runGraphFrame')(50000);
  assert.equal(paintedAt, 1350);
});

test('Main post-paint callback verifies the actual restored playback before resolving its exact ACK', async () => {
  for (const tamper of [false, true]) {
    const source = harness(); source.env.activateGraphRevealNodes(1350); source.freeze(true);
    const state = source.capture(), target = harness(targetNodes, targetSeed.edges);
    target.setNow(50000); target.freeze(true); target.restore(state);
    const seed = { source: 'real', ...targetSeed }, held = { seed, generation: 9 };
    const geometry = { width: 600, height: 400, left: 10, top: 20, dpr: 1 };
    const canvas = { isConnected: true, width: 600, height: 400 };
    const frames: (() => void)[] = [];
    const acknowledgment = { captureId: 'graph-1:3:4', presentationHash: 'handoff-v1:main-hash', source: { generation: 3 }, target: { generation: 9 } };
    let resolved = false;
    const applied = new Promise(resolve => { target.env.mainGraphApplyRef = { current: { seed, generation: 9, state, acknowledgment, resolve: (value: unknown) => { resolved = true; resolve(value); }, reject: resolve } }; });
    Object.assign(target.env, {
      currentRuntimeRef: { current: undefined }, mainGraphSourceRef: { current: held }, mainGraphPaintedSeedRef: { current: null },
      graphSeedRef: { current: seed }, sceneSeedRef: { current: seed }, canvasRef: { current: canvas },
      containerRef: { current: { getBoundingClientRect: () => ({ ...geometry }) } }, viewportRef: { current: geometry },
      workspaceVisibleRef: { current: true }, presentationCommitRef: { current: true }, paintReadinessEpochRef: { current: 7 },
      sessionHandleRef: { current: { capture: target.capture } }, sameGraphSessionSnapshot,
      window: { devicePixelRatio: 1, requestAnimationFrame: (callback: () => void) => { frames.push(callback); } },
    });
    target.compile('reportGraphPaint')();
    assert.equal(resolved, false); assert.equal(frames.length, 1);
    target.setNow(80000); assert.ok(sameGraphSessionSnapshot(target.capture(), state));
    if (tamper) target.env.playbackCameraFollowRef.current = false;
    frames.shift()!();
    const result = await applied;
    if (tamper) { assert.ok(result instanceof Error); assert.match(result.message, /presentation-mismatch/); assert.equal(resolved, false); }
    else { assert.equal(result, acknowledgment); assert.equal(resolved, true); }
  }
});

test('retained renderer effect survives persistence policy changes for 1 → 2 → 1 views and still cleans up on unmount', () => {
  const h = harness();
  const callbacks: { deps: unknown[]; value: unknown }[] = [];
  let cursor = 0, mounts = 0, unmounts = 0, writes = 0;
  let effectDeps: unknown[] | null = null, cleanup: (() => void) | undefined;
  const equal = (left: unknown[], right: unknown[]) => left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  const env: Record<string, any> = {
    persistView: true, runtime: undefined, persistViewRef: { current: true }, currentRuntimeRef: { current: undefined }, currentGraphView: () => ({ spatialVersion: 3 }),
    writeGraphViewState: () => { writes++; }, viewPersistTimerRef: { current: null }, VIEW_PERSIST_DELAY_MS: 200,
    runGraphFrameRef: { current: null }, runGraphFrame: () => {}, measureViewport: () => {}, resetNodes: () => {},
    containerRef: { current: null }, markGraphDirty: () => {}, requestGraphFrame: () => {},
    revealTimelineRef: h.env.revealTimelineRef, revealActiveRef: h.env.revealActiveRef, revealActivatedNodeIdsRef: h.env.revealActivatedNodeIdsRef,
    engineFrameRef: { current: 0 }, engineTimerRef: { current: null },
    window: { clearTimeout: () => {}, cancelAnimationFrame: () => {}, setTimeout: () => 1 },
    useCallback: (callback: unknown, deps: unknown[]) => { const index = cursor++; if (!callbacks[index] || !equal(callbacks[index].deps, deps)) callbacks[index] = { deps, value: callback }; return callbacks[index].value; },
    useEffect: (effect: () => (() => void), deps: unknown[]) => { if (effectDeps && equal(effectDeps, deps)) return; if (cleanup) { unmounts++; cleanup(); } effectDeps = deps; mounts++; cleanup = effect(); },
  };
  let engineEffect = '';
  const find = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('runGraphFrameRef.current = runGraphFrame')) engineEffect = node.getText(ast);
    ts.forEachChild(node, find);
  }; find(ast); assert.ok(engineEffect);
  const evaluate = (source: string) => Function(...Object.keys(env), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText)(...Object.values(env));
  const render = (persistView: boolean) => {
    env.persistView = persistView; env.persistViewRef.current = persistView; cursor = 0;
    for (const name of ['persistGraphView', 'saveGraphView', 'flushGraphView']) {
      env[name] = evaluate(`{ const ${declarations.get(name)}; return ${name}; }`);
    }
    evaluate(`${engineEffect};`);
  };
  render(true); const firstFlush = env.flushGraphView, timeline = h.env.revealTimelineRef.current;
  render(false); assert.equal(env.flushGraphView, firstFlush); env.flushGraphView(); assert.equal(writes, 0);
  assert.equal(h.env.revealTimelineRef.current, timeline); assert.equal(h.env.revealActiveRef.current, true);
  render(true); assert.equal(env.flushGraphView, firstFlush); env.flushGraphView(); assert.equal(writes, 1);
  assert.equal(mounts, 1); assert.equal(unmounts, 0); assert.equal(h.env.revealTimelineRef.current, timeline);
  cleanup!(); assert.equal(h.env.revealTimelineRef.current, null); assert.equal(h.env.revealActiveRef.current, false);
});
