import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NOTE_DATA_CASES, safeNoteDataExecution, singleNativeTestPassed } from "../scripts/check-macos-note-data.mjs";
import { APP, directory, download } from "../scripts/macos-build-common.mjs";
import { PHASES, publishableReport } from "../scripts/check-macos-internal.mjs";

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
