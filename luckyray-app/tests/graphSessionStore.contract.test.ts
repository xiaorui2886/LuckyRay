import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphSessionStore, validateGraphLayout, type GraphSessionSnapshot } from '../src/features/graph/graphSessionStore.ts';
import { graphSessionRects } from '../src/features/graph/graphSessionLayout.ts';

const snapshot = (panX: number): GraphSessionSnapshot => ({
  camera: { scale: .7, panX, panY: 21 },
  view: { spatialVersion: 3, filters: { note: true, material: false, tag: true, web: false }, showLabels: false },
  positions: [{ key: 'note-a', x: 8, y: 9, vx: 0, vy: 0 }], focusedKey: 'note-a', sideOpen: true,
  searchScope: { kind: 'document', label: 'A', nodeKeys: ['note-a'] },
});

test('selection changes membership focus only; each retained canvas owns camera, filters and selection', () => {
  const store = createGraphSessionStore(), a = snapshot(35), id = store.add(), b = snapshot(800);
  store.registerView('graph-1', { capture: () => a });
  store.registerView(id, { capture: () => b });
  for (let i = 0; i < 4; i++) { store.select('graph-1'); store.select(id); }
  assert.deepEqual(store.captureView('graph-1'), a);
  assert.deepEqual(store.captureView(id), b);
  assert.equal(store.getSnapshot().activeTabId, id);
  assert.equal(Object.keys(store.getSnapshot().views).length, 2);
});

test('duplicate is a deep independent snapshot of the chosen view, including selection and search', () => {
  const store = createGraphSessionStore(), a = snapshot(75);
  store.registerView('graph-1', { capture: () => a });
  const id = store.add({ duplicate: true });
  const copy = store.getInitialSnapshot(id)!;
  assert.deepEqual(copy, a);
  a.camera.panX = 500; a.view.filters!.note = false; a.positions[0].x = 400; a.searchScope!.nodeKeys.push('other');
  assert.equal(store.getInitialSnapshot(id)!.camera.panX, 75);
  assert.equal(store.getInitialSnapshot(id)!.view.filters!.note, true);
  assert.equal(store.getInitialSnapshot(id)!.positions[0].x, 8);
  assert.deepEqual(store.getInitialSnapshot(id)!.searchScope!.nodeKeys, ['note-a']);
  copy.camera.panX = -100;
  assert.equal(store.getInitialSnapshot(id)!.camera.panX, 75);
});

test('move to a split keeps IDs/handles, permits closing original view and collapses empty groups', () => {
  const store = createGraphSessionStore(), state = snapshot(200);
  store.registerView('graph-1', { capture: () => state });
  const other = store.add();
  assert.equal(store.split('graph-1', 'row', { move: true }), true);
  assert.equal(store.getSnapshot().groups.length, 2);
  assert.deepEqual(store.captureView('graph-1'), state);
  const target = store.getSnapshot().groups.find(group => group.tabIds.includes(other))!;
  store.move('graph-1', target.id, 0);
  assert.equal(store.getSnapshot().groups.length, 1);
  assert.deepEqual(store.getSnapshot().tabs.map(tab => tab.id), ['graph-1', other]);
  assert.equal(store.close('graph-1'), true);
  assert.equal(store.close(other), false);
});

test('split duplicates independent state; no-op move of the only tab never creates an empty group', () => {
  const store = createGraphSessionStore(), a = snapshot(15);
  store.registerView('graph-1', { capture: () => a });
  assert.equal(store.split('graph-1', 'row', { move: true }), false);
  store.split('graph-1', 'column');
  const second = store.getSnapshot().activeTabId;
  assert.deepEqual(store.getInitialSnapshot(second), a);
  assert.equal(store.getSnapshot().groups.length, 2);
  store.setRatio((store.getSnapshot().layout as { id: string }).id, .8);
  const rects = graphSessionRects(store.getSnapshot().layout, 1000, 800);
  assert.equal(rects.splits.length, 1);
  assert.equal([...rects.groups.values()].reduce((n, rect) => n + rect.height, 0), 794);
});

test('layout captures presentation without node content and restore keeps all additionally opened views', async () => {
  const store = createGraphSessionStore(), a = snapshot(35);
  let restored: GraphSessionSnapshot | null = null;
  store.registerView('graph-1', { capture: () => a, restore: value => { restored = value; } });
  const saved = store.capture();
  assert.equal(validateGraphLayout(saved), true);
  assert.deepEqual(saved.states['graph-1'].positions, []);
  assert.equal(saved.states['graph-1'].searchScope, undefined);
  assert.equal(saved.states['graph-1'].focusedKey, undefined);
  const extra = store.add(); store.split(extra, 'row');
  const ids = Object.keys(store.getSnapshot().views);
  assert.equal(await store.restore(saved), true);
  assert.deepEqual(Object.keys(store.getSnapshot().views), ids);
  assert.equal(store.getSnapshot().groups.length, 1);
  assert.equal((restored as GraphSessionSnapshot | null)?.camera.panX, 35);
  const invalid = JSON.parse(JSON.stringify(saved)); invalid.groups[0].tabIds.push('graph-1');
  assert.equal(validateGraphLayout(invalid), false);
  assert.equal(await store.restore(invalid), false);
});

test('reorder rejects foreign IDs and closing a background tab keeps selected view intact', () => {
  const store = createGraphSessionStore(), two = store.add(), three = store.add();
  store.reorder(three, 'graph-1');
  assert.deepEqual(store.getSnapshot().tabs.map(tab => tab.id), [three, 'graph-1', two]);
  assert.equal(store.reorder(three, 'not-present'), false);
  store.close(two);
  assert.equal(store.getSnapshot().activeTabId, three);
});


test('transaction checkpoint restores exact membership and full live selection/search after a later provider fails', async () => {
  const store = createGraphSessionStore(), before = snapshot(333);
  let current = before;
  store.registerView('graph-1', { capture: () => current, restore: next => { current = next; } });
  const rollback = store.checkpoint();
  const beforeState = JSON.parse(JSON.stringify(store.getSnapshot()));
  const incoming = createGraphSessionStore(); incoming.add();
  await store.restore(incoming.capture());
  current = { ...snapshot(0), focusedKey: null, searchScope: null };
  assert.equal(Object.keys(store.getSnapshot().views).length, 2);
  await rollback();
  assert.deepEqual(store.getSnapshot(), beforeState);
  assert.deepEqual(current, before);
  assert.equal(store.captureView('graph-2'), undefined);
});

test('invalid snapshot entries and view fields reject before changing any live canvas', async () => {
  const store = createGraphSessionStore(); let writes = 0;
  store.registerView('graph-1', { capture: () => snapshot(10), restore: () => { writes++; } });
  const saved = store.capture(), initial = store.getSnapshot();
  const invalidations = [
    (s: any) => { s.positions = [null]; },
    (s: any) => { s.positions = [{ key: 'a', x: NaN, y: 0, vx: 0, vy: 0 }]; },
    (s: any) => { s.positions = [{ key: 'a', x: 1e99, y: 0, vx: 0, vy: 0 }]; },
    (s: any) => { s.positions = Array(20001).fill({ key: 'a', x: 0, y: 0, vx: 0, vy: 0 }); },
    (s: any) => { s.camera.scale = Infinity; },
    (s: any) => { s.camera.panX = 1e30; },
    (s: any) => { s.view = {}; },
    (s: any) => { s.view.filters.note = 'yes'; },
    (s: any) => { s.view.nearbyDepth = 3; },
    (s: any) => { s.view.colorMode = 'wrong'; },
    (s: any) => { s.view.colorGroups = [null]; },
    (s: any) => { s.view.sections = { unknown: true }; },
    (s: any) => { s.view.nodeSize = NaN; },
    (s: any) => { s.focusedKey = {}; },
    (s: any) => { s.relationSourceKey = 12; },
    (s: any) => { s.searchScope = { kind: 'file', label: 'A', nodeKeys: ['a'] }; },
    (s: any) => { s.searchScope = { kind: 'folder', label: 'A', nodeKeys: [null] }; },
    (s: any) => { s.searchQuery = false; },
    (s: any) => { s.sideOpen = 'true'; },
  ];
  for (const invalidate of invalidations) {
    const bad = structuredClone(saved); invalidate(bad.states['graph-1']);
    assert.equal(validateGraphLayout(bad), false);
    assert.equal(await store.restore(bad), false);
    assert.equal(store.getSnapshot(), initial);
    assert.equal(writes, 0);
  }
});

test('restoring a split layout keeps IDs unique for subsequent split creation', async () => {
  const source = createGraphSessionStore(); source.split('graph-1', 'row');
  const saved = source.capture();
  saved.layout.id = 'graph-split-5'; // Valid persisted IDs need not be consecutive.
  const target = createGraphSessionStore();
  assert.equal(await target.restore(saved), true);
  target.split(target.getSnapshot().activeTabId, 'column');
  assert.equal(validateGraphLayout(target.capture()), true);
});
