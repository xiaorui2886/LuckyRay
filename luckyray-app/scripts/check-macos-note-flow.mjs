// One fixed synthetic notes exercise and same-profile restart, in the real app.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, realpath, lstat } from "node:fs/promises";
import { APP, TAURI, TARGET, directory, readRegular, writeNew, sha256, run, requireNative } from "./macos-build-common.mjs";
import { FIXTURE } from "./check-macos-material-flow.mjs";
import { knownProofSignal } from "./check-macos-lsh-proof.mjs";

export const NOTE_PHASES = Object.freeze(["exercise", "reopen"]);
export const NOTE_STEPS = Object.freeze(["not-started", "setup", "import", "preview", "save", "move", "delete", "conflict", "recover", "reopen", "quit"]);
export const NOTE_UI_FLAGS = Object.freeze({ exercise: ["imported", "previewDecoded", "edited", "moved", "deleted", "conflictShown", "recoveryCopyShown"],
  reopen: ["persistedNoteShown", "persistedPreviewDecoded", "persistedRecoveryShown"] });
export const NOTE_SOURCES = Object.freeze({ "Synthetic.md": "# Synthetic\n\nSynthetic note.\n\n![fixture](attachments/note-flow.png)\n", "Delete.md": "# Delete\n\nSynthetic delete.\n" });
export const NOTE_FILES = Object.freeze(["Moved/Synthetic.md", "Delete.md", "Delete-recovered.md", "attachments/note-flow.png"]);
export const NOTE_TIMEOUT_MS = 8 * 60 * 1000;
export const NOTE_CLEANUP_MS = 90000;
const FAILURE = ["none", "spawn-failed", "timeout", "cancelled", "forced-termination", "output-invalid", "scenario-failed", "files-changed", "quit-failed", "window-failed", "context-invalid", "driver-unavailable"];
const BOOLS = ["backendVerified", "filesVerified", "normalSavedQuit", "screenshotCaptured", "timedOut", "cancelRequested", "forcedTermination", "spawnFailed", "outputInvalid"];
const invalid = () => { throw new Error("macos-note-flow-result-invalid"); };
const blank = phase => ({ phase, status: "not-run", step: "not-started", flags: NOTE_UI_FLAGS[phase].map(() => false),
  ...Object.fromEntries(BOOLS.map(key => [key, false])), exitCode: null, signal: null, failure: "none" });
export const emptyNoteFlow = () => ({ schemaVersion: 1, status: "not-run", interaction: "application-dom-automation",
  sourceUnchanged: false, exercise: blank("exercise"), reopen: blank("reopen"), systemPointerInput: "not-run", nativeFilePicker: "not-run" });

export function safeNotePhase(value, phase) {
  if (!NOTE_PHASES.includes(phase) || value?.phase !== phase || !["not-run", "failed", "passed"].includes(value.status)
      || !NOTE_STEPS.includes(value.step) || !FAILURE.includes(value.failure) || BOOLS.some(key => typeof value[key] !== "boolean")
      || !Array.isArray(value.flags) || value.flags.length !== NOTE_UI_FLAGS[phase].length || value.flags.some(v => typeof v !== "boolean")
      || value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)
      || value.signal !== null && !knownProofSignal(value.signal)
      || (value.timedOut || value.forcedTermination) && !value.cancelRequested) invalid();
  if (value.status === "not-run") {
    if (value.step !== "not-started" || value.failure !== "none" || value.flags.some(Boolean) || BOOLS.some(k => value[k]) || value.exitCode !== null || value.signal !== null) invalid();
  } else {
    const passed = value.failure === "none" && value.flags.every(Boolean) && value.backendVerified && value.filesVerified && value.normalSavedQuit
      && (phase !== "reopen" || value.screenshotCaptured) && value.exitCode === 0 && value.signal === null
      && !["timedOut", "cancelRequested", "forcedTermination", "spawnFailed", "outputInvalid"].some(k => value[k])
      && value.step === (phase === "exercise" ? "recover" : "reopen");
    if ((value.status === "passed") !== passed || value.status === "failed" && value.failure === "none") invalid();
  }
  return { phase, status: value.status, step: value.step, flags: [...value.flags],
    ...Object.fromEntries(BOOLS.map(k => [k, value[k]])), exitCode: value.exitCode, signal: value.signal, failure: value.failure };
}
export function safeNoteFlow(value) {
  if (value?.schemaVersion !== 1 || value.interaction !== "application-dom-automation" || typeof value.sourceUnchanged !== "boolean") invalid();
  const exercise = safeNotePhase(value.exercise, "exercise"), reopen = safeNotePhase(value.reopen, "reopen");
  if (reopen.status !== "not-run" && exercise.status !== "passed") invalid();
  const status = exercise.status === "not-run" && reopen.status === "not-run" ? "not-run"
    : exercise.status === "passed" && reopen.status === "passed" && value.sourceUnchanged ? "passed" : "failed";
  if (value.status !== status || status === "not-run" && value.sourceUnchanged) invalid();
  return { schemaVersion: 1, status, interaction: "application-dom-automation", exercise, reopen, sourceUnchanged: value.sourceUnchanged,
    systemPointerInput: "not-run", nativeFilePicker: "not-run" };
}
export function noteScenarioRecord(value, phase) {
  if (value?.schemaVersion !== 1 || value.mode !== "macos-note-flow" || value.phase !== phase
      || !["passed", "failed"].includes(value.status) || !NOTE_STEPS.includes(value.step) || typeof value.backendVerified !== "boolean"
      || !Array.isArray(value.uiFlags) || value.uiFlags.length !== NOTE_UI_FLAGS[phase]?.length || value.uiFlags.some(v => typeof v !== "boolean")
      || value.status === "passed" && (!value.uiFlags.every(Boolean) || !value.backendVerified || value.step !== (phase === "exercise" ? "recover" : "reopen"))) invalid();
  return { phase, status: value.status, step: value.step, flags: [...value.uiFlags], backendVerified: value.backendVerified };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(exited, ms) {
  let timer;try { return await Promise.race([exited, new Promise(resolve => {timer = setTimeout(() => resolve(false), ms);})]); }
  finally {clearTimeout(timer);}
}
export async function observeNotePhase(child, phase, { readRecord, readQuit, verifyFiles, capture = async () => {}, timeoutMs = NOTE_TIMEOUT_MS,
  cleanupMs = NOTE_CLEANUP_MS, pollMs = 100 } = {}) {
  const row = { ...blank(phase), status: "failed", step: "setup", failure: "scenario-failed" };
  let closed = false, record = null, line = "";
  const exited = new Promise(resolve => {
    child.once("error", () => {row.spawnFailed = true; closed = true;resolve(true);});
    child.once("exit", (code, signal) => {row.exitCode = code; row.signal = signal; closed = true;resolve(true);});
  });
  child.stdin?.on("error", () => {});child.stdout?.resume();
  child.stderr?.on("data", bytes => {
    const lines = (line + bytes.toString()).split(/\r?\n/);line = lines.pop().slice(-128);
    if (lines.includes("macos-note-flow-context-invalid")) row.failure = "context-invalid";
    if (lines.includes("macos-note-flow-driver-unavailable")) row.failure = "driver-unavailable";
  });
  const cancel = () => {if (!closed && !row.cancelRequested) {row.cancelRequested = true;child.stdin?.end("C");}};
  const interrupt = () => cancel();
  process.once("SIGTERM", interrupt);process.once("SIGINT", interrupt);process.once("disconnect", interrupt);
  const timer = setTimeout(() => {if (!closed) {row.timedOut = true;cancel();}}, timeoutMs);
  try {
    while (!closed && !row.cancelRequested) {
      const value = await readRecord();
      if (value != null) {
        record = value;const projected = noteScenarioRecord(value, phase);
        Object.assign(row, { step: projected.step, flags: projected.flags, backendVerified: projected.backendVerified });
        if (projected.status !== "passed") break;
        row.filesVerified = await verifyFiles(record);
        if (!row.filesVerified) {row.failure = "files-changed";break;}
        if (phase === "reopen") {try {await capture(child.pid);row.screenshotCaptured = true;}catch {row.failure = "window-failed";break;}}
        row.failure = "none";break;
      }
      await delay(pollMs);
    }
    if (row.failure !== "none") cancel();
    while (!closed && !row.cancelRequested) await delay(pollMs);
  } catch {row.outputInvalid = true;row.failure = "output-invalid";cancel();}
  finally {
    if (!closed) {
      cancel();
      if (!await bounded(exited, cleanupMs)) {row.forcedTermination = true;child.kill("SIGKILL");await bounded(exited, 5000);}
    }
    clearTimeout(timer);
    process.removeListener("SIGTERM", interrupt);process.removeListener("SIGINT", interrupt);process.removeListener("disconnect", interrupt);
    try {
      const quit = await readQuit();
      row.normalSavedQuit = quit?.phase === phase && quit.normalSavedQuit === true;
      if (record && row.filesVerified) row.filesVerified = await verifyFiles(record);
    } catch {row.outputInvalid = true;}
    child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
  }
  row.failure = row.spawnFailed ? "spawn-failed" : row.timedOut ? "timeout" : row.forcedTermination ? "forced-termination"
    : row.outputInvalid ? "output-invalid" : row.cancelRequested && row.failure === "none" ? "cancelled"
    : row.failure !== "none" ? row.failure : !row.filesVerified ? "files-changed"
    : row.exitCode !== 0 || row.signal !== null || !row.normalSavedQuit ? "quit-failed" : "none";
  row.status = row.failure === "none" ? "passed" : "failed";
  return safeNotePhase(row, phase);
}
async function verifyFiles(root, record) {
  if (!Array.isArray(record.files) || record.files.length !== NOTE_FILES.length) return false;
  for (let i = 0; i < NOTE_FILES.length; i++) {
    const b = record.files[i], path = join(root, "vault", NOTE_FILES[i]);
    if (b?.path !== NOTE_FILES[i] || !/^[0-9]{1,20}$/.test(b.device) || !/^[0-9]{1,20}$/.test(b.inode)
        || !/^[a-f0-9]{64}$/.test(b.hash) || !Number.isSafeInteger(b.bytes) || b.bytes < 1 || b.bytes > 1024 * 1024) return false;
    const before = await lstat(path, { bigint: true }), bytes = await readRegular(path, 1024 * 1024), after = await lstat(path, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || after.uid !== BigInt(process.geteuid()) || (after.mode & 0o022n)
        || before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs
        || after.dev.toString() !== b.device || after.ino.toString() !== b.inode || bytes.length !== b.bytes || sha256(bytes) !== b.hash) return false;
  } return true;
}
function environment(home, temp, input) {
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "xiaorui2886/LuckyRay",
    GITHUB_SHA: input.GITHUB_SHA, RUNNER_TEMP: temp };
  for (const name of ["USER", "LOGNAME", "TMPDIR", "__CF_USER_TEXT_ENCODING", "XPC_FLAGS", "XPC_SERVICE_NAME", "SECURITYSESSIONID"])
    if (typeof input[name] === "string") env[name] = input[name];
  return env;
}
export async function runNoteFlow(app, input, evidence) {
  requireNative();
  const temp = await realpath(input.RUNNER_TEMP ?? "/missing-runner-temp");
  if (app !== join(TAURI, "target", TARGET, "release/bundle/macos/LuckyRay.app") || APP !== join(temp, "luckyray-macos-internal/luckyray-app")
      || input.GITHUB_ACTIONS !== "true" || input.GITHUB_REPOSITORY !== "xiaorui2886/LuckyRay" || !/^[a-f0-9]{40}$/.test(input.GITHUB_SHA ?? "")
      || evidence !== join(TAURI, ".macos-build/internal-validation-evidence")) throw new Error("macos-note-flow-context-invalid");
  const root = join(await directory(join(TAURI, "target")), `notes-flow-${randomUUID()}`);await mkdir(root, { mode: 0o700 });
  const home = await directory(join(root, "profile"));const vault = await directory(join(root, "vault"));
  const source = await directory(join(root, "source"));await directory(join(source, "attachments"));
  await directory(join(vault, "Moved"));await directory(join(vault, ".luckyray"));
  for (const [name, text] of Object.entries(NOTE_SOURCES)) await writeNew(join(source, name), text, 0o600);
  const image = Buffer.from(FIXTURE.base64, "base64");
  if (image.length !== FIXTURE.bytes || sha256(image) !== FIXTURE.sha256) invalid();
  await writeNew(join(source, "attachments/note-flow.png"), image, 0o600);
  const data = await directory(join(home, "Library/Application Support/com.luckyray.desktop"));
  const registration = { id: "synthetic-macos-notes-flow", name: "Synthetic notes flow", rootPath: vault, mode: "vault-bound",
    createdAt: "2026-11-02T00:00:00Z", lastOpenedAt: "2026-11-02T00:00:00Z", schemaVersion: 1, linkUpdatePolicy: "ask" };
  // Fixture precondition only: creation/selection UI is not part of this proof.
  await writeNew(join(vault, ".luckyray/vault.json"), JSON.stringify(registration) + "\n", 0o600);await writeNew(join(data, "notes-vault-current.json"), JSON.stringify(registration) + "\n", 0o600);
  const helper = join(root, "window-probe");await run("/usr/bin/swiftc", ["-target", "arm64-apple-macos15.0", join(APP, "scripts/macos-app-window.swift"), "-o", helper]);
  const state = emptyNoteFlow();
  const read = async name => {try {return JSON.parse((await readRegular(join(root, name), 16384)).toString());}catch (e) {if (e.code === "ENOENT") return null;throw e;}};
  const sourcesUnchanged = async () => {
    try {
      for (const [name, text] of Object.entries(NOTE_SOURCES)) if (sha256(await readRegular(join(source, name))) !== sha256(Buffer.from(text))) return false;
      return sha256(await readRegular(join(source, "attachments/note-flow.png"))) === FIXTURE.sha256;
    } catch {return false;}
  };
  for (const phase of NOTE_PHASES) {
    const child = spawn(join(app, "Contents/MacOS/luckyray-app"), ["--macos-note-flow", phase, root],
      { cwd: APP, env: environment(home, temp, input), stdio: ["pipe", "pipe", "pipe"] });
    state[phase] = await observeNotePhase(child, phase, { readRecord: () => read(`${phase}-result.json`), readQuit: () => read(`${phase}-quit.json`),
      verifyFiles: record => verifyFiles(root, record), capture: async pid => {
        const result = spawnSync(helper, [String(pid)], { encoding: "utf8", timeout: 5000 });
        if (result.status !== 0) throw new Error("macos-note-flow-window-failed");
        const window = JSON.parse(result.stdout);
        if (window.pid !== pid || !Number.isSafeInteger(window.windowID) || window.windowID <= 0) throw new Error("macos-note-flow-window-failed");
        const png = join(root, "LuckyRay-note-flow.png");
        const shot = spawnSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(window.windowID), png], { stdio: "ignore", timeout: 5000 });
        if (shot.status !== 0 || child.exitCode !== null || child.signalCode !== null) throw new Error("macos-note-flow-window-failed");
        const bytes = await readRegular(png, 32 * 1024 * 1024);
        if (bytes.length < 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("macos-note-flow-window-failed");
        await writeNew(join(evidence, "LuckyRay-note-flow.png"), bytes, 0o600);
      } });
    state.sourceUnchanged = await sourcesUnchanged();state.status = "failed";
    if (state[phase].status !== "passed" || !state.sourceUnchanged) return safeNoteFlow(state);
  }
  state.status = "passed";return safeNoteFlow(state);
}
