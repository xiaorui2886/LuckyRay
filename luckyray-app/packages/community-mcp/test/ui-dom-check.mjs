/** Real component event/DOM test. This is NOT a browser layout or native acceptance. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  { build } = require("esbuild"),
  { JSDOM } = require("jsdom");
const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  entryPoints: [resolve(here, "ui/entry.tsx")],
  bundle: true,
  write: false,
  outdir: "/tmp/mcp-dom",
  format: "iife",
  jsx: "automatic",
  alias: {
    "@tauri-apps/api/core": resolve(here, "ui/transport-fixture.ts"),
    "@tauri-apps/plugin-opener": resolve(here, "ui/transport-fixture.ts"),
  },
});
const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "MutationObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "HTMLInputElement",
  "HTMLSelectElement",
])
  globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.structuredClone = globalThis.structuredClone;
const {
  getByRole,
  getByLabelText,
  findByRole,
  findByText,
  waitFor,
  queryByRole,
} = require("@testing-library/dom");
const user = require("@testing-library/user-event").default.setup({
  document: dom.window.document,
});
dom.window.eval(bundle.outputFiles.find((x) => x.path.endsWith(".js")).text);
const body = document.body;
try {
  const add = await findByRole(body, "button", { name: "添加", exact: true });
  await waitFor(() => assert.equal(add.disabled, false));
  await user.click(add);
  await findByRole(body, "heading", { name: "素材库与知识库" });
  await user.selectOptions(
    getByLabelText(body, "素材库", { exact: true }),
    "assets",
  );
  await user.selectOptions(
    getByLabelText(body, "知识库", { exact: true }),
    "notes",
  );
  assert.equal(
    getByRole(body, "button", { name: "一起授权", exact: true }).disabled,
    true,
  );
  await user.click(
    getByLabelText(body, "确认允许网页 AI 使用上述权限，有效期 30 天"),
  );
  await user.click(
    getByRole(body, "button", { name: "一起授权", exact: true }),
  );
  await findByText(body, "两项授权已开启");
  await user.type(
    getByLabelText(body, "Tunnel ID", { exact: true }),
    "tunnel_0123456789abcdef0123456789abcdef",
  );
  await user.type(
    getByLabelText(body, "运行 API 密钥", { exact: true }),
    "synthetic-test-key",
  );
  assert.equal(
    getByLabelText(body, "运行 API 密钥", { exact: true }).type,
    "password",
  );
  await user.click(
    getByRole(body, "button", { name: "保存连接配置", exact: true }),
  );
  await waitFor(() =>
    assert.equal(
      getByLabelText(body, "运行 API 密钥", { exact: true }).value,
      "",
    ),
  );
  await user.click(getByRole(body, "button", { name: "连接", exact: true }));
  await findByRole(body, "button", { name: "停止连接", exact: true });
  assert.ok(body.textContent.includes("隧道就绪 · 等待网页调用"));
  assert.ok(!body.textContent.includes("synthetic-test-key"));
  await user.click(
    getByRole(body, "button", { name: "停止连接", exact: true }),
  );
  await findByRole(body, "button", { name: "连接", exact: true });
  await user.click(getByLabelText(body, /随 LuckyRay 启动连接/));
  await waitFor(() =>
    assert.equal(getByLabelText(body, /随 LuckyRay 启动连接/).checked, true),
  );
  await user.click(
    getByRole(body, "button", { name: "关闭授权", exact: true }),
  );
  await findByRole(body, "button", { name: "一起授权", exact: true });
  assert.equal(
    getByRole(body, "button", { name: "连接", exact: true }).disabled,
    true,
  );
  await user.keyboard("{Escape}");
  await waitFor(() => assert.equal(queryByRole(body, "dialog"), null));
  await user.click(
    getByRole(body, "button", { name: "管理连接", exact: true }),
  );
  await findByRole(body, "dialog");
  await user.click(
    getByRole(body, "button", { name: "卸载插件", exact: true }),
  );
  await findByRole(body, "button", { name: "确认卸载", exact: true });
  await user.click(getByRole(body, "button", { name: "取消", exact: true }));
  assert.equal(
    queryByRole(body, "button", { name: "确认卸载", exact: true }),
    null,
  );
  assert.deepEqual(
    Array.from(dom.window.__actions, (x) => x.action),
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
  console.log(
    "DOM interaction PASS: actual community component + original modal, unified consent, password masking/clearing, readiness labels, stop/revoke, Escape and uninstall cancellation. Layout and Windows transport NOT tested.",
  );
} finally {
  dom.window.close();
}
