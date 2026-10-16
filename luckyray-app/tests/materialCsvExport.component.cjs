// Production MaterialsPage + Tauri-bridge simulation. The native save dialog
// promise is paused to exercise the real controller's async guard and focus.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules', 'vite'))] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
const screenshots = process.env.LUCKYRAY_CSV_ENTRY_SCREENSHOTS;

const entry = String.raw`
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { I18nProvider } from './src/core/i18n/index';
  import { AppSidebar } from './src/app/AppSidebar';
  import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from './src/app/applicationModalIsolation';
  import MaterialsPage from './src/features/materials/MaterialsPage';
  import './src/App.css';
  import './src/core/theme/themeTokens.css';
  import './src/app/appShell.css';
  import './src/components/experienceLayer.css';
  import './src/features/materials/materials.css';
  const asset = { id: 'fixture-asset', name: 'fixture.txt', kind: 'text', mimeType: 'text/plain',
    sizeBytes: 10, thumbnailUrl: '', previewUrl: '', folderId: 'folder-a', storageMode: 'linked',
    importedAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z' };
  const folder = { id: 'folder-a', name: '超长中文分类名'.repeat(30), parentId: null, children: [] };
  const harness = { calls: [], pendingSaves: [], saveMode: 'hold', retryMode: 'normal', retryPending: [],
    status: { taskId: 'csv-1', phase: 'running', total: 1, completed: 0,
      outputPath: null, destination: 'D:/fixture/list.csv', error: null } };
  window.__csvHarness = harness;
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    harness.calls.push({ command, args: structuredClone(args) });
    if (command === 'plugin:path|resolve_directory') return 'D:/fixture';
    if (command === 'plugin:path|join') return args.paths.join('/');
    if (command === 'plugin:dialog|save') return new Promise(resolve => harness.pendingSaves.push(resolve));
    if (command === 'material_csv_export_plan') return { planId: 'csv-plan', total: 1,
      scopeLabel: 'Test Folder', includesDescendants: true };
    if (command === 'material_csv_export_start') return harness.status;
    if (command === 'material_csv_export_status') return harness.status;
    if (command === 'material_csv_export_cancel') {
      harness.status = { ...harness.status, phase: 'cancelling' }; return harness.status;
    }
    if (command === 'material_csv_export_retry') {
      if (harness.retryMode === 'hold') return new Promise((resolve, reject) => harness.retryPending.push({ resolve, reject }));
      return { ...harness.status, taskId: 'csv-retry', phase: 'completed', completed: 1,
        outputPath: 'D:/fixture/list (1).csv', error: null };
    }
    if (command === 'list_favorite_items' || command === 'material_catalog_list_note_attachments') return [];
    if (command === 'favorite_item_counts' || command === 'get_favorite_item_counts') return { material: 0, note: 0 };
    if (command === 'get_local_transport_client_config') return { baseUrl: 'http://127.0.0.1:1', credential: '' };
    if (command === 'material_catalog_attachment_details') return { referenceCount: 0, references: [], ordinary: true, absolutePath: '' };
    return [];
  } };
  const bridge = { listAssets: async () => [asset], listAssetsFiltered: async () => [asset],
    listFolders: async () => [folder], getAssetsByIds: async ids => ids.includes(asset.id) ? [asset] : [],
    getMaterialChangeState: async () => null, listFavoriteItems: async () => [],
    getFavoriteItemCounts: async () => ({ material: 0, note: 0 }),
    getCollectionServerBaseUrl: async () => null };
  Object.defineProperty(window, '__LUCKYRAY__', { get: () => bridge, set: () => {}, configurable: true });
  window.fetch = async () => new Response(JSON.stringify({ capabilities: [] }),
    { headers: { 'Content-Type': 'application/json' } });
  localStorage.setItem('luckyray-settings-v1', JSON.stringify({ 'materials.importModePromptSeen': true }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('luckyray:bridge-ready')), 100);
  createRoot(document.getElementById('root')).render(
    <ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}>
      <I18nProvider locale="zh-CN"><AppSidebar route="materials" onNavigate={() => {}} /><main style={{flex:1,minWidth:0}}><MaterialsPage /></main></I18nProvider>
    </ApplicationModalIsolationProvider>);
`;

async function run() {
  const built = await esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, outdir: 'out', format: 'iife', jsx: 'automatic', loader: { '.svg': 'dataurl', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'error' });
  const js = built.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  const css = built.outputFiles.find(file => file.path.endsWith('.css'))?.text;
  assert.ok(js && css && !css.includes('.material-csv-folder-entry') && css.includes('.folder-ctx-react'));
  const server = http.createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
    else if (request.url === '/app.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root" class="react-nav-shell" data-route="materials"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 }, deviceScaleFactor: 1.5 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => document.querySelector('[data-asset-id="fixture-asset"]'));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:folder-select',
      { detail: { scope: 'materials', folderId: 'folder-a' } })));
    assert.equal(await page.locator('.material-csv-folder-entry').count(), 0);
    const folder = page.locator('.sidebar [data-folder-id="folder-a"]').first();
    await folder.click({ button: 'right' });
    const folderButton = page.getByRole('menuitem', { name: '导出此分类清单（CSV）' });
    await folderButton.waitFor();
    await folderButton.click();
    const dialog = page.getByRole('dialog', { name: '导出素材清单（CSV）' });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /1 条素材记录/);
    assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
    await dialog.getByRole('button', { name: '选择保存位置' }).click();
    await page.waitForFunction(() => window.__csvHarness.pendingSaves.length === 1);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 1, 'native chooser cannot be escaped');
    assert.equal(await dialog.getByRole('button', { name: '选择保存位置' }).isDisabled(), true);
    await page.evaluate(() => window.__csvHarness.pendingSaves.shift()(null));
    await dialog.getByRole('button', { name: '选择保存位置' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.material-csv-plan button.primary').disabled);
    assert.equal(await page.evaluate(() => window.__csvHarness.calls.filter(call =>
      call.command === 'material_csv_export_start').length), 0, 'dialog cancel never writes');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '选择保存位置' }).click();
    await page.waitForFunction(() => window.__csvHarness.pendingSaves.length === 1);
    await page.evaluate(() => window.__csvHarness.pendingSaves.shift()('D:/fixture/list.csv'));
    await dialog.waitFor({ state: 'hidden' });
    const starts = await page.evaluate(() => window.__csvHarness.calls.filter(call =>
      call.command === 'material_csv_export_start'));
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.includeDescription, true);
    assert.equal(starts[0].args.destination, 'D:/fixture/list.csv');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('luckyray:materials-toolbar-command',
      { detail: { type: 'toggle-export-tasks' } })));
    const panel = page.locator('#materials-export-panel');
    await panel.waitFor();
    await panel.getByRole('button', { name: '取消任务' }).click();
    assert.equal(await page.evaluate(() => window.__csvHarness.calls.filter(call =>
      call.command === 'material_csv_export_cancel').length), 1);
    await page.evaluate(() => { window.__csvHarness.status = { ...window.__csvHarness.status,
      phase: 'failed', error: 'synthetic write failure' }; });
    await panel.getByRole('button', { name: '重试此清单' }).waitFor();
    await page.evaluate(() => { window.__csvHarness.retryMode = 'hold';
      const button = [...document.querySelectorAll('.material-csv-task button')]
        .find(node => node.textContent.includes('重试此清单')); button.click(); button.click(); });
    await page.waitForFunction(() => window.__csvHarness.retryPending.length === 1);
    assert.equal(await page.evaluate(() => window.__csvHarness.calls.filter(call =>
      call.command === 'material_csv_export_retry').length), 1, 'rapid retry creates one child');
    await page.evaluate(() => window.__csvHarness.retryPending.shift().resolve({ ...window.__csvHarness.status,
      taskId: 'csv-retry', phase: 'completed', error: null, completed: 1, outputPath: 'D:/fixture/list (1).csv' }));
    await panel.getByText('已完成', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('MATERIAL-CSV-PRODUCTION-COMPONENT-OK');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

const timeout = setTimeout(() => { console.error('MATERIAL-CSV-COMPONENT-TIMEOUT'); process.exit(124); }, 60_000);
run().then(() => clearTimeout(timeout)).catch(error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
