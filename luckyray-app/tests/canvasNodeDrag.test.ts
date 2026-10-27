import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCanvasNodeDragHandle, CANVAS_GENERATOR_DRAG_HANDLE } from '../src/core/canvas/nodeDrag.ts';
import type { CanvasNodeKind } from '../src/core/canvas/nodeCapabilities.ts';

test('persisted Agent content nodes recover body dragging, preserving content and refs', () => {
  for (const kind of ['text', 'image', 'video', 'noteRef', 'aiPrompt', 'aiResult'] as CanvasNodeKind[]) {
    const node = {id:kind, data:{kind,label:'long text '.repeat(400),generationReferences:[{id:'source'}]},position:{x:40,y:80},dragHandle:CANVAS_GENERATOR_DRAG_HANDLE};
    const restored = normalizeCanvasNodeDragHandle(JSON.parse(JSON.stringify(node)));
    assert.equal(restored.dragHandle, undefined);
    assert.deepEqual(restored.data, node.data);
    assert.deepEqual(restored.position, node.position);
    assert.equal(node.dragHandle, CANVAS_GENERATOR_DRAG_HANDLE);
  }
});
test('ordinary content and custom handles remain unchanged', () => {
  for (const kind of ['text','image','video','noteRef','group'] as CanvasNodeKind[]) {
    const node = {data:{kind}};
    assert.equal(normalizeCanvasNodeDragHandle(node),node);
    const custom = {...node,dragHandle:'.custom-handle'};
    assert.equal(normalizeCanvasNodeDragHandle(custom),custom);
  }
});
test('image/video generator handles are canonical; groups retain their own header', () => {
  for (const generationKind of ['image','video']) {
    const node = {data:{kind:'generator' as const,generationKind},dragHandle:undefined};
    assert.equal(normalizeCanvasNodeDragHandle(node).dragHandle,CANVAS_GENERATOR_DRAG_HANDLE);
  }
  const group = {data:{kind:'group' as const},dragHandle:'.canvas-group-drag-handle'};
  assert.equal(normalizeCanvasNodeDragHandle(group),group);
});
