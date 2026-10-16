// Server rendering of the actual Settings component with explicit native
// status fixtures. This is not a device/UI acceptance or a live profile test.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const { build } = viteRequire("esbuild");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function render(phase, canInstall = false, locale = "zh-CN") {
  const status = { phase, currentVersion: "0.1.7-rc.2", candidateVersion: canInstall ? "0.2.0-rc.2" : null,
    upstreamVersion: "0.2.0-rc.2", sourceClass: "development", channel: "preview", canCheck: true, canInstall,
    canRecover: false, canVerify: false, canRestart: false, canPrepareExit: false, canCancel: false, workStage: null };
  const bundle = await build({ entryPoints: [resolve(root, "src/features/settings/DshEngineUpdateCard.tsx")],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react/jsx-runtime"],
    loader: { ".css": "empty" }, plugins: [{ name: "explicit-native-fixtures", setup(builder) {
      builder.onResolve({ filter: /\/dshEngineUpdate$/ }, () => ({ path: "native-status", namespace: "fixture" }));
      builder.onResolve({ filter: /\/i18n\/index$/ }, () => ({ path: "locale", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "js", contents: path === "locale"
        ? `export const defineMessages = x => x; export const useMessages = x => ({ t: key => x[key][${JSON.stringify(locale)}] });`
        : `export const dshEngineUpdate = { latest: () => (${JSON.stringify(status)}), subscribe: () => () => {}, status: async () => (${JSON.stringify(status)}) };` }));
    } }] });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, compiled, compiled.exports);
  return renderToStaticMarkup(React.createElement(compiled.exports.default));
}

test("settings exposes the existing install action only for an admitted compatible candidate", async () => {
  const available = await render("available", true);
  assert.match(available, /0\.2\.0-rc\.2/u);
  assert.match(available, /下载并验证升级/u);
  for (const phase of ["legacy_contract", "no_candidate", "upgrade_path", "requires_host", "untrusted", "check_failed", "upstream_unvalidated"]) {
    const html = await render(phase);
    assert.doesNotMatch(html, /下载并验证升级/u);
    assert.doesNotMatch(html, /需要更新 LuckyRay/u);
  }
});

test("settings distinguishes catalog absence, legacy evidence, upgrade path and real incompatibility", async () => {
  assert.match(await render("no_candidate"), /暂无候选清单/u);
  assert.match(await render("legacy_contract"), /旧版更新清单绑定的宿主构建已变化/u);
  assert.match(await render("upgrade_path"), /候选未验证从当前引擎版本升级/u);
  assert.match(await render("requires_host"), /接口或能力.*不兼容/u);
  assert.match(await render("untrusted"), /签名、格式或有效期/u);
  assert.match(await render("check_failed"), /失败或离线/u);
  assert.match(await render("upstream_unvalidated", false, "en-US"), /has not verified it/u);
});
