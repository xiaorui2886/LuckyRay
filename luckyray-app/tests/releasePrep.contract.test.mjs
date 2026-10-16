import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("v1.9.4 is one version across desktop, Rust, Tauri, and Collector", async () => {
  const [packageJson, tauri, cargo, collector, collectorReadme] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("src-tauri/tauri.conf.json").then(JSON.parse),
    read("src-tauri/Cargo.toml"),
    read("browser-extension-prototype/manifest.json").then(JSON.parse),
    read("browser-extension-prototype/README.md"),
  ]);

  assert.equal(packageJson.version, "1.9.4");
  assert.equal(tauri.version, packageJson.version);
  assert.match(cargo, /^version = "1\.9\.4"$/m);
  assert.equal(collector.version, packageJson.version);
  assert.match(collectorReadme, /版本：v1\.9\.4/);
});

test("release asset assembly has exact private-release filenames and checksum authority", () => {
  const env = { ...process.env };
  delete env.CARGO_TARGET_DIR;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/assemble-release-assets.ps1",
    "-OutputRoot",
    "D:\\codex\\luckyray\\artifacts\\v1.9.4-contract",
    "-PlanOnly",
  ], { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    schemaVersion: 1,
    version: "1.9.4",
    installer: "LuckyRay_1.9.4_x64-setup.exe",
    collector: "LuckyRay-Collector-1.9.4.zip",
    checksums: "SHA256SUMS.txt",
    collectorSource: "tracked-files-only",
    targetRoot: path.join(root, "src-tauri", "target"),
  });
});

test("release assets cannot be assembled anywhere inside the Git worktree", () => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/assemble-release-assets.ps1",
    "-OutputRoot",
    path.resolve(root, "..", ".release-output-must-stay-outside"),
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: path.resolve(root, "..", ".missing-release-target"),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release-output-must-be-outside-repository/);
});

test("tracked release notes disclose the user-visible release and safety boundaries", async () => {
  const notes = await read("docs/releases/v1.9.4.md");
  assert.match(notes, /^# LuckyRay v1\.9\.4$/m);
  assert.match(notes, /简体中文与\s*English/);
  assert.match(notes, /正式安装与主开发资料仍隔离/);
  assert.match(notes, /CSV/);
  assert.match(notes, /原文件/);
  assert.match(notes, /0\.1\.7-rc\.2/);
  assert.match(notes, /未配置独立引擎在线签名feed/);
  assert.match(notes, /权限/);
  assert.match(notes, /未做Authenticode代码签名/);
});
