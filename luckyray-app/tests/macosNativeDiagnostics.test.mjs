import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DiagnosticCollector, diagnosticVocabulary, safeDiagnosticSummary } from "../scripts/macos-native-diagnostics.mjs";
import { publishableReport, PHASES } from "../scripts/check-macos-internal.mjs";
const canary = "private_test_value_never_publish";
const event = value => `MACOS_NATIVE_EVENT ${JSON.stringify(value)}\n`;

test("streamed diagnostics retain command failure and source position without raw sensitive text", () => {
  const files = new Set(["src/main.rs", "src/App.tsx"]);
  const collector = new DiagnosticCollector(new Set(["macos-build-not-macho"]), files);
  const raw = event({ event: "start", id: "12:1", stage: "compile-sidecars", command: "cargo", secret: canary })
    + `Authorization: Bearer ${canary}\nhttps://example.invalid/?token=${canary}\nmaterial ${canary}\n`
    + "\x1b[31merror[E0425]: cannot find function in this scope\x1b[0m\n --> src/main.rs:42:7\n"
    + ` --> /private/${canary}/main.rs:11:4\n`
    + ` --> src/${canary}.rs:12:5\n`
    + "src/App.tsx(8,4): error TS2307: Cannot find module\nModuleNotFoundError: No module named '_ssl'\n"
    + "MACOS_NATIVE_MODULE_START:sharp\nMACOS_NATIVE_MODULE_PASS:sharp\n"
    + `MACOS_NATIVE_MODULE_START:${canary}\n`
    + event({ event: "exit", id: "12:2", startedId: "12:1", stage: "compile-sidecars", command: "cargo", exit: 101, elapsedMs: 25 });
  for (let i = 0; i < raw.length; i += 7) collector.feed("stderr", Buffer.from(raw.slice(i, i + 7)));
  const result = safeDiagnosticSummary(collector.summary(), new Set(), files);
  assert.deepEqual(result.commands, [{ stage: "compile-sidecars", command: "cargo", status: "failed", exit: 101, elapsedMs: 25 }]);
  assert(result.issues.some(item => item.code === "E0425"));
  assert(result.issues.some(item => item.file === "src/main.rs" && item.line === 42 && item.column === 7));
  assert(result.issues.some(item => item.code === "TS2307")); assert(result.issues.some(item => item.module === "_ssl"));
  assert.deepEqual(result.nativeModules, [{ name: "sharp", status: "passed" }]);
  assert(!JSON.stringify(result).includes(canary));
});

test("bounded history retains an outer failure and discloses truncation", async () => {
  const vocabulary = await diagnosticVocabulary(async () => `throw new Error("macos-known-code"); // ${canary}`);
  assert.deepEqual([...vocabulary], ["macos-known-code"]);
  const collector = new DiagnosticCollector(vocabulary);
  collector.feed("stderr", event({ event: "start", id: "1:1", stage: "tauri-build", command: "pnpm" }));
  for (let i = 0; i < 40; i++) {
    const id = `2:${i + 1}`;
    collector.feed("stderr", event({ event: "start", id, stage: "source-download", command: "curl" }));
    collector.feed("stderr", event({ event: "exit", id: `3:${i + 1}`, startedId: id, stage: "source-download", command: "curl", exit: 0 }));
  }
  collector.feed("stdout", Buffer.from(canary.repeat(1000) + "\n"));
  collector.feed("stderr", "MACOS_HTTP_STATUS:200\nMACOS_HTTP_STATUS:403\nmacos-known-code\n");
  collector.feed("stderr", event({ event: "exit", id: "1:2", startedId: "1:1", stage: "tauri-build", command: "pnpm", exit: 1 }));
  const result = safeDiagnosticSummary(collector.summary(), vocabulary);
  assert.equal(result.truncated, true); assert(result.commands.length <= 16); assert(result.issues.length <= 12);
  assert(result.commands.some(item => item.stage === "tauri-build" && item.exit === 1));
  assert(result.issues.some(item => item.httpStatus === 403)); assert(!result.issues.some(item => item.httpStatus === 200));
  assert(!JSON.stringify(result).includes(canary));
});

test("a real failing diagnostic fixture preserves its exit code and drains stderr", () => {
  const common = new URL("../scripts/macos-build-common.mjs", import.meta.url).href;
  const child = `process.stderr.write(${JSON.stringify(`credential=${canary}\nerror[E0308]: mismatched types\n --> src/lib.rs:9:2\n`)});process.exit(23)`;
  const script = `import {run} from ${JSON.stringify(common)}; process.env.MACOS_INTERNAL_DIAGNOSTICS='1';try{await run(process.execPath,['-e',${JSON.stringify(child)}],{diagnosticStage:'diagnostic-self-test'});}catch{process.exitCode=23;}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 23);
  const files = new Set(["src/lib.rs"]);
  const collector = new DiagnosticCollector(new Set(), files); collector.feed("stdout", result.stdout); collector.feed("stderr", result.stderr);
  const summary = safeDiagnosticSummary(collector.summary(), new Set(), files);
  assert(summary.commands.some(item => item.stage === "diagnostic-self-test" && item.status === "failed" && item.exit === 23));
  assert(summary.issues.some(item => item.code === "E0308")); assert(summary.issues.some(item => item.line === 9));
  assert(!JSON.stringify(summary).includes(canary));
});

test("published workflow summary projects typed facts and preserves failed phases", () => {
  const input = { schemaVersion: 1, mode: "internal-native-validation", binaryExport: false, status: "failed", workerExit: 1,
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40), private: canary },
    phases: PHASES.map((phase, i) => ({ phase, status: i === 0 ? "passed" : i === 1 ? "failed" : "not-run", secret: canary })),
    failure: { code: "native-command-failed", exit: "1", rawMessage: canary }, distributionReady: false,
    diagnostics: { lastCheckpoint: "dsh-audit", raw: canary, commands: [{ stage: "tauri-build", command: "pnpm", status: "failed", exit: 1, arguments: canary }],
      issues: [{ class: "unsupported-option", raw: canary }, { class: canary, code: canary }] }, rawLog: canary };
  const summary = publishableReport(input);
  assert.equal(summary.phases[1].status, "failed"); assert.equal(summary.failure.exit, "1");
  assert.deepEqual(summary.diagnostics.issues, [{ class: "unsupported-option" }]);
  assert(!JSON.stringify(summary).includes(canary));
  assert.throws(() => publishableReport({ ...input, status: "passed" }), /macos-internal-result-invalid/);
});
