import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Canvas intake keeps Main durable quit registration and task guards', () => {
  const source = read('src/CanvasSpike.tsx');
  assert.match(source, /registerWorkspaceFlush\(\(\) => quitFlushRef.current\(\)\)/);
  assert.match(source, /quitFlushRef.current = \(\) => flushCanvasBeforeQuit/);
  assert.match(source, /writing: saveSlotRef.current.occupied/);
  assert.match(source, /saved: lastSavedGenerationRef.current/);
  assert.match(source, /canvasTaskSaveQueuesRef.current.size > 0/);
  assert.match(source, /runningGenerationTaskIdsRef.current.size > 0/);
  assert.match(source, /loadingCanvas \|\| groupDragging/);
  assert.match(source, /canvasAgent.busy \|\| canvasAgentExecution\?\.status === 'running'/);
});

test('native media preserves profile-change errors and refuses unbound resumed jobs', () => {
  const source = read('src-tauri/src/lib.rs');
  for (const kind of ['image', 'video']) {
    const start = source.indexOf(`async fn ai_${kind}_generate_with_binding(`);
    assert.ok(start > 0);
    const body = source.slice(start, source.indexOf('\nasync fn ', start + 1));
    assert.match(body, new RegExp(`Err\\("canvas-media-profile-changed" \\| "canvas-media-profile-missing"\\) => return Ok\\(ai_${kind}_failure\\("profile_changed"\\)\\)`));
  }
  assert.match(source, /request.provider_task_id.as_deref\(\).is_some_and\(\|id\| !id.is_empty\(\)\) && profile_id.is_none\(\)/);
});

test('Main DSH restart confirmation remains awaited and explicit', () => {
  const source = read('src/features/settings/DshEngineUpdateCard.tsx');
  assert.match(source, /await confirm\(/);
  assert.match(source, /approved !== true/);
  assert.doesNotMatch(source, /window.confirm\(/);
});
