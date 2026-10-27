import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("formal NSIS readiness owns every production resource and keeps one version", async () => {
  const [packageJson, tauri, cargo, cargoLock, tauriIgnore, installerHooks] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("src-tauri/tauri.conf.json").then(JSON.parse),
    read("src-tauri/Cargo.toml"),
    read("src-tauri/Cargo.lock"),
    read("src-tauri/.gitignore"),
    read("src-tauri/windows/native-messaging-hooks.nsh"),
  ]);

  assert.equal(packageJson.version, "1.9.9");
  assert.equal(tauri.version, packageJson.version);
  assert.match(cargo, /^version = "1\.9\.9"$/m);
  assert.match(cargoLock, /\[\[package\]\]\r?\nname = "luckyray-app"\r?\nversion = "1\.9\.9"\r?\n/);
  assert.deepEqual(tauri.bundle.resources, {
    "dsh/": "lr-lsh/199-1/deepseek-harness/",
    "dsh-host/": "lr-lsh/199-1/dsh-host/",
    "media-engine/": "media-engine/",
    "../third-party-notices/": "third-party-notices/",
  });
  assert.doesNotMatch(JSON.stringify(tauri.bundle), /agent-engine|hermes/i);
  assert.deepEqual(tauri.bundle.windows.nsis.languages, ["SimpChinese", "English"]);
  assert.equal(tauri.bundle.windows.nsis.displayLanguageSelector, true);
  assert.equal(tauri.bundle.windows.nsis.installerHooks, "./windows/native-messaging-hooks.nsh");
  assert.doesNotMatch(installerHooks, /^!define MUI_LANGDLL_ALWAYSSHOW$/m,
    "an upgrade must reuse the persisted installer language, not force a picker in passive mode");
  assert.match(installerHooks, /WriteRegStr HKCU "\$\{MANUPRODUCTKEY\}" "Installer Language" \$LANGUAGE/,
    "silent first installs must also persist the real selected language for the next passive upgrade");
  assert.match(tauriIgnore, /^\/dsh\/$/m);
});

test("the real beforeBuild child performs input and prepared gates around all owned staging", () => {
  const child = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$PSModuleAutoLoadingPreference='None'; & './scripts/prepare-tauri-build.ps1' -PlanOnly",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const plan = JSON.parse(child.stdout.trim());
  assert.deepEqual(plan.steps.map(({ name }) => name), [
    "readiness-inputs",
    "media-engine",
    "dsh-runtime",
    "external-bins",
    "frontend",
    "readiness-prepared",
  ]);
  assert.deepEqual(plan.steps[2], {
    name: "dsh-runtime",
    script: "scripts/prepare-dsh-package-runtime.ps1",
    output: "src-tauri/dsh",
  });
});

test("PowerShell dependencies are explicit and DSH package inputs stay frozen and app-owned", async () => {
  const [moduleLoader, mediaPrepare, dshPrepare, dshPackagePrepare, authority] = await Promise.all([
    read("scripts/import-package-powershell-modules.ps1"),
    read("scripts/prepare-media-engine.ps1"),
    read("scripts/prepare-dsh-runtime.ps1"),
    read("scripts/prepare-dsh-package-runtime.ps1"),
    read("dsh-host/runtime-authority.json").then(JSON.parse),
  ]);

  for (const moduleName of [
    "Microsoft.PowerShell.Management",
    "Microsoft.PowerShell.Utility",
    "Microsoft.PowerShell.Security",
    "Microsoft.PowerShell.Archive",
  ]) {
    assert.match(moduleLoader, new RegExp(moduleName.replaceAll(".", "\\.")));
  }
  assert.match(mediaPrepare, /import-package-powershell-modules\.ps1/);
  assert.match(dshPrepare, /import-package-powershell-modules\.ps1/);
  assert.match(dshPrepare, /PSObject\.Properties\['ArgumentList'\]/);
  assert.match(dshPrepare, /'--node-linker=hoisted'/);
  assert.match(dshPrepare, /'--package-import-method=copy'/);
  assert.match(dshPrepare, /project-release-stage/);
  assert.match(dshPackagePrepare, /runtime-authority\.json/);
  assert.match(dshPackagePrepare, /prepare-dsh-runtime\.ps1/);
  assert.match(dshPackagePrepare, /-ReleaseLayout/);
  assert.match(dshPackagePrepare, /verify-release-stage/);
  assert.match(dshPackagePrepare, /'fetch'/);
  assert.match(dshPackagePrepare, /'--frozen-lockfile'/);
  assert.match(dshPackagePrepare, /'--ignore-scripts'/);
  assert.match(dshPackagePrepare, /'--ignore-pnpmfile'/);
  assert.match(dshPackagePrepare, /PSObject\.Properties\['ArgumentList'\]/);
  assert.doesNotMatch(dshPackagePrepare, /\$(?:HOME|home)\b/);
  assert.doesNotMatch(dshPackagePrepare, /agent-engine|hermes|\$env:LOCALAPPDATA|verified-runtime-cache/i);

  const plan = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$PSModuleAutoLoadingPreference='None'; & './scripts/prepare-dsh-package-runtime.ps1' -PlanOnly",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  const parsed = JSON.parse(plan.stdout.trim());
  assert.deepEqual(parsed, {
    schemaVersion: 1,
    runtimeOwner: "dsh-host",
    outputRoot: path.join(root, "src-tauri", "dsh"),
    runtimePackage: authority.runtimePackage.version,
    node: authority.nodeRuntime.version,
    nodeArchiveSha256: authority.nodeRuntime.archiveSha256,
    pnpm: authority.packageManager.version,
    pnpmTarballSha256: authority.packageManager.sha256,
    dependencyLockSha256: authority.dependencyClosure.sha256,
    offlineStage: true,
    installScripts: false,
    releaseLayout: {
      nodeLinker: "hoisted",
      packageImportMethod: "copy",
      reparsePoints: 0,
      fixedEntryPoint: "host/node_modules/@deepseek-ai/dsh/lib/bin.js",
    },
  });
});

test("the release seal inputs and formal no-Hermes staging entry remain closed", async () => {
  const requiredSealInputs = [
    "dsh-host/runtime-authority.json",
    "dsh-host/records/dependency-audit.json",
    "dsh-host/records/launch-manifest.json",
    "dsh-host/records/runtime-manifest.json",
  ];
  await Promise.all(requiredSealInputs.map(read));

  const beforeBuild = await read("scripts/prepare-tauri-build.ps1");
  assert.match(beforeBuild, /prepare-dsh-package-runtime\.ps1/);
  assert.match(beforeBuild, /assert-package-readiness\.ps1/);
  assert.doesNotMatch(beforeBuild, /prepare-(?:agent-engine-runtime|hermes-engine)\.ps1/i);

  const buildRs = await read("src-tauri/build.rs");
  assert.match(buildRs, /let sidecar_prepare\s*=\s*std::env::var\("LUCKYRAY_SIDECAR_PREPARE"\)/);
  assert.match(
    buildRs,
    /if !sidecar_prepare \{[\s\S]*DEV_SIDECAR_PLACEHOLDER[\s\S]*validate_registered_cli_contract[\s\S]*validate_registered_sidecar_origin_contract/,
    "the controlled sidecar compiler must generate release binaries before ordinary release identity gates run",
  );
});

test("prepared readiness rejects NSIS resource source paths beyond the compiler boundary", async () => {
  const readiness = await read("scripts/assert-package-readiness.ps1");
  assert.match(readiness, /nsisMaxSourcePath\s*=\s*259/);
  assert.match(readiness, /package-nsis-resource-source-path-too-long/);
  assert.match(readiness, /Get-ChildItem[\s\S]*-File[\s\S]*-Recurse/);
});
