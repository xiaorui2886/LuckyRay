const fs = require("fs"), path = require("path"), http = require("http"), assert = require("assert/strict"), { execFileSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const esbuild = require(require.resolve("esbuild", { paths: [fs.realpathSync(root + "/node_modules/vite")] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const out = process.env.LUCKYRAY_MEDIA_AUDIT_OUTPUT || path.join(require("os").tmpdir(), "luckyray-media-ui-audit");
  fs.mkdirSync(out, { recursive: true });
  for (const [name, size] of [["wide", "640x360"], ["portrait", "180x320"]]) if (!fs.existsSync(out + "/" + name + ".mp4")) execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=" + size + ":d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", out + "/" + name + ".mp4"]);
  const entry = `import React from 'react';import{EditorView}from'@codemirror/view';window.editorEnd=()=>{const v=EditorView.findFromDOM(document.querySelector('#edit .cm-editor'));v.dispatch({selection:{anchor:v.state.doc.length},scrollIntoView:true});};import{I18nProvider}from'./src/core/i18n/index';import{createRoot}from'react-dom/client';import{LiveMarkdownEditor}from'./src/features/notes/editor/LiveMarkdownEditor';import{NotePreview}from'./src/features/notes/NotePreview';import './src/features/notes/notes.css';import './src/features/notes/editor/liveMarkdown.css';import './src/features/notes/media/noteMedia.css';import './src/features/notes/media/noteContent.css';
const assets=[['wide.png','image'],['tall.png','image'],['wide.mp4','video'],['portrait.mp4','video'],['bad.png','image'],['report.pdf','document']].map(([name,kind])=>({id:name,name,kind,previewUrl:kind==='document'?'':'/'+name,thumbnailUrl:kind==='image'?'/'+name:'',originalPath:name}));const text='# Media audit\\n\\nLeft aligned text.\\n\\n![[wide.png]]\\n\\n![[tall.png]]\\n\\n![[wide.mp4]]\\n\\n![[portrait.mp4]]\\n\\n![[wide.png|240]]\\n\\n![[bad.png]]\\n\\n![[report.pdf]]\\n\\n![[missing.png]]';const embeds=assets.map(a=>({targetName:a.name,assetId:a.id,isMissing:0}));window.events=[];function App(){return <main><section className='note-content-area' id='edit'><LiveMarkdownEditor currentNoteId='audit' value={text} assets={assets} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={embeds} onChange={()=>{}} onContextMenu={e=>window.events.push('context')}/></section><section className='note-content-area' id='read'><NotePreview text={text} assets={assets} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={embeds} onOpenNote={()=>{}} onCreateNote={()=>{}} onOpenAsset={()=>{}}/></section></main>};createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><App/></I18nProvider>);`;
  const build = await esbuild.build({ stdin: { contents: entry, loader: "tsx", resolveDir: root }, define: { "import.meta.env.DEV": "false" }, bundle: true, write: false, outdir: "out", format: "iife", jsx: "automatic", loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl" }, plugins: [{ name: "expose", setup(b) {
    b.onLoad({ filter: /NotesPage\.tsx$/ }, (a) => ({ contents: fs.readFileSync(a.path, "utf8") + "\nexport {NotePreview};", loader: "tsx" }));
  } }] });
  const js = build.outputFiles.find((x) => x.path.endsWith(".js")).text, css = build.outputFiles.filter((x) => x.path.endsWith(".css")).map((x) => x.text).join("\n");
  const server = http.createServer((q, r) => {
    const name = q.url.slice(1);
    if (name.endsWith(".mp4")) {
      const b = fs.readFileSync(out + "/" + name);
      r.setHeader("content-type", "video/mp4");
      r.setHeader("accept-ranges", "bytes");
      const m = /bytes=(\\d+)-(\\d*)/.exec(q.headers.range || "");
      if (m) {
        const a = +m[1], z = m[2] ? +m[2] : b.length - 1;
        r.statusCode = 206;
        r.setHeader("content-range", "bytes " + a + "-" + z + "/" + b.length);
        r.setHeader("content-length", z - a + 1);
        r.end(b.subarray(a, z + 1));
      } else {
        r.setHeader("content-length", b.length);
        r.end(b);
      }
      return;
    }
    if (["wide.png", "tall.png"].includes(name)) {
      r.setHeader("content-type", "image/svg+xml");
      r.end('<svg xmlns="http://www.w3.org/2000/svg" width="' + (name === "wide.png" ? 1200 : 300) + '" height="' + (name === "wide.png" ? 600 : 1200) + '"><rect width="100%" height="100%" fill="#487cab"/><text x="25" y="55" fill="white" font-size="24">Synthetic ' + name + "</text></svg>");
      return;
    }
    if (name === "app.js") {
      r.end(js);
      return;
    }
    if (name) {
      r.statusCode = 404;
      r.end();
      return;
    }
    r.end("<html><style>" + css + '\n:root{--bg-elevated:#24262b;--bg-surface:#18191d;--bg-active:#333;--text-primary:#eee;--text-secondary:#aaa;--text-tertiary:#999;--border:#555;--accent:#889cff}body{margin:0;background:#18191d;color:#eee;font-family:Arial}main{display:grid;grid-template-columns:1fr 1fr}section{height:900px;overflow:auto!important;min-width:0}body.light{background:white;color:#222;--bg-elevated:#eee;--bg-surface:#fff;--text-primary:#222;--text-secondary:#555;--text-tertiary:#666}body.single main{display:block}body.single section{height:900px}</style><div id="root"></div><script src="/app.js"><\/script></html>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1e3 } });
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  try {
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.waitForSelector("#read .note-media img");
    await page.waitForTimeout(2e3);
    const results = [];
    for (const [name, width, light, single] of [["wide-single", 1800, false, true], ["wide-dark", 1800, false, false], ["wide-light", 1800, true, false], ["narrow", 320, true, true]]) {
      await page.setViewportSize({ width, height: 1e3 });
      await page.evaluate(({ light: light2, single: single2 }) => document.body.className = [light2 ? "light" : "", single2 ? "single" : ""].join(" "), { light, single });
      await page.waitForTimeout(300);
      results.push({ name, metrics: await page.evaluate(() => [...document.querySelectorAll(".note-media")].map((e) => ({ pane: e.closest("section").id, kind: e.dataset.kind, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, img: e.querySelector("img")?.getAttribute("alt"), controls: e.querySelector("video")?.controls, hidden: !!e.querySelector("[aria-hidden=true] img"), body: !!e.querySelector(".lr-live-asset-body,.note-preview-asset-inline-body") }))) });
      await page.screenshot({ path: out + "/" + name + ".png", fullPage: true });
    }
    await page.setViewportSize({ width: 1800, height: 1e3 });
    await page.evaluate(() => {
      document.body.className = "light";
      window.scrollTo(0, 0);
      document.querySelector("#read .note-preview").scrollTop = 99999;
      document.querySelector("#edit .cm-scroller").scrollTop = 99999;
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.editorEnd());
    await page.waitForTimeout(300);
    await page.locator("#edit .note-media").first().dispatchEvent("contextmenu", { clientX: 60, clientY: 60 });
    console.log("context events", await page.evaluate(() => window.events));
    await page.locator("#edit").screenshot({ path: out + "/error-nonmedia-edit.png" });
    await page.locator("#read").screenshot({ path: out + "/error-nonmedia-read.png" });
    const imageOpen = page.locator("#read .note-media[data-kind=image] button[aria-label=\u653E\u5927\u56FE\u7247]").first();
    await imageOpen.focus();
    await page.waitForTimeout(200);
    await imageOpen.click();
    await page.waitForSelector("[role=dialog]");
    await page.keyboard.press("Escape");
    assert.equal(await imageOpen.evaluate((e) => document.activeElement === e), true, "image viewer focus restores");
    const editorOpen = page.locator("#edit .note-media[data-kind=image] button[aria-label=\u653E\u5927\u56FE\u7247]").last();
    await editorOpen.evaluate((e) => e.click());
    await page.waitForSelector("[role=dialog]");
    await page.keyboard.press("Escape");
    console.log("editor viewer restored", await editorOpen.evaluate((e) => document.activeElement === e));
    const full = page.locator("#read .note-media[data-kind=video] button[aria-label=\u5168\u5C4F\u64AD\u653E]").last();
    await full.focus();
    await page.waitForTimeout(200);
    await full.click();
    await page.waitForTimeout(150);
    console.log("fullscreen", await page.evaluate(() => document.fullscreenElement ? { tag: document.fullscreenElement.tagName, w: document.fullscreenElement.getBoundingClientRect().width, h: document.fullscreenElement.getBoundingClientRect().height } : null));
    await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : void 0);
    const focus = page.locator("#read .note-media .note-media-actions button").first();
    await focus.focus();
    await page.waitForTimeout(250);
    assert.equal(await focus.locator("..").evaluate((e) => getComputedStyle(e).opacity), "1");
    const v = page.locator("#read video").last();
    await v.evaluate((e) => new Promise((r) => {
      if (e.readyState >= 2) r();
      else e.addEventListener("loadeddata", r, { once: true });
    }));
    await v.evaluate((e) => {
      e.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      e.pause();
      e.currentTime = 1.5;
      e.closest(".note-media").dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    });
    await page.waitForTimeout(100);
    console.log("seek", await v.evaluate((e) => ({ t: e.currentTime, ready: e.readyState, d: e.duration, error: e.error?.code })));
    assert(await v.evaluate((e) => e.currentTime) > 1.4, "user seek must survive leave");
    console.log("PASS focus-within controls and video manual seek ownership");
    results.push({ name: "tail", metrics: await page.evaluate(() => [...document.querySelectorAll(".note-media")].map((e) => ({ pane: e.closest("section").id, kind: e.dataset.kind, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, text: e.textContent.slice(0, 100) }))) });
    for (const result of results.filter((r) => r.name !== "tail")) {
      const ed = result.metrics.find((m) => m.pane === "edit" && m.kind === "image");
      const rd = result.metrics.find((m) => m.pane === "read" && m.kind === "image");
      assert.equal(ed.w, rd.w);
      assert.equal(ed.h, rd.h);
      for (const m of result.metrics) {
        assert.equal(m.body, false);
        assert.equal(m.hidden, false);
        if (m.kind === "video") assert.equal(m.controls, true);
      }
    }
    const tail = results.find((r) => r.name === "tail").metrics;
    assert(tail.some((m) => m.pane === "edit" && m.w === 240 && m.h === 120));
    assert(tail.some((m) => m.pane === "read" && m.w === 240 && m.h === 120));
    const portrait = tail.filter((m) => m.kind === "video" && m.h === 700);
    assert.equal(portrait.length, 2);
    assert(tail.some((m) => m.pane === "read" && m.text.includes("\u8BFB\u53D6\u5931\u8D25") && m.h <= 200));
    for (const pane of ["edit", "read"]) {
      assert(results[0].metrics.some((m) => m.pane === pane && m.img === "tall.png" && m.w === 300 && m.h === 1200), "default images keep their intrinsic size in " + pane);
    }
    fs.writeFileSync(out + "/results.json", JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
