const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright",
);
(async () => {
  const entry = String.raw`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {LiveMarkdownEditor} from './src/features/notes/editor/LiveMarkdownEditor';import {EditorView} from '@codemirror/view';
  const initial=('# 标题\n\n'+('Long 中文 paragraph, editable text. '.repeat(12))+'\n\n').repeat(80);
  window.reconfigurations=0;window.changes=0;window.times=[];
  const original=EditorView.prototype.dispatch;EditorView.prototype.dispatch=function(...args){const t=performance.now();const result=original.apply(this,args);window.times.push(performance.now()-t);return result;};
  function Fixture(){const [value,setValue]=useState(initial);const [tick,setTick]=useState(0);window.rerender=()=>setTick(t=>t+1);window.value=value;
  return <LiveMarkdownEditor ref={h=>window.handle=h} value={value} currentNoteId='A' assets={[]} notes={[{id:'A',title:'A',contentText:value}]} tags={[]} noteLinks={[]} noteEmbeds={[]} onOpenAsset={()=>{}} onCreateNote={()=>{}} onChange={v=>{window.changes++;setValue(v)}}/>;}
  createRoot(document.getElementById('root')).render(<Fixture/>);window.getView=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'));`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
  });
  const server = http.createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      req.url === "/fixture.js" ? "text/javascript" : "text/html",
    );
    res.end(
      req.url === "/fixture.js"
        ? built.outputFiles[0].text
        : '<style>body{--text-primary:#ddd;--accent:#8785ff;background:#111}.cm-scroller{height:600px}</style><div id="root"></div><script src="/fixture.js"></script>',
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.waitForFunction(() => window.handle);
    await page.evaluate(() => {
      const view = window.getView();
      window.originalView = view;
      const update = view.update.bind(view);
      view.update = (trs) => {
        window.reconfigurations += trs.filter((tr) => tr.reconfigured).length;
        update(trs);
      };
      window.handle.setSelection({ start: 15, end: 15 });
      window.reconfigurations = 0;
    });
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.rerender());
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    const idle = await page.evaluate(() => window.reconfigurations);
    await page.locator(".cm-content").focus();
    await page.keyboard.type("Typing0123456789");
    for (let i = 0; i < 8; i++) await page.keyboard.press("Backspace");
    const result = await page.evaluate(
      (idle) => ({
        idle,
        changes: window.changes,
        valueMatches: window.value === window.handle.getValue(),
        sameView: window.originalView === window.getView(),
        reconfigurations: window.reconfigurations,
        times: window.times,
      }),
      idle,
    );
    result.times.sort((a, b) => a - b);
    result.p95 = result.times[Math.floor(result.times.length * 0.95)];
    delete result.times;
    console.log(JSON.stringify(result));
    assert.equal(
      idle,
      0,
      "parent-only updates must not reconfigure the live editor",
    );
    assert(result.valueMatches && result.sameView);
    await page.evaluate(() => window.handle.replaceRange("inserted reference", { start: 15, end: 19 }));
    await page.evaluate(() => window.rerender());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const insertion = await page.evaluate(() => ({ selection: window.handle.getSelection(), valueMatches: window.value === window.handle.getValue() }));
    assert.deepEqual(insertion.selection, { start: 33, end: 33 });
    assert(insertion.valueMatches);
  } finally {
    await browser?.close();
    await new Promise((r) => server.close(r));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
