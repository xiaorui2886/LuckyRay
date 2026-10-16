import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repo = process.cwd();
const sidecarNames = ["luckyray-native-host", "luckyray-cli", "luckyray-mcp", "luckyray-browser-host"] as const;
// Inputs outside src-tauri that build.rs fingerprints or Rust embeds. Keep real
// source bytes: bypassing those gates would stop these being release-gate tests.
const externalCargoInputs = [
  "dsh-host/runtime-authority.json",
  "dsh-host/records/dependency-audit.json",
  "dsh-host/records/launch-manifest.json",
  "dsh-host/records/runtime-manifest.json",
  "dsh-host/records/sbom.cdx.json",
  "dsh-host/records/THIRD-PARTY-NOTICES.txt",
  "dsh-host/package.json",
  "dsh-host/.npmrc",
  "dsh-host/pnpm-lock.yaml",
  "dsh-host/pnpm-workspace.yaml",
  "src/core/services/openInLightSeek.ts",
  "src/features/ai/DshNativeSurfacePage.tsx",
  "src/features/ai/LightSeekContentBrowser.tsx",
  "tests/openInLightSeek.contract.test.ts",
  "tests/dshNativeSurfaceImageIntent.contract.test.mjs",
  "src/core/canvas/twelveMediaSpecs.json",
  "protocol/companion-v1/services-v1/operations.json",
  "protocol/companion-v1/content-v1/capabilities.json",
  "scripts/dsh-frozen-assembly-worker.mjs",
  "scripts/dsh-supply-chain.mjs",
  "scripts/dsh-frozen-assembly-description.mjs",
  "scripts/dsh-frozen-inputs.mjs",
  "scripts/dsh-npm-tar-policy.mjs",
  "scripts/dsh-frozen-cache-relay.mjs",
  "scripts/dsh-assembly-network-fence.mjs",
  "plugin-sdk/examples/palette/example.palette.lrpack.json",
  "plugin-sdk/examples/outline/example.outline.lrpack.json",
  "plugin-sdk/examples/canvas-export/example.canvas-export.lrpack.json",
] as const;
const chromiumExtensionId = (subjectPublicKeyInfo: Buffer) => {
  const alphabet = "abcdefghijklmnop";
  const digest = createHash("sha256").update(subjectPublicKeyInfo).digest();
  return [...digest.subarray(0, 16).toString("hex")]
    .map((nibble) => alphabet[Number.parseInt(nibble, 16)])
    .join("");
};
const runPowerShell = (script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env,
  });

const copyCargoFixtureWithoutSidecars = (fixtureRoot: string) => {
  const source = path.join(repo, "src-tauri");
  const fixtureRepo = path.dirname(fixtureRoot);
  cpSync(source, fixtureRoot, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(source, entry).replaceAll("\\", "/");
      return !relative.split("/").some((part) => part === "node_modules" || part === "%SystemDrive%")
        && relative !== "target"
        && !relative.startsWith("target/")
        && relative !== "binaries"
        && !relative.startsWith("binaries/");
    },
  });
  cpSync(path.join(repo, "config"), path.join(fixtureRepo, "config"), { recursive: true });
  mkdirSync(path.join(fixtureRepo, "browser-extension-prototype"), { recursive: true });
  cpSync(
    path.join(repo, "browser-extension-prototype", "manifest.json"),
    path.join(fixtureRepo, "browser-extension-prototype", "manifest.json"),
  );
  for (const relative of externalCargoInputs) {
    const destination = path.join(fixtureRepo, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repo, relative), destination);
  }
};

test("the sidecar Cargo fixture preserves external compile inputs without product binaries", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "luckyray-sidecar-inputs-"));
  const fixture = path.join(temp, "src-tauri");
  try {
    copyCargoFixtureWithoutSidecars(fixture);
    // These are real build-script / include_str! inputs, not mocked contents.
    for (const relative of [
      "src/core/services/openInLightSeek.ts",
      "src/features/ai/DshNativeSurfacePage.tsx",
      "src/features/ai/LightSeekContentBrowser.tsx",
      "tests/openInLightSeek.contract.test.ts",
      "tests/dshNativeSurfaceImageIntent.contract.test.mjs",
      "src/core/canvas/twelveMediaSpecs.json",
      "protocol/companion-v1/services-v1/operations.json",
      "protocol/companion-v1/content-v1/capabilities.json",
      "scripts/dsh-frozen-assembly-worker.mjs",
      "dsh-host/records/sbom.cdx.json",
      "plugin-sdk/examples/palette/example.palette.lrpack.json",
    ]) {
      assert.ok(existsSync(path.join(temp, relative)), `missing compile input: ${relative}`);
      assert.deepEqual(readFileSync(path.join(temp, relative)), readFileSync(path.join(repo, relative)));
    }
    assert.equal(existsSync(path.join(fixture, "binaries")), false);
    assert.equal(existsSync(path.join(fixture, "target")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Cargo selects the desktop app when Tauri runs cargo without an explicit binary", () => {
  const result = spawnSync("cargo.exe", ["metadata", "--no-deps", "--format-version", "1"], {
    cwd: path.join(repo, "src-tauri"),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  const packageMetadata = metadata.packages.find((entry: { name: string }) => entry.name === "luckyray-app");
  assert.ok(packageMetadata, "luckyray-app package is present in Cargo metadata");
  assert.equal(packageMetadata.default_run, "luckyray-app");
  assert.deepEqual(
    packageMetadata.targets
      .filter((target: { kind: string[] }) => target.kind.includes("bin"))
      .map((target: { name: string }) => target.name)
      .sort(),
    ["luckyray-app", "luckyray-browser-host", "luckyray-browser-host-poc", "luckyray-cli", "luckyray-mcp", "luckyray-native-host", "luckyray-update-verify"],
  );
  assert.deepEqual(packageMetadata.features.default, ["sidecar-binaries"]);
  assert.deepEqual(packageMetadata.features["sidecar-binaries"], ["browser-host-runtime"]);
  assert.deepEqual(
    [...packageMetadata.features["browser-host-runtime"]].sort(),
    ["dep:url", "dep:webview2-com", "dep:windows"],
  );
  assert.deepEqual(
    [...packageMetadata.features["browser-host-poc"]].sort(),
    ["browser-host-runtime"],
  );
  assert.deepEqual(
    [...packageMetadata.features["browser-host-poc-fixture"]].sort(),
    ["browser-host-poc"],
  );
  const requiredFeatures = Object.fromEntries(
    packageMetadata.targets
      .filter((target: { kind: string[] }) => target.kind.includes("bin"))
      .map((target: { name: string; "required-features"?: string[] }) => [
        target.name,
        target["required-features"] ?? [],
      ]),
  );
  assert.deepEqual(requiredFeatures, {
    "luckyray-app": [],
    "luckyray-browser-host": ["sidecar-binaries"],
    "luckyray-browser-host-poc": ["browser-host-poc"],
    "luckyray-cli": ["sidecar-binaries"],
    "luckyray-mcp": ["sidecar-binaries"],
    "luckyray-native-host": ["sidecar-binaries"],
    "luckyray-update-verify": ["desktop-update-release-tools"],
  });
  const sidecarSources = packageMetadata.targets
    .filter((target: { name: string }) =>
      ["luckyray-browser-host", "luckyray-cli", "luckyray-mcp", "luckyray-native-host"].includes(target.name),
    )
    .map((target: { src_path: string }) => target.src_path.replaceAll("\\", "/"));
  assert.equal(sidecarSources.every((source: string) => source.includes("/src/sidecars/")), true);
  assert.equal(sidecarSources.some((source: string) => source.includes("/src/bin/")), false);
  const pocTarget = packageMetadata.targets.find(
    (target: { name: string }) => target.name === "luckyray-browser-host-poc",
  );
  assert.ok(pocTarget.src_path.replaceAll("\\", "/").includes("/src/poc/"));
  assert.equal(sidecarNames.includes(pocTarget.name), false);
});

test("a clean debug Cargo check creates the exact four Tauri sidecar placeholders", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "luckyray-empty-sidecars-"));
  const fixture = path.join(temp, "src-tauri");
  try {
    copyCargoFixtureWithoutSidecars(fixture);
    const result = spawnSync("cargo.exe", ["check", "--bin", "luckyray-app"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        CARGO_TARGET_DIR: path.join(temp, "target"),
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const metadata = spawnSync("rustc.exe", ["-vV"], { encoding: "utf8" });
    assert.equal(metadata.status, 0, metadata.stderr);
    const target = /^host:\s*(.+)$/m.exec(metadata.stdout)?.[1];
    assert.ok(target, "rustc reports its host target triple");
    const binaries = path.join(fixture, "binaries");
    const actual = readdirSync(binaries).sort();
    assert.deepEqual(
      actual,
      sidecarNames.map((name) => `${name}-${target}.exe`).sort(),
    );
    for (const filename of actual) {
      const bytes = readFileSync(path.join(binaries, filename));
      assert.equal(bytes.subarray(0, 2).toString("ascii"), "MZ", `${filename} is an MZ placeholder`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("release Cargo checks reject debug placeholders and never generate replacements", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "luckyray-release-sidecars-"));
  const fixture = path.join(temp, "src-tauri");
  const cargoEnv = {
    ...process.env,
    CARGO_TARGET_DIR: path.join(temp, "target"),
  };
  try {
    copyCargoFixtureWithoutSidecars(fixture);
    const debug = spawnSync("cargo.exe", ["check", "--bin", "luckyray-app"], {
      cwd: fixture,
      encoding: "utf8",
      env: cargoEnv,
    });
    assert.equal(debug.status, 0, debug.stderr);
    const binaries = path.join(fixture, "binaries");
    const before = new Map(
      readdirSync(binaries).map((filename) => [filename, readFileSync(path.join(binaries, filename))]),
    );

    const rejected = spawnSync(
      "cargo.exe",
      ["check", "--release", "--no-default-features", "--bin", "luckyray-app"],
      { cwd: fixture, encoding: "utf8", env: cargoEnv },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /debug placeholders are forbidden/);
    assert.deepEqual(
      new Map(readdirSync(binaries).map((filename) => [filename, readFileSync(path.join(binaries, filename))])),
      before,
      "a rejected release check leaves every placeholder unchanged",
    );

    rmSync(binaries, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const missing = spawnSync(
      "cargo.exe",
      ["check", "--release", "--no-default-features", "--bin", "luckyray-app"],
      { cwd: fixture, encoding: "utf8", env: cargoEnv },
    );
    assert.notEqual(missing.status, 0);
    assert.equal(existsSync(binaries), false, "release does not recreate the sidecar directory");
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("release Cargo checks reject a registered CLI whose identity or build profile drifted", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "luckyray-cli-contract-drift-"));
  const fixture = path.join(temp, "src-tauri");
  const cargoEnv = {
    ...process.env,
    CARGO_TARGET_DIR: path.join(temp, "target"),
  };
  try {
    copyCargoFixtureWithoutSidecars(fixture);
    const prepared = runPowerShell("scripts/prepare-native-host.ps1", [
      "-Release",
      "-DestinationRoot",
      path.join(fixture, "binaries"),
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const metadata = spawnSync("rustc.exe", ["-vV"], { encoding: "utf8" });
    assert.equal(metadata.status, 0, metadata.stderr);
    const target = /^host:\s*(.+)$/m.exec(metadata.stdout)?.[1];
    assert.ok(target, "rustc reports its host target triple");
    const recordPath = path.join(fixture, "binaries", `luckyray-cli-${target}.exe.identity.json`);
    const original = readFileSync(recordPath, "utf8");
    for (const mutate of [
      (record: { identity: string }) => {
        record.identity = "0".repeat(64);
      },
      (record: { profile: string }) => {
        record.profile = "debug";
      },
      (record: { hardening: string }) => {
        record.hardening = "development-unhardened";
      },
    ]) {
      const record = JSON.parse(original);
      mutate(record);
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
      const rejected = spawnSync(
        "cargo.exe",
        ["check", "--release", "--no-default-features", "--bin", "luckyray-app"],
        { cwd: fixture, encoding: "utf8", env: cargoEnv },
      );
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /does not match the current LuckyRay CLI protocol\/build identity/);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("development registration plan uses exact Edge and Chrome HKCU host keys", () => {
  const result = runPowerShell("scripts/register-native-host.ps1", ["-PlanOnly"]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout.trim());
  assert.equal(plan.hostName, "com.luckyray.desktop");
  assert.deepEqual(plan.registryKeys, [
    "HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.luckyray.desktop",
    "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.luckyray.desktop",
  ]);
  assert.equal(plan.hostBinary.includes("luckyray-native-host.exe"), true);
});

test("release native host plan uses the canonical private identity or a validated explicit override", () => {
  const noReleaseOverride = { ...process.env };
  delete noReleaseOverride.LUCKYRAY_EXTENSION_ORIGINS;
  const defaultPlan = runPowerShell("scripts/prepare-native-host.ps1", ["-Release", "-PlanOnly"], noReleaseOverride);
  assert.equal(defaultPlan.status, 0, defaultPlan.stderr);
  assert.equal(JSON.parse(defaultPlan.stdout.trim()).originSource, "canonical-private-release");
  const exact = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const allowed = runPowerShell("scripts/prepare-native-host.ps1", [
    "-Release",
    "-PlanOnly",
    "-ExtensionOrigins",
    exact,
  ]);
  assert.equal(allowed.status, 0, allowed.stderr);
  const plan = JSON.parse(allowed.stdout.trim());
  assert.equal(plan.originSource, "explicit-override");
  assert.equal(plan.extensionOriginCount, 1);
  assert.equal(allowed.stdout.includes("*"), false);

  const customTargetRoot = path.join(repo, "src-tauri", "target-contract-plan");
  const customTarget = runPowerShell("scripts/prepare-native-host.ps1", ["-Release", "-PlanOnly"], {
    ...noReleaseOverride,
    CARGO_TARGET_DIR: customTargetRoot,
  });
  assert.equal(customTarget.status, 0, customTarget.stderr);
  const customPlan = JSON.parse(customTarget.stdout.trim());
  assert.equal(
    customPlan.binaries.every((binary: { source: string }) =>
      binary.source.replaceAll("\\", "/").startsWith(`${customTargetRoot.replaceAll("\\", "/")}/release/`),
    ),
    true,
    "release staging must follow Cargo's explicit target directory instead of reading a stale default target",
  );
});

test("sidecar preparation plans one profile for all product binaries", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["build:sidecars"], packageJson.scripts["build:native-host"]);
  assert.match(
    readFileSync(path.join(repo, 'scripts/prepare-dev-sidecars.ps1'), 'utf8'),
    /prepare-native-host\.ps1" -SidecarNames luckyray-cli/,
    "Tauri dev refreshes the exact registered CLI externalBin instead of inheriting a stale source resource",
  );
  assert.equal(
    packageJson.scripts["build:nsis"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/build-nsis.ps1",
  );
  const nsisBuild = readFileSync(path.join(repo, "scripts/build-nsis.ps1"), "utf8");
  assert.match(
    nsisBuild,
    /tauri build --bundles nsis -- --no-default-features --features browser-host-runtime --bin luckyray-app/,
  );
  assert.equal(nsisBuild.includes("prepare-native-host.ps1"), false, "NSIS delegates staging to Tauri beforeBuild");
  assert.equal(nsisBuild.includes("prepare-media-engine.ps1"), false, "NSIS does not rebuild media runtime separately");
  assert.equal(nsisBuild.includes("native-messaging-hooks"), false);
  const nsisPlan = runPowerShell("scripts/build-nsis.ps1", [
    "-PlanOnly",
    "-ExtensionOrigins",
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
  ]);
  assert.equal(nsisPlan.status, 0, nsisPlan.stderr);
  const originConfigSha256 = createHash("sha256")
    .update(readFileSync(path.join(repo, "config", "release-extension-origins.json")))
    .digest("hex");
  assert.equal(originConfigSha256, "9556f1e138003fd34091a19e4e1d9a6343b7b7ceef7a86591167de5a41c4a024");
  assert.deepEqual(JSON.parse(nsisPlan.stdout.trim()), {
    schemaVersion: 1,
    profile: "release",
    originSource: "explicit-override",
    extensionOriginCount: 1,
    originFingerprint: "610b7b535affd45731867034c7fa11bfc28b06e428f062b5ff08761d4e149109",
    originConfigSha256,
    sidecarStaging: "tauri-before-build",
    command: [
      "pnpm.cmd",
      "tauri",
      "build",
      "--bundles",
      "nsis",
      "--",
      "--no-default-features",
      "--features",
      "browser-host-runtime",
      "--bin",
      "luckyray-app",
    ],
  });
  const result = runPowerShell("scripts/prepare-native-host.ps1", ["-PlanOnly"]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout.trim());
  assert.equal(plan.profile, "debug");
  assert.deepEqual(
    plan.binaries.map((entry: { name: string }) => entry.name),
    ["luckyray-native-host", "luckyray-cli", "luckyray-mcp", "luckyray-browser-host"],
  );
  assert.equal(plan.binaries.every((entry: { profile: string }) => entry.profile === "debug"), true);
  assert.equal(new Set(plan.binaries.map((entry: { destination: string }) => entry.destination)).size, 4);
  assert.equal(plan.binaries.every((entry: { destination: string }) => /-[^-]+-[^-]+-[^-]+\.exe$/i.test(entry.destination)), true);
});

test("release hygiene scans a drive-root repository as a path instead of a two-byte drive token", () => {
  const sidecarPrepare = readFileSync(path.join(repo, "scripts", "prepare-native-host.ps1"), "utf8");
  assert.match(sidecarPrepare, /Assert-ReleaseCliHygiene \$binary\.source \$repo \$userProfile/);
  assert.doesNotMatch(sidecarPrepare, /Assert-ReleaseCliHygiene \$binary\.source \$sourceRoot \$userProfile/);
});

test("ordinary Tauri before-build derives its private release origin from the tracked manifest-bound configuration", () => {
  const config = JSON.parse(readFileSync(path.join(repo, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.equal(
    config.build.beforeBuildCommand,
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-tauri-build.ps1",
  );
  const noReleaseOverride = { ...process.env };
  delete noReleaseOverride.LUCKYRAY_EXTENSION_ORIGINS;
  const planned = runPowerShell("scripts/prepare-tauri-build.ps1", ["-PlanOnly"], noReleaseOverride);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout.trim());
  assert.equal(plan.profile, "release");
  assert.equal(plan.originSource, "canonical-private-release");
  assert.equal(plan.extensionOriginCount, 1);
  assert.deepEqual(plan.sidecarNames, sidecarNames);
  assert.deepEqual(
    plan.steps.map((step: { name: string }) => step.name),
    ["readiness-inputs", "media-engine", "dsh-runtime", "external-bins", "frontend", "readiness-prepared"],
    "the real beforeBuild script stages resources and all registered externalBin files before frontend/Tauri build",
  );
  assert.deepEqual(plan.steps[3].sidecarNames, sidecarNames);
  assert.deepEqual(plan.steps[4].command, ["pnpm.cmd", "build"]);

  const originConfig = JSON.parse(
    readFileSync(path.join(repo, "config", "release-extension-origins.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(originConfig).sort(), ["channel", "origins", "publicKeySha256", "schemaVersion"]);
  assert.equal(originConfig.schemaVersion, 1);
  assert.equal(originConfig.channel, "private-release-v1");
  assert.equal(originConfig.origins.length, 1);
  assert.equal(originConfig.origins.includes("chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid"), false);

  const manifest = JSON.parse(readFileSync(path.join(repo, "browser-extension-prototype", "manifest.json"), "utf8"));
  assert.equal(typeof manifest.key, "string");
  const subjectPublicKeyInfo = Buffer.from(manifest.key, "base64");
  const publicKey = createPublicKey({ key: subjectPublicKeyInfo, format: "der", type: "spki" });
  assert.equal(publicKey.asymmetricKeyType, "rsa");
  assert.ok((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048);
  const derivedId = chromiumExtensionId(subjectPublicKeyInfo);
  assert.match(derivedId, /^[a-p]{32}$/);
  assert.equal(originConfig.origins[0], `chrome-extension://${derivedId}`);
  assert.equal(createHash("sha256").update(subjectPublicKeyInfo).digest("hex"), originConfig.publicKeySha256);

  const exactOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
  const override = runPowerShell("scripts/prepare-tauri-build.ps1", ["-PlanOnly"], {
    ...process.env,
    LUCKYRAY_EXTENSION_ORIGINS: exactOrigin,
  });
  assert.equal(override.status, 0, override.stderr);
  assert.equal(JSON.parse(override.stdout.trim()).originSource, "explicit-override");
  const invalid = runPowerShell("scripts/prepare-tauri-build.ps1", ["-PlanOnly"], {
    ...process.env,
    LUCKYRAY_EXTENSION_ORIGINS: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  });
  assert.notEqual(invalid.status, 0, "invalid release overrides fail before staging");

  const sidecarPlan = runPowerShell("scripts/prepare-native-host.ps1", [
    "-Release",
    "-PlanOnly",
    "-SidecarNames",
    sidecarNames.join(","),
  ]);
  assert.equal(sidecarPlan.status, 0, sidecarPlan.stderr);
  assert.deepEqual(
    JSON.parse(sidecarPlan.stdout.trim()).binaries.map((entry: { name: string }) => entry.name),
    sidecarNames,
    "the single before-build argument reaches the native staging script as the full registered externalBin set",
  );
});

test("PowerShell release-origin resolution rejects duplicate canonical-schema fields before staging", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "luckyray-origin-schema-"));
  try {
    mkdirSync(path.join(fixture, "config"), { recursive: true });
    mkdirSync(path.join(fixture, "browser-extension-prototype"), { recursive: true });
    const canonicalConfig = readFileSync(path.join(repo, "config", "release-extension-origins.json"), "utf8");
    writeFileSync(
      path.join(fixture, "config", "release-extension-origins.json"),
      canonicalConfig.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'),
    );
    cpSync(
      path.join(repo, "browser-extension-prototype", "manifest.json"),
      path.join(fixture, "browser-extension-prototype", "manifest.json"),
    );
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const resolver = quote(path.join(repo, "scripts", "release-extension-origins.ps1"));
    const fixtureRoot = quote(fixture);
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$ErrorActionPreference='Stop'; . ${resolver}; Get-LuckyRayReleaseOriginConfig -RepoRoot ${fixtureRoot} | Out-Null`,
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, "duplicate release schema fields must fail before staging");
    assert.match(`${result.stdout}${result.stderr}`, /release-extension-origins-schema-invalid/);
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("real sidecar preparation replaces stale files with one verified debug build", () => {
  const destinationRoot = mkdtempSync(path.join(os.tmpdir(), "luckyray-sidecars-"));
  try {
    const planned = runPowerShell("scripts/prepare-native-host.ps1", [
      "-PlanOnly",
      "-DestinationRoot",
      destinationRoot,
    ]);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout.trim());
    for (const binary of plan.binaries) {
      writeFileSync(binary.destination, "STALE-SIDECAR");
    }
    const built = runPowerShell("scripts/prepare-native-host.ps1", ["-DestinationRoot", destinationRoot]);
    assert.equal(built.status, 0, built.stderr);
    const result = JSON.parse(built.stdout.trim());
    assert.equal(result.profile, "debug");
    assert.deepEqual(
      result.binaries.map((entry: { name: string }) => entry.name),
      ["luckyray-native-host", "luckyray-cli", "luckyray-mcp", "luckyray-browser-host"],
    );
    assert.deepEqual(
      result.binaries.map((entry: { nativeMessagingHost: boolean }) => entry.nativeMessagingHost),
      [true, false, false, false],
    );
    for (const binary of result.binaries) {
      const source = readFileSync(binary.source);
      const destination = readFileSync(binary.destination);
      assert.equal(destination.subarray(0, 2).toString("ascii"), "MZ");
      assert.deepEqual(destination, source);
      assert.equal(
        binary.sha256.toLowerCase(),
        createHash("sha256").update(destination).digest("hex"),
      );
      assert.equal(binary.size, destination.length);
    }
    const cli = result.binaries.find((entry: { name: string }) => entry.name === "luckyray-cli");
    assert.ok(cli, "the controlled staging plan includes the registered CLI sidecar");
    assert.equal(cli.protocol, "luckyray-cli-contract-v1");
    assert.match(cli.protocolIdentity, /^[a-f0-9]{64}$/);
    const contract = JSON.parse(readFileSync(`${cli.destination}.identity.json`, "utf8"));
    assert.deepEqual(
      {
        schemaVersion: contract.schemaVersion,
        protocol: contract.protocol,
        identity: contract.identity,
        target: contract.target,
        binarySha256: contract.binarySha256,
        hardening: contract.hardening,
      },
      {
        schemaVersion: 1,
        protocol: cli.protocol,
        identity: cli.protocolIdentity,
        target: result.triple,
        binarySha256: cli.sha256,
        hardening: "development-unhardened",
      },
      "the staged externalBin carries a deterministic source/protocol binding",
    );
  } finally {
    rmSync(destinationRoot, { recursive: true, force: true });
  }
});

test("Tauri bundle and NSIS hook install the sidecar manifest for both browsers", () => {
  const config = JSON.parse(readFileSync(path.join(repo, "src-tauri/tauri.conf.json"), "utf8"));
  assert.deepEqual(config.bundle.externalBin, [
    "binaries/luckyray-native-host",
    "binaries/luckyray-cli",
    "binaries/luckyray-mcp",
    "binaries/luckyray-browser-host",
  ]);
  assert.equal(config.mainBinaryName, "luckyray-app");
  assert.equal(config.bundle.windows.nsis.installerHooks, "./windows/native-messaging-hooks.nsh");
  const hooks = readFileSync(path.join(repo, "src-tauri/windows/native-messaging-hooks.nsh"), "utf8");
  assert.match(hooks, /Microsoft\\Edge\\NativeMessagingHosts/);
  assert.match(hooks, /Google\\Chrome\\NativeMessagingHosts/);
  assert.match(hooks, /--install-manifest/);
  assert.equal(hooks.includes("luckyray-cli"), false);
  assert.equal(hooks.includes("luckyray-mcp"), false);
  assert.equal(hooks.includes("luckyray-browser-host"), false);
  assert.equal(hooks.includes("allowed_origins"), false, "origins are generated by the signed host, not the installer");
  assert.equal(existsSync(path.join(repo, "src-tauri/binaries/.gitignore")), true);
});

test("real native host exits after one framed response without waiting for stdin EOF", async () => {
  const build = spawnSync("cargo.exe", ["build", "--bin", "luckyray-native-host"], {
    cwd: path.join(repo, "src-tauri"),
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);
  const binary = path.join(repo, "src-tauri/target/debug/luckyray-native-host.exe");
  const temp = mkdtempSync(path.join(os.tmpdir(), "luckyray-native-host-contract-"));
  try {
    const message = Buffer.from(JSON.stringify({ type: "bootstrap", protocolVersion: 1 }), "utf8");
    const input = Buffer.concat([Buffer.alloc(4), message]);
    input.writeUInt32LE(message.length, 0);
    const child = spawn(binary, ["chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid/"], {
      env: { ...process.env, APPDATA: temp },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result = await new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("native host did not exit after its one-shot response"));
      }, 5_000);
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      child.stdin.write(input);
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    assert.equal(result.stdout.length >= 4, true);
    const length = result.stdout.readUInt32LE(0);
    assert.equal(result.stdout.length, length + 4, "stdout contains only one Native Messaging frame");
    const response = JSON.parse(result.stdout.subarray(4).toString("utf8"));
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "app-unavailable");
    assert.equal(result.stdout.toString("utf8").includes("LuckyRay native host:"), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
