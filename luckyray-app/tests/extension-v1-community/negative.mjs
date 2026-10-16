// Negative proofs for the community fixture entry. Every case must refuse to start;
// none may open a window, create a fixture root or touch a real profile.
//
// node tests/extension-v1-community/negative.mjs [--exe <fixture-build exe>] [--nofeature <exe built without the feature>] [--assets <dir>] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { snapshotDailyProfile } from "./profile-observation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const exe = path.resolve(arg("--exe", path.join(root, "target/extension-app/debug/luckyray-app.exe")));
const nofeature = arg("--nofeature", "");
const assets = path.resolve(arg("--assets", path.join(root, "target/extension-community-fixture")));
const out = path.resolve(arg("--out", path.join(root, "target/extension-community-evidence")));
fs.mkdirSync(out, { recursive: true });
const appdata = process.env.APPDATA;
// Daily profiles: metadata-only observations via the shared helper (NOT_PROVEN, never content).
const daily = () => ({ dev: snapshotDailyProfile("com.luckyray.desktop.dev"), prod: snapshotDailyProfile("com.luckyray.desktop") });
const fixtureDirs = () => fs.readdirSync(appdata).filter(n => n.startsWith("com.luckyray.extensionfixture.p")).sort();

const cases = [];
function run(name, file, args, env, expect) {
  const before = { ...daily(), fixtureDirs: fixtureDirs() };
  const result = spawnSync(file, args, { env: { ...process.env, ...env }, encoding: "utf8", timeout: 30000, windowsHide: true });
  const after = { ...daily(), fixtureDirs: fixtureDirs() };
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const pinned = env.LUCKYRAY_FIXTURE_NONCE ? d => !d.endsWith(env.LUCKYRAY_FIXTURE_NONCE) : () => true;
  const checks = {
    exitNonZero: result.status !== 0 && result.status !== null,
    exitCode: result.status,
    messageMatched: expect.test(text),
    noNewFixtureRoot: JSON.stringify(before.fixtureDirs.filter(pinned)) === JSON.stringify(after.fixtureDirs.filter(pinned)),
  };
  // Observations only (NOT_PROVEN): daily-profile metadata; a running daily instance changes its own mtimes.
  const observations = { realDevSameStats: JSON.stringify(before.dev) === JSON.stringify(after.dev), realProdSameStats: JSON.stringify(before.prod) === JSON.stringify(after.prod) };
  const ok = checks.exitNonZero && checks.messageMatched && checks.noNewFixtureRoot;
  cases.push({ name, file, args, env, ok, checks, observations, output: text.trim().slice(0, 1200) });
  console.log(`[negative] ${name}: ${ok ? "refused as expected" : "UNEXPECTED"} (exit ${result.status})`);
}

run("dev-profile-shell-refused", exe, ["--extension-community-fixture", assets], { LUCKYRAY_APP_PROFILE: "development" }, /refused/);
run("prod-profile-shell-refused", exe, ["--extension-community-fixture", assets], { LUCKYRAY_APP_PROFILE: "production" }, /refused/);
run("missing-assets-refused", exe, ["--extension-community-fixture", path.join(out, "does-not-exist")], { LUCKYRAY_APP_PROFILE: "" }, /assets missing|refused/);
{
  const nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
  const preexisting = path.join(appdata, `com.luckyray.extensionfixture.p${nonce}`);
  fs.mkdirSync(preexisting, { recursive: true });
  fs.writeFileSync(path.join(preexisting, "marker.txt"), "pre-existing root must be refused");
  try {
    run("existing-root-refused", exe, ["--extension-community-fixture", assets], { LUCKYRAY_APP_PROFILE: "", LUCKYRAY_FIXTURE_NONCE: nonce, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "" }, /already exists/);
    const untouched = fs.readdirSync(preexisting).length === 1;
    cases[cases.length - 1].checks.preexistingRootUntouched = untouched;
    cases[cases.length - 1].ok = cases[cases.length - 1].ok && untouched;
  } finally { fs.rmSync(preexisting, { recursive: true, force: true }); }
}
if (nofeature) {
  for (const flag of ["--extension-community-fixture", "--extension-domain-fixture", "--extension-webview-fixture"]) {
    run(`nofeature-build-refuses-${flag}`, path.resolve(nofeature), [flag, assets], { LUCKYRAY_APP_PROFILE: "" }, /luckyray-extension-fixture-unavailable/);
  }
} else {
  cases.push({ name: "nofeature-build", ok: null, note: "skipped: pass --nofeature <exe built without extension-runtime-fixture>" });
}
const summary = { at: new Date().toISOString(), exe, nofeature: nofeature || null, cases, ok: cases.every(c => c.ok !== false) };
fs.writeFileSync(path.join(out, "negative.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ok: summary.ok, cases: cases.map(c => `${c.name}:${c.ok === null ? "skipped" : c.ok ? "ok" : "FAIL"}`) }, null, 2));
process.exit(summary.ok ? 0 : 1);
