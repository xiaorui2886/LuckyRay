// Real production compare components in a headless browser (MATERIAL-VIEW-COMPARE-R1).
// Synthetic image data URLs stand in for library previews; no user data is read.
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
const out = process.env.LUCKYRAY_EVIDENCE_DIR || path.join(root, '.tmp-material-compare');

// Synthetic SVG assets with distinct colors/sizes — no external file access.
const svg = (color, w, h, label) =>
  'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><text x="8" y="28" font-size="20" fill="#fff">${label}</text></svg>`
  );
const assets = [
  { id: 'a1', name: 'red-1600.png', previewUrl: svg('#a33', 1600, 1200, 'A'), thumbnailUrl: '', updatedAt: '1', mimeType: 'image/png' },
  { id: 'a2', name: 'blue-800.png', previewUrl: svg('#36a', 800, 1600, 'B'), thumbnailUrl: '', updatedAt: '1', mimeType: 'image/png' },
  { id: 'a3', name: 'green-400.png', previewUrl: svg('#3a6', 400, 400, 'C'), thumbnailUrl: '', updatedAt: '1', mimeType: 'image/png' },
  { id: 'a4', name: 'broken.png', previewUrl: 'data:text/plain,not-an-image', thumbnailUrl: '', updatedAt: '1', mimeType: 'image/png' },
  { id: 'tiny', name: 'tiny-80.png', previewUrl: svg('#e67', 80, 80, 'T'), thumbnailUrl: '', updatedAt: '1', mimeType: 'image/png' },
];

(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/App.css';
    import './src/app/appShell.css';
    import './src/core/theme/themeTokens.css';
    import './src/features/materials/materials.css';
    // Notes is lazy-loaded in production and its generic modal rules remain
    // in the page. This import order reproduces the owner's narrow dialog.
    import './src/features/notes/notes.css';
    import { I18nProvider } from './src/core/i18n/index';
    import MaterialCompareModal from './src/features/materials/MaterialCompareModal';
    const assets = ${JSON.stringify(assets)};
    window.__assets = assets;
    window.__events = [];
    const App = () => {
      const [slotIds, setSlotIds] = React.useState(null);
      const [liveAssets, setLiveAssets] = React.useState(assets);
      window.__open = (ids) => { setLiveAssets(assets); setSlotIds(ids); };
      window.__close = () => setSlotIds(null);
      window.__deleteAsset = (id) => setLiveAssets(assets.filter(a => a.id !== id));
      window.__setOnly = (ids) => setLiveAssets(assets.filter(a => ids.includes(a.id)));
      const byId = React.useMemo(() => new Map(liveAssets.map(a => [a.id, a])), [liveAssets]);
      return React.createElement(React.Fragment, null,
        slotIds ? React.createElement(MaterialCompareModal, {
          slotAssetIds: slotIds,
          assetsById: byId,
          availableImages: liveAssets,
          onClose: () => { window.__events.push('close'); setSlotIds(null); },
          onSlotIdsChanged: (next) => { window.__events.push('slots:' + next.join(',')); setSlotIds(next); },
        }) : null,
      );
    };
    document.getElementById('root').className = 'react-nav-shell';
    createRoot(document.getElementById('mount')).render(React.createElement(I18nProvider, { locale: 'zh-CN' }, React.createElement(App)));
  ` }, bundle: true, format: 'iife', outfile: path.join(out, 'app.js'), loader: { '.svg': 'dataurl' } });

  // A page-level keydown listener stands in for material shortcuts / global
  // bindings: if compare leaks ANY key to it, the trap test fails.
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/app.css">' +
    '<style>body{margin:0;background:var(--theme-app-bg);color:var(--text-primary);font-family:Inter,"Microsoft YaHei",sans-serif}#root .main{position:fixed;inset:0 0 0 220px;width:auto;height:100vh;display:block}#root .titlebar{height:60px;position:relative}#mount{padding:12px}.modal-overlay-react{position:fixed;inset:0}</style>' +
    '<div id="root"><div class="main"><div class="titlebar"><button onclick="window.__titlebarClicks++">Titlebar action</button></div><div id="mount"></div></div></div><script>window.__titlebarClicks=0;window.__leaked=[];window.addEventListener("keydown",e=>window.__leaked.push(e.key));</script><script src="/app.js"></script></html>';
  const server = http.createServer((req, res) => {
    if (['/app.js', '/app.css'].includes(req.url)) {
      res.setHeader('Content-Type', req.url.endsWith('css') ? 'text/css' : 'text/javascript');
      res.end(fs.readFileSync(path.join(out, req.url.slice(1))));
    } else { res.setHeader('Content-Type', 'text/html'); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 780 } });
    const expandTools = async () => {
      const toggle = page.locator('.material-compare-toggle');
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push('console:' + message.text()); });
    await page.goto('http://127.0.0.1:' + server.address().port);
    // --- Compare: open with 3 supported images ---
    await page.evaluate(ids => window.__open(ids), ['a1','a2','a3']);
    await page.getByRole('dialog', { name: '图片比较' }).waitFor();
    const compareBounds = await page.locator('.material-compare-dialog').boundingBox();
    assert.ok(compareBounds && compareBounds.width >= 900 && compareBounds.height >= 600,
      `compare must use the available viewport after Notes CSS loads: ${JSON.stringify(compareBounds)}`);
    assert.ok(Math.abs(compareBounds.x - 220) <= 1 && Math.abs(compareBounds.y - 60) <= 1,
      `compare must align with viewer content bounds: ${JSON.stringify(compareBounds)}`);
    assert.equal(await page.evaluate(() => document.elementFromPoint(260, 20)?.classList.contains('material-compare-backdrop')), true,
      'transparent modal shield blocks titlebar interactions without expanding visible compare content');
    await page.mouse.click(260, 20);
    await page.waitForFunction(() => !document.querySelector('.material-compare-dialog'));
    assert.equal(await page.evaluate(() => window.__titlebarClicks), 0, 'outside click closes compare without activating titlebar control');
    await page.evaluate(ids => window.__open(ids), ['a1','a2','a3']);
    await page.getByRole('dialog', { name: '图片比较' }).waitFor();
    assert.equal(await page.locator('.material-compare-extra-actions button.icon').count(), 0, 'four actions default collapsed and leave no focus targets');
    const toolsToggle = page.locator('.material-compare-toggle');
    assert.equal(await toolsToggle.getAttribute('aria-label'), '展开比较工具');
    assert.equal(await toolsToggle.getAttribute('aria-expanded'), 'false');
    assert.ok(await page.locator('.material-compare-zoomreadout').isVisible(), 'zoom readout remains visible when actions collapse');
    assert.ok(await page.getByRole('button', { name: '关闭' }).isVisible(), 'close remains visible when actions collapse');
    await page.screenshot({ path: path.join(out, 'compare-tools-collapsed.png') });
    const measureToolbarSpacing = () => page.evaluate(() => {
      const toggle = document.querySelector('.material-compare-toggle').getBoundingClientRect();
      const readout = document.querySelector('.material-compare-zoomreadout');
      const text = document.createRange();
      text.selectNodeContents(readout);
      const readoutText = text.getBoundingClientRect();
      const toolbar = document.querySelector('.material-compare-toolbar').getBoundingClientRect();
      const dialog = document.querySelector('.material-compare-dialog').getBoundingClientRect();
      return { visualGap: readoutText.left - toggle.right, rightInset: dialog.right - toolbar.right };
    });
    let collapsedRightInset;
    const toolbarSpacing = [];
    for (const expanded of [false, true]) {
      if (expanded) await toolsToggle.click();
      const spacing = await measureToolbarSpacing();
      toolbarSpacing.push({ expanded, ...spacing });
      assert.ok(spacing.visualGap >= 0 && spacing.visualGap <= 12,
        `compare tools ${expanded ? 'expanded' : 'collapsed'} keep the readout close to the arrow: ${JSON.stringify(spacing)}`);
      if (!expanded) collapsedRightInset = spacing.rightInset;
      else assert.ok(Math.abs(spacing.rightInset - collapsedRightInset) <= 1,
        `expanding compare tools preserves their right anchor: ${JSON.stringify(spacing)}`);
    }
    const headTops = await page.locator('.material-compare-cell-head').evaluateAll((heads) => heads.slice(0, 2).map((head) => head.getBoundingClientRect().top));
    assert.ok(Math.abs(headTops[0] - headTops[1]) <= 1, `left/right metadata align at top: ${headTops}`);
    assert.equal(await toolsToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.material-compare-extra-actions button.icon').count(), 4, 'four icon-only actions expand on demand');
    const measureToolbarClearance = () => page.evaluate(() => {
      const head = document.querySelector('.material-compare-cell:nth-child(2) .material-compare-cell-head').getBoundingClientRect();
      const name = document.querySelector('.material-compare-cell:nth-child(2) .material-compare-name').getBoundingClientRect();
      const toolbar = document.querySelector('.material-compare-toolbar').getBoundingClientRect();
      return { head: { left: head.left, right: head.right, top: head.top, bottom: head.bottom }, nameWidth: name.width,
        toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom },
        overlaps: head.left < toolbar.right && head.right > toolbar.left && head.top < toolbar.bottom && head.bottom > toolbar.top };
    });
    for (const width of [1120, 1024, 900]) {
      await page.setViewportSize({ width, height: 780 });
      await page.waitForFunction(expected => Math.abs(document.querySelector('.material-compare-dialog').getBoundingClientRect().width - (expected - 220)) < 2, width);
      const clearance = await measureToolbarClearance();
      assert.ok(!clearance.overlaps && clearance.nameWidth > 40,
        `${width}px viewport with expanded sidebar keeps metadata out of tools: ${JSON.stringify(clearance)}`);
    }
    await page.setViewportSize({ width: 1120, height: 780 });
    assert.equal(await page.locator('.material-compare-title').count(), 0, 'no full-width compare heading row');
    const releasedStage = await page.evaluate(() => {
      const cell = document.querySelector('.material-compare-cell').getBoundingClientRect();
      const stage = document.querySelector('.material-compare-stage').getBoundingClientRect();
      return { cellTop: cell.top, cellHeight: cell.height, stageTop: stage.top, stageHeight: stage.height };
    });
    assert.ok(Math.abs(releasedStage.stageTop - releasedStage.cellTop) <= 2 && releasedStage.stageHeight >= releasedStage.cellHeight - 3,
      'stage truly occupies the cell beneath floating metadata/actions: ' + JSON.stringify(releasedStage));
    for (const button of await page.locator('.material-compare-extra-actions button.icon').all()) {
      assert.ok(await button.getAttribute('title'));
      assert.ok(await button.getAttribute('aria-label'));
      assert.equal((await button.innerText()).trim(), '');
    }
    await page.evaluate(() => { document.querySelector('#root .main').style.left = '60px'; });
    await page.waitForFunction(() => Math.abs(document.querySelector('.material-compare-dialog').getBoundingClientRect().left - 60) < 1);
    await page.evaluate(() => { document.querySelector('#root .main').style.left = '220px'; });
    await page.waitForFunction(() => Math.abs(document.querySelector('.material-compare-dialog').getBoundingClientRect().left - 220) < 1);
    await page.getByTestId('compare-image-a1').waitFor();
    // Render-geometry assertion (review P1-1): under the absolute-offset
    // model, FIT must CENTER every image inside its stage — no edge-hugging.
    await page.waitForFunction(() => {
      const stages = Array.from(document.querySelectorAll('.material-compare-stage'));
      return stages.length === 3 && stages.every((stage) => {
        const img = stage.querySelector('img');
        if (!img || !img.complete || img.naturalWidth === 0) return false;
        const s = stage.getBoundingClientRect();
        const r = img.getBoundingClientRect();
        const leftGap = r.left - s.left;
        const rightGap = s.right - r.right;
        const topGap = r.top - s.top;
        const bottomGap = s.bottom - r.bottom;
        const wide = Math.max(s.width, 1);
        const tol = wide * 0.02;
        if (r.width <= s.width) {
          if (Math.abs(leftGap - rightGap) > tol) return false;
        } else if (leftGap > tol || rightGap > tol) {
          return false;
        }
        if (r.height <= s.height) {
          if (Math.abs(topGap - bottomGap) > tol) return false;
        } else if (topGap > tol || bottomGap > tol) {
          return false;
        }
        return true;
      });
    });
    // FIT never crops the subject (review P1-2): the projected image fits
    // ENTIRELY inside the stage box at fit.
    const fitBounds = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid=compare-stage-a2]');
      const img = stage.querySelector('img');
      const s = stage.getBoundingClientRect();
      const r = img.getBoundingClientRect();
      return { sw: s.width, sh: s.height, rw: r.width, rh: r.height };
    });
    assert.ok(fitBounds.rw <= fitBounds.sw + 1 && fitBounds.rh <= fitBounds.sh + 1,
      'fit must contain the whole image in the stage, got ' + JSON.stringify(fitBounds));
    // Dimensions header shows real intrinsic sizes once loaded.
    await page.getByText('1600 × 1200').waitFor();
    assert.ok(await page.getByText('800 × 1600').isVisible());
    assert.ok(await page.getByText('400 × 400').isVisible());
    await page.screenshot({ path: path.join(out, 'compare-3-dark.png') });

    // --- Wheel zoom on slot 0 anchors and updates the readout ---
    const stage0 = page.getByTestId('compare-stage-a1');
    await stage0.hover();
    // Capture the normalized image-space coordinate under the cursor before
    // and after the wheel: it must stay constant (anchor holds).
    const anchorBefore = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid=compare-stage-a1]');
      const img = stage.querySelector('img');
      const s = stage.getBoundingClientRect();
      const r = img.getBoundingClientRect();
      return { cx: (s.left + s.width / 2 - r.left) / r.width, cy: (s.top + s.height / 2 - r.top) / r.height };
    });
    await page.mouse.wheel(0, -240);
    await page.waitForFunction(() => {
      const readout = document.querySelector('.material-compare-zoomreadout');
      return readout && readout.textContent && !readout.textContent.startsWith('100%');
    });
    const anchorAfter = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid=compare-stage-a1]');
      const img = stage.querySelector('img');
      const s = stage.getBoundingClientRect();
      const r = img.getBoundingClientRect();
      return { cx: (s.left + s.width / 2 - r.left) / r.width, cy: (s.top + s.height / 2 - r.top) / r.height };
    });
    assert.ok(Math.abs(anchorAfter.cx - anchorBefore.cx) < 0.03 && Math.abs(anchorAfter.cy - anchorBefore.cy) < 0.03,
      'wheel zoom must anchor the cursor pixel: ' + JSON.stringify({ anchorBefore, anchorAfter }));
    // Slot 0 is active by default; the readout reflects its multiplier.
    assert.match(await page.locator('.material-compare-zoomreadout').textContent(), /×fit$|%/);

    // --- Real pan gesture: drag slot 0 (zoomed first — at fit there is
    // nothing to pan by design), then hover — no ghost pan, no leaks ---
    {
      await page.getByTestId('compare-stage-a1').hover();
      await page.keyboard.press('+');
      await page.keyboard.press('+');
      await page.waitForTimeout(200);
      const stageBox = await page.getByTestId('compare-stage-a1').boundingBox();
      const imgBefore = await page.getByTestId('compare-image-a1').boundingBox();
      await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(stageBox.x + stageBox.width / 2 - 80, stageBox.y + stageBox.height / 2 - 40, { steps: 4 });
      await page.mouse.up();
      const imgAfterPan = await page.getByTestId('compare-image-a1').boundingBox();
      assert.ok(Math.abs((imgAfterPan?.x ?? 0) - (imgBefore?.x ?? 0)) > 20, 'a real drag must pan the image');
      // Pure hover after pointerup: the image must NOT keep following the mouse
      // (ghost-pan regression from the synthetic-event cleanup bug).
      const readoutAfterPan = await page.locator('.material-compare-zoomreadout').textContent();
      await page.mouse.move(stageBox.x + 40, stageBox.y + 60, { steps: 5 });
      await page.mouse.move(stageBox.x + stageBox.width - 60, stageBox.y + stageBox.height - 80, { steps: 5 });
      await page.waitForTimeout(250);
      const imgAfterHover = await page.getByTestId('compare-image-a1').boundingBox();
      assert.ok(
        Math.abs((imgAfterHover?.x ?? 0) - (imgAfterPan?.x ?? 0)) < 2,
        'hover after pointerup must not ghost-pan: ' + JSON.stringify({ imgAfterPan: imgAfterPan?.x, imgAfterHover: imgAfterHover?.x }),
      );
      const readoutAfterHover = await page.locator('.material-compare-zoomreadout').textContent();
      assert.equal(readoutAfterHover, readoutAfterPan, 'hover must not resurrect the pre-pan multiplier');
    }

    // --- Keyboard trap: no key reaches the page listener ---
    for (const key of ['Delete', 'a', 'ArrowLeft', '+', '0', 'l', 'r', '1']) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(120);
    assert.deepEqual(await page.evaluate(() => window.__leaked), [], 'compare must trap every key');

    // --- Linked zoom syncs the other slots ---
    // (the trap loop above pressed 'l', so read the CURRENT pressed state
    // and assert the button click flips it.)
    const linkedBefore = await page.getByRole('button', { name: '联动缩放' }).getAttribute('aria-pressed');
    await page.getByRole('button', { name: '联动缩放' }).click();
    assert.equal(await page.getByRole('button', { name: '联动缩放' }).getAttribute('aria-pressed'), linkedBefore === 'true' ? 'false' : 'true');
    await page.getByRole('button', { name: '联动缩放' }).click(); // back to linked ON for the test below
    assert.equal(await page.getByRole('button', { name: '联动缩放' }).getAttribute('aria-pressed'), linkedBefore === 'true' ? 'true' : 'false');
    if (linkedBefore !== 'true') { await page.getByRole('button', { name: '联动缩放' }).click(); }
    assert.equal(await page.getByRole('button', { name: '联动缩放' }).getAttribute('aria-pressed'), 'true');
    const before = await page.evaluate(() => Array.from(document.querySelectorAll('.material-compare-slotstate')).map(n => n.textContent));
    await page.keyboard.press('+');
    await page.waitForFunction(before => {
      const now = Array.from(document.querySelectorAll('.material-compare-slotstate')).map(n => n.textContent);
      return now.some((text, index) => text !== before[index]);
    }, before);

    // --- 100% is absolute per slot, never conflated with fit (R2) ---
    await page.keyboard.press('1');
    await page.waitForFunction(() => {
      const readout = document.querySelector('.material-compare-zoomreadout');
      return readout && readout.textContent === '1:1';
    });
    await page.screenshot({ path: path.join(out, 'compare-linked-100.png') });

    // --- Fit resets the active slot (readout shows "<n>% fit", not 1:1) ---
    await page.keyboard.press('0');
    await page.waitForFunction(() => {
      const readout = document.querySelector('.material-compare-zoomreadout')?.textContent || '';
      return readout.includes('fit') && readout !== '1:1';
    });

    // --- Replace a slot through the lightweight picker ---
    await page.locator('.material-compare-cell').nth(1).locator('.material-compare-mini', { hasText: '替换' }).click();
    await page.getByRole('dialog', { name: '选择图片' }).waitFor();
    assert.equal(await page.locator('.material-compare-picker.expanded').count(), 0, 'replace stays compact');
    const compactPickerGap = await page.evaluate(() => document.querySelector('.material-compare-dialog').getBoundingClientRect().bottom - document.querySelector('.material-compare-picker').getBoundingClientRect().bottom);
    assert.ok(Math.abs(compactPickerGap) <= 1, `compact replace picker meets compare bottom edge: ${compactPickerGap}`);
    await page.locator('.material-compare-picker-item', { hasText: 'broken.png' }).click();
    await page.waitForFunction(() => window.__events.some(e => e.startsWith('slots:')));
    // The broken slot shows a per-slot error, not a blank modal.
    await page.locator('.material-compare-error').waitFor();
    await page.screenshot({ path: path.join(out, 'compare-error-slot.png') });

    // --- Removing to one image immediately opens a large supplement picker ---
    await page.locator('.material-compare-cell').nth(0).locator('.material-compare-mini', { hasText: '移除' }).click();
    await page.locator('.material-compare-cell').nth(0).locator('.material-compare-mini', { hasText: '移除' }).click();
    await page.locator('.material-compare-picker.expanded').waitFor();
    assert.equal(await page.locator('.material-compare-cell').count(), 1, 'remaining image stays visible and identified');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('.material-compare-picker.expanded').contains(document.activeElement)), true,
      'keyboard focus remains in the large supplement while it is open');
    const pickerBounds = await page.locator('.material-compare-picker.expanded').boundingBox();
    assert.ok(pickerBounds && pickerBounds.height > compareBounds.height * 0.65, 'supplement uses available viewer height');
    const keptBounds = await page.locator('.material-compare-grid.supplementing .material-compare-cell').boundingBox();
    assert.ok(keptBounds && keptBounds.width > compareBounds.width * 0.35 &&
      keptBounds.x + keptBounds.width <= pickerBounds.x,
    'remaining image owns a substantial, unobscured stage beside the supplement');
    await page.locator('.material-compare-cell').locator('.material-compare-mini', { hasText: '替换' }).click();
    assert.equal(await page.locator('.material-compare-picker.expanded').count(), 0,
      'Replace exits the automatic supplement layout and uses the compact picker');
    assert.equal(await page.locator('.material-compare-picker').count(), 1);
    assert.equal(await page.locator('.material-compare-kept').count(), 0,
      'the image being replaced must not be labeled as retained');
    await page.locator('.material-compare-picker-head .material-compare-mini').click();
    assert.equal(await page.locator('.material-compare-picker').count(), 0,
      'one close dismisses the current picker without revealing another');
    assert.equal(await page.locator('.material-compare-cell').count(), 1);
    await page.locator('.material-compare-insufficient button').click();
    await page.locator('.material-compare-picker.expanded').waitFor();
    await page.locator('.material-compare-cell').locator('.material-compare-mini', { hasText: '替换' }).click();
    await page.locator('.material-compare-picker-item', { hasText: 'blue-800.png' }).click();
    assert.equal(await page.locator('.material-compare-cell').count(), 1, 'Replace changes the one remaining slot, not adds a second');
    await page.getByTestId('compare-image-a2').waitFor();
    assert.equal(await page.locator('.material-compare-picker').count(), 0);
    await page.locator('.material-compare-insufficient button').click();
    await page.locator('.material-compare-picker.expanded').waitFor();
    await page.locator('.material-compare-picker-item', { hasText: 'red-1600.png' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-cell').length === 2);
    await page.locator('.material-compare-cell').nth(1).locator('.material-compare-mini', { hasText: '移除' }).click();
    await page.locator('.material-compare-picker.expanded').waitFor();
    await page.screenshot({ path: path.join(out, 'compare-insufficient.png') });

    // Esc dismisses only the supplement, then a second Esc closes compare.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('.material-compare-picker.expanded').contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.material-compare-picker.expanded'));
    assert.equal(await page.locator('.material-compare-cell').count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector('.material-compare-dialog').contains(document.activeElement)), true,
      'dismissing an unmounted picker returns focus to compare');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__events.includes('close'));
    assert.equal(await page.getByRole('dialog', { name: '图片比较' }).count(), 0);

        // --- Themes: light mode with 2 images (side by side) ---// --- Themes: light mode with 2 images (side by side) ---
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.waitForTimeout(300);
    await page.evaluate(ids => window.__open(ids), ['a1','tiny']);
    await page.getByRole('dialog', { name: '图片比较' }).waitFor();
    await page.getByText('1600 × 1200').waitFor();
    await page.screenshot({ path: path.join(out, 'compare-2-light.png') });

        // --- Narrow window: controls stay reachable, grid adapts ---// --- Narrow window: controls stay reachable, grid adapts ---
    await page.setViewportSize({ width: 480, height: 720 });
    await page.waitForTimeout(250);
    const toolbarVisible = await page.locator('.material-compare-toolbar').boundingBox();
    assert.ok(toolbarVisible && toolbarVisible.height > 0, 'toolbar must stay visible in a narrow window');
    assert.ok(await page.locator('.material-compare-zoomreadout').isVisible(), 'narrow readout remains visible');
    assert.ok(await page.getByRole('button', { name: '关闭' }).isVisible(), 'narrow close remains visible');
    const narrowControls = await page.evaluate(() => {
      const dialog = document.querySelector('.material-compare-dialog').getBoundingClientRect();
      const toolbar = document.querySelector('.material-compare-toolbar').getBoundingClientRect();
      return { dialogLeft: dialog.left, toolbarLeft: toolbar.left, toolbarRight: toolbar.right, dialogRight: dialog.right };
    });
    assert.ok(narrowControls.toolbarLeft >= narrowControls.dialogLeft && narrowControls.toolbarRight <= narrowControls.dialogRight,
      `narrow toolbar stays inside compare: ${JSON.stringify(narrowControls)}`);
    await page.locator('.material-compare-toggle').click();
    assert.ok(await page.getByRole('button', { name: '复位' }).isVisible());
    const narrowExpandedClearance = await page.evaluate(() => ({
      headBottom: document.querySelector('.material-compare-cell-head').getBoundingClientRect().bottom,
      actionsTop: document.querySelector('.material-compare-extra-actions').getBoundingClientRect().top,
    }));
    assert.ok(narrowExpandedClearance.headBottom <= narrowExpandedClearance.actionsTop,
      `narrow expanded tools leave the metadata readable: ${JSON.stringify(narrowExpandedClearance)}`);
    await page.screenshot({ path: path.join(out, 'compare-narrow.png') });

        // --- Late identity: replacing a slot must not paint the old image's load ---// --- Late identity: replacing a slot must not paint the old image's load ---
    await page.setViewportSize({ width: 1120, height: 780 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__events.filter(e => e === 'close').length >= 2);
    await page.evaluate(ids => window.__open(ids), ['a1','tiny']);
    await page.getByRole('dialog', { name: '图片比较' }).waitFor();
    // Replace slot 1 immediately; the old image's onLoad must not resurrect it.
    await page.locator('.material-compare-cell').nth(1).locator('.material-compare-mini', { hasText: '替换' }).click();
    await page.locator('.material-compare-picker-item', { hasText: 'green-400.png' }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.material-compare-dims')).some(n => n.textContent === '400 × 400'));
    const dims = await page.locator('.material-compare-dims').allTextContents();
    assert.ok(dims.includes('400 × 400'), 'replaced slot shows the new image dimensions');
    assert.ok(!dims.includes('800 × 1600'), 'old image must not paint over the replaced slot');


        // ================= CENTRAL R1: linked mode shares ONE multiplier and pan =================// ================= CENTRAL R1: linked mode shares ONE multiplier and pan =================
    await page.evaluate(() => window.__close());
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-dialog').length === 0);
    await page.evaluate(ids => window.__open(ids), ['a1', 'a2']);

    await page.waitForFunction(() => {
      const stages = document.querySelectorAll('.material-compare-stage');
      return stages.length === 2 && Array.from(stages).every(s => s.querySelector('img'));
    });
    // Zoom slot a1 alone first (independent): the two readouts must DIVERGE.
    await page.getByTestId('compare-stage-a1').hover();
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);
    const diverged = await page.evaluate(() => Array.from(document.querySelectorAll('.material-compare-slotstate')).map(n => n.textContent));
    assert.ok(diverged[0] !== diverged[1], 'independent zoom must diverge the slots, got ' + JSON.stringify(diverged));
    await expandTools();
    // Enable linked; wheel on a1 — BOTH slots' ABSOLUTE rendering scale must
    // change by the same factor (shared multiplier, mixed aspect ratios).
    await page.getByRole('button', { name: '联动缩放' }).click();
    await page.waitForTimeout(100);
    const beforeLinked = await page.evaluate(() => Array.from(document.querySelectorAll('.material-compare-stage img')).map(img => {
      const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
      return Math.sqrt(m.a * m.a + m.b * m.b);
    }));
    await page.getByTestId('compare-stage-a1').hover();
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(200);
    const afterLinked = await page.evaluate(() => Array.from(document.querySelectorAll('.material-compare-stage img')).map(img => {
      const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
      return Math.sqrt(m.a * m.a + m.b * m.b);
    }));
    const ratios = afterLinked.map((scale, index) => scale / beforeLinked[index]);
    assert.ok(
      Math.abs(ratios[0] - ratios[1]) < 0.05,
      'linked wheel must scale BOTH slots by the same factor: ' + JSON.stringify({ beforeLinked, afterLinked, ratios }),
    );
    const linkedReadout = await page.locator('.material-compare-zoomreadout').textContent();
    assert.ok(/%/.test(linkedReadout), 'readout must update under linked zoom, got ' + linkedReadout);
    // Linked PAN: zoom BOTH slots past the stage on both axes first (so
    // neither slot's pan is clamp-centered), then drag slot a1 — slot a2's
    // transform MUST change too.
    for (let i = 0; i < 3; i += 1) {
      await page.getByTestId('compare-stage-a1').hover();
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(120);
    }
    const panBefore = await page.evaluate(() => {
      const img = document.querySelector('[data-testid=compare-stage-a2] img');
      const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
      return { e: m.e, f: m.f };
    });
    const boxA1 = await page.getByTestId('compare-stage-a1').boundingBox();
    await page.mouse.move(boxA1.x + boxA1.width / 2, boxA1.y + boxA1.height / 2);
    await page.mouse.down();
    await page.mouse.move(boxA1.x + boxA1.width / 2 - 60, boxA1.y + boxA1.height / 2 - 30, { steps: 3 });
    await page.mouse.up();
    const panAfter = await page.evaluate(() => {
      const img = document.querySelector('[data-testid=compare-stage-a2] img');
      const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
      return { e: m.e, f: m.f };
    });
    assert.ok(
      Math.abs(panAfter.e - panBefore.e) > 5 || Math.abs(panAfter.f - panBefore.f) > 5,
      'linked pan must move the OTHER slot too: ' + JSON.stringify({ panBefore, panAfter }),
    );
    await page.screenshot({ path: path.join(out, 'compare-linked-shared.png') });

        // ================= CENTRAL R1 follow-up: source-switch consistency =================// ================= CENTRAL R1 follow-up: source-switch consistency =================
    // Central's exact counterexample sequence: independent zoom on A -> enable
    // linked -> zoom on B must still ZOOM IN (was: reverse shrink to 0.8264),
    // switching the wheel source back and forth stays consistent, and turning
    // linked OFF carries the visible state with NO jump (was: a1 jumped
    // 573 -> 762). Assertions use REAL rendered widths, not equal readouts.
    await page.evaluate(() => window.__close());
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-dialog').length === 0);
    await page.evaluate(ids => window.__open(ids), ['a1', 'a2']);
    await page.waitForFunction(() => {
      const stages = document.querySelectorAll('.material-compare-stage');
      return stages.length === 2 && Array.from(stages).every(s => s.querySelector('img'));
    });
    await page.waitForTimeout(250);
    const widthsOf = () => page.evaluate(() => Array.from(document.querySelectorAll('.material-compare-stage img')).map(img => img.getBoundingClientRect().width));
    const fitWidthsBefore = await widthsOf();
    const wheelOn = async (id, deltaY) => {
      await page.getByTestId('compare-stage-' + id).hover();
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(180);
    };
    // 1) zoom a1 alone three times (independent).
    await wheelOn('a1', -100);
    await wheelOn('a1', -100);
    await wheelOn('a1', -100);
    // 2) enable linked: a1 keeps its size, a2 adopts the shared multiplier.
    await expandTools();
    await page.getByRole('button', { name: '联动缩放' }).click();
    await page.waitForTimeout(150);
    const linkedOnWidths = await widthsOf();
    assert.ok(linkedOnWidths[0] > fitWidthsBefore[0] * 1.2 && linkedOnWidths[1] > fitWidthsBefore[1] * 1.2,
      'linked-on baseline must grow from each slot fit size: ' + JSON.stringify({ fitWidthsBefore, linkedOnWidths }));
    // 3) wheel IN on a2: BOTH slots must GROW by ~1.1 (central saw 0.8264).
    await wheelOn('a2', -100);
    const afterB = await widthsOf();
    const ratiosB = afterB.map((w, i) => w / linkedOnWidths[i]);
    assert.ok(
      ratiosB.every(r => r > 1.05 && r < 1.16) && Math.abs(ratiosB[0] - ratiosB[1]) < 0.05,
      'zoom-in from B under linked must grow BOTH slots by ~1.1, got ' + JSON.stringify({ linkedOnWidths, afterB, ratiosB }),
    );
    // 4) switch the source back to a1 and zoom again: same consistent growth.
    await wheelOn('a1', -100);
    const afterA = await widthsOf();
    const ratiosA = afterA.map((w, i) => w / afterB[i]);
    assert.ok(
      ratiosA.every(r => r > 1.05 && r < 1.16) && Math.abs(ratiosA[0] - ratiosA[1]) < 0.05,
      'zoom-in back on A under linked must grow BOTH slots by ~1.1, got ' + JSON.stringify({ afterB, afterA, ratiosA }),
    );
    // 5) turn linked OFF: the visible state carries over with NO jump.
    await page.getByRole('button', { name: '联动缩放' }).click();
    await page.waitForTimeout(150);
    const linkedOffWidths = await widthsOf();
    assert.ok(
      linkedOffWidths.every((w, i) => Math.abs(w - afterA[i]) < 0.5),
      'disabling linked must NOT jump either slot, got ' + JSON.stringify({ afterA, linkedOffWidths }),
    );
    // 6) re-enable: still no jump (records already hold the shared state).
    await page.getByRole('button', { name: '联动缩放' }).click();
    await page.waitForTimeout(150);
    const relinkedWidths = await widthsOf();
    assert.ok(
      relinkedWidths.every((w, i) => Math.abs(w - linkedOffWidths[i]) < 0.5),
      're-enabling linked must NOT jump either slot, got ' + JSON.stringify({ linkedOffWidths, relinkedWidths }),
    );
    // 7) BOUNDARY: zoom OUT past the floor from one source, then from the
    // other source — widths freeze at fit and never invert/jump.
    for (let i = 0; i < 12; i += 1) await wheelOn('a2', 100);
    const floorWidths = await widthsOf();
    await wheelOn('a1', 100);
    const floorWidths2 = await widthsOf();
    assert.ok(
      floorWidths2.every((w, i) => Math.abs(w - floorWidths[i]) < 0.5),
      'the multiplier floor must hold when the wheel source switches, got ' + JSON.stringify({ floorWidths, floorWidths2 }),
    );
    // Recovery from the floor stays direction-correct from the other source.
    await wheelOn('a2', -100);
    const recovered = await widthsOf();
    assert.ok(
      recovered.every((w, i) => w / floorWidths2[i] > 1.05),
      'zoom-in from the floor must grow both slots, got ' + JSON.stringify({ floorWidths2, recovered }),
    );
    // 8) 100% then a source switch: 1:1 sets the ACTIVE slot to absolute
    // 1:1; wheeling afterwards from the OTHER slot keeps the direction.
    await wheelOn('a1', -100); // active = a1
    await page.getByRole('button', { name: '原始比例' }).click();
    await page.waitForTimeout(200);
    const oneToOneWidths = await widthsOf();
    assert.ok(Math.abs(oneToOneWidths[0] - 1600) < 2, 'a1 at absolute 1:1 renders 1600px, got ' + oneToOneWidths[0]);
    await wheelOn('a2', -100);
    const afterOneToOneSwitch = await widthsOf();
    const ratios100 = afterOneToOneSwitch.map((w, i) => w / oneToOneWidths[i]);
    assert.ok(
      ratios100.every(r => r > 1.05 && r < 1.16) && Math.abs(ratios100[0] - ratios100[1]) < 0.05,
      'wheel from the other slot after 100% must grow BOTH by ~1.1, got ' + JSON.stringify({ oneToOneWidths, afterOneToOneSwitch, ratios100 }),
    );
    await page.screenshot({ path: path.join(out, 'compare-linked-source-switch.png') });
    await page.getByRole('button', { name: '复位' }).click();

        // ================= CENTRAL P1: mixed-size linked 1:1 must not loop =================// ================= CENTRAL P1: mixed-size linked 1:1 must not loop =================
    // Central's boundary counterexample: tiny 80×80 + a1 1600×1200 linked,
    // 1:1 on the tiny slot previously hit "Maximum update depth exceeded"
    // (the large slot's lower bound can never reach the tiny slot's 1:1
    // fit-relative multiplier) and the compare dialog unmounted. The window
    // must survive, the tiny image must render at its ABSOLUTE 80px, and
    // later source switches / linked toggles stay jump- and loop-free.
    await page.evaluate(() => window.__close());
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-dialog').length === 0);
    await page.evaluate(ids => window.__open(ids), ['tiny', 'a1']);
    await page.waitForFunction(() => {
      const stages = document.querySelectorAll('.material-compare-stage');
      return stages.length === 2 && Array.from(stages).every(s => s.querySelector('img'));
    });
    await page.waitForTimeout(250);
    await expandTools();
    await page.getByRole('button', { name: '联动缩放' }).click();
    await page.waitForTimeout(150);
    const beforeOneToOne = await widthsOf();
    await page.getByRole('button', { name: '原始比例' }).click();
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole('dialog', { name: '图片比较' }).count(), 1, 'compare dialog must survive mixed-size linked 1:1');
    assert.ok(!errors.some(e => e.includes('Maximum update depth')), 'no update-depth loop: ' + JSON.stringify(errors.slice(0, 3)));
    const tinyOneToOne = await page.evaluate(() => document.querySelector('[data-testid="compare-image-tiny"]').getBoundingClientRect().width);
    assert.ok(Math.abs(tinyOneToOne - 80) < 2, 'tiny at absolute 1:1 renders exactly 80px, got ' + tinyOneToOne);
    // The large slot stays clamped at its own fit bound (its floor is
    // multiplier 1 — the shared 1/fit<1 target is unreachable, by design):
    // its rendered width is UNCHANGED by the tiny slot's 1:1, not chased.
    const mixedWidths = await widthsOf();
    assert.ok(
      Math.abs(mixedWidths[1] - beforeOneToOne[1]) < 0.5,
      'large slot keeps its own bound under the unreachable shared target: ' + JSON.stringify({ beforeOneToOne, mixedWidths }),
    );
    // Switch the wheel source to the LARGE slot: direction stays zoom-IN on
    // both (the clamp never inverts the gesture), no loop, window alive.
    await wheelOn('a1', -100);
    const afterLargeSource = await widthsOf();
    const mixedRatios = afterLargeSource.map((w, i) => w / mixedWidths[i]);
    assert.ok(
      mixedRatios.every(r => r > 1.05 && r < 1.16),
      'wheel from the large slot after mixed 1:1 grows both ~1.1: ' + JSON.stringify({ mixedWidths, afterLargeSource, mixedRatios }),
    );
    // Exit and re-enter linked: visible state carries over, no jump/loop.
    await page.getByRole('button', { name: '联动缩放' }).click();
    await page.waitForTimeout(150);
    const mixedOff = await widthsOf();
    assert.ok(mixedOff.every((w, i) => Math.abs(w - afterLargeSource[i]) < 0.5), 'linked off keeps the visible state: ' + JSON.stringify({ afterLargeSource, mixedOff }));
    await page.getByRole('button', { name: '联动缩放' }).click();
    await page.waitForTimeout(150);
    const mixedRelinked = await widthsOf();
    // Re-enabling is the EXPLICIT unification to the ACTIVE slot (a1, last
    // wheeled): a1 must not move; the clamped-diverged tiny slot re-unifies
    // toward a1's multiplier in one transition — never a loop.
    assert.ok(Math.abs(mixedRelinked[1] - mixedOff[1]) < 0.5, 'active slot keeps its visible state on re-enable: ' + JSON.stringify({ mixedOff, mixedRelinked }));
    assert.ok(mixedRelinked[0] > mixedOff[0], 'non-active slot re-unifies toward the active multiplier: ' + JSON.stringify({ mixedOff, mixedRelinked }));
    assert.equal(await page.getByRole('dialog', { name: '图片比较' }).count(), 1, 'dialog still alive after mixed toggling');
    await page.screenshot({ path: path.join(out, 'compare-mixed-boundary-1to1.png') });
    await page.getByRole('button', { name: '复位' }).click();

        // ================= CENTRAL R2: tiny image at 100% renders 1 CSS px per image px =================// ================= CENTRAL R2: tiny image at 100% renders 1 CSS px per image px =================
    await page.evaluate(() => window.__close());
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-dialog').length === 0);
    await page.evaluate(ids => window.__open(ids), ['a1', 'tiny']);
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-testid=compare-image-tiny]');
      return img && img.complete && img.naturalWidth === 80;
    });
    await page.locator('.material-compare-cell').nth(1).click();
    await page.keyboard.press('1');
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-testid=compare-image-tiny]');
      return img && Math.abs(img.getBoundingClientRect().width - 80) < 2;
    });
    await page.locator('.material-compare-cell').nth(0).click();
    await page.keyboard.press('1');
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-testid=compare-image-a1]');
      return img && Math.abs(img.getBoundingClientRect().width - 1600) < 4;
    });
    await page.screenshot({ path: path.join(out, 'compare-absolute-100.png') });

    // ================= CENTRAL R3: Tab never escapes the dialog =================
    await expandTools();
    await page.getByRole('button', { name: '复位' }).focus();
    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Tab');
    const trapped = await page.evaluate(() => {
      const dialog = document.querySelector('.material-compare-dialog');
      return dialog.contains(document.activeElement);
    });
    assert.equal(trapped, true, '8 Tabs must stay inside the dialog');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+Tab');
    const trappedBack = await page.evaluate(() => document.querySelector('.material-compare-dialog').contains(document.activeElement));
    assert.equal(trappedBack, true, 'Shift+Tab must stay inside the dialog too');

    // ================= CENTRAL R6: removal preserves other slots; external delete flips only that slot =================
    await page.evaluate(() => window.__close());
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-dialog').length === 0);
    await page.evaluate(ids => window.__open(ids), ['a1', 'a2', 'a3']);
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-stage').length === 3);
    await page.locator('[data-testid=compare-stage-a3]').hover();
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);
    // Capture the SEMANTIC state (fit-relative multiplier), not the absolute
    // scale: removing a slot legitimately re-flows the grid and re-fits.
    const a3Before = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid=compare-stage-a3]');
      const img = stage.querySelector('img');
      const s = stage.getBoundingClientRect();
      const r = img.getBoundingClientRect();
      const fit = Math.min(s.width / img.naturalWidth, s.height / img.naturalHeight);
      const multiplier = (r.width / img.naturalWidth) / fit;
      const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
      return { multiplier, e: m.e, f: m.f };
    });
    await page.locator('.material-compare-cell').nth(0).locator('.material-compare-mini', { hasText: '移除' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.material-compare-stage').length === 2);
    const a3After = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid=compare-stage-a3]');
      const img = stage ? stage.querySelector('img') : null;
      if (!img) return null;
      const s = stage.getBoundingClientRect();
      const r = img.getBoundingClientRect();
      const fit = Math.min(s.width / img.naturalWidth, s.height / img.naturalHeight);
      const multiplier = (r.width / img.naturalWidth) / fit;
      const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
      return { multiplier, e: m.e, f: m.f };
    });
    assert.ok(a3After, 'a3 must survive the removal of slot a1');
    assert.ok(
      Math.abs(a3After.multiplier - a3Before.multiplier) < 0.02,
      'removing ANOTHER slot must preserve a3 fit-relative multiplier: ' + JSON.stringify({ a3Before, a3After }),
    );
    // External delete of a2 (still 2 live slots → grid stays visible): only
    // a2 flips to missing; the survivor is untouched.
    await page.evaluate(() => window.__deleteAsset('a2'));
    await page.waitForFunction(() => {
      const cells = Array.from(document.querySelectorAll('.material-compare-cell'));
      return cells.length === 2 && cells.some(cell => cell.textContent.includes('素材已失效'));
    });
    const missingStates = await page.evaluate(() => Array.from(document.querySelectorAll('.material-compare-slotstate')).map(n => n.textContent));
    assert.ok(missingStates.some(s => s.includes('素材已失效')), 'deleted slot shows missing state');
    assert.ok(missingStates.some(s => !s.includes('素材已失效')), 'surviving slot is NOT marked missing');
    await page.screenshot({ path: path.join(out, 'compare-external-delete.png') });
    // Removing the missing slot starts the large supplement immediately.
    await page.locator('.material-compare-cell').filter({ hasText: '素材已失效' }).locator('.material-compare-mini', { hasText: '移除' }).click();
    await page.locator('.material-compare-picker.expanded').waitFor();
    await page.evaluate(() => window.__setOnly(['a3']));
    await page.getByText('当前没有可补选的图片').waitFor();
    assert.equal(await page.locator('.material-compare-picker-item').count(), 0, 'no candidate is explicit, not a blank picker');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.material-compare-picker.expanded'));
    await page.getByRole('button', { name: '补选图片' }).click();
    await page.locator('.material-compare-picker.expanded').waitFor();

    assert.deepEqual(errors, [], 'no page errors');
    console.log('MATERIAL-COMPARE-TOOLBAR-GEOMETRY', JSON.stringify(toolbarSpacing));
    console.log('MATERIAL-COMPARE-COMPONENT-OK');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
