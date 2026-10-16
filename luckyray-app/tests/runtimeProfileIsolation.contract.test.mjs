import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const runPowerShell = (script, args = [], env = {}) => spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  },
);

test("desktop development has one canonical isolated profile and cannot bundle", async () => {
  const [packageJson, production, development] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("src-tauri/tauri.conf.json").then(JSON.parse),
    read("src-tauri/tauri.dev.conf.json").then(JSON.parse),
  ]);

  assert.equal(production.identifier, "com.luckyray.desktop");
  assert.equal(development.identifier, "com.luckyray.desktop.dev");
  assert.notEqual(development.identifier, production.identifier);
  assert.equal(development.productName, "LuckyRay Dev");
  assert.equal(development.bundle.active, false);
  assert.equal(packageJson.scripts["dev:desktop"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-luckyray-dev.ps1");
  assert.match(production.build.beforeDevCommand, /--reject-bare/);
  assert.match(development.build.beforeDevCommand, /assert-runtime-profile\.ps1/);
  assert.equal(development.build.devUrl, 'http://127.0.0.1:1420');
});

test("the canonical dev wrapper resolves only the development identifier", () => {
  const plan = runPowerShell("scripts/start-luckyray-dev.ps1", ["-PlanOnly"], { LUCKYRAY_DEV_EXTENSION_ORIGINS: "" });
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout.trim()), {
    schemaVersion: 1,
    profile: "development",
    identifier: "com.luckyray.desktop.dev",
    extensionOrigins: [
      "chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid",
      "chrome-extension://kjibmbcoioanaejehhfopjhdpnbkodla",
    ],
    command: [
      "pnpm.cmd",
      "tauri",
      "dev",
      "--config",
      "src-tauri/tauri.dev.conf.json",
    ],
  });
});

test("development extension origin override stays exact and rejects wildcards", () => {
  const override = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const plan = runPowerShell("scripts/start-luckyray-dev.ps1", ["-PlanOnly"], { LUCKYRAY_DEV_EXTENSION_ORIGINS: override });
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).extensionOrigins, [override]);
  const invalid = runPowerShell("scripts/start-luckyray-dev.ps1", ["-PlanOnly"], { LUCKYRAY_DEV_EXTENSION_ORIGINS: "chrome-extension://*" });
  assert.notEqual(invalid.status, 0);
});

test("shared manifest public-key validation rejects missing, empty and short keys", () => {
  for (const manifest of [{}, { key: "" }, { key: "YQ==" }]) {
    const encoded = Buffer.from(JSON.stringify(manifest)).toString("base64");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; . ./scripts/release-extension-origins.ps1; $manifest=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; Get-LuckyRayManifestPublicKey $manifest`,
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release-extension-manifest-key-(missing|invalid)/);
  }
});

test("the before-dev gate fails closed without the exact development marker", () => {
  const marker = "LUCKYRAY_APP_PROFILE";
  const baseEnv = { [marker]: "" };
  const missing = runPowerShell("scripts/assert-runtime-profile.ps1", [], baseEnv);
  assert.notEqual(missing.status, 0);

  const wrong = runPowerShell("scripts/assert-runtime-profile.ps1", [], { [marker]: "production" });
  assert.notEqual(wrong.status, 0);

  const development = runPowerShell("scripts/assert-runtime-profile.ps1", [], { [marker]: "development" });
  assert.equal(development.status, 0, development.stderr);
});

test("documented desktop development never directs contributors into production data", async () => {
  const readme = await read("README.md");
  assert.match(readme, /pnpm dev:desktop/);
  assert.match(readme, /com\.luckyray\.desktop\.dev/);
  assert.doesNotMatch(readme, /^pnpm tauri dev$/m);
});
