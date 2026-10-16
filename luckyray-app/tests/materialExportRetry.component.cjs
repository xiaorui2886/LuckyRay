// Mount the production MaterialsPage + MaterialExportUI with the repository's
// esbuild/Playwright facility. Only the Tauri bridge is synthetic; retry
// promises are deliberately paused between click and native response.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules', 'vite'))] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');

const entry = String.raw`
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { I18nProvider } from './src/core/i18n/index';
  import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from './src/app/applicationModalIsolation';
  import MaterialsPage from './src/features/materials/MaterialsPage';
  const asset = { id: 'visible', name: 'visible.png', kind: 'image', mimeType: 'image/png',
    sizeBytes: 4, thumbnailUrl: '', previewUrl: '', folderId: null, storageMode: 'linked',
    importedAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' };
  const item = (id, state) => ({ assetId: id, name: id + '.png', state,
    outputPath: state === 'succeeded' ? 'D:/fixture/' + id + '.png' : null,
    error: state === 'failed' ? 'synthetic missing source' : null });
  const task = (id, items) => ({ taskId: id, destination: 'D:/fixture', preserveHierarchy: false,
    phase: 'completed', total: items.length, completed: items.length,
    succeeded: items.filter(i => i.state === 'succeeded').length,
    failed: items.filter(i => i.state === 'failed').length, cancelled: 0,
    currentFile: null, currentBytes: 0, currentTotalBytes: 0, items });
  let folderSerial = 0;
  let retrySerial = 0;
  const harness = { calls: [], retryMode: 'normal', dialogCancel: false,
    runningInitial: false, finishRunning: false, statusMode: 'normal', runningTask: null, pending: [], task,
    initial: () => task('parent-' + folderSerial,
      [item('first-' + folderSerial, 'succeeded'), item('second-' + folderSerial, 'failed'), item('third-' + folderSerial, 'failed')]) };
  window.__exportHarness = harness;
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    harness.calls.push({ command, args: structuredClone(args) });
    if (command === 'plugin:path|resolve_directory') return 'D:/fixture';
    if (command === 'plugin:dialog|open') return harness.dialogCancel ? null : 'D:/fixture';
    if (command === 'material_export_plan') {
      if (args.request.kind === 'folder') {
        folderSerial += 1;
        return { planId: 'initial-' + folderSerial, total: 3, scopeLabel: 'fixture', includesDescendants: true };
      }
      retrySerial += 1;
      const id = 'retry-plan-' + retrySerial;
      if (harness.retryMode === 'hold') return new Promise((resolve, reject) =>
        harness.pending.push({ resolve: () => resolve({ planId: id, total: args.request.assetIds.length,
          scopeLabel: 'failed only', includesDescendants: false }), reject }));
      if (harness.retryMode === 'fail-plan') throw Error('planned retry failed');
      return { planId: id, total: args.request.assetIds.length,
        scopeLabel: 'failed only', includesDescendants: false };
    }
    if (command === 'material_export_start') {
      if (args.planId.startsWith('initial-')) {
        if (harness.runningInitial) {
          harness.runningTask = { ...harness.initial(), phase: 'running', completed: 0,
            succeeded: 0, failed: 0, items: [item('first-' + folderSerial, 'queued'),
              item('second-' + folderSerial, 'queued'), item('third-' + folderSerial, 'queued')] };
          return harness.runningTask;
        }
        return harness.initial();
      }
      if (harness.retryMode === 'fail-start') throw Error('start retry failed');
      const requested = harness.calls.filter(call => call.command === 'material_export_plan' &&
        call.args.request.kind === 'assets').at(-1).args.request.assetIds;
      if (harness.retryMode === 'cancel-child') return { ...task('child-' + retrySerial,
        requested.map(id => item(id, 'cancelled'))), phase: 'cancelled', cancelled: requested.length };
      const round = args.planId === 'retry-plan-1' ?
        requested.map((id, index) => item(id, index === 0 ? 'succeeded' : 'failed')) :
        requested.map(id => item(id, 'succeeded'));
      return task('child-' + retrySerial, round);
    }
    if (command === 'material_export_discard_plan') return undefined;
    if (command === 'material_export_status') {
      if (harness.statusMode === 'transient-once') {
        harness.statusMode = 'normal';
        throw Error('temporary status failure');
      }
      if (harness.statusMode === 'expired') throw Error('导出任务不存在或摘要已过期');
      return harness.finishRunning ? harness.initial() : harness.runningTask;
    }
    if (command === 'list_favorite_items' || command === 'material_catalog_list_note_attachments') return [];
    if (command === 'favorite_item_counts' || command === 'get_favorite_item_counts') return { material: 0, note: 0 };
    if (command === 'get_local_transport_client_config') return { baseUrl: 'http://127.0.0.1:1', credential: '' };
    if (command === 'material_catalog_attachment_details') return { referenceCount: 0, references: [], ordinary: true, absolutePath: '' };
    return [];
  }};
  const bridge = { listAssets: async () => [asset], listAssetsFiltered: async () => [asset],
    listFolders: async () => [], getAssetsByIds: async ids => ids.includes('visible') ? [asset] : [],
    getMaterialChangeState: async () => null, listFavoriteItems: async () => [],
    getFavoriteItemCounts: async () => ({ material: 0, note: 0 }),
    getCollectionServerBaseUrl: async () => null };
  window.__LUCKYRAY__ = bridge;
  Object.defineProperty(window, '__LUCKYRAY__', { get: () => bridge, set: () => {}, configurable: true });
  window.fetch = async () => new Response(JSON.stringify({ capabilities: [] }),
    { headers: { 'Content-Type': 'application/json' } });
  localStorage.setItem('luckyray-settings-v1', JSON.stringify({ 'materials.importModePromptSeen': true }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('luckyray:bridge-ready')), 100);
  createRoot(document.getElementById('root')).render(
    <ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}>
      <I18nProvider locale="zh-CN"><MaterialsPage /></I18nProvider>
    </ApplicationModalIsolationProvider>);
`;

async function run() {
  const built = await esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'error' });
  const server = http.createServer((request, response) => {
    if (request.url === '/app.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(built.outputFiles[0].text);
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.__exportHarness && document.querySelector('[data-asset-id="visible"]'));
    const invokeCalls = command => page.evaluate(command => window.__exportHarness.calls
      .filter(call => call.command === command), command);
    const launch = async (expectStart = true) => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:materials-export-folder',
        { detail: { folderId: null } })));
      await page.getByRole('dialog', { name: '导出素材原文件' }).waitFor();
      // This legacy logic harness intentionally loads CSS as empty. Invoke the
      // production button directly; viewport hit testing is covered separately.
      await page.getByRole('button', { name: '选择导出位置并开始' }).evaluate(button => button.click());
      if (expectStart) await page.getByRole('dialog', { name: '导出素材原文件' }).waitFor({ state: 'hidden' });
      if (!await page.locator('#materials-export-panel').count()) {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:materials-toolbar-command',
          { detail: { type: 'toggle-export-tasks' } })));
      }
      await page.locator('#materials-export-panel').waitFor();
    };
    await launch();
    // IDs are not visible, so the first task section is the parent identity.
    const first = page.locator('[data-export-task-id="parent-1"]');
    await first.getByRole('button', { name: '仅重试失败项' }).waitFor();
    await page.evaluate(() => { window.__exportHarness.retryMode = 'hold'; });
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('[data-export-task-id="parent-1"] .material-export-row-actions button')]
        .find(node => node.textContent.includes('仅重试失败项'));
      button.click(); button.click();
    });
    await page.waitForFunction(() => window.__exportHarness.pending.length === 1);
    assert.equal((await invokeCalls('material_export_plan')).filter(call => call.args.request.kind === 'assets').length, 1,
      'two near clicks must make one retry plan');
    assert.equal(await first.getByRole('button', { name: '正在重试失败项…' }).isDisabled(), true);
    assert.equal(await first.getByRole('button', { name: '收起这条记录' }).isDisabled(), true,
      'an in-flight retry parent cannot be dismissed before its child is known');
    assert.equal(await page.getByRole('button', { name: '清空已完成记录' }).count(), 0,
      'clear-all must not erase the only in-flight retry parent or its gate');
    await page.evaluate(() => { window.__exportHarness.retryMode = 'normal'; window.__exportHarness.pending.shift().resolve(); });
    await page.waitForFunction(() => document.querySelectorAll('.material-export-task').length === 2);
    assert.equal(await first.getByRole('button', { name: '已由新任务接续' }).isDisabled(), true);
    const child = page.locator('[data-export-task-id="child-1"]');
    await child.getByRole('button', { name: '仅重试失败项' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.material-export-task').length === 3);
    const assetPlans = (await invokeCalls('material_export_plan')).filter(call => call.args.request.kind === 'assets');
    assert.deepEqual(assetPlans.map(call => call.args.request.assetIds),
      [['second-1', 'third-1'], ['third-1']], 'only child remaining failures continue');
    assert.equal((await invokeCalls('material_export_start')).length, 3,
      'one original plus exactly two child tasks');

    // A separate failed parent can recover after either plan or start failure;
    // the allocated plan is explicitly discarded when start rejects.
    await launch();
    await page.waitForFunction(() => document.querySelectorAll('.material-export-task').length === 4);
    const second = page.locator('[data-export-task-id="parent-2"]');
    await page.evaluate(() => { window.__exportHarness.retryMode = 'fail-plan'; });
    await second.getByRole('button', { name: '仅重试失败项' }).click();
    await second.getByRole('alert', { name: undefined }).waitFor();
    assert.equal(await second.getByRole('button', { name: '仅重试失败项' }).isEnabled(), true);
    await page.evaluate(() => { window.__exportHarness.retryMode = 'fail-start'; });
    await second.getByRole('button', { name: '仅重试失败项' }).click();
    await page.waitForFunction(() => window.__exportHarness.calls.some(call =>
      call.command === 'material_export_discard_plan'));
    assert.equal(await second.getByRole('button', { name: '仅重试失败项' }).isEnabled(), true);
    await page.evaluate(() => { window.__exportHarness.retryMode = 'normal'; });
    await second.getByRole('button', { name: '仅重试失败项' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.material-export-task').length === 5);
    assert.equal(await second.getByRole('button', { name: '已由新任务恢复' }).isDisabled(), true);

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:folder-select',
      { detail: { scope: 'materials', folderId: null } })));
    assert.equal(await page.locator('.material-export-task').count(), 5,
      'selection changes retain completed task identities and results');
    await page.evaluate(() => { window.__exportHarness.runningInitial = true; });
    await launch();
    await page.waitForFunction(() => document.querySelectorAll('.material-export-task').length === 6);
    const running = page.locator('[data-export-task-id="parent-3"]');
    await running.getByRole('button', { name: '取消任务' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:folder-select',
      { detail: { scope: 'materials', folderId: null } })));
    assert.equal(await running.getByRole('button', { name: '取消任务' }).count(), 1,
      'selection change keeps the in-flight task object');
    await page.evaluate(() => { window.__exportHarness.statusMode = 'transient-once'; });
    await running.getByRole('alert').waitFor();
    await running.getByRole('alert').waitFor({ state: 'hidden' });
    assert.equal(await running.getByRole('button', { name: '取消任务' }).isEnabled(), true,
      'one transient query failure recovers without losing cancellation');
    await page.evaluate(() => { window.__exportHarness.finishRunning = true; });
    await running.getByRole('button', { name: '仅重试失败项' }).waitFor();
    assert.equal(await page.locator('.material-export-task').count(), 6,
      'poll completion remains attached to the original task card');
    await page.evaluate(() => { window.__exportHarness.dialogCancel = true; });
    const startsBeforeCancel = (await invokeCalls('material_export_start')).length;
    await launch(false);
    await page.waitForTimeout(100);
    assert.equal((await invokeCalls('material_export_start')).length, startsBeforeCancel,
      'directory picker cancellation never starts copying');
    await page.evaluate(() => {
      window.__exportHarness.dialogCancel = false;
      window.__exportHarness.finishRunning = false;
      window.__exportHarness.statusMode = 'expired';
    });
    await launch();
    const latestInitialPlan = (await invokeCalls('material_export_start'))
      .filter(call => call.args.planId.startsWith('initial-')).at(-1).args.planId;
    const expired = page.locator('[data-export-task-id="' + latestInitialPlan.replace('initial-', 'parent-') + '"]');
    await expired.getByText('任务摘要已过期，无法继续查询或取消').waitFor();
    assert.equal(await expired.getByRole('button', { name: '取消任务' }).isDisabled(), true);
    const statusCallsAtStop = (await invokeCalls('material_export_status')).length;
    await page.waitForTimeout(1100);
    assert.equal((await invokeCalls('material_export_status')).length, statusCallsAtStop,
      'an exact expired summary stops polling instead of repeating alerts');
    await page.evaluate(() => {
      window.__exportHarness.runningInitial = false;
      window.__exportHarness.statusMode = 'normal';
      window.__exportHarness.retryMode = 'cancel-child';
    });
    await launch();
    const cancelledChildParentPlan = (await invokeCalls('material_export_start'))
      .filter(call => call.args.planId.startsWith('initial-')).at(-1).args.planId;
    const cancelledChildParent = page.locator('[data-export-task-id="' + cancelledChildParentPlan.replace('initial-', 'parent-') + '"]');
    await cancelledChildParent.getByRole('button', { name: '仅重试失败项' }).click();
    await cancelledChildParent.getByRole('button', { name: '已由新任务接续' }).waitFor();
    assert.equal(await cancelledChildParent.getByRole('button', { name: '已由新任务恢复' }).count(), 0,
      'cancelled child with zero failures is not a recovered parent');
    assert.deepEqual(pageErrors, [], 'production page has no uncaught browser errors');
    console.log('MATERIAL-EXPORT-RETRY-PRODUCTION-COMPONENT-OK');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

const timeout = setTimeout(() => { console.error('MATERIAL-EXPORT-RETRY-TIMEOUT'); process.exit(124); }, 60_000);
run().then(() => clearTimeout(timeout)).catch(error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
