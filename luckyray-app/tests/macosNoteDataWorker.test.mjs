import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, realpath, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { NOTE_DATA_CASES, INTEGRATION_NATIVE_CASES, NOTE_DATA_MESSAGE_FORMAT, noteDataCompileEnvironment, nativeCaseDisposition, safeNoteDataExecution, singleNativeTestPassed } from "../scripts/check-macos-note-data.mjs";
import { DiagnosticCollector, safeDiagnosticSummary } from "../scripts/macos-native-diagnostics.mjs";
import { APP, directory, download } from "../scripts/macos-build-common.mjs";
import { PHASES, publishableReport } from "../scripts/check-macos-internal.mjs";

function realNativeCommands(requests) {
  const module = new URL("../scripts/check-macos-note-data.mjs", import.meta.url).href;
  const source = `import {nativeCommand,nativeCaseDisposition} from ${JSON.stringify(module)};
    const results=[];for(const item of ${JSON.stringify(requests)}){
      const result=await nativeCommand(item.command,item.args,process.env,'native-note-data-test',item.timeout);
      const disposition=nativeCaseDisposition(result);results.push({result,disposition});
      if(disposition==='failed-stop')break;
    }process.stderr.write('\\nMACOS_CASE_RESULTS '+JSON.stringify(results)+'\\n');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source],
    { encoding: "utf8", timeout: 15000, maxBuffer: 12 * 1024 * 1024 });
  assert.equal(child.status, 0);assert.equal(child.signal, null);
  const result = child.stderr.split(/\r?\n/).find(line => line.startsWith("MACOS_CASE_RESULTS "));
  assert(result);return JSON.parse(result.slice("MACOS_CASE_RESULTS ".length));
}

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

test("real Cargo retains compile and test failure locations plus test-artifact JSON", async t => {
  const cargo = process.env.CARGO ?? "cargo";
  const available = spawnSync(cargo, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("Rust toolchain is not installed");
  assert.equal(available.status, 0);
  // Cargo reports an absolute source path through the canonical working
  // directory. Match that owned fixture root, including macOS /var aliases.
  const root = await realpath(await mkdtemp(join(tmpdir(), "luckyray-note-cargo-")));
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
    await writeFile(join(root, "src/lib.rs"), `#[test]\nfn fixture() { panic!("${canary}"); }\n#[test]\nfn fixture_pass() {}\n`);
    const passed = run();assert.equal(passed.status, 0);assert.equal(passed.signal, null);
    const artifacts = passed.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      .filter(item => item.reason === "compiler-artifact" && item.target?.name === "luckyray_app_lib" && item.profile?.test === true && typeof item.executable === "string");
    assert.equal(artifacts.length, 1);assert.equal(artifacts[0].target.src_path, join(root, "src/lib.rs"));
    const executions = realNativeCommands(["fixture", "fixture_pass"].map(name => ({ command: artifacts[0].executable,
      args: [name, "--exact", "--test-threads=1", "--quiet"], timeout: 3000 })));
    assert.equal(executions.length, 2, "a normal failed case must not prevent the independent next case");
    assert.deepEqual(executions.map(x => x.disposition), ["failed-continue", "passed"]);
    const execution = executions[0].result;
    assert.equal(execution.exit, 101);assert.equal(execution.signal, null);assert(execution.closed);
    const tests = new DiagnosticCollector(new Set(), files);
    tests.feed("stderr", 'MACOS_NATIVE_EVENT {"event":"start","id":"2:1","stage":"native-note-data-test","command":"other"}\n');
    tests.feed("stdout", execution.text);
    tests.feed("stderr", execution.stderrText ?? "");
    tests.feed("stderr", 'MACOS_NATIVE_EVENT {"event":"exit","id":"2:2","startedId":"2:1","stage":"native-note-data-test","command":"other","exit":101}\n');
    const testSummary = safeDiagnosticSummary(tests.summary(), new Set(), files);
    assert(testSummary.issues.some(item => item.class === "rust-test-panic" && item.file === "src/lib.rs" && item.line === 2 && item.column > 0));
    assert(testSummary.commands.some(item => item.stage === "native-note-data-test" && item.exit === 101));
    assert(!JSON.stringify(testSummary).includes(canary));assert(!JSON.stringify(testSummary).includes(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("abnormal real children stop collection before another case", () => {
  const next = { command: process.execPath, args: ["-e", "process.exit(0)"], timeout: 1000 };
  for (const [kind, code, timeout] of [
    ["timeout", "setInterval(()=>{},1000)", 50],
    ["ignored-timeout", "process.on('SIGTERM',()=>{});process.stdout.write('READY\\n');setInterval(()=>{},1000)", 1000],
    ["signal", "process.kill(process.pid,'SIGTERM')", 3000],
    ["stdout-budget", "process.stdout.write(Buffer.alloc(8*1024*1024+1,120))", 5000],
    ["stderr-budget", "process.stderr.write(Buffer.alloc(8*1024*1024+1,120))", 5000],
  ]) {
    const rows = realNativeCommands([{ command: process.execPath, args: ["-e", code], timeout }, next]);
    assert.equal(rows.length, 1, kind);assert.equal(rows[0].disposition, "failed-stop", kind);
    assert(rows[0].result.closed, kind);
    if (kind === "timeout") assert(rows[0].result.timedOut);
    if (kind === "ignored-timeout") {
      assert(rows[0].result.timedOut);assert(rows[0].result.text.includes("READY"));
      assert.equal(rows[0].result.signal, "SIGKILL");
    }
    if (kind.endsWith("budget")) assert(rows[0].result.outputInvalid);
    if (kind === "signal") assert.equal(rows[0].result.signal, "SIGTERM");
  }
  const missing = realNativeCommands([{ command: "/synthetic-nonexistent-native-test", args: [], timeout: 1000 }, next]);
  assert.equal(missing.length, 1);assert.equal(missing[0].disposition, "failed-stop");
  assert(missing[0].result.spawnFailed);assert.equal(missing[0].result.closed, false);
});

test("only an exact normal single-case failure may continue", () => {
  const failed = { text: "running 1 test\nfixture --- FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 19 filtered out; finished in 0.01s\n",
    exit: 101, signal: null, closed: true, spawnFailed: false, timedOut: false, terminationRequested: false, outputInvalid: false };
  assert.equal(nativeCaseDisposition(failed), "failed-continue");
  for (const key of ["spawnFailed", "timedOut", "terminationRequested", "outputInvalid"]) {
    assert.equal(nativeCaseDisposition({ ...failed, [key]: true }), "failed-stop");
  }
  for (const row of [{ ...failed, closed: false }, { ...failed, exit: 1 }, { ...failed, signal: "SIGTERM" },
    { ...failed, text: failed.text + failed.text }, { ...failed, text: failed.text.replace("0 ignored", "1 ignored") },
    { ...failed, text: "fatal fixture error" }]) assert.equal(nativeCaseDisposition(row), "failed-stop");
});

test("test panic projection accepts only tracked positions in the native test stage", () => {
  const files = new Set(["src/lib.rs"]);
  for (const stage of ["native-note-data-test", "native-note-data-compile"]) {
    const collector = new DiagnosticCollector(new Set(), files);
    collector.feed("stderr", `MACOS_NATIVE_EVENT ${JSON.stringify({ event: "start", id: "1:1", stage, command: "cargo" })}\n`);
    collector.feed("stdout", "thread 'synthetic' panicked at src/lib.rs:9:3:\n");
    collector.feed("stdout", "thread 'synthetic' panicked at /private/never_publish/src/lib.rs:8:4:\n");
    collector.feed("stdout", "thread 'synthetic' panicked at src/untracked.rs:7:5:\nprivate message never_publish\n");
    const result = safeDiagnosticSummary(collector.summary(), new Set(), files);
    assert.deepEqual(result.issues, stage === "native-note-data-test"
      ? [{ class: "rust-test-panic", origin: "process-output", stage, file: "src/lib.rs", line: 9, column: 3 }] : []);
    assert(!JSON.stringify(result).includes("never_publish"));
  }
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
  const projected = safeNoteDataExecution(complete);assert.equal(projected.total, NOTE_DATA_CASES.length);assert.equal(projected.passedCount, NOTE_DATA_CASES.length);
  assert(!JSON.stringify(projected).includes(canary));
  assert.throws(() => safeNoteDataExecution({ ...complete, cases: complete.cases.slice(1) }));
  assert.throws(() => safeNoteDataExecution({ ...complete, compiled: false }));
  assert.throws(() => safeNoteDataExecution({ ...complete, cases: complete.cases.map((item, i) => i === 0 ? { ...item, status: "not-run", exit: null } : item) }));
  const failed = { status: "failed", compiled: true, failure: "test-failed", cases: complete.cases.map((item, i) => i === 0 ? { ...item, status: "failed", exit: "SIGTERM" } : { ...item, status: "not-run", exit: null }) };
  assert.equal(safeNoteDataExecution(failed).passedCount, 0);
  const collected = { ...complete, status: "failed", failure: "test-failed", cases: complete.cases.map((item, i) =>
    [1, 8].includes(i) ? { ...item, status: "failed", exit: 101 } : item) };
  const all = safeNoteDataExecution(collected);
  assert.equal(all.passedCount, NOTE_DATA_CASES.length - 2);assert.equal(all.status, "failed");assert.equal(all.total, NOTE_DATA_CASES.length);
  assert.throws(() => safeNoteDataExecution({ ...collected, status: "passed" }));
  assert.throws(() => safeNoteDataExecution({ ...collected, cases: collected.cases.map((item, i) =>
    i === 1 ? { ...item, exit: "SIGTERM" } : item) }), /macos-note-data-result-invalid/);
  const sourceBlocked = { schemaVersion: 1, mode: "internal-native-validation", binaryExport: false, status: "failed",
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40) }, workerExit: 1, workerSignal: null,
    distributionReady: false, build: null, lsh: null, noteData: { ...complete, cases: INTEGRATION_NATIVE_CASES.map(({ id }) => ({ id, status: 'passed', exit: 0 })) },
    phases: PHASES.map((phase, index) => ({ phase, status: index < 2 ? "passed" : index === 2 ? "failed" : "not-run" })),
    failure: { code: "macos-note-data-source-input-missing" }, diagnostics: {}, privateMaterial: canary };
  const report = publishableReport(sourceBlocked);
  assert.equal(report.status, "failed");assert.equal(report.noteData.passedCount, INTEGRATION_NATIVE_CASES.length);
  assert.equal(report.coverage.notesRecoveryUi, "not-run");assert(!JSON.stringify(report).includes(canary));
  assert.throws(() => publishableReport({ ...sourceBlocked, noteData: null }), /macos-internal-result-invalid/);
});

test("the integrated candidate uses an explicit smaller selection and keeps historical assertions separate", () => {
  assert.equal(new Set(INTEGRATION_NATIVE_CASES.map(item => item.id)).size, INTEGRATION_NATIVE_CASES.length);
  assert.equal(new Set(INTEGRATION_NATIVE_CASES.map(item => item.test)).size, INTEGRATION_NATIVE_CASES.length);
  assert(INTEGRATION_NATIVE_CASES.some(item => item.id === 'identity-lan-tls'));
  assert(INTEGRATION_NATIVE_CASES.some(item => item.id === 'upload-service-reclaim-route'));
  assert(INTEGRATION_NATIVE_CASES.some(item => item.id === 'folder-product-post-interruption'));
  assert(!INTEGRATION_NATIVE_CASES.some(item => item.id === 'identity-record-process-recreate' || item.id === 'folder-mutation-closed'));
  const full = { status: 'passed', compiled: true, failure: 'none', cases: INTEGRATION_NATIVE_CASES.map(({ id }) => ({ id, status: 'passed', exit: 0 })) };
  assert.equal(safeNoteDataExecution(full, INTEGRATION_NATIVE_CASES).total, INTEGRATION_NATIVE_CASES.length);
  assert.throws(() => safeNoteDataExecution(full), /result-invalid/);
});

test("every exact native case names an existing production test", async () => {
  const moveTests = [
    "macos_note_move_fixture_preserves_the_attachment_target_and_source",
    "macos_note_move_rejects_stale_or_replaced_source_and_occupied_target",
    "macos_move_note_rejects_replaced_file_object_with_same_path_and_content",
    "macos_move_note_succeeds_after_normal_save_with_updated_file_identity",
    "macos_ui_rename_preserves_bytes_and_rejects_replacement_or_occupied_target",
    "macos_folder_mutation_entry_gate_fails_closed",
  ];
  for (const name of moveTests) {
    assert.equal(NOTE_DATA_CASES.filter(item => item.test === `knowledge::macos_operation_recovery_tests::${name}`).length, 1, name);
  }
  for (const item of NOTE_DATA_CASES) {
    const parts = item.test.split("::"); const module = parts[1]; const fn = parts.at(-1);
    const file = module === "macos_transactions" ? "macos_transaction_tests" : module === "tests" ? "mod" : module;
    const relative = parts[0] === "companion_gateway" && parts.includes("fixture_support") ? "companion_gateway/content/notes/fixture_support.rs"
      : parts[0] === "companion_gateway" && parts[1] === "services" ? "companion_gateway/services/knowledge.rs"
      : parts[0] === "companion_gateway" ? "companion_gateway/content/notes.rs"
      : parts[0] === "knowledge" && parts.includes("macos_companion_folder_create") ? "knowledge/macos_companion_folder_create.rs"
      : parts[0] === "knowledge" ? `knowledge/${file}.rs`
      : ["tools", "local_transport"].includes(parts[0]) ? `${parts[0]}/mod.rs` : `${parts[0]}.rs`;
    const source = await readFile(join(APP, "src-tauri/src", relative), "utf8");
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
