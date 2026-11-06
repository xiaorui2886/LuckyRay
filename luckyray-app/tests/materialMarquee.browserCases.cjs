// Runs against the real MaterialsPage/store fixture, with trusted mouse input.
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async (page, out, fixtures) => {
  const host = page.locator('.masonry-container');
  const overlay = page.locator('.materials-marquee');
  const selected = () => page.locator('[data-asset-id].batch-selected').evaluateAll(cards => cards.map(card => card.dataset.assetId).sort());
  const clear = async () => { await host.focus(); await page.keyboard.press('Escape'); };
  const layout = async mode => {
    await clear();
    await page.evaluate(viewMode => window.dispatchEvent(new CustomEvent('luckyray:materials-toolbar-command', { detail: { type: 'set-view', viewMode } })), mode);
    await page.waitForFunction(mode => !!document.querySelector(mode === 'grid' ? '.grid-view-react' : mode === 'list' ? '.list-view-react' : '.masonry'), mode);
    await host.evaluate(el => { el.scrollTop = 0; });
  };
  const bounds = () => page.locator('[data-asset-id]').evaluateAll(cards => cards.map(card => {
    const r = card.getBoundingClientRect();
    return { id: card.dataset.assetId, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  const hit = (cards, start, end) => cards.filter(c => c.left < Math.max(start.x, end.x) && c.right > Math.min(start.x, end.x)
    && c.top < Math.max(start.y, end.y) && c.bottom > Math.min(start.y, end.y)).map(c => c.id).sort();
  const drag = async (start, end, keys = []) => {
    for (const key of keys) await page.keyboard.down(key);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.waitForTimeout(60);
    await page.mouse.up();
    for (const key of keys) await page.keyboard.up(key);
    await page.waitForTimeout(40);
  };
  const topDrag = async id => {
    const cards = await bounds();
    const card = cards.find(c => c.id === id);
    const container = await host.boundingBox();
    return { cards, start: { x: card.left + 10, y: container.y + 4 }, end: { x: card.right - 10, y: card.top + 35 } };
  };

  // Real layout hit tests: top whitespace, reverse direction and narrow gaps.
  for (const mode of ['masonry', 'grid', 'list']) {
    await layout(mode);
    const cards = await bounds();
    const first = cards.reduce((a, b) => a.top <= b.top ? a : b);
    const rect = await host.boundingBox();
    const start = { x: rect.x + 4, y: rect.y + 4 };
    const end = { x: first.right - 4, y: first.top + 35 };
    await drag(start, end);
    assert.deepEqual(await selected(), hit(cards, start, end), `${mode}: real card bounds select into existing batch mode`);
    assert.equal(await overlay.isVisible(), false, 'rectangle clears on release');
    assert.equal(await page.locator('.material-viewer-react').count(), 0, 'release over card does not open detail');
    await clear();
    const gapStart = { x: first.left - 5, y: first.top + 40 };
    const gapEnd = { x: first.right - 8, y: first.top + 8 };
    await drag(gapStart, gapEnd);
    assert.deepEqual(await selected(), hit(cards, gapStart, gapEnd), `${mode}: gap start and upward drag`);
  }

  await layout('grid');
  // Replace, additive and toggle semantics reuse the same selection/BatchBar.
  const ids = (await bounds()).slice(0, 2).map(c => c.id);
  const a = await topDrag(ids[0]);
  const b = await topDrag(ids[1]);
  await drag(a.start, a.end);
  assert.deepEqual(await selected(), [ids[0]]);
  await drag(b.start, b.end, ['Shift']);
  assert.deepEqual(await selected(), [...ids].sort(), 'Shift adds without dropping previous cards');
  await drag(a.start, a.end, ['Control']);
  assert.deepEqual(await selected(), [ids[1]], 'Ctrl toggles once against the initial selection');
  await drag(a.start, a.end);
  assert.deepEqual(await selected(), [ids[0]], 'plain drag replaces prior selection');
  await page.locator('.batch-bar-react.show').waitFor();

  // A click/small hand movement does not start a rectangle or clear selection.
  await drag(a.start, { x: a.start.x + 2, y: a.start.y + 2 });
  assert.deepEqual(await selected(), [ids[0]], 'movement threshold preserves clicks');
  // Escape restores the prior selection, instead of leaking into page shortcuts.
  await page.mouse.move(b.start.x, b.start.y); await page.mouse.down();
  await page.mouse.move(b.end.x, b.end.y, { steps: 5 });
  await overlay.waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(out, 'material-marquee-during-drag.png') });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual(await selected(), [ids[0]], 'Escape cancels only the current marquee');
  // Pointer cancellation/window deactivation also release capture and scrolling.
  await page.mouse.move(b.start.x, b.start.y); await page.mouse.down();
  await page.mouse.move(b.end.x, b.end.y, { steps: 5 });
  await overlay.waitFor({ state: 'visible' });
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
  assert.equal(await overlay.isVisible(), false);
  assert.deepEqual(await selected(), [ids[0]], 'deactivation restores original selection');

  await page.mouse.move(b.start.x, b.start.y); await page.mouse.down();
  await page.mouse.move(b.end.x, b.end.y, { steps: 5 });
  await overlay.waitFor({ state: 'visible' });
  const version = await page.evaluate(() => {
    const before = window.__store.getSnapshot().version;
    window.__setLive(window.__store.getSnapshot().assets.map(asset => ({ ...asset })));
    return before;
  });
  await page.waitForFunction(before => window.__store.getSnapshot().version > before && window.__store.getSnapshot().status === 'ready', version);
  assert.ok(await overlay.isVisible(), 'same-list background refresh does not interrupt a held gesture');
  await page.mouse.up();
  assert.deepEqual(await selected(), [ids[1]]);

  // Existing checkbox, card detail, context menu and native dragging are intact.
  await clear();
  await page.locator('[data-asset-id="img1"] .batch-checkbox-react').click();
  assert.deepEqual(await selected(), ['img1']);
  await clear();
  await page.locator('[data-asset-id="img1"]').click();
  await page.locator('.material-viewer-react.detail').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.material-viewer-react'));
  await page.locator('[data-asset-id="img2"]').click({ button: 'right' });
  await page.locator('[data-material-context-action="compare"]').waitFor();
  assert.equal(await overlay.isVisible(), false, 'right-click never starts marquee');
  await page.keyboard.press('Escape');
  // More synthetic cards exercise scrolling with a content-anchored rectangle.
  await page.evaluate(images => window.__setLive(Array.from({ length: 65 }, (_, i) => ({ ...images[i % images.length], id: `scroll-${i}`, name: `fixture-${i}.png` }))), fixtures.images);
  await page.waitForFunction(() => document.querySelectorAll('[data-asset-id]').length === 65);
  await clear();
  const scrollRect = await host.boundingBox();
  const scrollStart = { x: scrollRect.x + 4, y: scrollRect.y + 4 };
  await page.mouse.move(scrollStart.x, scrollStart.y); await page.mouse.down();
  await page.mouse.move(scrollRect.x + scrollRect.width - 8, scrollRect.y + scrollRect.height - 4, { steps: 12 });
  await page.waitForFunction(() => document.querySelector('.masonry-container').scrollTop > 100, undefined, { timeout: 5000 });
  assert.ok((await selected()).length > 5, 'edge scrolling adds newly crossed rows');
  await page.mouse.up();
  const afterScroll = await host.evaluate(el => el.scrollTop);
  await page.waitForTimeout(100);
  assert.equal(await host.evaluate(el => el.scrollTop), afterScroll, 'scrolling stops on release');

  // A folder change retires an active gesture; old selection cannot be restored
  // into the new listing by a late Escape, pointerup or animation frame.
  await host.evaluate(el => { el.scrollTop = 0; }); await clear();
  await page.mouse.move(scrollStart.x, scrollStart.y); await page.mouse.down();
  await page.mouse.move(scrollStart.x + 150, scrollStart.y + 100, { steps: 5 });
  await overlay.waitFor({ state: 'visible' });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:folder-select', { detail: { scope: 'materials', folderId: 'folder-a' } })));
  await page.waitForFunction(() => window.__toolbarState?.folderName === 'Project A');
  await page.mouse.up();
  assert.equal(await overlay.isVisible(), false, 'scope change releases the old rectangle');
  const selectionAtChange = await selected();
  await page.waitForTimeout(100);
  assert.deepEqual(await selected(), selectionAtChange, 'no stale animation-frame writes after navigation');
  assert.equal(await page.evaluate(() => document.querySelector('.masonry-container').classList.contains('materials-marquee-active')), false);

  // Native-drag handoff is last: the headless CDP session cannot complete an
  // operating-system drag loop. Only its existing IPC route is mocked here.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:folder-select', { detail: { scope: 'materials', folderId: null } })));
  await page.waitForFunction(() => document.querySelectorAll('[data-asset-id]').length === 65);
  await page.evaluate(() => {
    const card = document.querySelector('[data-asset-id]');
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 81, isPrimary: true, pointerType: 'mouse', button: 0, buttons: 1, clientX: r.x + 20, clientY: r.y + 20 }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 81, isPrimary: true, pointerType: 'mouse', buttons: 1, clientX: r.x + 45, clientY: r.y + 25 }));
  });
  await page.waitForFunction(() => window.__calls.includes('material_catalog_begin_external_drag'));
  assert.equal(await overlay.isVisible(), false, 'card drag retains its native export path');
  console.log('MATERIAL-MARQUEE-REAL-PAGE-OK: 3 layouts, modifiers, cancel, scroll, scope and existing card gestures');
};
