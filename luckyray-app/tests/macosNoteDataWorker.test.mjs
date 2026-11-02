import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { NOTE_DATA_CASES, NOTE_DATA_MESSAGE_FORMAT, noteDataCompileEnvironment, safeNoteDataExecution, singleNativeTestPassed } from "../scripts/check-macos-note-data.mjs";
import { DiagnosticCollector, safeDiagnosticSummary } from "../scripts/macos-native-diagnostics.mjs";
import { APP, directory, download } from "../scripts/macos-build-common.mjs";
import { PHASES, publishableReport } from "../scripts/check-macos-internal.mjs";

test("only the native library compilation receives the fixed empty-resource config", () => {
  const env = Object.freeze({ HOME: "/synthetic-home", PATH: "/synthetic-tools", MACOSX_DEPLOYMENT_TARGET: "15.0" });
  const compile = noteDataCompileEnvironment(env);
  assert.notEqual(compile, env);
  assert.deepEqual(JSON.parse(compile.TAURI_CONFIG), { bundle: { externalBin: [], resources: [] } });
  assert.deepEqual(Object.keys(compile).filter(key => key !== "TAURI_CONFIG"), Object.keys(env));
  for (const key of Object.keys(env)) assert.equal(compile[key], env[key]);
  assert(!Object.hasOwn(env, "TAURI_CONFIG"), "later app build must retain its original environment");
  assert.throws(() => noteDataCompileEnvironment({ ...env, TAURI_CONFIG: "{}" }), /macos-note-data-config-override-rejected/);
});

test("real Cargo retains failing source diagnostics and successful test-artifact JSON", async t => {
  const cargo = process.env.CARGO ?? "cargo";
  const available = spawnSync(cargo, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("Rust toolchain is not installed");
  assert.equal(available.status, 0);
  const root = await mkdtemp(join(tmpdir(), "luckyray-note-cargo-"));
  const canary = "private_fixture_must_not_be_published";
  const env = noteDataCompileEnvironment({ ...process.env, CARGO_TARGET_DIR: join(root, "target") });
  const run = () => spawnSync(cargo, ["test", "--locked", "--offline", "--lib", "--no-run", NOTE_DATA_MESSAGE_FORMAT, "--color=never"],
    { cwd: root, env, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "Cargo.toml"), '[package]\nname="luckyray-note-diagnostic-fixture"\nversion="0.0.0"\nedition="2021"\n[lib]\nname="luckyray_app_lib"\n');
    await writeFile(join(root, "Cargo.lock"), 'version = 4\n[[package]]\nname = "luckyray-note-diagnostic-fixture"\nversion = "0.0.0"\n');
    await writeFile(join(root, "src/lib.rs"), `pub fn wrong() -> u8 {\n    "${canary}"\n}\n`);
    const failed = run();
    assert.equal(failed.status, 101);assert.equal(failed.signal, null);
    const files = new Set(["src/lib.rs"]);
    const collector = new DiagnosticCollector(new Set(), files);
    collector.feed("stderr", 'MACOS_NATIVE_EVENT {"event":"start","id":"1:1","stage":"native-note-data-compile","command":"cargo"}\n');
    collector.feed("stdout", failed.stdout);collector.feed("stderr", failed.stderr);
    collector.feed("stderr", 'MACOS_NATIVE_EVENT {"event":"exit","id":"1:2","startedId":"1:1","stage":"native-note-data-compile","command":"cargo","exit":101}\n');
    const summary = safeDiagnosticSummary(collector.summary(), new Set(), files);
    assert(summary.issues.some(item => item.class === "rust-compiler" && item.code === "E0308"));
    assert(summary.issues.some(item => item.file === "src/lib.rs" && item.line === 2 && item.column > 0));
    assert(summary.commands.some(item => item.stage === "native-note-data-compile" && item.exit === 101));
    assert(!JSON.stringify(summary).includes(canary));assert(!JSON.stringify(summary).includes(root));
    await writeFile(join(root, "src/lib.rs"), '#[test]\nfn fixture() { assert_eq!(2 + 2, 4); }\n');
    const passed = run();assert.equal(passed.status, 0);assert.equal(passed.signal, null);
    const artifacts = passed.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      .filter(item => item.reason === "compiler-artifact" && item.target?.name === "luckyray_app_lib" && item.profile?.test === true && typeof item.executable === "string");
    assert.equal(artifacts.length, 1);assert.equal(artifacts[0].target.src_path, join(root, "src/lib.rs"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exact native execution cannot pass with zero matches, ignored cases or a signal", () => {
  const one = "\nrunning 1 test\n.\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 20 filtered out; finished in 0.01s\n";
  assert(singleNativeTestPassed(one, 0, null));
  for (const output of [one.replace("running 1 test", "running 0 tests").replace("1 passed", "0 passed"),
    one.replace("0 ignored", "1 ignored"), one + one]) assert(!singleNativeTestPassed(output, 0, null));
  assert(!singleNativeTestPassed(one, 1, null)); assert(!singleNativeTestPassed(one, 0, "SIGTERM"));
});

test("worker projection requires the complete fixed set and strips unexpected material", () => {
  const canary = "private_fixture_must_not_be_published";
  const complete = { status: "passed", compiled: true, failure: "none", raw: canary,
    cases: NOTE_DATA_CASES.map(({ id }) => ({ id, status: "passed", exit: 0, raw: canary })) };
  const projected = safeNoteDataExecution(complete);assert.equal(projected.total, 20);assert.equal(projected.passedCount, 20);
  assert(!JSON.stringify(projected).includes(canary));
  assert.throws(() => safeNoteDataExecution({ ...complete, cases: complete.cases.slice(1) }));
  assert.throws(() => safeNoteDataExecution({ ...complete, compiled: false }));
  assert.throws(() => safeNoteDataExecution({ ...complete, cases: complete.cases.map((item, i) => i === 0 ? { ...item, status: "not-run", exit: null } : item) }));
  const failed = { status: "failed", compiled: true, failure: "test-failed", cases: complete.cases.map((item, i) => i === 0 ? { ...item, status: "failed", exit: "SIGTERM" } : { ...item, status: "not-run", exit: null }) };
  assert.equal(safeNoteDataExecution(failed).passedCount, 0);
  const sourceBlocked = { schemaVersion: 1, mode: "internal-native-validation", binaryExport: false, status: "failed",
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40) }, workerExit: 1, workerSignal: null,
    distributionReady: false, build: null, lsh: null, noteData: complete,
    phases: PHASES.map((phase, index) => ({ phase, status: index < 2 ? "passed" : index === 2 ? "failed" : "not-run" })),
    failure: { code: "macos-note-data-source-input-missing" }, diagnostics: {}, privateMaterial: canary };
  const report = publishableReport(sourceBlocked);
  assert.equal(report.status, "failed");assert.equal(report.noteData.passedCount, 20);
  assert.equal(report.coverage.notesRecoveryUi, "not-run");assert(!JSON.stringify(report).includes(canary));
  assert.throws(() => publishableReport({ ...sourceBlocked, noteData: null }), /macos-internal-result-invalid/);
});

test("every exact native case names an existing production test", async () => {
  for (const item of NOTE_DATA_CASES) {
    const parts = item.test.split("::"); const module = parts[1]; const fn = parts.at(-1);
    const file = module === "macos_transactions" ? "macos_transaction_tests" : module;
    const source = await readFile(join(APP, "src-tauri/src/knowledge", `${file}.rs`), "utf8");
    assert(source.includes(`fn ${fn}(`), item.id);
  }
});

test("an unavailable offline source never calls a transfer or creates a partial download", async () => {
  const parent = join(APP, "src-tauri/.macos-build");await directory(parent);
  const cacheDirectory = await mkdtemp(join(parent, "offline-source-fixture-"));
  let calls = 0;
  try {
    const input = { url: "https://example.invalid/synthetic-source.tar.xz", sha256: createHash("sha256").update("synthetic source").digest("hex") };
    await assert.rejects(download(input, { cacheDirectory, allowNetwork: false, transfer: async () => { calls += 1; } }), /macos-build-source-input-required/);
    assert.equal(calls, 0);assert.deepEqual(await readdir(cacheDirectory), []);
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});
