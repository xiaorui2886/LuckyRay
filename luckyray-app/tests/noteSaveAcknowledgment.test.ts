import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeNoteSave, shouldPauseConflictAutosave } from '../src/features/notes/noteSaveAcknowledgment.ts';

test('self-save is already baseline when watcher/native views are notified', () => {
  const baselines = new Map([['note', 'before']]);
  let observation = '';
  acknowledgeNoteSave(baselines, 'note', '![[attachments/image.png]]', {contentText:'![[attachments/image.png]]',revision:'r2'}, () => true, () => {
    observation = baselines.get('note')!;
  });
  assert.equal(observation, '![[attachments/image.png]]');
});
test('late old-vault acknowledgement cannot update a new source baseline or notify views', () => {
  const baselines = new Map([['note', 'current']]);
  let notified = false;
  assert.throws(() => acknowledgeNoteSave(baselines,'note','old',{contentText:'old',revision:'r'},() => false,() => {notified=true;}));
  assert.equal(baselines.get('note'),'current'); assert.equal(notified,false);
});
test('missing revision or different returned content is not an acknowledged write', () => {
  const baselines = new Map([['note','before']]);
  for (const saved of [{contentText:'next'}, {contentText:'other',revision:'r'}]) {
    assert.throws(() => acknowledgeNoteSave(baselines,'note','next',saved,() => true,() => assert.fail()));
    assert.equal(baselines.get('note'),'before');
  }
});
test('real external conflict pauses noisy autosave, but not explicit save or other notes', () => {
  assert.equal(shouldPauseConflictAutosave('user-edit-autosave','a','a',new Set()),true);
  assert.equal(shouldPauseConflictAutosave('user-edit-autosave','a',undefined,new Set(['a'])),true);
  assert.equal(shouldPauseConflictAutosave('explicit-save','a','a',new Set(['a'])),false);
  assert.equal(shouldPauseConflictAutosave('user-edit-autosave','b','a',new Set(['a'])),false);
});

import { NoteDocumentReadCoordinator } from '../src/features/notes/noteDocumentReadCoordinator.ts';
test('watcher burst waits for save acknowledgement and collapses queued work', async () => {
  const coordinator = new NoteDocumentReadCoordinator();
  const baselines = new Map([['note', 'before']]);
  let finish!: () => void;
  const save = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  const read = async () => { await save; reads++; assert.equal(baselines.get('note'),'after'); };
  const running = coordinator.requestExternalCheck(read);
  await Promise.resolve();
  for (let i=0;i<100;i++) coordinator.requestExternalCheck(read);
  acknowledgeNoteSave(baselines,'note','after',{contentText:'after',revision:'r2'},() => true,() => {});
  finish(); await running;
  assert.equal(reads,2);
});
