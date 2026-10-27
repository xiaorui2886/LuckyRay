// Real production export component + titlebar + theme/CSS geometry. Only data
// and native IPC are synthetic. This is intentionally separate from the
// CSS-empty async controller test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules', 'vite'))] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
  'playwright');
const output = process.env.LUCKYRAY_EXPORT_UX_SCREENSHOTS || path.join(root, 'output', 'playwright');

const entry = String.raw`
  import React, { useEffect, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { I18nProvider } from './src/core/i18n/index';
  import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from './src/app/applicationModalIsolation';
  import { AppTitlebar } from './src/app/AppSidebar';
  import { MaterialExportUI } from './src/features/materials/MaterialExportUI';
  import { MaterialCsvExportDialog } from './src/features/materials/MaterialCsvExportUI';
  import { isMaterialExportRunning, upsertMaterialExportTask } from './src/features/materials/materialExportPresentation';
  import { publishMaterialsToolbarState } from './src/features/materials/materialsToolbarProtocol';
  import './src/core/theme/themeTokens.css';
  import './src/app/appShell.css';
  import './src/components/experienceLayer.css';
  import './src/features/materials/materials.css';

  const makeTask = (id, phase, destination, total = 1) => ({
    taskId: id, destination, preserveHierarchy: false, phase, total,
    completed: phase === 'running' ? 0 : total,
    succeeded: phase === 'completed' ? total : 0,
    failed: phase === 'failed' ? total : 0,
    cancelled: phase === 'cancelled' ? total : 0,
    currentFile: phase === 'running' ? 'a-very-long-current-file-' + 'x'.repeat(120) + '.mp4' : null,
    currentBytes: phase === 'running' ? 9000 : 0,
    currentTotalBytes: phase === 'running' ? 900000 : 0,
    items: Array.from({ length: total }, (_, index) => ({ assetId: id + '-' + index,
      name: id + '-' + index + '.png', state: phase === 'running' ? 'running' :
        phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : 'succeeded',
      outputPath: null, error: phase === 'failed' ? 'synthetic error' : null })),
  });
  const longPath = '\\\\?\\D:\\' + 'nested-folder-'.repeat(20) + '\\' + '中文目录名'.repeat(22);
  function Fixture() {
    const [tasks, setTasks] = useState({});
    const [csvTasks, setCsvTasks] = useState({});
    const [csvPlan, setCsvPlan] = useState(null);
    const [csvBusy, setCsvBusy] = useState('idle');
    const [panelOpen, setPanelOpen] = useState(false);
    const [notices, setNotices] = useState([]);
    const [plan, setPlan] = useState(null);
    const [submissionPhase, setSubmissionPhase] = useState('idle');
    const [retryState, setRetryState] = useState({});
    const calls = window.__visualCalls || (window.__visualCalls = []);
    useEffect(() => {
      window.__visual = {
        makeTask, longPath,
        add: (task) => setTasks(current => upsertMaterialExportTask(current, task)),
        addMany: (count) => { for (let index = 0; index < count; index++)
          setTasks(current => upsertMaterialExportTask(current, makeTask('history-' + index,
            index % 4 === 0 ? 'failed' : 'completed', longPath))); },
        notice: (id) => setNotices(current => [...current, { id, taskId: null,
          message: '已导出 1 个素材', tone: 'success', action: 'records' }].slice(-2)),
        openPlan: () => setPlan({ planId: 'visual-plan', total: 1, scopeLabel: 'visual', includesDescendants: false }),
        submissionPhase: setSubmissionPhase,
        retryState: (value) => setRetryState(value),
        setPanelOpen,
        csvPlan: () => setCsvPlan({ planId: 'csv-visual', total: 500,
          scopeLabel: '分类 '.repeat(45), includesDescendants: true }),
        csvBusy: setCsvBusy,
        csvTask: (phase) => setCsvTasks({ 'csv-visual-task': { taskId: 'csv-visual-task',
          phase, total: 500, completed: phase === 'running' ? 230 : 500,
          destination: longPath + '\\清单.csv', outputPath: null,
          error: phase === 'failed' ? 'synthetic write failure' : null } }),
      };
      const command = event => { if (event.detail?.type === 'toggle-export-tasks') setPanelOpen(open => !open); };
      window.addEventListener('luckyray:materials-toolbar-command', command);
      return () => window.removeEventListener('luckyray:materials-toolbar-command', command);
    }, []);
    useEffect(() => publishMaterialsToolbarState({ viewMode: 'masonry', workView: 'general',
      folderName: null, sortBy: 'recent', filterOpen: false, activeFilterCount: 0,
      missingOpen: false, exportOpen: panelOpen,
      exportRunningCount: Object.values(tasks).filter(isMaterialExportRunning).length,
      exportNeedsAttention: Object.values(tasks).some(task => task.failed > 0) }), [tasks, panelOpen]);
    return <div className="react-nav-shell" data-route="materials">
      <div className="main">
        <AppTitlebar route="materials" onOpenSearch={() => {}} />
        <div className="content-wrap"><div className="content materials-mode">
          <div id="page-materials" className="page" style={{ height: '100%' }}>
            <div className="materials-layout"><div className="materials-main"><div className="masonry-container" /></div></div>
            <MaterialExportUI planning={false} plan={plan} submissionPhase={submissionPhase}
              preserveHierarchy={false} onPreserveHierarchy={() => {}}
              onCancelPlan={() => setPlan(null)} onConfirm={() => setPlan(null)} error=""
              tasks={Object.values(tasks)} labels={{}} panelOpen={panelOpen}
              onClosePanel={() => setPanelOpen(false)} onOpenPanel={() => setPanelOpen(true)}
              notices={notices} onDismissNotice={id => setNotices(current => current.filter(n => n.id !== id))}
              taskProblems={{}} actionErrors={{}} retryState={retryState} retryChildren={{}} retryErrors={{}}
              onCancelTask={id => { calls.push({ type: 'cancel', id }); setTasks(current =>
                upsertMaterialExportTask(current, { ...current[id], phase: 'cancelled',
                  completed: current[id].total, cancelled: current[id].total })); }}
              onRetry={task => calls.push({ type: 'retry', id: task.taskId })}
              onOpenDestination={id => calls.push({ type: 'open', id })}
              onCopyDestination={(id) => calls.push({ type: 'copy', id })}
              onDismissTask={id => setTasks(current => { const next = { ...current }; delete next[id]; return next; })}
              onClearCompleted={() => setTasks(current => Object.fromEntries(Object.entries(current)
                .filter(([, task]) => isMaterialExportRunning(task))))}
              onRefreshTask={id => calls.push({ type: 'refresh', id })}
              csvTasks={Object.values(csvTasks)} csvRetrying={null}
              onCancelCsvTask={id => calls.push({ type: 'cancel-csv', id })}
              onRetryCsvTask={id => calls.push({ type: 'retry-csv', id })}
              onDismissCsvTask={id => setCsvTasks(current => { const next = { ...current }; delete next[id]; return next; })} />
      <MaterialCsvExportDialog planning={false} plan={csvPlan} description={false}
        onDescription={() => {}} busy={csvBusy} error="" onClose={() => setCsvPlan(null)}
        onConfirm={() => calls.push({ type: 'csv-confirm' })} />
          </div>
        </div></div>
      </div>
    </div>;
  }
  window.__TAURI_INTERNALS__ = { invoke: async () => [] };
  createRoot(document.getElementById('root')).render(
    <ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}>
      <I18nProvider locale="zh-CN"><Fixture /></I18nProvider>
    </ApplicationModalIsolationProvider>);
`;

async function run() {
  const built = await esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, outdir: 'out', format: 'iife', jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'error' });
  const js = built.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  const css = built.outputFiles.find(file => file.path.endsWith('.css'))?.text;
  assert.ok(js && css && css.includes('.material-export-panel'), 'production CSS must be included');
  const server = http.createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
    else if (request.url === '/app.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(output, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    for (const { width, height, scale } of [
      { width: 1440, height: 900, scale: 1 },
      { width: 1280, height: 720, scale: 1.25 },
      { width: 1024, height: 700, scale: 1.5 },
    ]) {
      for (const theme of ['dark', 'light']) {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.__visual);
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const trigger = page.getByRole('button', { name: '导出任务' });
        await trigger.click();
        const panel = page.locator('#materials-export-panel');
        await panel.waitFor();
        assert.equal(await panel.locator('[data-export-panel-initial-focus]').evaluate(node => node === document.activeElement),
          true, 'opening the on-demand panel moves keyboard focus into it');
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true,
          'Escape returns focus to the titlebar task trigger');
        await trigger.click();
        await page.evaluate(() => {
          window.__visual.addMany(20);
          window.__visual.add(window.__visual.makeTask('running-one', 'running', window.__visual.longPath));
          window.__visual.add(window.__visual.makeTask('running-two', 'running', window.__visual.longPath));
        });
        await panel.waitFor();
        await page.locator('[data-export-task-id="running-two"]').waitFor();
        assert.equal(await panel.locator('.material-export-task').count(), 16, 'UI history stays bounded at 16 including active tasks');
        const geometry = await page.evaluate(() => {
          const panel = document.querySelector('#materials-export-panel');
          const controls = [...panel.querySelectorAll('.material-export-task.is-active .material-export-cancel')];
          const inside = rect => rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
          return { viewport: [innerWidth, innerHeight], panel: panel.getBoundingClientRect().toJSON(),
            panelInView: inside(panel.getBoundingClientRect()),
            controls: controls.map(button => { const rect = button.getBoundingClientRect();
              const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return { rect: rect.toJSON(), inView: inside(rect), hit: top === button || button.contains(top) }; }),
            panelNoHorizontalScroll: panel.scrollWidth <= panel.clientWidth + 1,
            pageNoHorizontalScroll: document.documentElement.scrollWidth <= innerWidth + 1 };
        });
        assert.equal(geometry.panelInView, true, JSON.stringify(geometry));
        assert.equal(geometry.controls.length, 2, JSON.stringify(geometry));
        assert.ok(geometry.controls.every(control => control.inView && control.hit), JSON.stringify(geometry));
        assert.equal(geometry.panelNoHorizontalScroll, true, JSON.stringify(geometry));
        assert.equal(geometry.pageNoHorizontalScroll, true, JSON.stringify(geometry));
        await page.screenshot({ path: path.join(output, `export-ux-${width}x${height}-${scale}-${theme}.png`) });
        await page.locator('[data-export-task-id="running-one"] .material-export-cancel').click();
        assert.equal(await page.evaluate(() => window.__visualCalls.some(call => call.type === 'cancel' && call.id === 'running-one')), true);
        await page.locator('#materials-export-panel .material-export-panel-heading button').click();
        assert.equal(await panel.count(), 0, 'closing panel does not cancel second running task');
        assert.equal(await page.evaluate(() => window.__visualCalls.some(call => call.type === 'cancel' && call.id === 'running-two')), false);
        if (width === 1440 && theme === 'dark') {
          await page.evaluate(() => window.__visual.notice('notice-one'));
          const notice = page.locator('.material-export-notice');
          await notice.waitFor();
          await notice.hover();
          await notice.waitFor({ state: 'visible' });
          await page.waitForFunction(() => document.querySelector('.material-export-notice')?.dataset.paused === 'true');
          await page.waitForTimeout(4300);
          assert.equal(await notice.count(), 1, 'hover pauses the short notice');
          await page.mouse.move(3, 300);
          await notice.waitFor({ state: 'hidden', timeout: 5000 });
          await page.evaluate(() => window.__visual.notice('notice-two'));
          await notice.getByRole('button', { name: '查看记录' }).focus();
          await page.waitForFunction(() => document.querySelector('.material-export-notice')?.dataset.paused === 'true');
          await page.waitForTimeout(4300);
          assert.equal(await notice.count(), 1, 'keyboard focus pauses the short notice');
          await trigger.focus();
          await notice.waitFor({ state: 'hidden', timeout: 5000 });
          await page.evaluate(() => {
            window.__visual.notice('notice-three');
            window.__visual.notice('notice-four');
            window.__visual.notice('notice-five');
          });
          await page.waitForFunction(() => document.querySelectorAll('.material-export-notice').length === 2);
          assert.equal(await page.locator('.material-export-notice').count(), 2,
            'continuous results keep at most two visible notices');
          await page.evaluate(() => window.__visual.openPlan());
          const dialog = page.getByRole('dialog', { name: '导出素材原文件' });
          await dialog.waitFor();
          assert.equal(await dialog.getByRole('button', { name: '关闭' }).evaluate(node => node === document.activeElement),
            true, 'modal takes focus');
          await page.evaluate(() => window.__visual.submissionPhase('choosing'));
          await dialog.getByRole('status').waitFor();
          await page.keyboard.press('Escape');
          assert.equal(await dialog.count(), 1, 'Esc cannot discard a plan while chooser is active');
          await page.evaluate(() => window.__visual.submissionPhase('idle'));
          await page.waitForFunction(() => {
            const button = document.querySelector('.material-export-plan [data-modal-initial-focus]');
            return button && !button.disabled && button === document.activeElement;
          });
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
        }
        await trigger.click();
        await page.evaluate(() => window.__visual.csvTask('running'));
        const csvCancel = page.locator('.material-csv-task .material-export-cancel');
        await csvCancel.waitFor();
        const csvGeometry = await csvCancel.evaluate(button => {
          const rect = button.getBoundingClientRect();
          const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { inView: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            hit: at === button || button.contains(at), rect: rect.toJSON() };
        });
        assert.ok(csvGeometry.inView && csvGeometry.hit, JSON.stringify(csvGeometry));
        await page.screenshot({ path: path.join(output, `csv-task-${width}x${height}-${scale}-${theme}.png`) });
        await csvCancel.click();
        assert.equal(await page.evaluate(() => window.__visualCalls.some(call => call.type === 'cancel-csv')), true);
        await page.evaluate(() => window.__visual.csvPlan());
        const csvDialog = page.getByRole('dialog', { name: '导出素材清单（CSV）' });
        await csvDialog.waitFor();
        await page.waitForFunction(() => {
          const dialog = document.querySelector('.material-csv-plan');
          return dialog && getComputedStyle(dialog).opacity === '1'
            && dialog.getAnimations().every(animation => animation.playState === 'finished');
        });
        const csvDialogGeometry = await csvDialog.evaluate(node => {
          const rect = node.getBoundingClientRect();
          const button = node.querySelector('button.primary');
          const b = button.getBoundingClientRect();
          const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return { dialogInView: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            buttonInView: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
            hit: at === button || button.contains(at), dialog: rect.toJSON(), button: b.toJSON() };
        });
        assert.ok(csvDialogGeometry.dialogInView && csvDialogGeometry.buttonInView && csvDialogGeometry.hit,
          JSON.stringify(csvDialogGeometry));
        await page.screenshot({ path: path.join(output, `csv-dialog-${width}x${height}-${scale}-${theme}.png`) });
        await csvDialog.getByRole('button', { name: '选择保存位置' }).click();
        assert.equal(await page.evaluate(() => window.__visualCalls.some(call => call.type === 'csv-confirm')), true);
        await page.evaluate(() => window.__visual.csvBusy('choosing'));
        await page.keyboard.press('Escape');
        assert.equal(await csvDialog.count(), 1, 'native chooser phase cannot be escaped');
        await page.evaluate(() => window.__visual.csvBusy('idle'));
        await page.waitForFunction(() => {
          const button = document.querySelector('.material-csv-plan [data-modal-initial-focus]');
          return button && !button.disabled && button === document.activeElement;
        });
        await csvDialog.locator('[data-modal-initial-focus]').focus();
        await page.keyboard.press('Escape');
        await csvDialog.waitFor({ state: 'hidden' });
        assert.deepEqual(errors, [], 'no browser errors');
        console.log('GEOMETRY', JSON.stringify({ width, height, scale, theme, controls: geometry.controls }));
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('MATERIAL-EXPORT-UX-REAL-CSS-OK');
}

const timeout = setTimeout(() => { console.error('MATERIAL-EXPORT-UX-VISUAL-TIMEOUT'); process.exit(124); }, 120_000);
run().then(() => clearTimeout(timeout)).catch(error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
