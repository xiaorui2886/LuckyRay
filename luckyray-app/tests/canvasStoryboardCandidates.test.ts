import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultShot, shotPreview, validShot } from '../src/core/canvas/storyboard';
import { storyboardCandidates, adoptStoryboardCandidate, clearStoryboardChoice } from '../src/core/canvas/storyboardCandidates';
import { sanitizeCanvasNodesForPersistence } from '../src/features/canvas/canvasPersistence';
const board = (id = 'b'): any => ({ id, data: { kind: 'group', storyboard: { version: 1 } } });
const shot = (id = 's', parentId = 'b'): any => ({ id, parentId, data: { kind: 'generator', generationKind: 'image', generationPrompt: 'untouched', generationReferences: [{ id: 'ref' }], storyboardShot: defaultShot(0) } });
const entry = (taskId: string, sourceNodeId: string, parentTaskId?: string, extra = {}): any => ({ id: `h:${taskId}`, taskId, sourceNodeId, resultNodeId: `result:${taskId}`, parentTaskId, status: 'succeeded', kind: 'image', outputMediaUrl: `/${taskId}.png`, ...extra });
test('exact lineage includes nested forks, excludes unrelated, siblings, foreign shots and boards', () => {
  const s = shot(); s.data.sourceGenerationTaskId = 'branch';
  const h = [entry('ancestor', 'outside'), entry('branch', 'outside', 'ancestor'), entry('sibling', 'outside', 'ancestor'), entry('descendant', 'fork', 'branch'), entry('nested', 'fork2', 'descendant'), entry('other-shot', 's2', 'branch'), entry('other-board', 's3', 'branch'), entry('random', 'same title')];
  assert.deepEqual(storyboardCandidates([board(), s, shot('s2'), board('b2'), shot('s3', 'b2')], h, 'b', 's').candidates.map(c => c.taskId), ['branch', 'descendant', 'nested']);
});
test('multi-item outputs and local materials dedupe within shot, not across shots', () => {
  const s = shot(); s.data.refMediaUrl = '/material.png'; s.data.resultMediaItems = [{ url: '/local.png' }];
  const h = [entry('t', 's', undefined, { outputMediaUrl: '/a.png', outputMediaItems: [{ url: '/a.png' }, { url: '/b.png' }, { url: '/b.png' }] })];
  const nodes = [board(), s, { ...shot('s2'), data: { ...shot().data, refMediaUrl: '/a.png' } }];
  assert.deepEqual(storyboardCandidates(nodes, h, 'b', 's').candidates.map(c => c.url), ['/a.png', '/b.png', '/local.png', '/material.png']);
  assert.equal(storyboardCandidates(nodes, h, 'b', 's2').candidates[0].url, '/a.png');
});
test('pending/failed results cannot be selected; live descendant tasks are separate from selected preview', () => {
  const s = shot();
  const h = [entry('done', 's'), entry('pending', 'fork', 'done', { status: 'queued' }), entry('failed', 'fork', 'done', { status: 'failed' })];
  const live: any = { id: 'running-node', data: { kind: 'generator', generationTask: { id: 'live', sourceNodeId: 'fork', parentTaskId: 'done', status: 'running' }, resultMediaUrl: '/partial.png' } };
  const state = storyboardCandidates([board(), s, live], h, 'b', 's');
  assert.deepEqual(state.candidates.map(c => c.taskId), ['done']);
  assert.deepEqual(state.activeTaskIds, ['pending', 'live']);
  assert.throws(() => adoptStoryboardCandidate([board(), s], h, 'b', 's', '/attacker.png'));
  assert.throws(() => adoptStoryboardCandidate([board(), s], h, 'b', 's', JSON.stringify(['s','image','/failed.png'])));
});
test('adoption only changes snapshot metadata, persists, survives cleanup and new generation, clear restores live', () => {
  const s = shot(); s.data.resultMediaUrl = '/live.png';
  const nodes = [board(), s], h = [entry('old', 's')];
  const c = storyboardCandidates(nodes, h, 'b', 's').candidates[0];
  const next = adoptStoryboardCandidate(nodes, h, 'b', 's', c.key, '2026-10-17T00:00:00Z');
  const expected = structuredClone(s); expected.data.storyboardShot.chosenResult = { key: c.key, kind: c.kind, url: c.url, taskId: c.taskId, historyId: c.historyId, thumbnailUrl: undefined, selectedAt: '2026-10-17T00:00:00Z' };
  assert.deepEqual(next[1], expected); assert.equal(next[0], nodes[0]); assert.equal(s.data.storyboardShot.chosenResult, undefined);
  const persisted = JSON.parse(JSON.stringify(sanitizeCanvasNodesForPersistence(next)));
  assert.equal(validShot(persisted[1].data.storyboardShot), true);
  assert.equal(shotPreview(persisted[1]), '/old.png');
  assert.equal(storyboardCandidates(persisted, [], 'b', 's').candidates.find(c => c.source === 'chosen')?.url, '/old.png');
  persisted[1].data.resultMediaUrl = '/new.png';
  assert.equal(shotPreview(persisted[1]), '/old.png');
  assert.equal(shotPreview(clearStoryboardChoice(persisted, 'b', 's')[1]), '/new.png');
});
test('video choice uses only poster and empty poster never becomes a movie image', () => {
  const s = shot(); const h = [entry('video', 's', undefined, { kind: 'video', outputMediaUrl: '/movie.mp4', outputThumbnailUrl: '/poster.png' })];
  const c = storyboardCandidates([board(), s], h, 'b', 's').candidates[0];
  const next = adoptStoryboardCandidate([board(), s], h, 'b', 's', c.key);
  assert.equal(shotPreview(next[1]), '/poster.png');
  delete next[1].data.storyboardShot.chosenResult.thumbnailUrl;
  assert.equal(shotPreview(next[1]), '');
});
test('current failed tasks do not expose partial result and task status overrides stale history', () => {
  const s = shot(); s.data.generationTask = { id: 't', status: 'failed' }; s.data.resultMediaUrl = '/partial.png';
  assert.deepEqual(storyboardCandidates([board(), s], [entry('t', 's')], 'b', 's').candidates, []);
});
test('invalid board and over-limit board do not permit adoption', () => {
  const nodes = [board(), ...Array.from({ length: 65 }, (_, i) => shot(`s${i}`))];
  assert.deepEqual(storyboardCandidates(nodes, [], 'b', 's0'), { candidates: [], activeTaskIds: [] });
  assert.throws(() => clearStoryboardChoice(nodes, 'missing', 's0'));
});
test('chosen descendant provenance keeps future forks discoverable after history cleanup', () => {
  const s = shot(); const h = [entry('root', 's'), entry('chosen', 'fork', 'root')];
  const c = storyboardCandidates([board(), s], h, 'b', 's').candidates.find(c => c.taskId === 'chosen')!;
  const next = adoptStoryboardCandidate([board(), s], h, 'b', 's', c.key);
  const state = storyboardCandidates(next, [entry('future', 'new-fork', 'chosen', { status: 'running' })], 'b', 's');
  assert.deepEqual(state.activeTaskIds, ['future']);
  assert.equal(shotPreview(next[1]), '/chosen.png');
});
test('production reroll copies shot metadata into an unparented fork; it remains a candidate and busy descendant', () => {
  const s = shot(); s.data.generationTask = { id: 'root', sourceNodeId: 's', resultNodeId: 's', status: 'succeeded' };
  const fork: any = { id: 'fork', data: { ...s.data, generationTask: { id: 'reroll', parentTaskId: 'root', sourceNodeId: 'fork', resultNodeId: 'fork', status: 'running' }, sourceGenerationTaskId: 'root', sourceGenerationHistoryId: 'h:root' } };
  const nodes = [board(), s, fork];
  assert.deepEqual(storyboardCandidates(nodes, [entry('root', 's')], 'b', 's').activeTaskIds, ['reroll']);
  fork.data.generationTask.status = 'succeeded'; fork.data.resultMediaUrl = '/reroll.png';
  const history = [entry('root', 's'), entry('reroll', 'fork', 'root', { resultNodeId: 'fork', outputMediaUrl: '/reroll.png' })];
  assert.deepEqual(storyboardCandidates(nodes, history, 'b', 's').candidates.map(c => c.url), ['/root.png', '/reroll.png']);
});
test('duplicated shot metadata and provenance cannot pull another actively owned shot task lineage', () => {
  const original = shot(); original.data.generationTask = { id: 'root', sourceNodeId: 's', resultNodeId: 's', status: 'succeeded' };
  const duplicate: any = { ...original, id: 'duplicate', parentId: 'b2', data: { ...original.data, sourceGenerationTaskId: 'root', sourceGenerationHistoryId: 'h:root', refMediaUrl: '/shared-current.png' } };
  const nodes = [board(), original, board('b2'), duplicate];
  const history = [entry('root', 's', undefined, { resultNodeId: 's' }), entry('child', 'fork', 'root')];
  assert.deepEqual(storyboardCandidates(nodes, history, 'b2', 'duplicate').candidates.map(c => c.url), ['/shared-current.png']);
});
