const assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const outputDir = process.env.LUCKYRAY_TEST_OUTPUT_DIR || path.join(require("node:os").tmpdir(), "luckyray-note-image-viewer");
const esbuild = require(require.resolve("esbuild", { paths: [fs.realpathSync(root + "/node_modules/vite")] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const built = await esbuild.build({ stdin: { contents: 'import {openImageViewer} from "./src/features/notes/media/imageViewer"; window.openViewer = openImageViewer;', resolveDir: root, loader: "ts" }, bundle: true, write: false, outdir: outputDir, format: "iife" });
  const script = built.outputFiles.find(f => f.path.endsWith(".js")).text;
  const css = built.outputFiles.find(f => f.path.endsWith(".css")).text;
  let failures = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/viewer.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(script); }
    if (req.url === "/viewer.css") { res.setHeader("Content-Type", "text/css"); return res.end(css); }
    if (req.url === "/image.svg" || (req.url === "/recovered.svg" && failures++ > 0)) {
      res.setHeader("Content-Type", "image/svg+xml"); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="teal"/><circle cx="800" cy="500" r="30" fill="white"/></svg>');
    }
    if (req.url === "/recovered.svg") { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<link rel="stylesheet" href="/viewer.css"><button id="opener">Open image</button><button id="outside">Outside</button><script src="/viewer.js"></script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LUCKYRAY_CHROMIUM_EXECUTABLE }).catch(error => { server.close(); throw error; });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const open = async (src = "/image.svg") => {
      await page.evaluate(src => { const button = document.querySelector("#opener"); button.focus(); window.disposeViewer = window.openViewer({ src, alt: "Synthetic image" }, button); }, src);
    };
    const ready = () => page.waitForFunction(() => { const image = document.querySelector("dialog img"); return image?.naturalWidth && !image.hidden; });
    await open(); await ready();
    assert.match(await page.locator(":focus").getAttribute("aria-label"), /关闭/);
    const stage = await page.locator(".note-image-viewer-stage").boundingBox();
    const point = { x: stage.x + stage.width / 2 + 50, y: stage.y + stage.height / 2 + 20 };
    await page.mouse.dblclick(point.x, point.y);
    let matrix = await page.locator("dialog img").evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return { scale: m.a, x: m.e, y: m.f }; });
    assert.equal(matrix.scale, 2.5);
    assert.equal(50 * matrix.scale + matrix.x, 50, "image point remains under mouse after zoom");
    assert.equal(20 * matrix.scale + matrix.y, 20);
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 100, point.y + 60); await page.mouse.up();
    const panned = await page.locator("dialog img").evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return {x:m.e,y:m.f}; });
    assert.equal(panned.x, matrix.x + 100, JSON.stringify(await page.locator(".note-image-viewer-stage").evaluate(el => ({zoom:el.dataset.zoomed,drag:el.dataset.dragging,w:el.clientWidth,h:el.clientHeight,img:el.querySelector("img").style.cssText})))); assert.equal(panned.y, matrix.y + 60);
    await page.mouse.dblclick(point.x, point.y);
    assert.equal(await page.locator(".note-image-viewer-stage").getAttribute("data-zoomed"), "false");
    for (let i=0;i<5;i++) { await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => !!document.activeElement.closest("dialog")), true); }
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").count(), 0);
    assert.equal(await page.locator(":focus").getAttribute("id"), "opener");
    await page.setViewportSize({ width: 320, height: 480 }); await open(); await ready();
    const box = await page.locator("dialog img").boundingBox();
    assert.ok(box.width <= 320 && box.height < 480); assert.ok(Math.abs(box.width / box.height - 1.6) < .01);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => { window.disposeViewer(); window.disposeViewer(); });
    await open("/recovered.svg"); await page.getByRole("status").filter({hasText:"图片无法加载"}).waitFor();
    await page.keyboard.press("Escape"); await open("/recovered.svg"); await ready();
    assert.equal(await page.getByRole("status").isVisible(), false, "reopening recovered same URL clears old failure");
    await open(); await ready(); assert.equal(await page.locator("dialog").count(), 1);
    await page.keyboard.press("Escape");
    console.log("PASS actual image viewer: cursor anchored zoom, pan, fit, modal keyboard focus, Escape restore, narrow layout, error recovery and disposal");
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
