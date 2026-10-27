// Windows browser regression for the R1 Window-receiver hotfix. Synthetic canvas only.
// LR_TEST_TOOLS locates an existing Playwright installation; no project dependency install.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(app, 'package.json'));
const tools = process.env.LR_TEST_TOOLS ? createRequire(join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const {chromium} = tools('playwright');
const {build} = createRequire(require.resolve('vite'))('esbuild');
const output = resolve(process.env.LR_VIEWPORT_QA_DIR || join(app, 'output/playwright/viewport-hotfix'));
const red = process.argv.includes('--expect-broken');
await mkdir(output, {recursive: true});
await build({entryPoints: [join(app, 'tests/fixtures/viewport/entry.tsx')], bundle: true, format: 'esm',
  jsx: 'automatic', outfile: join(output, 'entry.js'), define: {'process.env.NODE_ENV': '"development"'}});
await writeFile(join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Canvas viewport hotfix regression</title><link rel="stylesheet" href="/entry.css"><style>:root{--theme-glass-bg:#252528;--theme-border-subtle:#ffffff14;--theme-border-strong:#ffffff26;--theme-hover:#ffffff0d;--theme-selected:#ffffff16;--theme-shadow-lg:0 10px 36px #0006;--theme-glass-filter:blur(18px);--theme-canvas-workspace:#141416;--theme-text-muted:#99999f;--text-primary:#ededf0;--text-secondary:#a6a6b0;--accent:#a69bff}body{margin:0;background:#19191b;color:var(--text-primary);font-family:Arial,sans-serif}*{box-sizing:border-box}header{font-size:12px}output{font-size:10px}button,input,textarea{font:inherit}</style><div id="root"></div><script type="module" src="/entry.js"></script>');
const allowed = new Map([['/', ['index.html', 'text/html']], ['/entry.js', ['entry.js', 'text/javascript']], ['/entry.css', ['entry.css', 'text/css']]]);
const server = createServer(async (req, res) => {
  const file = allowed.get(req.url);
  if (!file) {res.writeHead(404).end(); return;}
  try {res.writeHead(200, {'Content-Type': file[1]}); res.end(await readFile(join(output, file[0])));}
  catch {res.writeHead(500).end();}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
const evidence = {platform: process.platform, mode: red ? 'BEFORE_HOTFIX' : 'AFTER_HOTFIX',
  fixture: 'Production CanvasViewportControls + actual ReactFlow renderer under React.StrictMode',
  nativeWebView2Acceptance: 'NOT_RUN_USER_PENDING', screenshots: false, checks: [], pageErrors: []};
try {
  browser = await chromium.launch({channel: process.env.LR_BROWSER_CHANNEL || 'msedge', headless: true});
  evidence.browserVersion = browser.version();
  const page = await browser.newPage({viewport: {width: 1100, height: 800}});
  page.on('pageerror', e => evidence.pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil: 'networkidle'});
  await page.waitForSelector('.react-flow__node[data-id="a"]');
  const camera = () => page.evaluate(() => {
    const v = JSON.parse(document.querySelector('[data-testid="camera"]').textContent);
    const matrix = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
    const node = document.querySelector('.react-flow__node[data-id="a"]').getBoundingClientRect();
    return {...v, rendered: {x: matrix.e, y: matrix.f, zoom: matrix.a},
      percentage: Number(document.querySelector('.canvas-zoom-percentage').textContent.replace(/[^0-9.]/g, '')),
      node: {x: node.x, y: node.y, width: node.width, height: node.height}};
  });
  const check = (value, name, detail) => {evidence.checks.push({name, pass: !!value, detail}); assert.ok(value, name);};
  const synced = v => Math.abs(v.rendered.zoom - v.zoom) < .00001 &&
    Math.abs(v.rendered.x - v.x) < .001 && Math.abs(v.rendered.y - v.y) < .001 && v.percentage === Math.round(v.zoom * 100);
  const pause = () => page.waitForTimeout(450);
  const point = () => page.locator('.react-flow').boundingBox().then(r => ({x: r.x + 50, y: r.y + r.height * .55, left: r.x, top: r.y}));
  const scroll = async (dx, dy) => {const p = await point(); await page.mouse.move(p.x, p.y); await page.mouse.wheel(dx, dy); return p;};
  const preset = async percent => {await page.getByRole('button', {name: '缩放选项', exact: true}).click();
    await page.getByRole('button', {name: `${percent}%`, exact: true}).click(); await pause(); return camera();};

  let before = await camera();
  const anchor = await scroll(0, -120); await pause();
  let after = await camera();
  if (red) {
    const wheelUnchanged = Math.abs(after.zoom - before.zoom) < .00001;
    const selected25 = await preset(25);
    const presetUnchanged = Math.abs(selected25.zoom - before.zoom) < .00001;
    check(wheelUnchanged && presetUnchanged && evidence.pageErrors.some(x => /Illegal invocation/i.test(x)),
      'baseline reproduces native Window receiver failure for wheel and preset', {before, after, selected25});
    evidence.status = 'RED_REPRODUCED';
  } else {
    check(after.zoom > before.zoom && synced(after), 'wheel changes rendered canvas and synchronized percentage', {before, after});
    const local = {x: anchor.x - anchor.left, y: anchor.y - anchor.top};
    check(Math.abs((local.x - before.x) / before.zoom - (local.x - after.x) / after.zoom) < .01 &&
      Math.abs((local.y - before.y) / before.zoom - (local.y - after.y) / after.zoom) < .01, 'wheel preserves world point under cursor');
    check(after.saved - before.saved === 1, 'wheel persists once after settling');
    for (const percent of [25, 100, 200]) {
      const previous = after; after = await preset(percent);
      check(Math.abs(after.zoom - percent / 100) < .00001 && synced(after), `${percent}% selects actual rendered zoom and percentage`, after);
      check(Math.abs(after.node.width / previous.node.width - after.zoom / previous.zoom) < .001,
        `${percent}% changes node pixel size consistently`);
    }
    await preset(100); before = await camera();
    for (let i = 0; i < 8; i++) await scroll(0, -15);
    await pause(); after = await camera();
    check(after.zoom > before.zoom && synced(after), 'continuous wheel updates actual camera and percentage', {before, after});
    const drag = await point(); before = after;
    await page.mouse.move(drag.x, drag.y); await page.mouse.down({button: 'middle'});
    await page.mouse.move(drag.x + 120, drag.y + 65, {steps: 12}); await page.mouse.up({button: 'middle'});
    await pause(); after = await camera();
    check(Math.abs(after.x - before.x - 120) < 1 && Math.abs(after.y - before.y - 65) < 1 && after.zoom === before.zoom && synced(after),
      'canvas drag after continuous zoom moves correct distance without changing zoom', {before, after});
    const settledDrag = after; await pause(); after = await camera();
    check(after.x === settledDrag.x && after.y === settledDrag.y && after.zoom === settledDrag.zoom, 'no stale animation after drag');
    const node = page.locator('.react-flow__node[data-id="a"]'); const rect = await node.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 25); await page.mouse.down();
    // ReactFlow starts node dragging after its movement threshold. Measure the
    // requested delta from the active drag, instead of counting that threshold.
    await page.mouse.move(rect.x + rect.width / 2 + 10, rect.y + 35); before = await camera();
    await page.mouse.move(rect.x + rect.width / 2 + 70, rect.y + 80, {steps: 12}); await page.mouse.up();
    await pause(); after = await camera();
    check(Math.abs(after.node.x - before.node.x - 60) < 1 && Math.abs(after.node.y - before.node.y - 45) < 1,
      'node drag after continuous zoom updates real node position', {before, after});
    check(Math.abs(after.x - before.x) < .001 && Math.abs(after.y - before.y) < .001 && after.zoom === before.zoom,
      'node drag does not displace camera');
    await page.getByLabel('滚轮平移', {exact: true}).check(); before = await camera();
    await scroll(30, 100); await pause(); after = await camera();
    check(Math.abs(after.x - before.x + 30) < 1 && Math.abs(after.y - before.y + 100) < 1 && after.zoom === before.zoom && synced(after),
      'scroll-to-pan changes rendered translation and preserves percentage', {before, after});
    before = after; await page.keyboard.down('Control');
    try {await scroll(0, -80);} finally {await page.keyboard.up('Control');}
    await pause(); after = await camera();
    check(after.zoom > before.zoom && synced(after), 'Ctrl wheel still zooms in scroll-to-pan mode', {before, after});
    check(evidence.pageErrors.length === 0, 'no browser page errors', evidence.pageErrors);
    evidence.status = 'PASS';
  }
} catch (e) {evidence.status = 'FAIL'; evidence.error = e.stack; process.exitCode = 1;}
finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
  await writeFile(join(output, 'RESULT.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({status: evidence.status, mode: evidence.mode, browser: evidence.browserVersion,
  assertions: evidence.checks.length, failures: evidence.checks.filter(x => !x.pass).map(x => x.name),
  pageErrors: evidence.pageErrors, report: join(output, 'RESULT.json')}, null, 2));
