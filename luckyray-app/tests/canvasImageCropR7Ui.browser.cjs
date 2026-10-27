// Dedicated real-browser crop contracts. All assets/data are local and synthetic.
// Mouse gestures use Playwright input and verified native pointer capture.
// pointercancel is a real DOM PointerEvent dispatch, not an Escape substitute.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const requireTool = process.env.LR_BROWSER_TOOLS
  ? createRequire(path.join(process.env.LR_BROWSER_TOOLS, 'package.json')) : require;
const { chromium } = requireTool('playwright');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules/vite'))] }));
const out = process.env.LR_IMAGE_CROP_UI_OUT || path.join(root, 'output/canvas-image-crop-r7-ui');
const expectedChecks = 29;
const rectKeys = ['x', 'y', 'width', 'height'];
const fullCrop = { x: 0, y: 0, width: 1, height: 1 };
const colors = {
  red: [255, 0, 0, 255], green: [0, 255, 0, 255], blue: [0, 0, 255, 255], yellow: [255, 255, 0, 255],
  cyan: [0, 255, 255, 255], magenta: [255, 0, 255, 255], white: [255, 255, 255, 255], black: [0, 0, 0, 255],
};
function near(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);
}
function sameRect(actual, expected, message, tolerance = 1e-6) {
  for (const key of rectKeys) near(actual[key], expected[key], `${message} ${key}`, tolerance);
}
function legal(rect) {
  assert.ok(Object.values(rect).every(Number.isFinite), 'finite crop');
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001, 'crop stays inside source');
  assert.ok(rect.width * 400 >= 1 - 1e-6 && rect.height * 300 >= 1 - 1e-6, 'at least one source pixel');
}
function anchors(before, after, handle) {
  if (handle.includes('w')) near(after.x + after.width, before.x + before.width, `${handle} right anchor`);
  else if (handle.includes('e')) near(after.x, before.x, `${handle} left anchor`);
  else near(after.x + after.width / 2, before.x + before.width / 2, `${handle} horizontal center`);
  if (handle.includes('n')) near(after.y + after.height, before.y + before.height, `${handle} bottom anchor`);
  else if (handle.includes('s')) near(after.y, before.y, `${handle} top anchor`);
  else near(after.y + after.height / 2, before.y + before.height / 2, `${handle} vertical center`);
}
function assertPixels(saved, expected, message) {
  assert.equal(saved.mime, 'image/png');
  assert.ok(saved.bytes > 0);
  assert.equal(saved.pixels.length, 16, 'decode sixteen interior PNG pixels');
  for (const pixel of saved.pixels) {
    assert.deepEqual(pixel.rgba, expected(pixel, saved), `${message} at (${pixel.x},${pixel.y})`);
  }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ jsx: 'automatic', entryPoints: [path.join(__dirname, 'canvasImageCropR7Ui.fixture.tsx')], bundle: true, outfile: path.join(out, 'fixture.js'), loader: { '.css': 'css' } });
  const html = `<!doctype html><html data-theme="dark"><meta charset="UTF-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%;font-family:Arial,'Noto Sans CJK SC',sans-serif;background:var(--theme-app-bg);color:var(--text-primary)}*{box-sizing:border-box}.crop-contract-fixture{min-height:100%;padding:20px;background:radial-gradient(var(--theme-border-strong) 1px,transparent 1px) 0 0/22px 22px}.crop-contract-controls{display:flex;gap:8px;flex-wrap:wrap}.crop-contract-controls button{background:var(--theme-surface-raised);color:var(--text-primary);border:1px solid var(--theme-border-strong);border-radius:8px;padding:8px}.crop-contract-fixture p{font-size:12px;color:var(--text-secondary)}</style><div id="root"></div><script src="/fixture.js"></script></html>`;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); }
    else if (['/fixture.js', '/fixture.css'].includes(pathname)) {
      response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(fs.readFileSync(path.join(out, pathname.slice(1))));
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, context, page, failure = null;
  const checks = [], errors = [], unexpectedRequests = [], failedRequests = [], cancelledLocalReads = [];
  const notRun = [{ contract: 'real touch / pen input', status: 'NOT_RUN', reason: 'This suite verifies native mouse pointer capture and DOM pointercancel. No touch, pen, or OS-level cancellation claim is made.' }];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.LR_CHROMIUM ? { executablePath: process.env.LR_CHROMIUM } : {}) });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      unexpectedRequests.push(url.href);
      return route.abort();
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    page.on('requestfailed', request => {
      const entry = { url: request.url(), error: request.failure()?.errorText };
      // React StrictMode and changing the source intentionally abort obsolete
      // media reads. Record those, but do not misreport cancellation as failure.
      if (/^(data:|blob:)/.test(entry.url) && entry.error === 'net::ERR_ABORTED') cancelledLocalReads.push(entry);
      else failedRequests.push(entry);
    });
    // Observation only: preserve the native pointer ID instead of guessing it.
    await page.addInitScript(() => {
      window.__r7CropPointer = null;
      document.addEventListener('pointerdown', event => {
        if (event.target instanceof Element && event.target.closest('[data-crop-handle]')) {
          window.__r7CropPointer = { id: event.pointerId, type: event.pointerType, trusted: event.isTrusted };
        }
      }, true);
    });
    await page.goto(origin);
    const dialog = page.getByRole('dialog', { name: 'Image tools', exact: true });
    const stage = page.locator('.canvas-image-crop-stage');
    const selection = page.locator('.canvas-image-crop-selection');
    const handle = name => page.locator(`[data-crop-handle="${name}"]`);
    const input = name => page.getByRole('spinbutton', { name, exact: true });
    const dimensions = async () => ({ width: Number(await input('output-width').inputValue()), height: Number(await input('output-height').inputValue()) });
    const readCrop = () => selection.evaluate(element => ({ x: parseFloat(element.style.left) / 100, y: parseFloat(element.style.top) / 100, width: parseFloat(element.style.width) / 100, height: parseFloat(element.style.height) / 100 }));
    const diagnostics = async () => JSON.parse(await page.locator('#crop-fixture-diagnostics').textContent());
    const control = action => page.evaluate(action => document.dispatchEvent(new CustomEvent('r7-crop-fixture-control', { detail: action })), action);
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const settle = async () => {
      await dialog.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
      await frames();
      assert.equal(await dialog.evaluate(element => getComputedStyle(element).opacity), '1');
    };
    const ready = async (width = 400, height = 300) => {
      await page.waitForFunction(({ width, height }) => {
        const stage = document.querySelector('.canvas-image-crop-stage');
        const canvas = stage?.querySelector('canvas');
        return stage && !stage.classList.contains('is-disabled') && canvas?.width === width && canvas?.height === height;
      }, { width, height });
      await frames();
    };
    const fresh = async () => {
      if (await dialog.count()) await page.getByRole('button', { name: 'Close', exact: true }).click();
      await control('source-primary');
      await page.getByRole('button', { name: 'Open synthetic crop editor', exact: true }).click();
      await dialog.waitFor();
      await settle();
      await ready();
      sameRect(await readCrop(), fullCrop, 'fresh source');
    };
    const cropField = async (key, percent) => { await input(`${key}-crop`).fill(String(percent)); await frames(); };
    const initialFree = async () => {
      await fresh();
      await cropField('width', 50); await cropField('height', 50);
      await cropField('x', 25); await cropField('y', 25);
      sameRect(await readCrop(), { x: .25, y: .25, width: .5, height: .5 }, 'free starting crop');
    };
    const outputWidth = async value => { await input('output-width').fill(String(value)); await input('output-width').press('Tab'); await frames(); };
    const assertFields = async rect => {
      for (const key of rectKeys) near(Number(await input(`${key}-crop`).inputValue()), Number((rect[key] * 100).toFixed(2)), `${key} percent field`);
    };
    const begin = async (name, dx, dy) => {
      const target = handle(name), box = await target.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0, `${name} reachable handle`);
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      const pointer = await page.evaluate(() => window.__r7CropPointer);
      assert.ok(pointer?.trusted && pointer.type === 'mouse', 'genuine Playwright mouse input');
      assert.equal(await target.evaluate((element, id) => element.hasPointerCapture(id), pointer.id), true, `${name} captures native pointer`);
      await page.mouse.move(x + dx, y + dy, { steps: 6 }); await frames();
      assert.equal(await stage.evaluate(element => element.classList.contains('is-dragging')), true);
      return { target, pointerId: pointer.id, x: x + dx, y: y + dy };
    };
    const drag = async (name, dx, dy) => {
      const gesture = await begin(name, dx, dy);
      await page.mouse.up(); await frames();
      assert.equal(await gesture.target.evaluate((element, id) => element.hasPointerCapture(id), gesture.pointerId), false, 'pointer capture released on pointerup');
      assert.equal(await stage.evaluate(element => element.classList.contains('is-dragging')), false);
      return readCrop();
    };
    const screenshot = async name => { await settle(); await page.screenshot({ path: path.join(out, name) }); };
    const save = async () => {
      const before = (await diagnostics()).completed;
      await page.getByRole('button', { name: 'Save copy to canvas', exact: true }).click();
      await page.waitForFunction(count => JSON.parse(document.querySelector('#crop-fixture-diagnostics').textContent).completed === count + 1, before);
      await page.getByRole('button', { name: 'Save copy to canvas', exact: true }).waitFor();
      const state = await diagnostics();
      return state.saves[state.saves.length - 1];
    };

    await fresh();
    assert.equal(await handle('move').isEnabled(), true);
    assert.equal(await page.locator('[data-crop-handle]').count(), 9);
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1441 && bounds.y + bounds.height <= 1001);
    await screenshot('crop-initial-dark.png');
    checks.push('production crop editor loads local 400x300 source with nine enabled handles and visible dialog');

    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const name of handles) {
      await initialFree();
      const before = await readCrop(), box = await stage.boundingBox();
      const dx = name.includes('w') ? .05 : name.includes('e') ? -.05 : 0;
      const dy = name.includes('n') ? .05 : name.includes('s') ? -.05 : 0;
      const after = await drag(name, box.width * dx, box.height * dy);
      legal(after); anchors(before, after, name);
      sameRect(after, {
        x: before.x + (name.includes('w') ? dx : 0),
        y: before.y + (name.includes('n') ? dy : 0),
        width: before.width + (name.includes('w') ? -dx : dx),
        height: before.height + (name.includes('n') ? -dy : dy),
      }, `free ${name}`, .001);
      await assertFields(after);
      assert.deepEqual(await dimensions(), { width: Math.round(after.width * 400), height: Math.round(after.height * 300) });
      checks.push(`free ${name}: real pointer capture, intended edges, opposite anchors, percent fields, output size`);
    }
    for (const name of handles) {
      await fresh();
      await page.getByRole('combobox', { name: 'Crop aspect ratio', exact: true }).selectOption({ label: '1:1' });
      await cropField('width', 40); await cropField('x', 20); await cropField('y', 20);
      await outputWidth(137);
      const before = await readCrop(), box = await stage.boundingBox();
      const scale = 137 / (before.width * 400);
      const dx = name.includes('w') ? .04 : name.includes('e') ? -.04 : 0;
      const dy = name.includes('n') ? .04 : name.includes('s') ? -.04 : 0;
      const after = await drag(name, box.width * dx, box.height * dy);
      legal(after); anchors(before, after, name);
      assert.ok(after.width < before.width && after.height < before.height, `${name} shrinks both fixed-ratio sides`);
      near(after.width * 400 / (after.height * 300), 1, `${name} source-pixel square, not normalized-coordinate square`);
      assert.deepEqual(await dimensions(), { width: Math.round(after.width * 400 * scale), height: Math.round(after.height * 300 * scale) });
      await assertFields(after);
      checks.push(`fixed ${name}: source-pixel ratio, anchors/center, both sides resize, manual output scale`);
    }
    await screenshot('crop-fixed-ratio-all-handles.png');

    await initialFree(); await outputWidth(137);
    let before = await readCrop(), originalOutput = await dimensions(), box = await stage.boundingBox();
    let after = await drag('move', box.width * .125, -box.height * .125);
    sameRect(after, { ...before, x: before.x + .125, y: before.y - .125 }, 'interior source movement', .001);
    assert.deepEqual(await dimensions(), originalOutput, 'translation preserves output dimensions');
    await assertFields(after);
    checks.push('inside move: captured real pointer translates only position and preserves manual output size');

    // Retain the original R7C keyboard and Escape contracts in this dedicated
    // suite, independently of the older creative-panel regression fixture.
    await initialFree(); await outputWidth(137);
    before = await readCrop();
    await handle('move').focus(); await page.keyboard.press('ArrowRight'); await frames();
    after = await readCrop();
    near(after.x - before.x, 1 / 400, 'ArrowRight moves one source pixel');
    await page.keyboard.press('Shift+ArrowDown'); await frames();
    after = await readCrop();
    near(after.y - before.y, 10 / 300, 'Shift+ArrowDown moves ten source pixels');
    checks.push('keyboard Arrow/Shift+Arrow move the selection by exactly 1/10 original source pixels');
    const escapeRect = after, escapeOutput = await dimensions();
    box = await stage.boundingBox();
    await begin('se', -box.width * .06, -box.height * .06);
    assert.notDeepEqual(await readCrop(), escapeRect);
    await page.keyboard.press('Escape'); await page.mouse.up(); await frames();
    assert.equal(await dialog.count(), 1, 'Escape cancels the active crop gesture instead of closing editor');
    sameRect(await readCrop(), escapeRect, 'Escape restores exact pre-gesture crop');
    assert.deepEqual(await dimensions(), escapeOutput, 'Escape restores scaled output dimensions');
    checks.push('Escape restores active captured gesture and scaled output, without closing editor');

    await fresh();
    const ratio = page.getByRole('combobox', { name: 'Crop aspect ratio', exact: true });
    await ratio.selectOption({ label: '1:1' }); await outputWidth(137);
    const stableScale = 137 / 300;
    for (let cycle = 0; cycle < 12; cycle++) {
      for (const label of ['16:9', '3:4', '4:3', '1:1']) {
        await ratio.selectOption({ label }); await frames();
        const rect = await readCrop();
        assert.deepEqual(await dimensions(), { width: Math.round(rect.width * 400 * stableScale), height: Math.round(rect.height * 300 * stableScale) }, `cycle ${cycle} ${label} never feeds rounded sizes back into scale`);
      }
      assert.deepEqual(await dimensions(), { width: 137, height: 137 });
    }
    checks.push('12 aspect cycles (48 changes) preserve the same output scale without rounding drift');

    // The actual east-handle gesture selects only the left half of the source.
    // Thus green/yellow in any decoded output would reveal a wrong source crop.
    await fresh(); box = await stage.boundingBox();
    after = await drag('e', -box.width / 2, 0);
    near(after.width, .5, 'drag selects left source half', .001);
    // Normalize possible sub-CSS-pixel input quantization to an exact 200px edge.
    await cropField('width', 49); await cropField('width', 50); await outputWidth(100);
    let saved = await save();
    assert.deepEqual({ width: saved.width, height: saved.height }, { width: 100, height: 150 });
    sameRect(saved.edit.crop, { x: 0, y: 0, width: .5, height: 1 }, 'saved left half');
    assertPixels(saved, (pixel, image) => pixel.y < image.height / 2 ? colors.red : colors.blue, 'left-half PNG source pixels');
    checks.push('save left-half crop: decoded 100x150 PNG contains red above blue and excludes right-source colors');
    await page.getByRole('button', { name: 'Rotate 90°', exact: true }).click(); await frames();
    saved = await save();
    assert.equal(saved.edit.turns, 1);
    assert.deepEqual({ width: saved.width, height: saved.height }, { width: 150, height: 100 });
    sameRect(saved.edit.crop, { x: 0, y: 0, width: 1, height: .5 }, 'rotated selected source region');
    assertPixels(saved, (pixel, image) => pixel.x < image.width / 2 ? colors.blue : colors.red, '90-degree PNG orientation');
    checks.push('rotate 90 then save: decoded 150x100 PNG contains blue left/red right, preserving selected source region');
    await page.getByRole('button', { name: 'Flip horizontally', exact: true }).click(); await frames();
    saved = await save();
    assert.equal(saved.edit.turns, 1); assert.equal(saved.edit.flipX, true);
    assert.deepEqual({ width: saved.width, height: saved.height }, { width: 150, height: 100 });
    assertPixels(saved, (pixel, image) => pixel.x < image.width / 2 ? colors.red : colors.blue, 'rotated and horizontally flipped PNG');
    checks.push('horizontal flip after rotation then save: decoded source colors reverse left/right with unchanged output dimensions');
    await screenshot('crop-rotated-flipped-source.png');
    await page.getByRole('button', { name: 'Reset crop', exact: true }).click(); await frames();
    sameRect(await readCrop(), fullCrop, 'Reset crop restores full source, not transform');
    assert.deepEqual(await stage.locator('canvas').evaluate(element => ({ width: element.width, height: element.height })), { width: 300, height: 400 });
    saved = await save();
    assert.equal(saved.itemId, 'quadrants-primary');
    assert.equal(saved.edit.turns, 1); assert.equal(saved.edit.flipX, true);
    assert.deepEqual({ width: saved.width, height: saved.height }, { width: 150, height: 200 });
    assertPixels(saved, (pixel, image) => pixel.y < image.height / 2
      ? (pixel.x < image.width / 2 ? colors.red : colors.blue)
      : (pixel.x < image.width / 2 ? colors.green : colors.yellow), 'reset retains rotated/flipped original');
    checks.push('reset crop restores the full original source while retaining 90-degree rotation, horizontal flip, and manual scale');

    await initialFree();
    await control('hold-save');
    const countBefore = await diagnostics(), heldRect = await readCrop();
    await page.getByRole('button', { name: 'Save copy to canvas', exact: true }).click();
    await page.waitForFunction(count => {
      const state = JSON.parse(document.querySelector('#crop-fixture-diagnostics').textContent);
      return state.pending && state.invocations === count + 1 && state.saves.length === count + 1;
    }, countBefore.invocations);
    assert.equal(await page.locator('.canvas-image-tools-layout').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('fieldset').evaluate(element => element.disabled), true);
    assert.equal(await page.locator('fieldset button, fieldset input, fieldset select').evaluateAll(elements => elements.every(element => element.matches(':disabled'))), true);
    assert.equal(await page.locator('[data-crop-handle]').evaluateAll(elements => elements.every(element => element.disabled)), true);
    const heldSave = page.getByRole('button', { name: 'Saving…', exact: true });
    assert.equal(await heldSave.isDisabled(), true);
    const moveBox = await handle('move').boundingBox();
    await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2); await page.mouse.down();
    await page.mouse.move(moveBox.x + moveBox.width / 2 + 30, moveBox.y + moveBox.height / 2 + 20, { steps: 4 }); await page.mouse.up();
    // Explicit duplicate-event stress while the callback promise remains pending.
    await heldSave.dispatchEvent('click'); await heldSave.dispatchEvent('click');
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await page.keyboard.press('Escape');
    await frames(); await frames();
    assert.equal(await dialog.count(), 1, 'close and Escape cannot discard an in-flight save');
    sameRect(await readCrop(), heldRect, 'pending save blocks pointer mutation');
    assert.equal((await diagnostics()).invocations, countBefore.invocations + 1, 'only one onSave invocation');
    assert.equal((await diagnostics()).completed, countBefore.completed, 'deferred onSave really remains unresolved');
    await screenshot('crop-save-pending-disabled.png');
    await control('release-save');
    await page.waitForFunction(count => {
      const state = JSON.parse(document.querySelector('#crop-fixture-diagnostics').textContent);
      return !state.pending && state.completed === count + 1;
    }, countBefore.completed);
    await ready();
    assert.equal(await page.getByRole('button', { name: 'Save copy to canvas', exact: true }).isEnabled(), true);
    sameRect(await readCrop(), heldRect, 'resolved save leaves original selection');
    checks.push('deferred save: all edit controls and handles disabled, drag/duplicate/close blocked, release restores editor');

    await initialFree(); before = await readCrop(); box = await stage.boundingBox();
    const oldGesture = await begin('move', box.width * .08, box.height * .08);
    assert.notDeepEqual(await readCrop(), before, 'old gesture moved before source change');
    const oldTarget = await oldGesture.target.elementHandle();
    await control('source-secondary'); await ready(320, 240);
    assert.equal((await diagnostics()).source, 'secondary');
    sameRect(await readCrop(), fullCrop, 'new source starts full');
    assert.equal(await oldTarget.evaluate((element, id) => element.hasPointerCapture(id), oldGesture.pointerId), false, 'old gesture pointer capture released, whether DOM was reused or detached');
    await page.mouse.move(oldGesture.x + 35, oldGesture.y + 25, { steps: 4 }); await page.mouse.up(); await frames();
    sameRect(await readCrop(), fullCrop, 'old pointer continuation cannot leak previous crop');
    assert.deepEqual(await dimensions(), { width: 320, height: 240 });
    saved = await save(); assert.equal(saved.itemId, 'quadrants-secondary');
    assert.deepEqual({ width: saved.width, height: saved.height }, { width: 320, height: 240 });
    assertPixels(saved, (pixel, image) => pixel.y < image.height / 2
      ? (pixel.x < image.width / 2 ? colors.cyan : colors.magenta)
      : (pixel.x < image.width / 2 ? colors.white : colors.black), 'new source PNG after old gesture');
    checks.push('source changes during native capture: old gesture/crop invalidated, new full crop and decoded new-source pixels stay intact');
    await screenshot('crop-source-change-no-leak.png');

    await initialFree(); before = await readCrop(); originalOutput = await dimensions(); box = await stage.boundingBox();
    const cancelled = await begin('se', -box.width * .08, -box.height * .08);
    assert.notDeepEqual(await readCrop(), before, 'gesture updates before pointercancel');
    await cancelled.target.dispatchEvent('pointercancel', { pointerId: cancelled.pointerId, pointerType: 'mouse', isPrimary: true, bubbles: true, button: 0 });
    await frames();
    sameRect(await readCrop(), before, 'DOM pointercancel rolls back source rectangle');
    assert.deepEqual(await dimensions(), originalOutput, 'pointercancel rolls back output size');
    assert.equal(await cancelled.target.evaluate((element, id) => element.hasPointerCapture(id), cancelled.pointerId), false);
    assert.equal(await stage.evaluate(element => element.classList.contains('is-dragging')), false);
    assert.equal(await dialog.getByText('Crop adjustment cancelled.', { exact: true }).count(), 1);
    await page.mouse.move(cancelled.x - 20, cancelled.y - 20, { steps: 3 }); await page.mouse.up(); await frames();
    sameRect(await readCrop(), before, 'pointer continuation after cancel does not recommit');
    checks.push('DOM pointercancel during native capture: rectangle/output rollback, capture release, no later move/up recommit');
    await screenshot('crop-pointercancel-rollback.png');

    assert.deepEqual(errors, [], 'no page or console errors');
    assert.deepEqual(unexpectedRequests, [], 'localhost/data/blob allowlist only');
    assert.deepEqual(failedRequests, [], 'no failed allowed requests');
    checks.push('strict runtime integrity: no page/console errors, denied external requests, or failed local requests');
    assert.equal(checks.length, expectedChecks);
    console.log(`${checks.length} checks passed: ${out}; touch/pen: NOT_RUN`);
  } catch (error) {
    failure = String(error?.stack || error);
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    // Keep the actual emitted PNG bytes as well as independently decoded
    // samples, including any successful saves before a later assertion fails.
    let saveDiagnostics = null;
    if (page) {
      try { saveDiagnostics = JSON.parse(await page.locator('#crop-fixture-diagnostics').textContent({ timeout: 1000 })); } catch {}
    }
    if (saveDiagnostics) {
      saveDiagnostics.saves = saveDiagnostics.saves.map(({ pngBase64, ...saved }, index) => {
        const artifact = `saved-png-${String(index + 1).padStart(2, '0')}.png`;
        fs.writeFileSync(path.join(out, artifact), Buffer.from(pngBase64, 'base64'));
        return { ...saved, artifact };
      });
    }
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify({ checks, expectedChecks, errors, unexpectedRequests, failedRequests, cancelledLocalReads, failure, notRun, saveDiagnostics, fixture: 'synthetic-local-quadrants-no-native-or-provider' }, null, 2));
    await context?.tracing.stop({ path: path.join(out, 'trace.zip') }).catch(() => {});
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    esbuild.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
