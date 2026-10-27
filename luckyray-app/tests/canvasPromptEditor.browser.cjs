const { chromium } = require(
  process.env.LR_PLAYWRIGHT_MODULE || "playwright-core",
);
// Real layout check. Requires Playwright + a supported Chromium runtime.
// DOM-only coverage lives separately in canvasPromptEditor.dom.cjs.
const fs = require("fs");
const assert = require("assert/strict");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const repo = path.resolve(__dirname, "..");
const requireFromRepo = createRequire(path.join(repo, "package.json"));
const { build } = createRequire(requireFromRepo.resolve("vite"))("esbuild");
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lr-prompt-layout-"));
  const bundle = path.join(temporary, "fixture.js");
  await build({
    stdin: {
      contents:
        "import {mountPromptEditorFixture} from './tests/fixtures/canvasPromptEditor.fixture.tsx'; window.fixture = mountPromptEditorFixture(document.getElementById('root'));",
      resolveDir: repo,
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    outfile: bundle,
  });
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.LR_CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(
      '<style>body{font:12px sans-serif} #root{width:360px} .canvas-prompt-editor img{display:block;width:100%;height:100%}</style><div id="root"></div>',
    );
    await page.addStyleTag({
      content: fs.readFileSync(
        path.join(repo, "src/canvas-spike-scroll.css"),
        "utf8",
      ),
    });
    await page.addStyleTag({
      content: fs.readFileSync(
        path.join(repo, "src/features/canvas/canvasPromptEditor.css"),
        "utf8",
      ),
    });
    await page.addScriptTag({ path: bundle });
    await page.waitForTimeout(60);
    await page.evaluate(() => window.fixture.set(""));
    await page.waitForTimeout(30);
    await page.evaluate(() => {
      const editor = document.querySelector("[role=textbox]");
      editor.classList.add("canvas-composer-prompt");
      editor.innerHTML = "<div><br></div>";
      editor.focus();
      window.fixture.handle.current.insertReference("a");
    });
    await page.waitForTimeout(30);
    const metrics = await page.evaluate(() => {
      const e = document.querySelector("[role=textbox]");
      const token = e.querySelector(".canvas-prompt-token");
      const img = document.createElement("img");
      img.className = "canvas-prompt-token-thumb";
      img.src =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>';
      token.querySelector(".canvas-prompt-token-remove").prepend(img);
      let a = e.getBoundingClientRect(),
        b = token.getBoundingClientRect(),
        i = img.getBoundingClientRect();
      return {
        value: window.fixture.value(),
        top: b.top - a.top,
        height: b.height,
        thumbWidth: i.width,
        thumbHeight: i.height,
        display: getComputedStyle(img).display,
      };
    });
    assert.equal(metrics.value, "[[lr-ref:a]]");
    assert.ok(metrics.top < 20, JSON.stringify(metrics));
    assert.equal(metrics.thumbWidth, 15);
    assert.equal(metrics.thumbHeight, 15);
    assert.equal(metrics.display, "inline-block");
    await page.keyboard.type(" after");
    await page.waitForTimeout(30);
    assert.equal(
      await page.evaluate(() => window.fixture.value()),
      "[[lr-ref:a]] after",
    );
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(30);
    await page.evaluate(() =>
      window.fixture.handle.current.insertReference("a"),
    );
    await page.waitForTimeout(30);
    assert.equal(
      await page.evaluate(() => window.fixture.value()),
      "[[lr-ref:a]]",
    );
    console.log(
      "PASS real Chromium first-line insertion, 15px image despite broad image rule, typing after token, delete-all/reinsert",
      metrics,
    );
  } finally {
    await browser?.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
