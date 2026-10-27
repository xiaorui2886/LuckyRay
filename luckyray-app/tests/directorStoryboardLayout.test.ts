import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storyboardNodeSize } from '../src/core/canvas/storyboardLayout.ts';
import { createDirectorDocument, addShot } from '../src/core/canvas/director/model.ts';
import { directorShotDescription } from '../src/core/canvas/director/integration.ts';
import { defaultShot } from '../src/core/canvas/storyboard.ts';
import { sanitizeCanvasNodesForPersistence } from '../src/features/canvas/canvasPersistence.ts';
import { DIRECTOR_STORYBOARD_INSETS as insets, directorStoryboardAppendY, directorStoryboardBounds, spaceDirectorStoryboards } from '../src/core/canvas/director/storyboardLayout.ts';

const captured = addShot(createDirectorDocument()).shots[0];
const frame = (id = 'frame'): any => ({ id, parentId: 'board', position: { x: 42, y: 58 }, data: {
  kind: 'image', directorShotSource: { version: 1, shotId: captured.id, shot: captured },
  storyboardShot: { ...defaultShot(0), description: directorShotDescription(captured) },
} });

test('director image reserves its actual 560px preview and summary before ReactFlow measures it', () => {
  const node = frame(), size = storyboardNodeSize(node);
  assert.ok(size.width >= 560, '300px generic asset fallback cannot bound a director PNG');
  assert.ok(size.height > 560 * 9 / 16 + 46 + 8, 'media and summary must both fit');
  const measured = { ...node, measured: { width: 562, height: 450 } };
  assert.equal(storyboardNodeSize(measured).height, 450, 'complete measurement must not receive a second summary');
});

test('new frames fit the group on both axes with header, summary and caption breathing room', () => {
  const first = { ...frame(), position: { x: insets.x, y: insets.top } };
  const second = { ...frame('second'), position: { x: insets.x, y: directorStoryboardAppendY([first]) } };
  const bounds = directorStoryboardBounds([first, second]);
  assert.ok(bounds.width >= 560 + insets.x * 2);
  assert.ok(Math.abs(second.position.y - first.position.y - storyboardNodeSize(first).height - 80) < 1e-6);
  assert.ok(bounds.height >= second.position.y + storyboardNodeSize(second).height + 64);
  for (const zoom of [.25, .54, 1, 2]) assert.equal(directorStoryboardAppendY([{ ...first, zoom }]), second.position.y);
});

test('existing cramped director stack is fixed once without moving unrelated content or changing shots', () => {
  const board: any = { id: 'board', type: 'group', position: { x: 1000, y: 500 }, style: { width: 540, height: 800 }, data: { kind: 'group', storyboard: { version: 1 }, directorDocument: createDirectorDocument() } };
  const first = { ...frame(), position: { x: -20, y: 58 } }, second = { ...frame('second'), position: { x: -20, y: 450 } };
  const unrelated: any = { id: 'ordinary', position: { x: 1, y: 2 }, data: { kind: 'generator', storyboardShot: defaultShot(0) } };
  const source = [board, first, second, unrelated], result = spaceDirectorStoryboards(source);
  assert.deepEqual(result[0].position, board.position);
  assert.equal(result[1].position.x, 64); assert.equal(result[1].position.y, 88);
  assert.equal(result[2].position.y, directorStoryboardAppendY([result[1]]));
  assert.strictEqual(result[1].data, first.data); assert.strictEqual(result[0].data, board.data); assert.strictEqual(result[3], unrelated);
  assert.deepEqual(source[1].position, { x: -20, y: 58 });
  assert.strictEqual(spaceDirectorStoryboards(result), result, 'no repeat reflow or save loop');
  const saved = sanitizeCanvasNodesForPersistence(result);
  assert.deepEqual(saved.map(node => node.position), result.map(node => node.position));
  assert.deepEqual(saved[0].style, result[0].style);
  assert.deepEqual(saved[1].data, first.data);
  assert.strictEqual(spaceDirectorStoryboards(saved), saved, 'saved compact-group repair stays stable on reopen');
});

test('custom director positions and existing spacious groups are not automatically restacked', () => {
  const board: any = { id: 'board', position: { x: 100, y: 200 }, style: { width: 2000, height: 2000 }, data: { kind: 'group', storyboard: { version: 1 }, directorDocument: createDirectorDocument() } };
  const a = { ...frame(), position: { x: 100, y: 200 } }, b = { ...frame('second'), position: { x: 800, y: 200 } };
  const source = [board, a, b]; assert.strictEqual(spaceDirectorStoryboards(source), source);
  const ordinary = [{ ...board, data: { ...board.data, directorDocument: undefined }, style: { width: 540, height: 300 } }, frame()];
  assert.strictEqual(spaceDirectorStoryboards(ordinary), ordinary);
});

test('landscape, square and portrait frames reserve full media, and append never moves existing frames', () => {
  for (const aspect of ['16:9', '1:1', '9:16']) {
    const node = frame(); node.data.directorShotSource.shot = { ...captured, scene: { ...captured.scene, camera: { ...captured.scene.camera, aspect } } };
    const [w, h] = aspect.split(':').map(Number), size = storyboardNodeSize(node);
    assert.ok(size.width >= Math.min(560, 420 * w / h));
    assert.ok(size.height > Math.min(420, 560 * h / w) + 46);
    node.position = { x: 170, y: 900 };
    const snapshot = structuredClone(node);
    assert.equal(directorStoryboardAppendY([node]), 900 + size.height + 80);
    assert.deepEqual(node, snapshot);
  }
});

test('director export uses full bounds on both axes; entry-only repair uses normal history and save path', () => {
  const source = readFileSync(new URL('../src/CanvasSpike.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const exportDirectorShot =');
  const section = source.slice(start, source.indexOf('const createStoryboard', start));
  assert.match(section, /x: DIRECTOR_STORYBOARD_INSETS\.x, y: directorStoryboardAppendY\(members\)/);
  assert.match(section, /directorStoryboardBounds\(\[\.\.\.members, node\]\)/);
  assert.match(section, /width: Math\.max\(size\.width, bounds\.width\), height: Math\.max\(size\.height, bounds\.height\)/);
  assert.match(source, /if \(next !== source\) commitStoryboardNodes\(next\);[\s\S]*?\}, \[currentCanvasId, loadingCanvas, visible\]\)/);
  assert.match(source, /commitHistory\(\);markDirty\(\);nodesRef\.current=next;setNodes\(next\)/);
});
