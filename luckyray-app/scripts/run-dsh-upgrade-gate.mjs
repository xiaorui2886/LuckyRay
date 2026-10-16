import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowed = ["--from-root", "--from-version", "--from-authority", "--from-records", "--from-verifier",
  "--to-root", "--to-version", "--to-authority", "--to-records", "--to-verifier", "--host-adapter"];
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key?.startsWith("--") || !value || options.has(key)) throw Error("upgrade-arguments-invalid");
  options.set(key, value);
}
if (options.size !== allowed.length || [...options.keys()].some(key => !allowed.includes(key))) {
  throw Error(`upgrade-arguments-required: ${allowed.join(" ")}`);
}
const path = key => realpathSync(options.get(key));
const version = key => {
  const value = options.get(key);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) throw Error(`${key}-invalid`);
  return value;
};
const input = {
  fromRoot: path("--from-root"), fromVersion: version("--from-version"),
  fromAuthority: path("--from-authority"), fromRecords: path("--from-records"),
  fromVerifier: path("--from-verifier"),
  toRoot: path("--to-root"), toVersion: version("--to-version"),
  toAuthority: path("--to-authority"), toRecords: path("--to-records"),
  toVerifier: path("--to-verifier"),
  hostAdapter: path("--host-adapter"),
};
if (input.fromRoot === input.toRoot) throw Error("upgrade-roots-must-differ");
if (input.hostAdapter !== realpathSync(join(appRoot, "src-tauri/dsh-host/luckyray-dsh-host.mjs"))
  || !statSync(input.hostAdapter).isFile()) throw Error("upgrade-host-adapter-untrusted");
const hostAdapterSha256 = createHash("sha256").update(readFileSync(input.hostAdapter)).digest("hex");
const backendIdentityTests = [
  "dsh_host::tests::host_script_identity_is_checkout_eol_stable_and_rejects_unbound_bytes",
  "dsh_host::tests::tracked_surface_assets_match_the_backend_identity_contract",
];
for (const test of backendIdentityTests) {
  const check = spawnSync("cargo", ["test", "--manifest-path", join(appRoot, "src-tauri/Cargo.toml"),
    "--lib", "--no-default-features", "--features", "sidecar-binaries", test, "--", "--exact"], {
    cwd: appRoot, encoding: "utf8", windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(check.stdout ?? ""); process.stderr.write(check.stderr ?? "");
  if (check.error || check.status !== 0 || !/test result: ok\. 1 passed; 0 failed;/m.test(check.stdout)) {
    throw Error(`upgrade-backend-identity-gate-failed: ${test}`);
  }
}
async function verifyEnd(role) {
  const root = input[`${role}Root`], expected = input[`${role}Version`];
  const authorityPath = input[`${role}Authority`], recordsDirectory = input[`${role}Records`];
  const verifier = input[`${role}Verifier`];
  if (!statSync(verifier).isFile()) throw Error(`${role}-verifier-invalid`);
  const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
  if (authority.runtimePackage?.version !== expected) throw Error(`${role}-authority-version-mismatch`);
  const pkg = JSON.parse(readFileSync(join(root, "host/node_modules/@deepseek-ai/dsh/package.json"), "utf8"));
  if (pkg.version !== expected) throw Error(`${role}-package-version-mismatch`);
  const node = join(root, "node/node.exe"), entry = join(root, "host/node_modules/@deepseek-ai/dsh/lib/bin.js");
  const cli = spawnSync(node, [entry, "--version"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000 });
  if (cli.error || cli.status !== 0 || cli.stdout.trim() !== expected) throw Error(`${role}-cli-version-mismatch`);
  const seal = spawnSync(node, [verifier, "verify-release-stage", "--authority", authorityPath,
    "--records", recordsDirectory, "--stage", root], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024,
  });
  if (seal.error || seal.status !== 0) throw Error(`${role}-source-verification-failed: ${(seal.stderr ?? "").trim()}`);
  return { version: expected, runtimeRoot: root, authorityPath, recordsDirectory,
    verifierSha256: createHash("sha256").update(readFileSync(verifier)).digest("hex"),
    nodeVersion: authority.nodeRuntime.version, cliVersion: cli.stdout.trim() };
}
const from = await verifyEnd("from"), to = await verifyEnd("to");
const run = spawnSync(join(input.toRoot, "node/node.exe"), ["--test", "--test-concurrency=1", "--test-reporter=tap",
  "tests/dshUpgradeContinuity.integration.test.mjs", "tests/dshWebSettingsMigration.integration.test.mjs"], {
  cwd: appRoot, encoding: "utf8", windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env,
    DSH_UPGRADE_FROM_RUNTIME_ROOT: input.fromRoot, DSH_UPGRADE_TO_RUNTIME_ROOT: input.toRoot,
    DSH_UPGRADE_FROM_VERSION: input.fromVersion, DSH_UPGRADE_TO_VERSION: input.toVersion,
    DSH_UPGRADE_HOST_ADAPTER: input.hostAdapter,
  },
});
process.stdout.write(run.stdout ?? ""); process.stderr.write(run.stderr ?? "");
if (run.error || run.status !== 0 || !/^# tests 3$/m.test(run.stdout)
  || !/^# pass 3$/m.test(run.stdout) || !/^# fail 0$/m.test(run.stdout)
  || !/^# skipped 0$/m.test(run.stdout)) throw Error("upgrade-continuity-gate-failed");
process.stdout.write(`${JSON.stringify({ kind: "upgrade-gate", status: "passed", from, to,
  hostAdapterSha256, backendIdentityTests: backendIdentityTests.length, continuityTests: 3, tests: 5 })}\n`);
