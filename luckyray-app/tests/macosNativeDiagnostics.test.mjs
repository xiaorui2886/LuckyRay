import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DiagnosticCollector, diagnosticVocabulary, safeDiagnosticSummary, PYTHON_PROBE_IMPORTS } from "../scripts/macos-native-diagnostics.mjs";
import { publishableReport, PHASES } from "../scripts/check-macos-internal.mjs";
import { PYTHON_RUNTIME_PROBE } from "../scripts/prepare-macos-runtimes.mjs";
import { FIXTURE_DIAGNOSTIC_CODES } from "../scripts/check-macos-note-data.mjs";
import { readFile } from "node:fs/promises";
const canary = "private_test_value_never_publish";
const event = value => `MACOS_NATIVE_EVENT ${JSON.stringify(value)}\n`;

test("fixture failures project only fixed codes, never backend messages or paths", async () => {
  const vocabulary = await diagnosticVocabulary(file => readFile(new URL(`../scripts/${file}`, import.meta.url)));
  for (const code of FIXTURE_DIAGNOSTIC_CODES) assert(vocabulary.has(code));
  const collector = new DiagnosticCollector(vocabulary);
  collector.feed("stderr", event({ event: "start", id: "9:1", stage: "native-note-data-test", command: "cargo" }));
  collector.feed("stderr", `thread 'fixture' panicked: macos-fixture-backend-media-transfer\n/private/${canary}\n`);
  const lanCodes = ["macos-lan-fixture-no-private-interface", "macos-lan-interface-changed", "macos-lan-bind-failed",
    "macos-lan-gateway-start-failed", "macos-lan-tls-connect-failed"];
  for (const code of lanCodes) collector.feed("stderr", `thread 'fixture' panicked: ${code}\n`);
  collector.feed("stderr", event({ event: "exit", id: "9:2", startedId: "9:1", stage: "native-note-data-test", command: "cargo", exit: 101 }));
  const result = safeDiagnosticSummary(collector.summary(), vocabulary);
  assert(result.issues.some(item => item.code === "macos-fixture-backend-media-transfer" && item.stage === "native-note-data-test"));
  for (const code of lanCodes) assert(result.issues.some(item => item.code === code && item.stage === "native-note-data-test"));
  assert(!JSON.stringify(result).includes(canary));
});

test("Keychain phase and status diagnostics survive projection without private data", async () => {
  const vocabulary = await diagnosticVocabulary(file => readFile(new URL(`../scripts/${file}`, import.meta.url)));
  const collector = new DiagnosticCollector(vocabulary);
  collector.feed("stderr", event({ event: "start", id: "10:1", stage: "native-note-data-test", command: "other" }));
  collector.feed("stdout", `macos-keychain-search-failed\nmacos-keychain-status-param\n/private/${canary}\n`);
  collector.feed("stderr", event({ event: "exit", id: "10:2", startedId: "10:1", stage: "native-note-data-test", command: "other", exit: 101 }));
  const result = safeDiagnosticSummary(collector.summary(), vocabulary);
  assert(result.issues.some(item => item.code === "macos-keychain-search-failed" && item.stage === "native-note-data-test"));
  assert(result.issues.some(item => item.code === "macos-keychain-status-param" && item.stage === "native-note-data-test"));
  assert(!JSON.stringify(result).includes(canary));
});

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
  const probes = new DiagnosticCollector(new Set(), new Set(), "configure-probe-log");
  probes.feed("stderr", "fatal error: 'unlisted.h' file not found\nC compiler test failed.\n");
  const probeSummary = safeDiagnosticSummary(probes.summary());
  assert(probeSummary.issues.some(item => item.class === "header-not-found" && item.origin === "configure-probe-log"));
  assert(probeSummary.issues.some(item => item.class === "configure-terminal" && item.code === "ffmpeg-c-compiler-test-failed"));
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

test("Rust warning locations do not evict a bounded compiler failure", () => {
  const files = new Set(["src/lib.rs"]);
  const collector = new DiagnosticCollector(new Set(), files);
  collector.feed("stderr", event({ event: "start", id: "8:1", stage: "native-note-data-compile", command: "cargo" }));
  for (let i = 1; i <= 30; i++) collector.feed("stderr", `warning: unused item ${canary}\n --> src/lib.rs:${i}:1\n`);
  collector.feed("stderr", `error[E0425]: cannot find ${canary}\n --> src/lib.rs:43:7\n`);
  collector.feed("stderr", `error: future cannot be sent between threads safely ${canary}\n --> src/lib.rs:51:9\n`);
  for (let i = 60; i <= 90; i++) collector.feed("stderr", `warning: unused item ${canary}\n --> src/lib.rs:${i}:1\n`);
  collector.feed("stderr", event({ event: "exit", id: "8:2", startedId: "8:1", stage: "native-note-data-compile", command: "cargo", exit: 101 }));
  const result = safeDiagnosticSummary(collector.summary(), new Set(), files);
  assert(result.issues.some(item => item.code === "E0425" && item.file === "src/lib.rs" && item.line === 43));
  assert(result.issues.some(item => item.class === "rust-compiler" && item.line === 51));
  assert(!result.issues.some(item => item.line && item.line !== 43 && item.line !== 51));
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
  if (process.platform !== "win32") for (const { missing, stage } of [
    { missing: PYTHON_PROBE_IMPORTS, stage: "python-install-probe" },
    { missing: ["bz2", "lzma", "sqlite3"], stage: "python-probe" },
    { missing: [], stage: "python-probe" },
  ]) {
    const fixture = `import sys
print('HOST_VERSION:' + '.'.join(map(str, sys.version_info[:3])))
class MissingExtension:
 def find_spec(self, fullname, path=None, target=None):
  if fullname in ${JSON.stringify(missing)}: raise ModuleNotFoundError(${JSON.stringify(canary)})
sys.meta_path.insert(0, MissingExtension())
${PYTHON_RUNTIME_PROBE}`;
    const child = spawnSync("python3", ["-I", "-B", "-c", fixture, "unused-prefix", "1"], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 1, "real Python import failure must retain exit 1");
    const diagnostics = new DiagnosticCollector();
    diagnostics.feed("stderr", event({ event: "start", id: "5:1", stage, command: "python3" }));
    diagnostics.feed("stderr", child.stderr);
    diagnostics.feed("stderr", `MACOS_PYTHON_PROBE_IMPORTS:${canary}\n`);
    for (let code = 400; code < 430; code++) diagnostics.feed("stderr", `MACOS_HTTP_STATUS:${code}\n`);
    diagnostics.feed("stderr", event({ event: "exit", id: "5:2", startedId: "5:1", stage, command: "python3", exit: child.status }));
    const safe = safeDiagnosticSummary(diagnostics.summary());
    assert.equal(safe.issues.length, 12);
    assert.deepEqual(safe.pythonImports, [{ stage, imports: PYTHON_PROBE_IMPORTS.map(name => ({ name, status: missing.includes(name) ? "failed" : "passed" })) }]);
    assert(child.stderr.includes("macos-python-prefix-probe"), "invalid prefix must fail even after collecting imports");
    if (child.stdout.trim() !== "HOST_VERSION:3.11.8") assert(child.stderr.includes("macos-python-version-probe"));
    if (missing.includes("ssl")) assert(child.stderr.includes("macos-python-ssl-probe"));
    assert(!child.stderr.includes(canary));
    assert(!JSON.stringify(safe).includes(canary));
  }
});

test("published workflow summary projects typed facts and preserves failed phases", () => {
  const input = { schemaVersion: 1, mode: "internal-native-validation", binaryExport: false, status: "failed", workerExit: 1,
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40), private: canary },
    phases: PHASES.map((phase, i) => ({ phase, status: i === 0 ? "passed" : i === 1 ? "failed" : "not-run", secret: canary })),
    failure: { code: "native-command-failed", exit: "1", rawMessage: canary }, distributionReady: false,
    diagnostics: { lastCheckpoint: "dsh-audit", raw: canary, commands: [{ stage: "tauri-build", command: "pnpm", status: "failed", exit: 1, arguments: canary }],
      issues: [{ class: "unsupported-option", raw: canary }, { class: canary, code: canary }],
      pythonImports: [{ stage: "python-install-probe", imports: PYTHON_PROBE_IMPORTS.map(name => ({ name, status: "failed", raw: canary })) }, { stage: canary }] }, rawLog: canary };
  const summary = publishableReport(input);
  assert.equal(summary.phases[1].status, "failed"); assert.equal(summary.failure.exit, "1");
  assert.deepEqual(summary.diagnostics.issues, [{ class: "unsupported-option" }]);
  assert.deepEqual(summary.diagnostics.pythonImports, [{ stage: "python-install-probe", imports: PYTHON_PROBE_IMPORTS.map(name => ({ name, status: "failed" })) }]);
  assert.deepEqual(safeDiagnosticSummary({ pythonImports: [{ stage: "python-probe", imports: [{ name: canary, status: "failed" }] }] }).pythonImports, []);
  assert(!JSON.stringify(summary).includes(canary));
  assert.throws(() => publishableReport({ ...input, status: "passed" }), /macos-internal-result-invalid/);
});
