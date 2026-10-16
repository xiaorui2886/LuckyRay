import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseWindowSurfaceColor,
  syncWindowSurfaceBackground,
} from "../src/app/windowSurfaceBackground";
import { selectCompactShellForViewport } from "../src/app/shellViewport";

const readJson = async (path: URL) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

test("the native window has an opaque first-frame fallback before the webview paints", async () => {
  const config = await readJson(new URL("../src-tauri/tauri.conf.json", import.meta.url));
  const app = config.app as { windows?: Array<{ backgroundColor?: unknown }> };
  assert.equal(app.windows?.[0]?.backgroundColor, "#0a0a0c",
    "the undecorated Windows surface must not expose the platform white/default backing store during restore");

  const capability = await readJson(new URL("../src-tauri/capabilities/default.json", import.meta.url));
  const permissions = capability.permissions as string[];
  assert.ok(permissions.includes("core:window:allow-set-background-color"));
  assert.ok(permissions.includes("core:webview:allow-set-webview-background-color"));
});

test("theme surfaces synchronize the window and webview to the effective app background", async () => {
  assert.deepEqual(parseWindowSurfaceColor("#0a0a0c"), [10, 10, 12, 255]);
  assert.deepEqual(parseWindowSurfaceColor(" #f3e8ec "), [243, 232, 236, 255]);
  assert.equal(parseWindowSurfaceColor("transparent"), null);

  const applied: Array<[number, number, number, number]> = [];
  const didApply = await syncWindowSurfaceBackground(
    () => "#c7d1dc",
    async (color) => { applied.push(color); },
  );
  assert.equal(didApply, true);
  assert.deepEqual(applied, [[199, 209, 220, 255]]);
});

test("unpaintable or non-Tauri surfaces fail soft without inventing a background", async () => {
  let calls = 0;
  const didApply = await syncWindowSurfaceBackground(
    () => "rgba(0, 0, 0, 0)",
    async () => { calls += 1; },
  );
  assert.equal(didApply, false);
  assert.equal(calls, 0);
});

test("minimized transient viewports do not churn the retained shell mode", () => {
  assert.equal(selectCompactShellForViewport(1, false), false);
  assert.equal(selectCompactShellForViewport(1, true), true);
  assert.equal(selectCompactShellForViewport(1200, false), true);
  assert.equal(selectCompactShellForViewport(1280, true), false);
});
