import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTaskContext } from '../src/core/canvas/agent/contextSelection.ts';

const node = (id: string, parentId?: string) => ({ id, title: id, text: `full source for ${id}`, kind: 'text', ...(parentId ? { parentId } : {}) });
test('task target beyond 256 plus parent, child and reference neighbors outrank arbitrary order', () => {
  const nodes = [...Array.from({ length: 600 }, (_, i) => node(`n${i}`)), node('parent'), node('target', 'parent'), node('child', 'target'), node('reference')];
  const edges = [{ source: 'target', target: 'reference' }];
  const selected = selectTaskContext(nodes, edges, { targetNodeIds: ['target'], maxNodes: 4 });
  assert.deepEqual(selected.nodeIds, ['target', 'child', 'parent', 'reference']);
  assert.equal(selected.overview.length, 604); assert.equal(selected.coverage.omittedNodes, 600);
  assert.equal(selected.coverage.complete, false); assert.equal(selected.overview.find(n => n.id === 'n599')?.fullTextIncluded, false);
  assert.deepEqual(selectTaskContext([...nodes].reverse(), edges, { targetNodeIds: ['target'], maxNodes: 4 }).nodeIds, selected.nodeIds);
});
test('selection and explicit references are never silently clipped by working-set budget', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const result = selectTaskContext(nodes, [], { targetNodeIds: ['a'], selectedNodeIds: ['b'], referenceNodeIds: ['c', 'missing'], maxNodes: 1 });
  assert.deepEqual(result.nodeIds, ['a', 'b', 'c']); assert.deepEqual(result.coverage.missingNodeIds, ['missing']);
  assert.equal(result.coverage.transportBudgetExceeded, true);
});
test('full read returns all source bodies; lightweight overview never substitutes full text', () => {
  const nodes = [node('a'), node('b')];
  const result = selectTaskContext(nodes, [], { maxNodes: 1, full: true });
  assert.deepEqual(result.nodes, nodes); assert.equal(result.coverage.complete, true);
  assert.equal(Object.hasOwn(result.overview[0], 'text'), false);
  assert.match(result.coverage.notice, /not evidence/);
});
test('selection is read-only and reports omitted relationships and missing targets', () => {
  const nodes = [node('a'), node('b'), node('c')]; const before = JSON.stringify(nodes);
  const result = selectTaskContext(nodes, [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }], { targetNodeIds: ['absent'], maxNodes: 1 });
  assert.deepEqual(result.coverage.missingNodeIds, ['absent']); assert.equal(result.coverage.omittedConnections, 2);
  assert.equal(JSON.stringify(nodes), before);
  assert.throws(() => selectTaskContext(nodes, [], { maxNodes: 0 }), /invalid-budget/);
});
