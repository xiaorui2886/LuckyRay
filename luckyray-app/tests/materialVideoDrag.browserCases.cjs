const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async (page, out) => {
  const host = page.locator('.masonry-container');
  const card = page.locator('[data-asset-id="vid1"]');
  const video = card.locator('.hover-video-wrap-react video');
  const count = () => page.evaluate(() => window.__drags.length);
  const drag = async locator => {
    const box = await locator.boundingBox();
    const start = { x: box.x + box.width * .4, y: box.y + box.height * .4 };
    const target = await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.tagName, start);
    const before = await count();
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 28, start.y + 5, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(60);
    assert.equal(await count(), before + 1, `drag starts existing native file transport; hit=${target}`);
    assert.equal(await page.locator('.materials-marquee').isVisible(), false, 'card drag does not start marquee');
    assert.equal(await page.locator('.material-viewer-react').count(), 0, 'drag release does not open detail');
  };
  for (const viewMode of ['masonry', 'grid', 'list']) {
    await page.evaluate(viewMode => window.dispatchEvent(new CustomEvent('luckyray:materials-toolbar-command', { detail: { type: 'set-view', viewMode } })), viewMode);
    await page.waitForFunction(mode => !!document.querySelector(mode === 'grid' ? '.grid-view-react' : mode === 'list' ? '.list-view-react' : '.masonry'), viewMode);
    await card.scrollIntoViewIfNeeded();
    await video.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-asset-id="vid1"] video')?.videoWidth > 0, undefined, { timeout: 7000 }).catch(async error => {
      console.error('VIDEO-FIXTURE', await video.evaluate(el => ({ ready: el.readyState, network: el.networkState, error: el.error?.code, source: el.src.split(':')[0], clip: window.__clipInfo })));
      throw error;
    });
    assert.equal(await video.evaluate(el => el.controls), false, 'hover video is a decoration, not a player control');
    await drag(card.locator('.hover-video-wrap-react'));
    assert.deepEqual(await page.evaluate(() => window.__drags.at(-1)), { assetIds: ['vid1'], libraryId: 'fixture-library' });
    // This is the same service used by AppSidebar's native folder-tree drop.
    const moved = await page.evaluate(() => window.__moveActiveToFolder('folder-a'));
    assert.deepEqual(moved, { moved: 1, total: 1 });
    assert.deepEqual(await page.evaluate(() => window.__moves.at(-1)), { id: 'vid1', folderId: 'folder-a', libraryId: 'fixture-library' });
    await host.focus(); await page.keyboard.press('Escape');
  }
  // Existing hover scrubbing still reaches its wrapper after hit-testing fix.
  const box = await card.locator('.hover-video-wrap-react').boundingBox();
  await page.mouse.move(box.x + box.width * .15, box.y + box.height * .5);
  const left = await card.locator('.hover-video-progress-react span').evaluate(el => parseFloat(el.style.width));
  await page.mouse.move(box.x + box.width * .85, box.y + box.height * .5);
  const right = await card.locator('.hover-video-progress-react span').evaluate(el => parseFloat(el.style.width));
  assert.ok(right > left + 40, 'hover scrub follows pointer across the preview');
  // Mixed batch selection must keep both identities when dragged from video.
  await card.locator('.batch-checkbox-react').click();
  await page.locator('[data-asset-id="img1"] .batch-checkbox-react').click();
  await drag(card.locator('.hover-video-wrap-react'));
  assert.deepEqual((await page.evaluate(() => window.__drags.at(-1))).assetIds.sort(), ['img1', 'vid1']);
  const movedBatch = await page.evaluate(() => window.__moveActiveToFolder('folder-a'));
  assert.deepEqual(movedBatch, { moved: 2, total: 2 });
  await page.screenshot({ path: path.join(out, 'video-drag-selection.png') });
  console.log('MATERIAL-VIDEO-DRAG-OK: actual decoded preview hit testing, 3 layouts, native IPC, folder move service, scrub and mixed batch');
};
