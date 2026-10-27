import test from 'node:test';
import assert from 'node:assert/strict';
import { readKnowledgeScopeTransition, confirmKnowledgeScopeRead, withKnowledgeScopeTransition } from '../src/core/services/knowledgeScopeTransition.ts';

test('pending native switch fences presentation before editor source changes', async () => {
  confirmKnowledgeScopeRead('old', readKnowledgeScopeTransition().generation);
  const oldGeneration = readKnowledgeScopeTransition().generation;
  let complete!: (value: string) => void;
  const pending = withKnowledgeScopeTransition(() => new Promise<string>(resolve => { complete = resolve; }), value => value);
  assert.equal(readKnowledgeScopeTransition().pending, 1);
  confirmKnowledgeScopeRead('stale-read', oldGeneration);
  assert.equal(readKnowledgeScopeTransition().confirmedVaultId, 'old');
  complete('new');
  await pending;
  assert.equal(readKnowledgeScopeTransition().pending, 0);
  assert.equal(readKnowledgeScopeTransition().confirmedVaultId, 'new');
  assert.notEqual(readKnowledgeScopeTransition().generation, oldGeneration);
});

test('uncertain IPC failure stays fenced until a fresh authoritative read', async () => {
  await assert.rejects(withKnowledgeScopeTransition(async () => { throw Error('lost response'); }, () => 'unused'));
  assert.equal(readKnowledgeScopeTransition().uncertain, true);
  assert.equal(readKnowledgeScopeTransition().pending, 0);
  confirmKnowledgeScopeRead('confirmed', readKnowledgeScopeTransition().generation);
  assert.equal(readKnowledgeScopeTransition().uncertain, false);
  assert.equal(readKnowledgeScopeTransition().confirmedVaultId, 'confirmed');
});

test('overlapping switch responses remain uncertain until native selection is reread', async () => {
  let firstDone!: (value: string) => void;
  let secondDone!: (value: string) => void;
  const first = withKnowledgeScopeTransition(() => new Promise<string>(resolve => { firstDone = resolve; }), value => value);
  const second = withKnowledgeScopeTransition(() => new Promise<string>(resolve => { secondDone = resolve; }), value => value);
  secondDone('second'); await second;
  assert.equal(readKnowledgeScopeTransition().pending, 1);
  firstDone('first'); await first;
  assert.equal(readKnowledgeScopeTransition().pending, 0);
  assert.equal(readKnowledgeScopeTransition().uncertain, true);
  confirmKnowledgeScopeRead('actual', readKnowledgeScopeTransition().generation);
  assert.equal(readKnowledgeScopeTransition().confirmedVaultId, 'actual');
  assert.equal(readKnowledgeScopeTransition().uncertain, false);
});
