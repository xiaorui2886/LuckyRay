import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleAttachmentPrefetch, setAttachmentWarmFunction } from '../src/features/notes/media/attachmentPrefetch.ts';

test('releasing old in-flight work advances only the latest queue within four slots', async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  let active = 0, peak = 0;
  setAttachmentWarmFunction(async url => {
    started.push(url);
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => releases.set(url, resolve));
    active--;
    if (url === 'old1') throw new Error('decode failed');
    return true;
  });
  const schedule = (urls: string[]) => scheduleAttachmentPrefetch(urls.map(url => ({ url, kind: 'image' })), () => true);
  schedule(['old0', 'old1', 'old2', 'old3', 'discard-old']);
  schedule(['discard-middle']);
  schedule(['new0', 'new1']);
  assert.deepEqual(started, ['old0', 'old1', 'old2', 'old3']);
  for (const key of ['old0', 'old1', 'old2', 'old3']) releases.get(key)!();
  await new Promise(resolve => setTimeout(resolve, 20));
  try {
    assert.deepEqual(started, ['old0', 'old1', 'old2', 'old3', 'new0', 'new1']);
    assert.ok(peak <= 4);
  } finally {
    for (const release of releases.values()) release();
    scheduleAttachmentPrefetch([], () => false);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
});
