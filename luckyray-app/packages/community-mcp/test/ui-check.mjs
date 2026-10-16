import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  { build } = require("esbuild"),
  { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url)),
  out = resolve(process.env.LR_MCP_UI_OUTPUT ?? "/tmp/luckyray-mcp-ui");
await mkdir(out, { recursive: true });
await build({
  entryPoints: [resolve(here, "ui/entry.tsx")],
  bundle: true,
  outfile: resolve(out, "app.js"),
  format: "esm",
  jsx: "automatic",
  alias: {
    "@tauri-apps/api/core": resolve(here, "ui/transport-fixture.ts"),
    "@tauri-apps/plugin-opener": resolve(here, "ui/transport-fixture.ts"),
  },
});
await writeFile(
  resolve(out, "index.html"),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;font-family:system-ui,sans-serif}button,input,select{font:inherit}button{cursor:pointer}</style><div id="root"></div><script type="module" src="/app.js"></script></html>',
);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!["index.html", "app.js", "app.css"].includes(file)) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(resolve(out, file)));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole("button", { name: "添加", exact: true }).waitFor();
  await page.screenshot({ path: resolve(out, "community-uninstalled.png") });
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("progressbar", { name: "正在校验并安装插件…" }).waitFor();
  await page.getByRole("heading", { name: "素材库与知识库" }).waitFor();
  await page.getByLabel("素材库", { exact: true }).selectOption("assets");
  await page.getByLabel("知识库", { exact: true }).selectOption("notes");
  assert.equal(
    await page
      .getByRole("button", { name: "一起授权", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByLabel("确认允许网页 AI 使用上述权限，有效期 30 天").check();
  await page.getByRole("button", { name: "一起授权", exact: true }).click();
  await page.getByText("两项授权已开启").waitFor();
  await page
    .getByLabel("Tunnel ID", { exact: true })
    .fill("key_synthetic_wrong_id");
  await page
    .getByLabel("运行 API 密钥", { exact: true })
    .fill("fixture-only-not-a-real-key");
  assert.equal(await page.getByRole("button", { name: "保存连接配置", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "连接", exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("随 LuckyRay 启动连接", { exact: false }).isDisabled(), true);
  await page.getByText("请输入完整的 tunnel_… 隧道 ID，不要填写 API 密钥、Key ID 或网页地址。", { exact: true }).waitFor();
  await page.getByText("请先保存连接配置，再连接或开启随 LuckyRay 启动连接。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "打开隧道管理页", exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => window.__actions.some(x => x.action === "configure")), false);
  await page.screenshot({ path: resolve(out, "community-invalid-tunnel.png") });
  await page.getByLabel("Tunnel ID", { exact: true }).fill("  tunnel_" + "g".repeat(32) + "  ");
  assert.equal(await page.getByLabel("Tunnel ID", { exact: true }).getAttribute("aria-invalid"), null);
  assert.equal(await page.getByRole("button", { name: "保存连接配置", exact: true }).isDisabled(), false);
  assert.equal(
    await page
      .getByLabel("运行 API 密钥", { exact: true })
      .getAttribute("type"),
    "password",
  );
  await page.getByRole("button", { name: "保存连接配置", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("input[type=password]")?.value === "",
  );
  assert.equal(await page.evaluate(() => window.__actions.find(x => x.action === "configure").tunnelId), "tunnel_" + "g".repeat(32));
  await page.screenshot({ path: resolve(out, "community-configured.png") });
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page
    .getByText("隧道就绪 · 等待网页调用", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "停止连接", exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "停止连接", exact: true }).click();
  await page.getByLabel("随 LuckyRay 启动连接", { exact: false }).click();
  await page.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked === true);
  await page.getByRole("button", { name: "关闭授权", exact: true }).click();
  await page.getByRole("button", { name: "一起授权", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "连接", exact: true }).isDisabled(),
    true,
  );
  // Revocation renders the unbound form before its action finally releases busy.
  // Escape is intentionally disabled until that mutation completes.
  await page.waitForFunction(() => {
    const close = document.querySelector('button[aria-label="关闭"]');
    return close && !close.disabled;
  });
  assert.equal(await page.getByRole("dialog").evaluate((dialog) => dialog.contains(document.activeElement)), true);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "管理连接", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("dialog").evaluate((dialog) => Promise.all(dialog.getAnimations().map((animation) => animation.finished)));
  await page.screenshot({ path: resolve(out, "community-narrow.png") });
  const bounds = await page.getByRole("dialog").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.screenshot({ path: resolve(out, "community-light.png") });
  const actions = await page.evaluate(() => window.__actions);
  assert.deepEqual(
    actions.map((x) => x.action),
    [
      "install",
      "authorize",
      "configure",
      "connect",
      "disconnect",
      "preferences",
      "revoke",
    ],
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(out, "result.json"),
    JSON.stringify(
      {
        passed: true,
        scope:
          "Actual React component + original theme/modal components; native transport is a test fixture, not Windows/web acceptance",
        actions: actions.map((x) => x.action),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "UI fixture PASS: install, unified consent, secure input clearing, readiness distinction, stop, autoconnect, revoke, Escape, narrow and light layouts",
  );
} catch (error) {
  for (const page of browser.contexts().flatMap((context) => context.pages())) {
    await page.screenshot({ path: resolve(out, "failure.png") }).catch(() => {});
    console.error(await page.locator("body").ariaSnapshot().catch(() => "snapshot unavailable"));
  }
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
