import assert from 'node:assert/strict';
import test from 'node:test';
import { VaultFileChangeQueue, markdownContentChanges } from '../src/core/services/vaultFileChanges.ts';

test('ordinary Markdown modifies are content hints; rename, mixed and overflow remain reconciliation', () => {
  const batch = { vaultId:'v',rootPath:'C:/v',session:1,generation:1,observations:[{paths:['C:/v/a.md'],type:{modify:{kind:'any'}}}],reconcileRequired:false };
  assert.deepEqual(markdownContentChanges(batch),['C:/v/a.md']);
  for (const type of [{modify:{kind:'rename'}},{create:{}},{remove:{}},null]) assert.equal(markdownContentChanges({...batch,observations:[{paths:['C:/v/a.md'],type}]}),null);
  assert.equal(markdownContentChanges({...batch,reconcileRequired:true}),null);
  assert.equal(markdownContentChanges({...batch,observations:[...batch.observations,{paths:['C:/v/image.png'],type:{modify:{kind:'any'}}}]}),null);
});

test('continuous events cannot postpone a batch indefinitely', () => {
  const queue = new VaultFileChangeQueue();
  queue.add({ paths: ['a.png'], type: { modify: { kind: 'data' } } }, 0);
  queue.add({ paths: ['b.png'], type: { modify: { kind: 'data' } } }, 1900);
  assert.equal(queue.delay(1900), 100);
  assert.equal(queue.delay(2100), 0);
  assert.equal(queue.drain().observations.length, 2);
  queue.add(null, 3000);
  assert.equal(queue.delay(3000), 720);
  assert.equal(queue.drain().reconcileRequired, true);
});

test('event and memory overflow require reconciliation; complete batches keep exact rename facts', () => {
  const queue = new VaultFileChangeQueue();
  const event = { paths: ['old.png', 'new.png'], type: { modify: { kind: 'rename', mode: 'both' } } };
  queue.add(event, 0);
  event.paths[0] = 'mutated.png';
  assert.equal(queue.drain().observations[0].paths[0], 'old.png');
  for (let i = 0; i < 300; i++) queue.add({ paths: [`${i}.png`], type: 'any' }, i);
  const batch = queue.drain();
  assert.equal(batch.observations.length, 256);
  assert.equal(batch.reconcileRequired, true);
  queue.add({ paths: ['x'.repeat(128 * 1024)], type: 'any' }, 0);
  assert.deepEqual(queue.drain(), { observations: [], reconcileRequired: true });
  assert.deepEqual(queue.drain(), { observations: [], reconcileRequired: false });
});
