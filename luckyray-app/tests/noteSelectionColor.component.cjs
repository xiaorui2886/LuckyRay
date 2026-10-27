const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const built = await esbuild.build({
    stdin: { contents: String.raw`import {EditorView,drawSelection} from '@codemirror/view';
      import {liveMarkdownTheme} from './src/features/notes/editor/liveMarkdownExtensions';
      window.view=new EditorView({doc:'中文选区必须清晰可读\nSecond selected line',parent:document.querySelector('#editor'),extensions:[drawSelection(),liveMarkdownTheme]});`, resolveDir: root, loader: 'js' },
    bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'empty' },
  });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>body{--accent:#8785ff;--text-primary:#eee;background:#101014}.cm-scroller{height:300px}</style><button id="outside">Outside</button><div id="editor" class="lr-live-markdown-editor"></div>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'src/features/notes/editor/liveMarkdown.css'), 'utf8') });
    await page.addScriptTag({ content: built.outputFiles[0].text });
    const color = async () => {
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      return page.locator('.cm-selectionBackground').first().evaluate(e => getComputedStyle(e).backgroundColor);
    };
    await page.evaluate(() => { window.view.dispatch({selection:{anchor:0,head:8}}); window.view.focus(); });
    const focused = await color();
    await page.locator('#outside').click();
    const blurred = await color();
    assert.equal(focused, blurred, 'focused selection must retain the readable application color');
    const line = await page.locator('.cm-line').first().boundingBox();
    await page.mouse.move(line.x + 2, line.y + 8);
    await page.mouse.down();
    await page.mouse.move(line.x + 110, line.y + 8, { steps: 8 });
    const dragging = await color();
    await page.mouse.up();
    const released = await color();
    assert.equal(dragging, blurred);
    assert.equal(released, blurred);
    const before = await page.evaluate(() => window.view.state.selection.main.toJSON());
    await page.locator('#outside').click();
    assert.deepEqual(await page.evaluate(() => window.view.state.selection.main.toJSON()), before);
    await page.evaluate(() => { document.querySelector('.cm-editor').dataset.attachmentOnlySelection = 'true'; window.view.focus(); });
    assert.equal(await color(), 'rgba(0, 0, 0, 0)', 'attachment-only outline behavior is preserved');
    console.log(JSON.stringify({ focused, blurred, dragging, released, selectionPreserved: true, attachmentOutlinePreserved: true }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
