// Production-component rendering with synthetic fixtures only. Optional Playwright tooling.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const requireTool = process.env.LR_BROWSER_TOOLS ? createRequire(path.join(process.env.LR_BROWSER_TOOLS, 'package.json')) : require;
const { chromium } = requireTool('playwright');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules/vite'))] }));
const out = process.env.LR_AGENT_UI_OUT || path.join(root, 'output/canvas-agent-r5-ui');
const checks = [];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'canvasAgentR5Ui.fixture.tsx')], bundle: true, outfile: path.join(out, 'fixture.js'), loader: { '.css': 'css' } });
  const html = `<!doctype html><html data-theme="dark"><meta charset="UTF-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%;font-family:Arial,'Noto Sans CJK SC',sans-serif;background:#0b0c10;color:#e6e7eb}*{box-sizing:border-box}.fixture-stage{position:relative;width:100%;height:100%;background:radial-gradient(#343540 1px,transparent 1px) 0 0/22px 22px}.fixture-stage nav{position:absolute;left:20px;top:20px;display:flex;gap:10px}.fixture-stage nav button{padding:8px;background:#202127;border:1px solid #454650;border-radius:8px;color:#ddd}.fixture-art{position:absolute;left:12%;top:30%;font-size:24px;color:#b1b8c7}.fixture-art small{font-size:13px;color:#717989}.canvas-r1-agent-panel{top:76px;--canvas-panel-surface:#131419;--theme-surface-raised:#202127;--theme-border-strong:#383941;--theme-hover:rgba(255,255,255,.06);--text-primary:#e6e7eb}.canvas-agent-history-popover{background:var(--canvas-panel-surface)}</style><div id="root"></div><script src="/fixture.js"></script></html>`;
  const server = http.createServer((req, res) => { const name = req.url === '/' ? null : path.basename(req.url); if (!name) { res.setHeader('Content-Type','text/html'); res.end(html); } else if (['fixture.js','fixture.css'].includes(name)) { res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/css'); res.end(fs.readFileSync(path.join(out,name))); } else { res.statusCode=404;res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.LR_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.locator('.canvas-agent-message-actions').first().waitFor();
    await page.screenshot({ path: path.join(out,'conversation-1440.png') });
    assert.equal(await page.locator('.canvas-agent-message-actions button').allTextContents().then(values => values.every(value => !value)),true); checks.push('icon-only accessible message actions');
    await page.getByRole('button',{name:'历史对话',exact:true}).click();
    const panel = await page.locator('.canvas-r1-agent-panel').boundingBox(), history = await page.locator('.canvas-agent-history-popover').boundingBox();
    assert.ok(history.x >= panel.x && history.x + history.width <= panel.x + panel.width + 1); checks.push('history contained in panel');
    await page.screenshot({ path:path.join(out,'history-1440.png') });
    await page.getByRole('button',{name:'关闭历史对话',exact:true}).click();
    await page.locator('.canvas-agent-model-reasoning summary').click();
    assert.equal(await page.locator('.canvas-agent-model-reasoning').getAttribute('open'),''); checks.push('real model reasoning is collapsible');
    await page.screenshot({ path:path.join(out,'reasoning-1440.png') });
    await page.getByRole('button',{name:'欢迎页',exact:true}).click();
    await page.locator('.canvas-r1-agent-transcript').evaluate(el=>{el.scrollTop=70;el.dispatchEvent(new Event('scroll'));});
    assert.equal(await page.locator('.canvas-agent-back-bottom').count(),0); checks.push('welcome scroll has no latest button');
    await page.getByRole('button',{name:'完整对话',exact:true}).click();
    await page.setViewportSize({width:780,height:540});
    await page.screenshot({path:path.join(out,'conversation-780.png')});
    const box=await page.locator('.canvas-r1-agent-composer').boundingBox(); assert.ok(box.y+box.height<=540); checks.push('compact-height composer stays visible');
    await page.getByRole('button',{name:'流式状态',exact:true}).click();
    assert.equal(await page.locator('.canvas-agent-stream-caret').count(),1); checks.push('streaming cursor uses runtime state');
    await page.screenshot({path:path.join(out,'streaming-780.png')});
    assert.deepEqual(errors,[]); fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2)); console.log(`${checks.length} browser checks passed. ${out}`);
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); esbuild.stop(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
