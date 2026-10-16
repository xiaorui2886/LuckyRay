const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
    "C:/Users/Administrator/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright",
);
(async () => {
  const source = fs.readFileSync(
    root + "/src/features/materials/MaterialsPage.tsx",
    "utf8",
  );
  const component = source.slice(
    source.indexOf("function ImagePreview("),
    source.indexOf("\nfunction AssetHoverControls"),
  );
  assert(
    component.includes("failedIdentity") && !component.includes("useEffect"),
    "failure identity must not be reset by an effect",
  );
  assert.match(
    source,
    /isImage \? \(\s*<ImagePreview[\s\S]*?variant="viewer"/,
    "viewer uses the shared failure-aware image",
  );
  const cardImageCalls = [...source.matchAll(/<ImagePreview\b[^>]*src=\{previewUrl\}[^>]*\/>/g)];
  assert.equal(cardImageCalls.length,3,"all three production material views use the shared image");
  for (const call of cardImageCalls) assert.match(call[0],/sourceIdentity=\{`\$\{asset\.id\}:\$\{asset\.updatedAt \|\| ""\}`\}/,"each card passes asset and file-generation identity");
  const script = await esbuild.build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{materialsZhCN}from'./src/core/i18n/materialsMessages';const useI18n=()=>({t:key=>materialsZhCN[key]});const FileIcon=()=> <svg viewBox="0 0 16 16" width="24" height="24" aria-hidden="true"><path d="M3 1h7l3 3v11H3z" fill="none" stroke="currentColor"/></svg>;${component}
 function Fixture(){const [src,setSrc]=useState('/missing.png'),[version,setVersion]=useState('1');window.changeImage=setSrc;window.changeVersion=setVersion;return <><div id="card" className="masonry-item"><ImagePreview src={src} alt="带有很长名称的附件图片.png" className="asset-image-thumb-react" sourceIdentity={version}/></div><div id="viewer" className="qp-media-stage-react"><ImagePreview src={src} alt="带有很长名称的附件图片.png" variant="viewer" sourceIdentity={version}/></div></>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
  });
  const css = fs.readFileSync(
    root + "/src/features/materials/materials.css",
    "utf8",
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==",
    "base64",
  );
  let mutableReady = false;
  const server = http.createServer((q, r) => {
    if (q.url === "/mutable.png") {
      r.writeHead(mutableReady ? 200 : 404,{"content-type":"image/png","cache-control":"no-store"});
      r.end(mutableReady ? png : "temporarily missing"); return;
    }
    if (q.url.startsWith("/missing")) {
      r.writeHead(404, {
        "content-type": "image/png",
        "cache-control": "public,max-age=3600",
      });
      r.end("invalid image");
      return;
    }
    if (q.url.startsWith("/good")) {
      r.setHeader("content-type", "image/png");
      r.end(png);
      return;
    }
    r.setHeader(
      "content-type",
      q.url === "/app.js"
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8",
    );
    r.end(
      q.url === "/app.js"
        ? script.outputFiles[0].text
        : `<meta charset="utf-8"><style>:root{--bg-active:#202026;--text-secondary:#bcbcc5;--text-tertiary:#90909a;--radius-md:8px}body{margin:20px;background:#111114;color:#ddd;font:13px sans-serif}${css}#card{width:320px}#viewer{width:320px;height:280px;position:relative;margin-top:24px}</style><main id="root"></main><script src="/app.js"></script>`,
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({
        viewport: { width: 390, height: 800 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.locator("#card .image-preview-fallback-react").waitFor();
    await page.locator("#viewer .image-preview-error-react").waitFor();
    assert.equal(
      await page
        .locator("#viewer")
        .getByText("图片加载失败", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator("#viewer")
        .getByText("带有很长名称的附件图片.png", { exact: true })
        .count(),
      1,
    );
    assert(
      (await page.locator("#card").boundingBox()).height >= 120,
      "failed masonry image does not collapse into a strip",
    );
    await page.evaluate(() => window.changeVersion("2"));
    await page.locator("#card .image-preview-fallback-react").waitFor();
    assert.equal(
      await page.locator("#card img").count(),
      0,
      "cached failure survives StrictMode and source-version remount",
    );
    await page.evaluate(() => window.changeImage("/good.png"));
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("img")].length === 2 &&
        [...document.querySelectorAll("img")].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
    );
    assert.equal(
      await page
        .locator(".image-preview-fallback-react,.image-preview-error-react")
        .count(),
      0,
    );
    assert.equal(
      Math.round((await page.locator("#card img").boundingBox()).width),
      320,
      "successful card sizing is unchanged",
    );
    await page.evaluate(() => window.changeImage("/missing-again.png"));
    await page.locator("#card .image-preview-fallback-react").waitFor();
    await page.locator("#viewer .image-preview-error-react").waitFor();
    await page.screenshot({
      path: "C:/Cursor/material-image-failure-regression.png",
      fullPage: true,
    });
    await page.evaluate(()=>window.changeImage('/mutable.png'));
    await page.locator('#card .image-preview-fallback-react').waitFor();
    mutableReady=true;
    await page.evaluate(()=>window.changeVersion('file-revision-3'));
    await page.waitForFunction(()=>[...document.querySelectorAll('img')].length===2 && [...document.querySelectorAll('img')].every(image=>image.complete&&image.naturalWidth>0));
    assert.equal(await page.locator('.image-preview-fallback-react,.image-preview-error-react').count(),0,'same URL is retried after file generation changes');
    assert.deepEqual(errors, []);
    console.log(
      "PASS: production shared ImagePreview and viewer usage, real cached HTTP image failure, StrictMode, source change recovery, subsequent failure, masonry height, viewer filename, production CSS, success sizing",
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
