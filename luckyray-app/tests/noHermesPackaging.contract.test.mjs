import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the formal Windows package is no-Hermes and media owns its Python runtime", async () => {
  const tauri = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.deepEqual(tauri.bundle.resources, {
    "dsh/": "deepseek-harness/",
    "dsh-host/": "dsh-host/",
    "media-engine/": "media-engine/",
  });

  const manifest = JSON.parse(
    await readFile(path.join(root, "third_party", "media-engine", "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.python, {
    version: "3.11.8",
    fileName: "python-3.11.8-embed-amd64.zip",
    url: "https://www.python.org/ftp/python/3.11.8/python-3.11.8-embed-amd64.zip",
    sha256: "6347068ca56bf4dd6319f7ef5695f5a03f1ade3e9aa2d6a095ab27faa77a1290",
    license: "Python-2.0",
  });

  const plan = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/prepare-media-engine.ps1", "-PlanOnly"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(plan.status, 0, plan.stderr);
  const packagePlan = JSON.parse(plan.stdout);
  assert.equal(typeof packagePlan.existingRuntimeValid, "boolean");
  delete packagePlan.existingRuntimeValid;
  assert.deepEqual(packagePlan, {
    outputRoot: path.join(root, "src-tauri", "media-engine"),
    runtimeOwner: "media-engine",
    python: "3.11.8",
    pythonArchiveSha256: "6347068ca56bf4dd6319f7ef5695f5a03f1ade3e9aa2d6a095ab27faa77a1290",
    ytDlp: "2026.7.4",
    ytDlpEjs: "0.8.0",
    deno: "2.9.4",
    ffmpeg: "9.0.1",
  });

  const resolver = await readFile(path.join(root, "src-tauri", "src", "media_transfer.rs"), "utf8");
  assert.doesNotMatch(resolver, /resource_dir\.join\("agent-engine"\)\.join\("python\.exe"\)/);
  assert.match(resolver, /safe_runtime_path\(&canonical_root, &manifest\.python\)/);
});
