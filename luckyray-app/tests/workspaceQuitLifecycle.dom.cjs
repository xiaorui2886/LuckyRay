// Controlled browser/DOM regression of the actual product lifetime module.
// No real profile, document, cookie or LSH process is accessed or faulted.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', {paths: [fs.realpathSync(root + '/node_modules/vite')]}));
const {chromium} = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
const evidence = process.env.LUCKYRAY_QUIT_EVIDENCE_DIR || path.join(root, 'output/playwright/quit-status');

(async () => {
  const built = await esbuild.build({stdin: {resolveDir: root, loader: 'ts', contents: `
    import {installWorkspaceLifecycle, registerWorkspaceFlush, workspaceCompositionActive} from './src/workspace/windowLifecycle';
    window.listeners = new Map(); window.acks = []; window.trace = []; window.fail = false; window.dirty = false;
    window.fire = (phase, id) => window.listeners.get('luckyray:workspace-quit-' + phase)?.({payload: {id}});
    let resolve, reject;
    registerWorkspaceFlush(async () => {
      window.trace.push('flush');
      if (window.dirty) await new Promise((yes, no) => {resolve = yes; reject = no;});
      if (window.fail) throw Error('controlled synthetic save failure');
      window.dirty = false; return !workspaceCompositionActive();
    }, () => window.dirty);
    window.finish = () => resolve?.(); window.failSave = () => {window.fail = true; reject?.(Error('controlled failure'));};
    new MutationObserver(() => {
      window.trace.push({status: document.querySelector('[role=status]')?.textContent ?? null, inert: document.getElementById('root').inert});
    }).observe(document.body, {childList: true});
    installWorkspaceLifecycle().then(() => {window.ready = true;});
  `}, bundle: true, write: false, format: 'iife', target: 'es2022', plugins: [{name: 'native-test-seam', setup(build) {
    build.onResolve({filter: /^@tauri-apps\/api\//}, args => ({path: args.path, namespace: 'quit-mock'}));
    build.onResolve({filter: /^\.\/nativeClient$/}, args => args.importer.endsWith('windowLifecycle.ts') ? {path: 'client', namespace: 'quit-mock'} : undefined);
    build.onLoad({filter: /.*/, namespace: 'quit-mock'}, args => ({loader: 'js', contents:
      args.path.endsWith('/event') ? `export const listen=async(name,callback)=>{window.listeners.set(name,callback);return()=>{}};` :
      args.path.endsWith('/window') ? `export const getCurrentWindow=()=>({label:'main'});` :
      `export const workspaceCommand=async(command)=>{window.acks.push(command);window.trace.push({ack:command});};`,
    }));
  }}]});
  const html = `<html><head><style>${fs.readFileSync(root + '/src/core/theme/themeTokens.css', 'utf8')}
    body{margin:0;background:var(--theme-bg,#09090b);color:var(--text-primary,#eee);font-family:system-ui}
    #root{padding:32px}textarea{display:block;margin:24px 0;background:var(--theme-surface-panel);color:var(--text-primary);width:600px;height:240px}
    </style></head><body><main id="root"><h2>LuckyRay · 合成退出保护检查</h2><p>真实退出生命周期模块，受控保存与原生消息边界。</p><textarea>仅合成正文，不使用任何用户资料。</textarea></main><script src="/test.js"></script></body></html>`;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', req.url === '/test.js' ? 'text/javascript' : 'text/html; charset=utf-8');
    res.end(req.url === '/test.js' ? built.outputFiles[0].text : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const report = [];
  try {
    const page = await browser.newPage({viewport: {width: 1024, height: 680}});
    const load = async () => {await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => window.ready);};
    const state = () => page.evaluate(() => ({inert: document.getElementById('root').inert,
      status: document.querySelector('[role=status]')?.textContent ?? null, acks: window.acks, trace: window.trace}));
    await fs.promises.mkdir(evidence, {recursive: true});
    await load(); await page.evaluate(() => window.fire('prepare', 'clean'));
    assert.equal((await state()).status, null); assert.equal((await state()).acks[0].saved, true);
    await page.screenshot({path: path.join(evidence, 'clean.png')}); report.push({case: 'clean', result: 'PASS', ...await state()});

    await load(); await page.evaluate(() => {window.dirty = true; window.fire('prepare', 'slow');});
    assert.equal((await state()).status, null);
    await page.waitForSelector('[data-workspace-quit-status=saving]');
    const bounds = await page.locator('[role=status]').boundingBox(); assert.ok(bounds.width < 400 && bounds.height < 100);
    await page.screenshot({path: path.join(evidence, 'slow-saving.png')});
    await page.evaluate(() => window.finish()); await page.waitForFunction(() => window.acks.length === 1);
    assert.equal((await state()).status, null);
    await page.evaluate(() => window.fire('draining', 'slow')); await page.waitForSelector('[data-workspace-quit-status=draining]');
    assert.equal((await state()).status, '正在退出…'); await page.screenshot({path: path.join(evidence, 'draining.png')});
    report.push({case: 'slow-to-native-draining', result: 'PASS', ...await state()});

    for (const failure of ['failure', 'timeout']) {
      await load(); await page.evaluate(id => {window.dirty = true; window.fire('prepare', id);}, failure);
      await page.waitForSelector('[data-workspace-quit-status=saving]');
      await page.evaluate(id => id === 'failure' ? window.failSave() : window.fire('cancelled', id), failure);
      await page.waitForFunction(() => !document.getElementById('root').inert);
      assert.equal((await state()).status, null);
      await page.locator('textarea').fill('取消／失败后仍可操作。仅合成正文。');
      assert.match(await page.locator('textarea').inputValue(), /仍可操作/);
      if (failure === 'timeout') {await page.evaluate(() => window.finish()); assert.equal((await state()).acks.length, 0);}
      await page.screenshot({path: path.join(evidence, failure + '-interactive.png')});
      report.push({case: failure, result: 'PASS', controlledNativeTimeout: failure === 'timeout', ...await state()});
    }
    await load(); await page.locator('textarea').dispatchEvent('compositionstart');
    await page.evaluate(() => window.fire('prepare', 'ime')); assert.equal((await state()).acks[0].saved, false);
    assert.equal((await state()).inert, false); assert.equal((await state()).status, null);
    report.push({case: 'composition-event-guard', result: 'PASS', realChineseIME: false, ...await state()});
    await fs.promises.writeFile(path.join(evidence, 'controlled-dom.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({result: 'PASS', cases: report.map(({case: name, result}) => ({name, result})), evidence, realMain: false}));
  } finally {await browser.close(); await new Promise(resolve => server.close(resolve));}
})().catch(error => {console.error(error); process.exitCode = 1;});
