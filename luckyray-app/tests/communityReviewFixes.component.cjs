// Production CommunityPage + controlled memory transports in a fresh headless browser.
// No native host, script execution, package mutations, real notes or external requests.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const out = path.resolve(process.env.COMMUNITY_FIX_EVIDENCE || path.join(root, 'output/community-review-fixes'));
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), checks: [], errors: [], externalRequests: [], screenshots: [] };
const fixture = `
import { createRoot } from 'react-dom/client';
import CommunityPage from './src/features/community/CommunityPage';
import { I18nProvider } from './src/core/i18n/index';
import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from './src/app/applicationModalIsolation';
import { applyGlobalSettings } from './src/features/settings/useSettings';
import { setActiveKnowledgeSource, clearActiveKnowledgeSource } from './src/core/services/knowledgeSource';
import './src/core/theme/themeTokens.css';
import './src/app/appShell.css';
window.registry = { revision: 1, hostVersion: '1.9.4', packages: [{ package: {
  manifest: { schemaVersion: 1, apiVersion: 1, type: 'script', entry: 'main.js', minHostVersion: '1.9.2', requiredModules: [], optionalModules: [], id: 'example.page-desk', name: '页面示例台', version: '1.0.0' },
  resource: { code: '// inert controlled component fixture', requiredPermissions: [], optionalPermissions: [], dataVersion: 1, contributions: [{ id: 'board', label: '示例看板', kind: 'page' }, { id: 'about', label: '关于此示例', kind: 'page' }] }
}, enabled: false, digest: 'component-only', grants: [], epoch: 1 }] };
window.catalog = [
  { id: 'test.skill.a', name: '资料整理', description: '整理登记的资料与说明。', type: 'skill', enabled: true, parameters: [] },
  { id: 'test.skill.b', name: '长说明能力', description: '只读说明。'.repeat(350), type: 'skill', enabled: false, parameters: [], available: false, unavailableReason: '当前服务不可用' },
  { id: 'test.workflow.a', name: '工作流说明', description: '仅显示登记信息。', type: 'workflow', enabled: true, parameters: [] },
  { id: 'test.tool.a', name: '浏览器收集', description: '浏览器中的收集能力。', type: 'extension', enabled: true, parameters: [] }
];
window.packageReads = []; window.fetches = []; window.commands = []; window.mutations = [];
window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
  window.commands.push(command);
  if (command === 'manage_extension_packages') {
    const request = JSON.parse(args.request);
    if (request.op !== 'list') { window.mutations.push(request.op); throw Error('Component refuses package mutations'); }
    window.packageReads.push(request.op);
    if (window.failRegistry) throw Error('component-list-failed');
    return structuredClone(window.registry);
  }
  if (command === 'get_local_transport_client_config') return { baseUrl: 'http://127.0.0.1:1', credential: '', protocolVersion: 1 };
  if (command === 'get_collection_server_base_url') return 'http://127.0.0.1:1';
  if (command === 'knowledge_activate_ui_source') return { vaultId: 'component-vault', sourceEpoch: 1 };
  if (command === 'knowledge_get_current_context') return null;
  if (command === 'knowledge_create_document' && window.testUnknownWrite) throw Error('component-unknown-write-result');
  throw Error('Component refuses command: ' + command);
} };
window.fetch = async url => {
  window.fetches.push(String(url));
  if (!String(url).endsWith('/api/capability/list')) throw Error('Component refuses HTTP mutations');
  if (window.delayCatalog) await new Promise(resolve => { window.releaseCatalog = resolve; });
  return new Response(JSON.stringify({ capabilities: window.catalog }), { status: window.failCatalog ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
};
window.base = theme => applyGlobalSettings({ 'general.theme': theme, 'appearance.accentColor': '#579472' });
window.activateVault = () => setActiveKnowledgeSource({ mode: 'real-vault', vaultId: 'component-vault' }, true);
window.clearVault = clearActiveKnowledgeSource;
window.base('light');
let mounted;
window.reopenCommunity = () => {
  mounted?.unmount();
  location.hash = '#community?tab=extensions';
  mounted = createRoot(document.getElementById('root'));
  mounted.render(<I18nProvider locale='zh-CN'><ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><CommunityPage /></ApplicationModalIsolationProvider></I18nProvider>);
};
window.reopenCommunity();
`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'"><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:var(--theme-app-bg);color:var(--text-primary);font:13px/1.5 system-ui}#root{display:block;height:100vh;overflow:auto}#page-community{display:block;min-height:100vh;overflow:visible}body>aside{padding:6px 16px;font-size:11px}</style><aside role="note">隔离修复验证 · 生产社区组件 / 受控内存数据 · 非 Main 或原生验收</aside><div id="root" class="react-nav-shell"></div><script src="/app.js"></script></html>`;
let browser, server;
(async () => {
  await esbuild.build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, outfile: path.join(out, 'app.js'), metafile: true }).then(result => fs.writeFileSync(path.join(out, 'bundle-inputs.json'), JSON.stringify(result.metafile, null, 2)));
  if (process.argv.includes('--build-only')) return;
  const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
  server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
    else if (req.url === '/app.js' || req.url === '/app.css') { res.setHeader('Content-Type', req.url.endsWith('css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(out, req.url.slice(1)))); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
  await page.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); report.externalRequests.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => report.errors.push(String(error)));
  const check = async (name, run) => { try { await run(); report.checks.push({ name, ok: true }); } catch (error) { report.checks.push({ name, ok: false, failure: String(error) }); throw error; } };
  const tab = async key => { await page.locator('#community-tab-' + key).click(); await page.waitForFunction(key => location.hash === '#community?tab=' + key, key); };
  const shot = async name => { const file = 'screenshots/' + name + '.png'; await page.screenshot({ path: path.join(out, file), fullPage: true, animations: 'disabled' }); report.screenshots.push(file); };
  const copyNotice = page.getByRole('alert').getByText(/手动复制/);
  const refuseCopy = () => page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('controlled-copy-refusal'); } } }));
  await page.goto(origin);
  await page.waitForLoadState('networkidle');
  await page.locator('.plugin-card').waitFor();
  await check('first read renders navigation and all filter counts without another read', async () => {
    assert.equal(await page.evaluate(() => window.packageReads.length), 1);
    assert.equal(await page.locator('#community-tab-extensions .community-tab-count').textContent(), '1');
    assert.equal((await page.locator('.community-filters').textContent()).replace(/\s/g, ''), '全部1已启用0未启用1');
  });
  await shot('01-first-read-counts');
  await tab('status'); await refuseCopy();
  await page.getByRole('button', { name: '复制路径', exact: true }).click(); await copyNotice.waitFor();
  await check('copy refusal gives truthful guidance with a selectable visible source path', async () => {
    assert.equal(await page.locator('.community-source-path').count(), 1);
    assert.equal(await page.getByText('已复制仓库内插件目录', { exact: true }).count(), 0);
  });
  await shot('02-copy-refusal-tools');
  await tab('extensions'); await page.locator('.plugin-card').waitFor();
  // Capture the defect before asserting so RED has a useful screenshot.
  await shot('03-after-switch-plugins');
  await check('copy refusal is removed when the tools context closes', async () => assert.equal(await copyNotice.count(), 0));
  await tab('status');
  await check('reopening tools does not restore an old copy refusal', async () => assert.equal(await copyNotice.count(), 0));
  await refuseCopy(); await page.getByRole('button', { name: '复制路径', exact: true }).click(); await copyNotice.waitFor();
  await page.evaluate(() => { window.copiedValues = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedValues.push(value); } } }); });
  await page.getByRole('button', { name: '复制路径', exact: true }).click();
  await page.getByRole('status').getByText('已复制仓库内插件目录', { exact: true }).waitFor();
  await check('a subsequent successful copy clears the failure and copies the displayed path', async () => {
    assert.equal(await copyNotice.count(), 0);
    assert.equal(await page.evaluate(() => window.copiedValues[0]), await page.locator('.community-source-path code').textContent());
  });
  await shot('04-copy-success');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((resolve, reject) => { window.rejectCopy = reject; window.resolveCopy = resolve; }) } }));
  await page.getByRole('button', { name: '复制路径', exact: true }).click();
  await tab('extensions'); await page.evaluate(() => window.rejectCopy(Error('late-refusal'))); await tab('status');
  await check('a refusal arriving after tab departure cannot reappear on return', async () => assert.equal(await copyNotice.count(), 0));
  await page.getByRole('button', { name: '复制路径', exact: true }).click(); await page.waitForFunction(() => !!window.rejectCopy);
  await page.evaluate(() => { location.hash = '#community?tab=skills'; }); await page.locator('#community-tab-skills[aria-selected=true]').waitFor();
  await page.evaluate(() => window.rejectCopy(Error('late-hash-refusal'))); await tab('status');
  await check('hash navigation also invalidates an in-flight copy context', async () => assert.equal(await copyNotice.count(), 0));
  await refuseCopy(); await page.getByRole('button', { name: '复制路径', exact: true }).click(); await copyNotice.waitFor();
  await page.evaluate(() => window.reopenCommunity()); await page.locator('.plugin-card').waitFor(); await tab('status');
  await check('remounting Community does not retain copy feedback', async () => assert.equal(await copyNotice.count(), 0));
  await refuseCopy(); await page.getByRole('button', { name: '复制路径', exact: true }).click(); await copyNotice.waitFor();
  await page.evaluate(() => { location.hash = '#notes'; }); await page.waitForFunction(() => location.hash === '#notes');
  await tab('status');
  await check('leaving and reopening the Community route clears only copy feedback', async () => assert.equal(await copyNotice.count(), 0));
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(resolve => { window.resolveCopy = resolve; }) } }));
  await page.getByRole('button', { name: '复制路径', exact: true }).click(); await tab('extensions');
  await page.evaluate(() => window.resolveCopy()); await tab('status');
  await check('a success arriving after tab departure does not publish a stale toast', async () => assert.equal(await page.getByText('已复制仓库内插件目录', { exact: true }).count(), 0));
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((resolve, reject) => { window.rejectOldCopy = reject; }) } }));
  await page.getByRole('button', { name: '复制路径', exact: true }).click();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }));
  await page.getByRole('button', { name: '复制路径', exact: true }).click();
  await page.getByRole('status').getByText('已复制仓库内插件目录', { exact: true }).waitFor();
  await page.evaluate(() => window.rejectOldCopy(Error('superseded-copy-refusal')));
  await check('an older copy refusal cannot overwrite a newer copy success', async () => assert.equal(await copyNotice.count(), 0));
  await tab('templates'); await page.evaluate(() => { window.testUnknownWrite = true; window.activateVault(); });
  await page.waitForFunction(() => !document.querySelector('.community-note-template .lr-cap-run:not(.secondary)').disabled);
  await page.locator('.community-note-template').first().getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByRole('alert').waitFor();
  const warning = await page.getByRole('alert').innerText();
  await tab('extensions');
  await check('unconfirmed template result guidance survives unrelated tab changes', async () => {
    assert.match(warning, /未确认|检查|确认/);
    assert.equal(await page.getByRole('alert').innerText(), warning);
  });
  await check('no package mutations, real writes, browser errors or external requests', async () => {
    assert.deepEqual(await page.evaluate(() => window.mutations), []);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
  });
})().catch(error => { report.failure = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(out, 'targeted-ui.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ head: report.head, checks: report.checks, errors: report.errors, externalRequests: report.externalRequests, failure: report.failure }, null, 2));
});
