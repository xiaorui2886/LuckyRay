// REAL MaterialsPage consumer verification (MATERIAL-VIEW-COMPARE-R1 R4/R5).
// The actual page component with its material store fed by a synthetic
// bridge — verifying preset switching (view/zoom/info differences, general
// snapshot/restore) and the compare entry predicate (pure-2–4-images vs
// mixed selection) on production wiring, not a bare Switcher.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
    'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright',
);
const out = process.env.LUCKYRAY_EVIDENCE_DIR || path.join(root, '.tmp-materials-page');

const svg = (color, w, h, label) =>
  'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><text x="8" y="28" font-size="20" fill="#fff">${label}</text></svg>`
  );

const fixtures = {
  images: [
    { id: 'img1', name: 'red.png', kind: 'image', mimeType: 'image/png', sizeBytes: 1000, thumbnailUrl: svg('#a33', 400, 300, 'R'), previewUrl: svg('#a33', 1600, 1200, 'R'), dominantColor: '#a33a33', folderId: null, storageMode: 'linked', importedAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 'img2', name: 'blue.png', kind: 'image', mimeType: 'image/png', sizeBytes: 1200, thumbnailUrl: svg('#36a', 300, 400, 'B'), previewUrl: svg('#36a', 800, 1600, 'B'), dominantColor: '#3666aa', folderId: 'folder-a', storageMode: 'linked', importedAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 'img3', name: 'green.png', kind: 'image', mimeType: 'image/jpeg', sizeBytes: 900, thumbnailUrl: svg('#3a6', 400, 400, 'G'), previewUrl: svg('#3a6', 400, 400, 'G'), dominantColor: '#33aa66', folderId: null, storageMode: 'managed', importedAt: '2026-08-20T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  ],
  video: { id: 'vid1', name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 900000, thumbnailUrl: svg('#777', 400, 300, 'V'), previewUrl: '', dominantColor: null, folderId: null, storageMode: 'linked', importedAt: '2026-09-04T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  video2: { id: 'vid2', name: 'old-clip.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 400000, thumbnailUrl: svg('#666', 400, 300, 'W'), previewUrl: '', dominantColor: null, folderId: null, storageMode: 'linked', importedAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' },
};

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const appStubPlugin = {
    name: 'luckyray-app-stub',
    setup(build) {
      build.onResolve({ filter: /\.\/App$/ }, (args) => {
        if (args.importer.endsWith('luckyrayBridge.ts')) {
          return { path: 'stub-app', namespace: 'appstub' };
        }
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: 'appstub' }, () => ({
        contents: "export function buildLuckyRayBridge() { return window.__LUCKYRAY__; }",
        loader: 'js',
      }));
    },
  };
  await esbuild.build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/App.css';
    import './src/app/appShell.css';
    import './src/core/theme/themeTokens.css';
    import './src/features/materials/materials.css';
    import { I18nProvider } from './src/core/i18n/index';
    import MaterialsPage from './src/features/materials/MaterialsPage';
    import { materialStore } from './src/core/services/materialStore';
    const fixtures = ${JSON.stringify(fixtures)};
    let live = [fixtures.video, ...fixtures.images, fixtures.video2];
    let folders = [{ id: 'folder-a', name: 'Project A', parentId: null, children: [] }];
    window.__setLive = (next) => { live = next; materialStore.invalidate({ reason: 'fixture-change', resync: true }); window.dispatchEvent(new CustomEvent('luckyray:materials-data-changed')); };
    window.__renameFolder = (name) => { folders = [{ ...folders[0], name }]; materialStore.invalidate({ reason: 'fixture-folder-rename', resync: true }); window.dispatchEvent(new CustomEvent('luckyray:materials-folders-changed', { detail: { scope: 'materials' } })); };
    window.__toolbarState = null;
    window.addEventListener('luckyray:materials-toolbar-state', event => { window.__toolbarState = event.detail; });
    window.__calls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.__calls.push(String(command));
      if (command === 'list_material_assets') return structuredClone(live);
      if (command === 'list_favorite_items' || command === 'material_catalog_list_note_attachments') return [];
      if (command === 'favorite_item_counts' || command === 'get_favorite_item_counts') return { material: 0, note: 0 };
      if (command === 'get_local_transport_client_config') return { baseUrl: 'http://127.0.0.1:1', credential: '' };
      if (command === 'material_catalog_attachment_details') return { referenceCount: 0, references: [], ordinary: true, absolutePath: '' };
      if (String(command).includes('event')) return 0;
      void args;
      return [];
    } };
    window.fetch = async () => new Response(JSON.stringify({ capabilities: [] }), { headers: { 'Content-Type': 'application/json' } });
    // The page's store reads window.__LUCKYRAY__ synchronously. A deep async
    // proxy supplies safe defaults for every bridge surface; the materials
    // list is overridden with the live fixture set.
    const fixtureBridge = {
      listAssets: async () => structuredClone(live),
      listAssetsFiltered: async () => structuredClone(live),
      listFolders: async () => structuredClone(folders),
      getAssetsByIds: async (ids) => structuredClone(live.filter(a => ids.includes(a.id))),
      getMaterialChangeState: async () => null,
      listFavoriteItems: async () => [],
      getFavoriteItemCounts: async () => ({ material: 0, note: 0 }),
      addFavoriteItem: async (type, id) => ({ itemType: type, itemId: id, label: id }),
      removeFavoriteItem: async () => {},
      listVaults: async () => [],
      getCollectionServerBaseUrl: async () => null,
    };
    window.__LUCKYRAY__ = fixtureBridge;
    Object.defineProperty(window, '__LUCKYRAY__', {
      get: () => fixtureBridge,
      set: () => {},
      configurable: true,
    });
    localStorage.setItem('luckyray-settings-v1', JSON.stringify({ 'materials.importModePromptSeen': true }));
    window.__store = materialStore;
    window.__harnessReady = true;
    document.getElementById('root').className = 'react-nav-shell';
    document.getElementById('root').style.display = 'block';
    setTimeout(() => window.dispatchEvent(new CustomEvent('luckyray:bridge-ready')), 150);
    createRoot(document.getElementById('root')).render(React.createElement(I18nProvider, { locale: 'zh-CN' }, React.createElement(MaterialsPage)));
  ` }, bundle: true, format: 'iife', outfile: path.join(out, 'app.js'), loader: { '.svg': 'dataurl' }, plugins: [appStubPlugin] });

  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/app.css">' +
    '<style>body{margin:0;background:var(--theme-app-bg);color:var(--text-primary);font-family:Inter,"Microsoft YaHei",sans-serif}#root{height:100vh;overflow:auto}#page-materials{display:flex;flex-direction:column;height:100%}.materials-layout{flex:1;min-height:0}.masonry-container{flex:1;min-height:200px;overflow:auto;display:block}</style>' +
    '<div id="root"></div><script src="/app.js"></script></html>';
  const server = http.createServer((req, res) => {
    if (['/app.js', '/app.css'].includes(req.url)) {
      res.setHeader('Content-Type', req.url.endsWith('css') ? 'text/css' : 'text/javascript');
      res.end(fs.readFileSync(path.join(out, req.url.slice(1))));
    } else { res.setHeader('Content-Type', 'text/html'); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForTimeout(6000);
    if (errors.length) console.log('EARLY-ERRORS:', JSON.stringify(errors.slice(0, 5)));
    await page.waitForFunction(() => window.__harnessReady === true, { timeout: 45000 });
    // The store boots through the bridge; cards for our fixture images are
    // the proof the production data path worked.
    await page.locator('[data-asset-id="img1"]').waitFor({ timeout: 20000 });

    // ===== R5: preset switching on the REAL page =====
    const cycleWorkView = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:materials-toolbar-command', { detail: { type: 'cycle-workview' } })));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('luckyray-materials-workview-v1') || '{"active":"general"}').active), 'general');
    const visibleAssetOrder = () => page.locator('[data-asset-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-asset-id')));
    assert.equal((await visibleAssetOrder())[0], 'vid1', 'general keeps the existing source order for equal timestamps');
    // Departure from 通用 snapshots the current habit (masonry at default).
    const zoomBefore = await page.evaluate(() => document.documentElement.style.getPropertyValue('--materials-card-size'));
    await cycleWorkView();
    await page.waitForFunction(() => document.querySelector('.grid-view-react') !== null);
    assert.deepEqual(await visibleAssetOrder(), ['img2', 'img3', 'img1', 'vid1', 'vid2'], 'design promotes images while keeping recent order within both groups');
    const setSort = async sortBy => {
      await page.evaluate(sort => window.dispatchEvent(new CustomEvent('luckyray:materials-toolbar-command', { detail: { type: 'set-sort', sortBy: sort } })), sortBy);
      await page.waitForFunction(sort => window.__toolbarState?.sortBy === sort, sortBy);
    };
    await setSort('newest');
    assert.deepEqual(await visibleAssetOrder(), ['img2', 'img3', 'img1', 'vid1', 'vid2'], 'newest cannot break the design priority group');
    await setSort('random');
    const designRandom = await visibleAssetOrder();
    assert.deepEqual(designRandom.slice(0, 3).sort(), ['img1', 'img2', 'img3']);
    assert.deepEqual(designRandom.slice(3).sort(), ['vid1', 'vid2']);
    await setSort('recent');
    await setSort('random');
    assert.deepEqual(await visibleAssetOrder(), [...designRandom.slice(0, 3), ...designRandom.slice(3)], 'random order is retained across sort changes');
    await setSort('recent');
    // Design drives the grid + its meta line: the mime hint appears.
    assert.ok(await page.locator('.workview-design-hint').first().isVisible().catch(() => false), 'design meta hint visible');
    await page.screenshot({ path: path.join(out, 'page-design-preset.png') });
    await cycleWorkView();
    await page.waitForFunction(() => document.querySelector('.masonry-container') !== null);
    assert.deepEqual((await visibleAssetOrder()).slice(0, 2), ['vid1', 'vid2'], 'video view prioritizes video without losing the rest');
    // Preset-applied density persists through the shared channel — a restart
    // must not fall back to the stale pre-preset slider value.
    assert.equal(await page.evaluate(() => localStorage.getItem('luckyray-materials-zoom-v1')), '260', 'preset zoom persisted');
    // Video preset shows the video badge on video cards (existing metadata only).
    await page.locator('[data-asset-id="vid1"]').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('[data-asset-id="vid1"] .workview-video-hint').isVisible());
    await page.screenshot({ path: path.join(out, 'page-video-preset.png') });
    // Back to 通用: the snapshotted habit (masonry + same zoom) restores.
    await cycleWorkView();
    await page.waitForFunction(() => document.querySelector('.masonry-container') !== null);
    const zoomAfter = await page.evaluate(() => document.documentElement.style.getPropertyValue('--materials-card-size'));
    assert.equal(zoomAfter, zoomBefore, 'returning to 通用 restores the snapshotted zoom');
    // Manual adjustment while 通用 active is recorded into 通用's saved state
    // (persisted store) — reselecting 通用 after another preset restores it.
    await page.evaluate(() => { window.dispatchEvent(new CustomEvent('luckyray:materials-zoom', { detail: { zoom: 220 } })); });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--materials-card-size') === '220px');
    await cycleWorkView();
    await page.waitForFunction(() => document.querySelector('.grid-view-react') !== null);
    await cycleWorkView();
    await cycleWorkView();
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--materials-card-size') === '220px');
    // Persisted for the next mount.
    const stored = await page.evaluate(() => localStorage.getItem('luckyray-materials-workview-v1'));
    assert.ok(stored && JSON.parse(stored).saved.general && JSON.parse(stored).saved.general.zoom === 220, 'manual zoom recorded into 通用: ' + stored);

    // A titlebar work-view cycle while immersive detail is open retires that
    // viewer before the underlying presentation changes.
    await page.locator('[data-asset-id="img1"]').click();
    await page.locator('.material-viewer-react').waitFor();
    await cycleWorkView();
    await page.waitForFunction(() => document.querySelector('.material-viewer-react') === null);

    // The new top command is still the page's single preset authority.
    assert.equal(await page.evaluate(() => window.__toolbarState.workView), 'design');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:materials-toolbar-command', { detail: { type: 'toggle-filter' } })));
    await page.locator('.filter-panel-react').waitFor();
    const filterCountBeforeSort = await page.evaluate(() => window.__toolbarState.activeFilterCount);
    await page.locator('#materials-filter-sort-label').waitFor();
    await page.locator('#materials-filter-sort-label').locator('..').locator('button').nth(1).click();
    await page.waitForFunction(() => window.__toolbarState?.sortBy === 'newest');
    assert.equal(await page.evaluate(() => window.__toolbarState.activeFilterCount), filterCountBeforeSort, 'sort does not become a filter');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:materials-toolbar-command', { detail: { type: 'toggle-filter' } })));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:folder-select', { detail: { scope: 'materials', folderId: 'folder-a' } })));
    await page.waitForFunction(() => window.__toolbarState?.folderName === 'Project A');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-asset-id]')).map(card => card.getAttribute('data-asset-id')).join(',') === 'img2');
    assert.deepEqual(await visibleAssetOrder(), ['img2'], 'work-view priority does not widen the selected folder scope');
    await page.evaluate(() => window.__renameFolder('Project B'));
    await page.waitForFunction(() => window.__toolbarState?.folderName === 'Project B');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:folder-select', { detail: { scope: 'materials', folderId: null } })));
    await page.waitForFunction(() => window.__toolbarState?.folderName === null);
    await page.waitForFunction(() => document.querySelectorAll('[data-asset-id]').length === 5);

    // ===== R4: compare entry predicate on the REAL page =====
    // Selection is driven through each card's batch checkbox (the page's own
    // multi-select control). Trusted ctrl-clicks on the draggable masonry
    // cards work for the first two cards and then leave the headless CDP
    // session in a stuck native-drag state where NO further mouse events are
    // delivered anywhere in the page (verified with document-level capture
    // listeners: zero pointerdown/mousedown/click). The checkbox path is the
    // equivalent real interaction and stays reliable.
    const toggle = (id) => page.locator(`[data-asset-id="${id}"] .batch-checkbox-react`).click();
    await toggle('img1');
    const batchBar = page.locator('.batch-bar-react.show');
    await batchBar.waitFor();
    await toggle('img2');
    const compareBtn = page.locator('.batch-bar-react button', { hasText: '比较' });
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('.batch-bar-react button'));
      const compare = buttons.find(b => b.textContent === '比较');
      return compare && !compare.disabled;
    });
    assert.ok(await compareBtn.isEnabled(), '2 pure images enable compare');
    await toggle('img3');
    assert.equal(await compareBtn.isDisabled(), true, '3 images cannot open the comparison entry');
    await toggle('img3');
    assert.ok(await compareBtn.isEnabled(), 'returning to exactly 2 images re-enables compare');
    // Adding a video to the selection DISABLES it with the honest reason.
    await toggle('vid1');
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('.batch-bar-react button'));
      const compare = buttons.find(b => b.textContent === '比较');
      return compare && compare.disabled;
    });
    const disabledTitle = await compareBtn.getAttribute('title');
    assert.ok(disabledTitle && disabledTitle.includes('非图片'), 'mixed selection shows the honest reason: ' + disabledTitle);
    await page.screenshot({ path: path.join(out, 'page-compare-disabled-mixed.png') });
    // Dropping the video re-enables; clicking opens the REAL compare modal.
    await toggle('vid1');
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('.batch-bar-react button'));
      const compare = buttons.find(b => b.textContent === '比较');
      return compare && !compare.disabled;
    });
    const viewStoreBefore = await page.evaluate(() => localStorage.getItem('luckyray-materials-view-v1'));
    await compareBtn.click();
    await page.getByRole('dialog', { name: '图片比较' }).waitFor();
    assert.equal(await page.locator('.material-compare-cell').count(), 2);
    await page.waitForFunction(() => {
      const imgs = Array.from(document.querySelectorAll('.material-compare-stage img'));
      return imgs.length === 2 && imgs.every(img => img.complete);
    });
    await page.screenshot({ path: path.join(out, 'page-compare-open.png') });
    // Esc closes and focus returns to the compare entry button.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-dialog').length === 0);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.textContent), '比较', 'focus returns to the compare entry');
    // Closing via the ✕ button must also disarm the focus net: focus returns
    // to the compare entry, not document.body.
    await compareBtn.click();
    await page.getByRole('dialog', { name: '图片比较' }).waitFor();
    await page.locator('.material-compare-close').click();
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-dialog').length === 0);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.textContent), '比较', 'focus returns after ✕ close');
    // The underlying list state survived: selection still 2, same folder/sort.
    assert.ok(await batchBar.isVisible(), 'batch bar still active after compare close');
    assert.equal(await page.evaluate(() => localStorage.getItem('luckyray-materials-view-v1')), viewStoreBefore, 'view store untouched by compare');

    // R4: a single image starts comparison from the DETAIL action without
    // adopting unrelated batch selection, and detail returns on close.
    await toggle('img1');
    await toggle('img2');
    await page.locator('[data-asset-id="img1"]').click();
    await page.locator('.material-viewer-react.detail').waitFor();
    await page.locator('.detail-action-grid-react button', { hasText: '比较' }).click();
    await page.getByRole('dialog', { name: '图片比较' }).waitFor();
    assert.equal(await page.locator('.material-viewer-react').count(), 0, 'detail and compare never stack as two modal layers');
    assert.deepEqual(await page.locator('.material-compare-cell img').evaluateAll(imgs => imgs.map(img => img.alt)), ['red.png'], 'detail action compares only its image');
    assert.equal(await page.locator('.material-compare-picker.expanded').count(), 1, 'single image opens supplement immediately');
    await page.locator('.material-compare-close').click();
    await page.locator('.material-viewer-react.detail').waitFor();
    assert.ok(await page.locator('.material-viewer-react img[alt="red.png"]').count(), 'closing compare restores the same detail');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.material-viewer-react'));

    // Right-click identity is the clicked image, not a stale selected card.
    await page.locator('[data-asset-id="img2"]').click({ button: 'right' });
    await page.locator('[data-material-context-action="compare"]').click();
    await page.getByRole('dialog', { name: '图片比较' }).waitFor();
    assert.deepEqual(await page.locator('.material-compare-cell img').evaluateAll(imgs => imgs.map(img => img.alt)), ['blue.png']);
    await page.locator('.material-compare-close').click();
    await page.waitForFunction(() => !document.querySelector('.material-compare-dialog'));
    assert.equal(await page.locator('.material-viewer-react').count(), 0, 'context compare closes back to list, not detail');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-asset-id]')?.getAttribute('data-asset-id')), 'img2', 'context compare returns focus to its own card');
    assert.equal(await page.evaluate(() => localStorage.getItem('luckyray-materials-view-v1')), viewStoreBefore, 'context compare does not mutate view state');

    await page.locator('[data-asset-id="vid1"]').click({ button: 'right' });
    assert.equal(await page.locator('[data-material-context-action="compare"]').isDisabled(), true, 'video cannot enter image compare');
    assert.match(await page.locator('[data-material-context-action="compare"]').getAttribute('title'), /只有图片/);
    await page.keyboard.press('Escape');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('MATERIALS-PAGE-CONSUMER-OK');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
