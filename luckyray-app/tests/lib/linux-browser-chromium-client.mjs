// Linux-only acceptance client. No browser API, fetch, native host, extension
// source, origin or port-discovery substitution is installed in the worker.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { CdpConnection, attachSession, evaluate, getTargets } from "../browser-extension-runtime/lib/cdp-client.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, args) => {
  if (i % 2 === 0) pairs.push([value, args[i + 1]]);
  return pairs;
}, []));
const preflight = options["--mode"] === "preflight";
assert(preflight || options["--mode"] === undefined);
let browser, child, diagnostics, startupInspection, startupFatal;
let phase = "browser-identity", sandboxCheck, preflightEmitted = false;
const phaseFailures = {
  "browser-identity": "browser-identity-invalid", "extension-identity": "extension-identity-invalid",
  "synthetic-profile": "synthetic-profile-invalid", "browser-arguments": "browser-arguments-invalid",
  "browser-start": "browser-start-failed", "cdp-connect": "cdp-connect-failed",
  "sandbox-page": "sandbox-page-failed", "sandbox-observation": "sandbox-observation-failed",
  "sandbox-assertion": "sandbox-assertion-failed", "browser-cleanup": "browser-cleanup-failed",
};
const safeIoCode = error => ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR"].includes(error?.code) ? error.code : "UNAVAILABLE";
const STATIC_FATAL_REASONS = {
  CHECK: new Set(["Check failed: client.StartHandler(handler_path, *database_path, metrics_path, url, annotations, arguments, false, false, attachments, preserve_handles)"]),
  FATAL: new Set(["No usable sandbox!"]),
  CRASHPAD: new Set(["--database is required"]),
  CXX: new Set(["std::system_error: Resource temporarily unavailable",
    "std::system_error: Operation not permitted", "std::bad_alloc: std::bad_alloc"]),
};
function staticFatalReason(kind, text) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return STATIC_FATAL_REASONS[kind]?.has(normalized) ? normalized : "UNKNOWN_REASON";
}
function readStartupFatal() {
  if (!diagnostics) return { state: "NOT_STARTED", readBytes: 0, truncated: false, records: [] };
  let fd;
  try {
    const file = path.join(diagnostics, "browser.stderr"), metadata = fs.lstatSync(file);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid()
      && metadata.nlink === 1 && !(metadata.mode & 0o077));
    fd = fs.openSync(file, "r");
    const opened = fs.fstatSync(fd);
    assert(opened.dev === metadata.dev && opened.ino === metadata.ino && opened.isFile());
    const size = metadata.size, count = Math.min(size, 65536), bytes = Buffer.alloc(count);
    const first = size > count ? count / 2 : count;
    const firstRead = fs.readSync(fd, bytes, 0, first, 0);
    const lastRead = size > count ? fs.readSync(fd, bytes, first, count - first, size - (count - first)) : 0;
    const lines = bytes.subarray(0, firstRead).toString("utf8").split(/\r?\n/).concat(
      lastRead ? bytes.subarray(first, first + lastRead).toString("utf8").split(/\r?\n/) : []);
    const records = [];
    for (let i = 0; i < lines.length && records.length < 2; i++) {
      const line = lines[i];
      const fatal = line.match(/\bFATAL:([^\]\r\n]{1,240}):(\d{1,7})\]\s*(.*)$/);
      if (fatal) {
        const source = path.posix.basename(fatal[1].replaceAll("\\", "/"));
        if (!/^[a-z0-9_]{1,80}\.(?:cc|cpp|h)$/.test(source)) continue;
        let reason = fatal[3], kind = "FATAL";
        if (/^(?:Check|DCHECK) failed: /.test(reason)) {
          kind = "CHECK";
          // Chromium CHECK appends runtime values after its static condition.
          if (reason.includes(" vs. ")) {
            const values = reason.lastIndexOf(" (", reason.indexOf(" vs. "));
            if (values >= 0) reason = reason.slice(0, values);
          }
          reason = reason.split(". ")[0];
        }
        records.push({ kind, source, line: Number(fatal[2]), reason: staticFatalReason(kind, reason) });
      } else if (/chrome_crashpad_handler:\s*--database is required\s*$/.test(line)) {
        records.push({ kind: "CRASHPAD", source: "chrome_crashpad_handler", line: null, reason: "--database is required" });
      } else if (/^terminate called after throwing an instance of '(?:std::system_error|std::runtime_error|std::bad_alloc)'\s*$/.test(line)) {
        const type = line.match(/'(std::[a-z_]+)'/)[1];
        const what = lines[i + 1]?.match(/^\s*what\(\):\s*(.*)$/)?.[1];
        records.push({ kind: "CXX", source: "cxx-runtime", line: null,
          reason: staticFatalReason("CXX", type + (what ? ": " + what : "")) });
      }
    }
    return { state: records.length ? "FOUND" : "NOT_FOUND", readBytes: firstRead + lastRead,
      truncated: size > count, records };
  } catch (error) {
    return { state: "UNAVAILABLE", readBytes: 0, truncated: false, records: [], errorCode: safeIoCode(error) };
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
function inspectInstalledElf(file, identity) {
  let fd;
  try {
    const value = fs.lstatSync(file);
    const safe = value.isFile() && !value.isSymbolicLink() && value.nlink === 1
      && [0, process.getuid()].includes(value.uid) && !(value.mode & 0o7022);
    const result = { state: safe ? "OBSERVED" : "UNSAFE", present: true, regular: value.isFile(),
      trustedOwner: [0, process.getuid()].includes(value.uid), mode: value.mode & 0o7777, executable: null };
    if (!safe) return result;
    try { fs.accessSync(file, fs.constants.X_OK); result.executable = true; } catch { result.executable = false; }
    if (identity) return { ...result, elf: true, bytes: identity.bytes, sha256: identity.sha256 };
    fd = fs.openSync(file, "r");
    const opened = fs.fstatSync(fd), header = Buffer.alloc(4);
    assert(opened.dev === value.dev && opened.ino === value.ino && opened.isFile());
    const elf = fs.readSync(fd, header, 0, 4, 0) === 4 && header.equals(Buffer.from([127, 69, 76, 70]));
    if (!elf) return { ...result, elf: false, bytes: value.size };
    const bytes = fs.readFileSync(fd);
    return { ...result, elf: true, bytes: bytes.length, sha256: sha(bytes) };
  } catch (error) { return { state: error?.code === "ENOENT" ? "MISSING" : "UNAVAILABLE", present: error?.code === "ENOENT" ? false : null, errorCode: safeIoCode(error) }; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
function inspectSyntheticPaths(profile) {
  const home = process.env.HOME, temporary = process.env.TMPDIR;
  const trustedRoots = typeof home === "string" && typeof temporary === "string" && path.isAbsolute(home)
    && path.isAbsolute(temporary) && path.basename(home) === "synthetic-home" && path.basename(temporary) === "tmp"
    && path.basename(path.dirname(home)) === "private" && path.dirname(home) === path.dirname(temporary);
  const writable = target => { try { fs.accessSync(target, fs.constants.W_OK | fs.constants.X_OK); return true; } catch { return false; } };
  function probe(target, set) {
    const result = { set };
    if (!set) return { ...result, state: "UNSET" };
    const root = trustedRoots && [home, temporary].find(base => target === base || target.startsWith(base + path.sep));
    if (!root || path.resolve(target) !== target) return { ...result, state: "OUTSIDE_SYNTHETIC" };
    let current = root;
    try {
      const rootMetadata = fs.lstatSync(root);
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || rootMetadata.uid !== process.getuid()
          || fs.realpathSync(root) !== root) return { ...result, state: "UNSAFE" };
      const parts = path.relative(root, target).split(path.sep).filter(Boolean);
      for (const part of parts) {
        const next = path.join(current, part);
        let entry;
        try { entry = fs.lstatSync(next); } catch (error) {
          if (error?.code === "ENOENT") return { ...result, state: "MISSING", parentWritable: writable(current) };
          throw error;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) return { ...result, state: "UNSAFE" };
        current = next;
      }
      const entry = fs.lstatSync(current);
      return { ...result, state: "DIRECTORY", ownerCurrent: entry.uid === process.getuid(), mode: entry.mode & 0o7777,
        writable: writable(current) };
    } catch (error) { return { ...result, state: "UNAVAILABLE", errorCode: safeIoCode(error) }; }
  }
  const result = {};
  for (const key of ["HOME", "TMPDIR", "RUNNER_TEMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "CHROME_CONFIG_HOME"]) {
    const value = process.env[key];
    result[key] = probe(value, typeof value === "string" && value.length > 0);
  }
  const config = process.env.CHROME_CONFIG_HOME || process.env.XDG_CONFIG_HOME || (typeof home === "string" ? path.join(home, ".config") : undefined);
  result.defaultCrashReports = probe(config ? path.join(config, "chromium", "Crash Reports") : undefined, !!config);
  result.explicitProfile = probe(profile, !!profile);
  return result;
}
function preflightFailure(error) {
  const messages = new Map([
    ["Chromium exited before DevTools was ready", "browser-exited-before-devtools"],
    ["Chromium terminated by a signal before DevTools was ready", "browser-signaled-before-devtools"],
    ["Chromium DevTools did not start; sandbox is never disabled as a fallback", "devtools-start-timeout"],
    ["actual chrome://sandbox state unavailable", "sandbox-observation-timeout"],
  ]);
  const checks = { namespace: "namespace-sandbox-required", "PID namespaces": "pid-namespaces-required",
    "Network namespaces": "network-namespaces-required", "Seccomp-BPF sandbox": "seccomp-bpf-required",
    evaluation: "adequate-sandbox-required" };
  return { phase: phaseFailures[phase] ? phase : "unknown",
    code: messages.get(error?.message) || (phase === "sandbox-assertion" && checks[sandboxCheck])
      || phaseFailures[phase] || "unclassified-client-failure",
    ...(["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"].includes(error?.code)
      ? { osError: error.code } : {}),
    ...(child ? { browserExitCode: child.exitCode } : {}),
    ...(["SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGKILL", "SIGSEGV", "SIGSYS", "SIGTERM", "SIGTRAP"].includes(child?.signalCode)
      ? { browserSignal: child.signalCode } : {}) };
}
function emitPreflightFailure(failure) {
  if (preflightEmitted) return;
  preflightEmitted = true;
  process.stdout.write(JSON.stringify({ status: "FAIL", ...(browser ? { browser } : {}),
    ...(startupInspection ? { startupInspection } : {}), failure: { ...failure, ...(startupFatal ? { fatal: startupFatal } : {}) } }) + "\n");
}
// Observe initialization failures without changing Node's fatal exit behavior.
if (preflight) process.once("uncaughtExceptionMonitor", error => emitPreflightFailure(preflightFailure(error)));
const browserPath = fs.realpathSync(options["--browser"]);
const metadata = fs.statSync(browserPath);
assert([0, process.getuid()].includes(metadata.uid) && !(metadata.mode & 0o7022));
assert(fs.readFileSync(browserPath).subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), "preinstalled Chromium ELF required");
const versionOutput = execFileSync(browserPath, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
assert(/^Chromium \d+\./.test(versionOutput), "the runner's unbranded Chromium is required");
const version = versionOutput.match(/^Chromium \d+(?:\.\d+)+/)?.[0];
assert(version && version.length <= 80, "bounded Chromium version required");
browser = { version, sha256: sha(fs.readFileSync(browserPath)), bytes: metadata.size };
if (preflight) startupInspection = { browser: inspectInstalledElf(browserPath, browser),
  crashpad: inspectInstalledElf(path.join(path.dirname(browserPath), "chrome_crashpad_handler")), paths: inspectSyntheticPaths() };
phase = "extension-identity";
const extensionPath = fileURLToPath(new URL("../../browser-extension-prototype/", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, "manifest.json"), "utf8"));
const keyHash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
const origin = "chrome-extension://" + [...keyHash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join("");
const files = [];
function inventory(dir, prefix = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    assert(!entry.isSymbolicLink(), "no links in the source extension");
    const name = prefix + entry.name, target = path.join(dir, entry.name);
    if (entry.isDirectory()) inventory(target, name + "/");
    else {
      assert(entry.isFile());
      const bytes = fs.readFileSync(target);
      files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
    }
  }
}
inventory(extensionPath);
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const extension = { origin, manifestSha256: sha(fs.readFileSync(path.join(extensionPath, "manifest.json"))),
  files: files.length, closureSha256: sha(files.map(f => `${f.path}\0${f.bytes}\0${f.sha256}\n`).join("")) };
if (!preflight) assert.equal(origin, options["--origin"], "compile and register the public manifest-derived origin");
const port = Number(options["--port"]);
if (!preflight) assert(Number.isInteger(port) && port >= 37418 && port <= 37467);
const session = randomUUID();
phase = "synthetic-profile";
diagnostics = fs.mkdtempSync(path.join(os.tmpdir(), "luckyray-chromium-consent-"));
fs.chmodSync(diagnostics, 0o700);
// Chromium searches DIR_USER_DATA/NativeMessagingHosts. Use the exact default
// directory registered by the real CLI in this fresh synthetic XDG home.
// The two browser sessions reuse this one disposable profile; no manifest is
// copied to an alternate lookup path and no personal profile is inspected.
const profile = preflight ? diagnostics : path.join(process.env.XDG_CONFIG_HOME, "chromium");
if (!preflight) {
  const home = fs.realpathSync(process.env.HOME);
  assert.equal(path.basename(home), "Synthetic profile");
  assert(path.basename(path.dirname(home)).startsWith("linux-browser-connection-"));
  assert.equal(process.env.XDG_CONFIG_HOME, path.join(home, "config"));
  const marker = path.join(home, ".luckyray-linux-browser-fixture"), m = fs.lstatSync(marker);
  assert(m.isFile() && m.uid === process.getuid() && m.nlink === 1 && (m.mode & 0o777) === 0o600);
  assert.equal(fs.readFileSync(marker, "utf8"), "isolated-linux-browser-consent-v1\n");
}
assert.equal(fs.realpathSync(profile), profile);
const profileMetadata = fs.statSync(profile);
assert(profileMetadata.isDirectory() && profileMetadata.uid === process.getuid() && !(profileMetadata.mode & 0o077));
if (preflight) startupInspection.paths = inspectSyntheticPaths(profile);
if (!preflight) {
  const registration = JSON.parse(fs.readFileSync(path.join(profile, "NativeMessagingHosts/com.luckyray.desktop.json"), "utf8"));
  assert.equal(registration.name, "com.luckyray.desktop");
  assert.equal(registration.type, "stdio");
  assert.deepEqual(registration.allowed_origins, [`${origin}/`]);
}
const activeFile = path.join(profile, "DevToolsActivePort");
if (fs.existsSync(activeFile)) {
  const old = fs.lstatSync(activeFile);
  assert(old.isFile() && old.uid === process.getuid() && old.nlink === 1);
  fs.unlinkSync(activeFile);
}
phase = "browser-arguments";
const args = ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--disable-component-update", "--disable-default-apps", "--disable-sync", "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`];
if (!preflight) args.push(`--load-extension=${extensionPath}`);
args.push("about:blank");
assert(!args.some(arg => /no-sandbox|disable.*sandbox|single-process|in-process-gpu|disable-web-security/i.test(arg)));
let connection, worker;
const counters = { protectedReads: 0, anonymousBootstrap: 0 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms, message) {
  const began = Date.now();
  while (Date.now() - began < ms) { const result = await fn(); if (result) return result; await pause(100); }
  throw new Error(message);
}
async function start() {
  phase = "browser-start";
  const stderr = fs.openSync(path.join(diagnostics, "browser.stderr"), "wx", 0o600);
  try { child = spawn(browserPath, args, { stdio: ["ignore", "ignore", stderr], env: process.env }); }
  finally { fs.closeSync(stderr); }
  let spawnError;
  child.on("error", error => { spawnError = error; });
  const active = await until(() => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error("Chromium exited before DevTools was ready");
    if (child.signalCode !== null) throw new Error("Chromium terminated by a signal before DevTools was ready");
    const file = path.join(profile, "DevToolsActivePort");
    if (!fs.existsSync(file)) return null;
    const [text, endpoint] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    if (!/^\d+$/.test(text) || !endpoint?.startsWith("/devtools/browser/")) return null;
    return `ws://127.0.0.1:${Number(text)}${endpoint}`;
  }, 20000, "Chromium DevTools did not start; sandbox is never disabled as a fallback");
  phase = "cdp-connect";
  connection = await CdpConnection.connect(active);
  phase = "sandbox-page";
  const { targetId } = await connection.send("Target.createTarget", { url: "chrome://sandbox/" });
  const sandboxSession = await attachSession(connection, targetId);
  phase = "sandbox-observation";
  const state = await until(async () => {
    const value = await evaluate(connection, sandboxSession,
      "({evaluation:document.querySelector('#evaluation')?.innerText,rows:[...document.querySelectorAll('#sandbox-status tr')].map(r=>[...r.cells].map(c=>c.innerText))})");
    return value?.evaluation && value.rows.length ? value : null;
  }, 15000, "actual chrome://sandbox state unavailable");
  const rows = Object.fromEntries(state.rows);
  phase = "sandbox-assertion";
  sandboxCheck = "namespace";
  assert(rows["Layer 1 Sandbox"] === "Namespace" || rows["Namespace Sandbox"] === "Yes", "namespace sandbox required");
  for (const name of ["PID namespaces", "Network namespaces", "Seccomp-BPF sandbox"]) {
    sandboxCheck = name;
    assert.equal(rows[name], "Yes", name);
  }
  sandboxCheck = "evaluation";
  assert.equal(state.evaluation, "You are adequately sandboxed.");
  phase = "sandbox-page";
  await connection.send("Target.closeTarget", { targetId });
  const sandbox = { status: "PASS", namespace: "Yes", pidNamespaces: "Yes", networkNamespaces: "Yes", seccompBpf: "Yes",
    adequatelySandboxed: true, securityDisablingFlags: [], source: "ACTUAL_CHROME_SANDBOX_PAGE" };
  if (preflight) return sandbox;
  phase = "extension-worker";
  const target = await until(async () => (await getTargets(connection)).find(t => t.type === "service_worker"
    && t.url === `${origin}/background.js`), 20000, "unchanged extension worker did not load");
  worker = await attachSession(connection, target.targetId);
  await connection.send("Runtime.enable", {}, worker);
  await connection.send("Network.enable", {}, worker);
  connection.on("Network.requestWillBeSent", event => {
    const url = new URL(event.request.url);
    if (url.hostname !== "127.0.0.1") return;
    if (url.pathname === "/api/v1/extension/bootstrap") counters.anonymousBootstrap++;
    if (url.pathname === "/api/v1/folders") counters.protectedReads++;
  });
  const actual = await evaluate(connection, worker,
    "new Promise(resolve=>chrome.runtime.getPlatformInfo(info=>resolve({origin:chrome.runtime.getURL('').replace(/\\/$/,''),os:info.os,adapter:!!globalThis.LuckyRayLocalTransport,fixtureGlobals:typeof globalThis.process!=='undefined'||'__LUCKYRAY_TEST_PORTS__' in globalThis||'__LUCKYRAY_ISOLATED_TRANSPORT_TARGET__' in globalThis})))");
  assert.deepEqual(actual, { origin, os: "linux", adapter: true, fixtureGlobals: false });
  return sandbox;
}
async function cleanup() {
  if (connection) { await connection.send("Browser.close").catch(() => {}); await connection.close(); }
  if (child && child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), pause(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), pause(5000)]);
    }
  }
  assert(!child || child.exitCode !== null || child.signalCode !== null, "owned Chromium did not stop");
  if (preflight) startupFatal = readStartupFatal();
  fs.rmSync(diagnostics, { recursive: true });
}
let failure, failureDetail, preflightSandbox;
try {
  assert(process.platform === "linux" && process.getuid() !== 0, "ordinary Linux user required");
  const sandbox = await start();
  if (preflight) {
    preflightSandbox = sandbox;
  } else {
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const command = JSON.parse(line);
      assert(["connect", "read", "read-first", "reset"].includes(command.type));
      phase = "extension-command";
      const result = await evaluate(connection, worker, `(async()=>{
        try {
          if (${JSON.stringify(command.type)} === 'connect') {
            const binding = await LuckyRayLocalTransport.openBinding(${port});
            globalThis.__linuxConsentCurrent = binding; globalThis.__linuxConsentFirst ||= binding;
            return {ok:true,binding};
          }
          if (${JSON.stringify(command.type)} === 'reset') { LuckyRayLocalTransport.resetSession();return {ok:true}; }
          const binding = ${JSON.stringify(command.type)} === 'read-first' ? globalThis.__linuxConsentFirst : globalThis.__linuxConsentCurrent;
          const response = await LuckyRayLocalTransport.fetch(binding,'/api/v1/folders');
          await response.arrayBuffer(); return {ok:response.ok,httpStatus:response.status};
        } catch(error) {return {ok:false,code:error.code||'browser-call-failed',notDispatched:error.notDispatched===true};}
      })()`);
      process.stdout.write(JSON.stringify({ ...result, counters, session, browser, sandbox, extension,
        browserApi: "REAL_CHROMIUM_NO_API_SUBSTITUTION" }) + "\n");
    }
  }
} catch (error) {
  failure = error;
  failureDetail = preflightFailure(error);
  process.stderr.write(`Linux Chromium acceptance failed: ${error.message}\n`);
  if (!preflight) process.stdout.write(JSON.stringify({ ok: false, code: "chromium-client-failed", phase, counters }) + "\n");
  process.exitCode = 1;
} finally {
  phase = "browser-cleanup";
  try { await cleanup(); } catch (error) {
    failure ||= error; failureDetail ||= preflightFailure(error); process.exitCode = 1;
  }
  if (preflight) {
    if (failure) emitPreflightFailure(failureDetail);
    else {
      preflightEmitted = true;
      process.stdout.write(JSON.stringify({ status: "PASS", browser, sandbox: preflightSandbox, startupInspection }) + "\n");
    }
  }
}
