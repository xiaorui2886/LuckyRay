import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const exe = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
await mkdir(out, { recursive: true });
await esbuild.build({ entryPoints: [new URL("./native-menu.ts", import.meta.url).pathname.replace(/^\/(.:)/, "$1")], bundle: true, format: "iife", outfile: join(out, "app.js") });
for (const name of ["index", "child"]) await writeFile(join(out, `${name}.html`), '<!doctype html><meta charset="utf-8"><script src="app.js" defer></script>');
const child = spawn(exe, ["--extension-community-fixture", out], { env: { ...process.env, LUCKYRAY_APP_PROFILE: "", LUCKYRAY_FIXTURE_TIMEOUT_SECS: "90" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let stdout = "", stderr = "";
child.stdout.on("data", (data) => stdout += data);
child.stderr.on("data", (data) => stderr += data);
let root, result;
try {
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    const line = stdout.split(/\r?\n/).find((line) => line.includes('"community-fixture-ready"'));
    if (line) root = JSON.parse(line).root;
    if (root) {
      const read = (name) => readFile(join(root, "reports", `${name}.json`), "utf8").then(JSON.parse).catch(() => null);
      const main = await read("native-menu-main"), nested = await read("native-menu-child");
      if (main && nested) { result = { main, child: nested }; break; }
    }
    if (child.exitCode !== null) throw Error(`fixture exited ${child.exitCode}: ${stderr.slice(-1500)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(result, `fixture report timeout: ${stderr.slice(-1500)}`);
  await writeFile(join(out, "result.json"), JSON.stringify({ root, ...result }, null, 2));
  assert.equal(result.main.ok, true, JSON.stringify(result.main));
  assert.equal(result.child.ok, true, JSON.stringify(result.child));
  console.log("PASS real native icon menu creation, item identity, enabled state, localization, reuse and cleanup after child creation");
} finally {
  // Only this test's spawned fixture process; its broker drops owned workers.
  child.kill();
}
