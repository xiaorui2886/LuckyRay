import test from 'node:test';
import assert from 'node:assert/strict';
import { generatorCardDimensions, storyboardNodeSize, storyboardAppendY, storyboardBounds } from '../src/core/canvas/storyboardLayout.ts';
import { applyCreation, creationRevision, type CreationState } from '../src/core/canvas/agent/creationEngine.ts';
import { defaultShot } from '../src/core/canvas/storyboard.ts';
const shot = (description = '', extra: any = {}): any => ({ id: 's', position: { x: 42, y: 58 }, data: { kind: 'generator', generationAspect: '16:9', storyboardShot: { ...defaultShot(0), description } }, ...extra });
let id = 0;
const apply = (state: CreationState, operation: any): CreationState => ({ ...state, ...applyCreation(state, { expectedRevision: creationRevision(state), operation }, { createId: () => `r15-${++id}`, origin: { x: 0, y: 0 } }) });
const board = () => apply({ canvasId: 'test', nodes: [], edges: [], history: [] }, { op: 'storyboard.create', name: 'Test' });
test('pre-mount sizing follows real generator aspect and compact summary content', () => {
  const empty = storyboardNodeSize(shot()), short = storyboardNodeSize(shot('Hello')), long = storyboardNodeSize(shot('中文😀'.repeat(200)));
  assert.deepEqual(generatorCardDimensions(16 / 9), { width: 430, height: 242 });
  assert.ok(empty.height < short.height && short.height < long.height);
  assert.ok(long.height <= 242 + 150 + 10);
  assert.ok(storyboardNodeSize(shot('', { data: { kind: 'generator', generationAspect: '9:16', storyboardShot: defaultShot(0) } })).height > empty.height);
});
test('measured canvas-space dimensions cover async layout growth and append is zoom independent', () => {
  const node = shot('long'.repeat(30), { measured: { width: 600, height: 620 }, position: { x: 42, y: 300 } });
  assert.deepEqual(storyboardNodeSize(node), { width: 600, height: 620 });
  assert.equal(storyboardAppendY([node]), 968);
  for (const zoom of [.25, .41, 1, 2]) assert.equal(storyboardAppendY([{ ...node, zoom }]), 968);
  assert.deepEqual(storyboardBounds([node]), { width: 684, height: 962 });
});
test('stale short measurement cannot truncate an edited summary estimate', () => {
  const node = shot('中文'.repeat(200), { measured: { width: 430, height: 290 } });
  assert.ok(storyboardNodeSize(node).height > 290);
  assert.equal(storyboardAppendY([node]), 58 + storyboardNodeSize(node).height + 48);
});
test('Agent new board is content-sized and add preserves all old manual positions', () => {
  let state = board(); const bid = state.nodes.find(n => n.data.storyboard)!.id;
  const first = state.nodes.find(n => n.data.storyboardShot)!;
  assert.ok(Number(state.nodes.find(n => n.id === bid)!.style!.height) < 700);
  state = { ...state, nodes: state.nodes.map(n => n.id === first.id ? { ...n, position: { x: 100, y: 300 }, measured: { width: 430, height: 480 } } : n) };
  const positions = state.nodes.map(n => ({ id: n.id, position: n.position }));
  state = apply(state, { op: 'shot.add', boardId: bid, kind: 'video', fields: { description: 'Scene' } });
  for (const old of positions) assert.deepEqual(state.nodes.find(n => n.id === old.id)!.position, old.position);
  const added = state.nodes.at(-1)!;
  assert.equal(added.position.y, 300 + 480 + 48);
  assert.ok(Number(state.nodes.find(n => n.id === bid)!.style!.height) >= added.position.y + storyboardNodeSize(added).height + 42);
});
test('Agent duplicate appends below visible card contents without fixed 660 stride', () => {
  let state = board(); const bid = state.nodes.find(n => n.data.storyboard)!.id, sid = state.nodes.find(n => n.data.storyboardShot)!.id;
  state = apply(state, { op: 'shot.update', boardId: bid, shotId: sid, fields: { description: 'A short scene' } });
  const original = state.nodes.find(n => n.id === sid)!;
  state = apply(state, { op: 'shot.duplicate', boardId: bid, shotId: sid });
  assert.equal(state.nodes.at(-1)!.position.y, storyboardAppendY([original]));
  assert.ok(state.nodes.at(-1)!.position.y - original.position.y < 660);
  assert.deepEqual(state.nodes.find(n => n.id === sid)!.position, original.position);
});
test('foreign members and unusual manual layouts retain append non-overlap bounds', () => {
  const foreign = { id: 'text', position: { x: 700, y: 2200 }, measured: { width: 800, height: 900 }, data: { kind: 'text' } };
  assert.equal(storyboardAppendY([shot(), foreign]), 3148);
  assert.deepEqual(storyboardBounds([foreign]), { width: 1542, height: 3142 });
});

test('single reused-shot import and shot edits grow compact board bounds without moving cards', () => {
  for (const importing of [false, true]) {
    let state = board(); const bid = state.nodes.find(n => n.data.storyboard)!.id, sid = state.nodes.find(n => n.data.storyboardShot)!.id;
    const position = state.nodes.find(n => n.id === sid)!.position;
    state = apply(state, importing
      ? { op: 'storyboard.importScript', boardId: bid, sourceText: '镜头1：测试\n画面：' + '中文'.repeat(100) + '\n动作：' + '动作'.repeat(100) + '\n台词：' + '台词'.repeat(100) }
      : { op: 'shot.update', boardId: bid, shotId: sid, fields: { description: '中文'.repeat(100), action: '动作'.repeat(100), dialogue: '台词'.repeat(100) } });
    const card = state.nodes.find(n => n.id === sid)!;
    assert.deepEqual(card.position, position);
    assert.ok(Number(state.nodes.find(n => n.id === bid)!.style!.height) >= card.position.y + storyboardNodeSize(card).height + 42);
  }
});
test('newly tagged image/video reserves summary before stale measurement refresh', () => {
  for (const kind of ['image', 'video']) {
    const asset = shot('description'.repeat(50), { measured: { width: 430, height: 242 }, data: { kind, storyboardShot: { ...defaultShot(0), description: 'description'.repeat(50) } } });
    assert.ok(storyboardNodeSize(asset).height > 242);
    assert.ok(storyboardAppendY([asset]) >= 58 + 242 + 8 + 46 + 48);
  }
});
