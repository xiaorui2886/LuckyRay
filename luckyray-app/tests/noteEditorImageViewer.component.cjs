const assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const outputDir = process.env.LUCKYRAY_TEST_OUTPUT_DIR || path.join(require("node:os").tmpdir(), "luckyray-note-image-viewer");
const esbuild = require(require.resolve("esbuild", { paths: [fs.realpathSync(root + "/node_modules/vite")] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright");
(async () => {
    const built = await esbuild.build({ stdin: { contents: `
import React, { useState, useEffect } from 'react';
import { KnowledgeStore } from './src/core/services/knowledgeStore';
import { attachmentPresentationVersion } from './src/core/markdown/realVaultEmbeds';
import { createRoot } from 'react-dom/client';
import { LiveMarkdownEditor } from './src/features/notes/editor/LiveMarkdownEditor';
import { NoteMedia } from './src/features/notes/media/NoteMedia';
import { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';
window.getView = () => EditorView.findFromDOM(document.querySelector('.cm-editor'));
window.depth = () => undoDepth(window.getView().state);
function App() {
  const [value, setValue] = useState('![[image.svg]]\\n\\nText');
  const [, setGeneration] = useState(0);
  const [version, setVersion] = useState('1');
  useEffect(() => {
    const store = new KnowledgeStore();
    store.watchedRoot = 'C:/synthetic';
    store.snapshot.vault = { id: 'fixture', rootPath: 'C:/synthetic' };
    store.invalidate = async () => {
      setVersion(previous => attachmentPresentationVersion(
        '1', previous, 'image.svg', store.getSnapshot().attachmentChanges,
      ));
      setGeneration(value => value + 1);
      return store.getSnapshot();
    };
    // Capture the real fallback callback so the test can advance its 30s tick.
    const original = window.setInterval;
    window.setInterval = callback => {
      window.fallbackTick = callback;
      return 424242;
    };
    store.startWatchFallback();
    window.setInterval = original;
    window.contentChanged = () => {
      store.fileChanges.add({ paths: ['C:/synthetic/image.svg'], type: 'modify' }, Date.now());
      store.queueVaultWatchRefresh();
    };
    return () => store.stopVaultWatch();
  }, []);
  window.rerender = () => setGeneration(value => value + 1);
  window.value = value;
  const asset = { id: 'image', name: 'image.svg', kind: 'image', previewUrl: '/image.svg?v=' + version };
  return <>
    <section id="edit">
      <LiveMarkdownEditor currentNoteId="note" value={value} assets={[asset]}
        notes={[]} tags={[]} noteLinks={[]}
        noteEmbeds={[{ targetName: 'image.svg', assetId: 'image', isMissing: 0 }]}
        onChange={setValue} />
    </section>
    <section id="read">
      <NoteMedia asset={asset} alt="Reading image" />
    </section>
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
`, resolveDir: root, loader: "tsx" }, jsx: 'automatic', bundle: true, write: false, outdir: outputDir, format: "iife" });
    const script = built.outputFiles.find(f => f.path.endsWith(".js")).text;
    const css = built.outputFiles.find(f => f.path.endsWith(".css")).text;
    const server = http.createServer((req, res) => {
        if (req.url === "/viewer.js") {
            res.setHeader("Content-Type", "text/javascript");
            return res.end(script);
        }
        if (req.url === "/viewer.css") {
            res.setHeader("Content-Type", "text/css");
            return res.end(css);
        }
        if (new URL(req.url, "http://fixture").pathname === "/image.svg") {
            res.setHeader("Content-Type", "image/svg+xml");
            return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="teal"/><circle cx="800" cy="500" r="30" fill="white"/></svg>');
        }
        res.setHeader('Content-Type', 'text/html');
        res.end('<link rel="stylesheet" href="/viewer.css"><style>#edit,#read{width:460px;display:inline-block;vertical-align:top}</style><div id="root"></div><script src="/viewer.js"></script>');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true, channel: "msedge" }).catch(error => { server.close(); throw error; });
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.locator('#edit img').waitFor();
        await page.evaluate(() => {
            const view = window.getView();
            view.dispatch({ changes: { from: view.state.doc.length, insert: ' typed' } });
        });
        await page.waitForFunction(() => window.value.endsWith(' typed'));
        assert.ok(await page.evaluate(() => window.depth()) > 0);
        for (const mode of ['edit', 'read']) {
            const button = page.locator('#' + mode + ' button[aria-label="放大图片"]');
            await page.locator("#" + mode + " img").hover();
            await button.click();
            await page.waitForFunction(() => document.querySelector('dialog img')?.naturalWidth > 0);
            await page.evaluate(() => {
                window.dialog = document.querySelector('dialog');
                window.editor = window.getView();
                window.originalValue = window.value;
                window.undoDepth = window.depth();
                window.viewerRemoved = 0;
                window.observer = new MutationObserver(records => {
                    for (const record of records) {
                        for (const node of record.removedNodes) {
                            if (node === window.dialog) window.viewerRemoved++;
                        }
                    }
                });
                window.observer.observe(document.body, { childList: true });
            });
            const stage = await page.locator('.note-image-viewer-stage').boundingBox();
            const x = stage.x + stage.width / 2 + 40, y = stage.y + stage.height / 2 + 20;
            await page.mouse.dblclick(x, y);
            await page.evaluate(() => new Promise(requestAnimationFrame));
            assert.equal(await page.evaluate(() => document.querySelector('dialog img') && new DOMMatrix(getComputedStyle(document.querySelector('dialog img')).transform).a), 2.5, mode + ' zoom');
            await page.evaluate(() => {
                window.rerender();
                window.fallbackTick();
                window.dispatchEvent(new Event('focus'));
                window.fallbackTick();
            });
            await page.evaluate(() => new Promise(requestAnimationFrame));
            const beforePan = await page.locator('dialog img').evaluate(image => new DOMMatrix(getComputedStyle(image).transform).e);
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + 80, y + 40, { steps: 5 });
            await page.mouse.up();
            const afterPan = await page.locator('dialog img').evaluate(image => new DOMMatrix(getComputedStyle(image).transform).e);
            assert.equal(afterPan, beforePan + 80, mode + ' image pans by the dragged distance');
            assert.equal(await page.evaluate(() => window.dialog === document.querySelector('dialog')), true, mode + ' viewer identity');
            assert.equal(await page.evaluate(() => window.viewerRemoved), 0, mode + ' viewer never replaced');
            assert.equal(await page.evaluate(() => window.editor === window.getView() && window.originalValue === window.value && window.undoDepth === window.depth()), true, mode + ' editor unchanged');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('dialog').count(), 0);
            await page.evaluate(() => window.observer.disconnect());
            await page.locator('#' + mode + ' img').hover();
            await button.click();
            await page.waitForFunction(() => document.querySelector('dialog img')?.naturalWidth > 0);
            await page.evaluate(() => window.contentChanged());
            await page.waitForFunction(() => !document.querySelector('dialog'));
            assert.equal(await page.locator('dialog').count(), 0, mode + ' confirmed content event closes old source viewer');
        }
        console.log("PASS actual editor and reading viewer: zoom, pan, stable fallback ticks/focus, confirmed content invalidation, Escape, editor identity and undo");
    }
    finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
