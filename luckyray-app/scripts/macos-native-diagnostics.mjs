// Positive extraction only: no raw excerpts, arguments, URLs, environment or
// absolute paths enter reports. The stream parser retains bounded typed facts.
export const DIAGNOSTIC_STAGES = Object.freeze([
  "command", "frontend-build", "frontend-install", "package-manager-version", "tauri-build",
  "dsh-fetch", "dsh-install", "dsh-project", "dsh-audit", "dsh-native-load", "dsh-version", "dsh-materials",
  "source-download", "source-extract", "openssl-configure", "openssl-build", "openssl-install",
  "liblzma-configure", "liblzma-build", "liblzma-install",
  "python-configure", "python-build", "python-install", "python-install-probe", "python-stdlib", "python-probe",
  "ffmpeg-flags", "ffmpeg-configure", "ffmpeg-build", "ffmpeg-probe", "deno-probe", "node-version",
  "compile-sidecars", "cli-identity", "arm64-check", "code-sign", "diagnostic-self-test",
]);
const COMMANDS = Object.freeze(["node", "pnpm", "cargo", "make", "configure", "perl", "curl", "python3", "python3.11",
  "lipo", "codesign", "otool", "plutil", "git", "deno", "ffmpeg", "swiftc", "screencapture", "luckyray-cli"]);
const CLASSES = Object.freeze(["rust-compiler", "typescript-compiler", "python-error", "native-compiler", "compiler-error", "header-not-found", "unresolved-name", "type-mismatch",
  "linker-failure", "library-not-found", "compiler-link-probe-failed", "unsupported-option", "invalid-config", "io-error",
  "before-build-failed", "module-not-found", "native-module-load-failed", "architecture-mismatch", "permission-denied",
  "disk-full", "source-download-failed", "pinned-input-rejected", "runtime-minimum-rejected", "project-error", "configure-log-unavailable", "configure-terminal"]);
const ORIGINS = Object.freeze(["process-output", "configure-probe-log"]);
const TERMINALS = Object.freeze({
  "C compiler test failed.": "ffmpeg-c-compiler-test-failed",
  "Host compiler lacks C11 support": "ffmpeg-host-c11-unsupported",
});
const HEADERS = Object.freeze(["stdio.h", "stdlib.h", "Python.h", "openssl/ssl.h", "openssl/crypto.h", "ffi.h", "zlib.h", "bzlib.h", "lzma.h", "sqlite3.h", "readline/readline.h"]);
const NATIVE_MODULES = Object.freeze(["koffi", "node-pty", "sharp", "node-addon-require-builtin"]);
const PYTHON_ERRORS = Object.freeze(["SyntaxError", "ModuleNotFoundError", "ImportError", "AssertionError", "FileNotFoundError", "PermissionError"]);
export const PYTHON_PROBE_IMPORTS = Object.freeze(["ssl", "hashlib", "zlib", "bz2", "lzma", "sqlite3", "zipfile"]);
const PYTHON_PROBE_STAGES = Object.freeze(["python-install-probe", "python-probe"]);
const PYTHON_MODULES = Object.freeze([...PYTHON_PROBE_IMPORTS, "_ssl", "_hashlib", "_socket", "_bz2", "_lzma", "_sqlite3", "_struct", "binascii", "encodings", "codecs", "yt_dlp", "yt_dlp_ejs"]);
const IO_CODES = Object.freeze(["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "ETIMEDOUT"]);
const SIGNALS = Object.freeze(["SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGXCPU", "SIGXFSZ"]);
const PREFIX = "MACOS_NATIVE_EVENT ";
const SOURCES = Object.freeze(["macos-build-common.mjs", "macos-dsh-distribution.mjs", "prepare-macos-build.mjs",
  "prepare-macos-runtimes.mjs", "prepare-macos-sidecars.mjs", "prepare-macos-node-input.mjs", "prepare-macos-deno-input.mjs",
  "check-macos-media-sources.mjs", "dsh-supply-chain.mjs", "build-macos.mjs", "check-macos-internal.mjs"]);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000000;
export const safeExit = value => Number.isInteger(value) && value >= 0 && value <= 255 || SIGNALS.includes(value) || value === "SPAWN_ERROR";
export async function diagnosticVocabulary(readScript) {
  const codes = new Set();
  for (const file of SOURCES) {
    const text = (await readScript(file)).toString();
    for (const match of text.matchAll(/["'`]((?:macos|dsh)-[a-z0-9-]{1,100})["'`]/g)) codes.add(match[1]);
  }
  if (codes.size > 2048) throw new Error("macos-diagnostic-catalog-budget");
  return codes;
}
let sequence = 0;
export function commandEvent(event, stage, command, extra = {}) {
  if (process.env.MACOS_INTERNAL_DIAGNOSTICS !== "1") return null;
  const kind = COMMANDS.includes(command.split("/").at(-1)) ? command.split("/").at(-1) : "other";
  const value = { event, id: `${process.pid}:${++sequence}`, stage: DIAGNOSTIC_STAGES.includes(stage) ? stage : "command", command: kind, ...extra };
  process.stderr.write(`\n${PREFIX}${JSON.stringify(value)}\n`);
  return value.id;
}
function location(line, files) {
  const match = /(?:^|\s)((?:src\/[A-Za-z0-9_./-]+\.(?:rs|ts|tsx|c|h|cpp|cc|m|mm))|build\.rs)(?::(\d+):(\d+)|\((\d+),(\d+)\))/.exec(line);
  if (!match || !files.has(match[1]) || match[1].length > 160 || match[1].split("/").includes("..")) return {};
  const row = +(match[2] ?? match[4]); const column = +(match[3] ?? match[5]);
  return count(row) && count(column) ? { file: match[1], line: row, column } : {};
}
export class DiagnosticCollector {
  constructor(codes = new Set(), files = new Set(), origin = "process-output") { this.codes = codes; this.files = files; this.origin = ORIGINS.includes(origin) ? origin : "process-output"; this.buffers = { stdout: "", stderr: "" }; this.commands = []; this.issues = []; this.nativeModules = new Map(); this.pythonImports = new Map(); this.lastCheckpoint = null; this.truncated = false; }
  feed(stream, chunk) {
    if (!["stdout", "stderr"].includes(stream)) return;
    const text = this.buffers[stream] + chunk.toString();
    if (text.split(/\r?\n/).some(line => line.length > 8192)) this.truncated = true;
    const lines = text.split(/\r?\n/); this.buffers[stream] = lines.pop().slice(-8192);
    for (const line of lines) this.line(line.slice(0, 8192).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
  }
  add(issue) {
    if (!ORIGINS.includes(issue.origin)) issue.origin = this.origin;
    const active = this.commands.findLast(item => item.status === "started");
    if (active && !issue.stage) issue.stage = active.stage;
    const serialized = JSON.stringify(issue);
    if (!this.issues.some(item => JSON.stringify(item) === serialized)) this.issues.push(issue);
    if (this.issues.length > 12) this.issues.splice(6, 1);
  }
  line(line) {
    if (Object.hasOwn(TERMINALS, line.trim())) this.add({ class: "configure-terminal", code: TERMINALS[line.trim()] });
    const pythonImports = /^MACOS_PYTHON_PROBE_IMPORTS:([01]{7})$/.exec(line);
    if (pythonImports) {
      const active = this.commands.findLast(item => item.status === "started" && PYTHON_PROBE_STAGES.includes(item.stage));
      if (active) this.pythonImports.set(active.stage, PYTHON_PROBE_IMPORTS.map((name, i) => ({ name, status: pythonImports[1][i] === "1" ? "passed" : "failed" })));
      return;
    }
    const native = /^MACOS_NATIVE_MODULE_(START|PASS):([a-z-]+)$/.exec(line);
    if (native && NATIVE_MODULES.includes(native[2])) {
      if (native[1] === "START") this.nativeModules.set(native[2], "started");
      else if (this.nativeModules.has(native[2])) this.nativeModules.set(native[2], "passed");
      return;
    }
    if (line.startsWith(PREFIX)) {
      try {
        const e = JSON.parse(line.slice(PREFIX.length));
        if (!/^[0-9]{1,10}:[0-9]{1,10}$/.test(e.id) || !DIAGNOSTIC_STAGES.includes(e.stage)
            || ![...COMMANDS, "other"].includes(e.command) || !["start", "exit", "checkpoint", "issues"].includes(e.event)) return;
        if (e.event === "checkpoint") this.lastCheckpoint = e.stage;
        else if (e.event === "issues") {
          for (const item of safeDiagnosticSummary({ issues: e.issues }, this.codes, this.files).issues)
            this.add({ ...item, stage: e.stage });
        }
        else if (e.event === "start") {
          const value = { id: e.id, stage: e.stage, command: e.command, status: "started" };
          if (typeof e.inputSha256 === "string" && /^[a-f0-9]{64}$/.test(e.inputSha256)) value.inputSha256 = e.inputSha256;
          this.commands.push(value);
          if (this.commands.length > 32) {
            const completed = this.commands.findIndex(item => item.status !== "started");
            this.commands.splice(completed < 0 ? 0 : completed, 1); this.truncated = true;
          }
        } else {
          const index = this.commands.findIndex(item => item.id === e.startedId); const value = this.commands[index];
          if (!value || value.stage !== e.stage || value.command !== e.command || !safeExit(e.exit)) return;
          value.exit = e.exit; value.status = e.exit === 0 ? "passed" : "failed";
          if (IO_CODES.includes(e.ioCode)) value.ioCode = e.ioCode;
          if (count(e.elapsedMs)) value.elapsedMs = e.elapsedMs;
          this.commands.splice(index, 1); this.commands.push(value);
        }
      } catch { /* Malformed untrusted child output is never copied. */ }
      return;
    }
    const rust = /\berror\[(E\d{4})\]/.exec(line);
    if (rust) this.add({ class: "rust-compiler", code: rust[1] });
    const typescript = /\berror (TS\d{4,5})\b/.exec(line);
    if (typescript) this.add({ class: "typescript-compiler", code: typescript[1] });
    for (const errorType of PYTHON_ERRORS) if (line.startsWith(`${errorType}:`)) {
      this.add({ class: "python-error", errorType });
      for (const module of PYTHON_MODULES) if (line.includes(`'${module}'`)) this.add({ class: "module-not-found", module });
    }
    if (/(?:^|:)\s*(?:fatal )?error:/.test(line)) this.add({ class: "compiler-error" });
    const where = location(line, this.files);
    if (where.file && (/\berror\b|-->/.test(line))) this.add({ class: /\.rs:/.test(line) ? "rust-compiler" : /\.(?:ts|tsx)\(/.test(line) ? "typescript-compiler" : "native-compiler", ...where });
    for (const code of this.codes) if (line.includes(code)) this.add({ class: "project-error", code });
    for (const code of IO_CODES) if (new RegExp(`\\b${code}\\b`).test(line)) this.add({ class: "io-error", code });
    const categories = [
      [/file not found|No such file or directory.*\.h\b/i, "header-not-found"],
      [/cannot find (?:value|function|type|module)|undeclared identifier|unresolved import/i, "unresolved-name"],
      [/mismatched types|incompatible (?:pointer|function)|type mismatch/i, "type-mismatch"],
      [/undefined symbols|undefined reference|linker command failed|linking with .+ failed/i, "linker-failure"],
      [/library not found|cannot find -l/i, "library-not-found"],
      [/C compiler cannot create executables|cannot compile a simple test program/i, "compiler-link-probe-failed"],
      [/unexpected argument|unknown (?:argument|option)|unrecognized (?:command.line )?option|invalid value.+for ['"]?--/i, "unsupported-option"],
      [/invalid (?:configuration|config)|unknown field|failed to parse.*config/i, "invalid-config"],
      [/(?:beforeBuildCommand|beforeBuild command|before-build).*(?:fail|non.zero|exit code)/i, "before-build-failed"],
      [/Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|Could not resolve|Failed to resolve import/i, "module-not-found"],
      [/ERR_DLOPEN_FAILED|dlopen\(.+\).*failed|Library not loaded/i, "native-module-load-failed"],
      [/incompatible architecture|wrong architecture|bad CPU type/i, "architecture-mismatch"],
      [/Permission denied|Operation not permitted/i, "permission-denied"], [/No space left on device/i, "disk-full"],
      [/curl: \((?:6|7|22|28|35|60)\)/, "source-download-failed"],
    ];
    for (const [pattern, kind] of categories) if (pattern.test(line)) this.add({ class: kind });
    if (/macos-frozen-runtime-requires-/.test(line)) this.add({ class: "runtime-minimum-rejected" });
    if (/file not found/.test(line)) for (const header of HEADERS)
      if (line.includes(`'${header}'`) || line.includes(`\"${header}\"`)) this.add({ class: "header-not-found", header });
    const http = /^MACOS_HTTP_STATUS:(\d{3})$/.exec(line);
    if (http && +http[1] >= 400 && +http[1] <= 599) this.add({ class: "source-download-failed", httpStatus: +http[1] });
  }
  summary() {
    for (const stream of Object.keys(this.buffers)) { if (this.buffers[stream]) this.line(this.buffers[stream]); this.buffers[stream] = ""; }
    return { lastCheckpoint: this.lastCheckpoint, commands: this.commands.slice(-16), issues: this.issues,
      nativeModules: [...this.nativeModules].map(([name, status]) => ({ name, status })),
      pythonImports: [...this.pythonImports].map(([stage, imports]) => ({ stage, imports })), truncated: this.truncated };
  }
}
// Re-project persisted reports before publishing them to the workflow log.
export function safeDiagnosticSummary(input, codes = new Set(), files = new Set()) {
  const result = { lastCheckpoint: DIAGNOSTIC_STAGES.includes(input?.lastCheckpoint) ? input.lastCheckpoint : null, commands: [], issues: [], nativeModules: [], pythonImports: [], truncated: input?.truncated === true };
  // Two fixed probe stages, seven fixed results each; independent of issue eviction.
  for (const stage of PYTHON_PROBE_STAGES) {
    const item = (Array.isArray(input?.pythonImports) ? input.pythonImports : []).slice(0, 2).find(item => item?.stage === stage);
    if (!Array.isArray(item?.imports) || item.imports.length !== PYTHON_PROBE_IMPORTS.length
        || item.imports.some((value, i) => value?.name !== PYTHON_PROBE_IMPORTS[i] || !["passed", "failed"].includes(value.status))) continue;
    result.pythonImports.push({ stage, imports: item.imports.map((value, i) => ({ name: PYTHON_PROBE_IMPORTS[i], status: value.status })) });
  }
  for (const item of (Array.isArray(input?.nativeModules) ? input.nativeModules : []).slice(-4))
    if (NATIVE_MODULES.includes(item.name) && ["started", "passed"].includes(item.status)) result.nativeModules.push({ name: item.name, status: item.status });
  for (const item of (Array.isArray(input?.commands) ? input.commands : []).slice(-16)) {
    if (!DIAGNOSTIC_STAGES.includes(item.stage) || ![...COMMANDS, "other"].includes(item.command)
        || !["started", "passed", "failed"].includes(item.status)) continue;
    const value = { stage: item.stage, command: item.command, status: item.status };
    if (item.status === "passed" && item.exit !== 0 || item.status === "failed" && (!safeExit(item.exit) || item.exit === 0)) continue;
    if (safeExit(item.exit)) value.exit = item.exit;
    if (IO_CODES.includes(item.ioCode)) value.ioCode = item.ioCode;
    if (count(item.elapsedMs)) value.elapsedMs = item.elapsedMs;
    if (typeof item.inputSha256 === "string" && /^[a-f0-9]{64}$/.test(item.inputSha256)) value.inputSha256 = item.inputSha256;
    result.commands.push(value);
  }
  for (const item of (Array.isArray(input?.issues) ? input.issues : []).slice(-12)) {
    if (!CLASSES.includes(item.class)) continue;
    const value = { class: item.class };
    if (ORIGINS.includes(item.origin)) value.origin = item.origin;
    if (DIAGNOSTIC_STAGES.includes(item.stage)) value.stage = item.stage;
    if (HEADERS.includes(item.header)) value.header = item.header;
    if (PYTHON_ERRORS.includes(item.errorType)) value.errorType = item.errorType;
    if (PYTHON_MODULES.includes(item.module)) value.module = item.module;
    if (/^(?:E\d{4}|TS\d{4,5})$/.test(item.code) || codes.has(item.code) || IO_CODES.includes(item.code) || Object.values(TERMINALS).includes(item.code)) value.code = item.code;
    const where = location(`${item.file ?? ""}:${item.line ?? ""}:${item.column ?? ""}`, files);
    Object.assign(value, where);
    if (count(item.httpStatus) && item.httpStatus >= 400 && item.httpStatus <= 599) value.httpStatus = item.httpStatus;
    result.issues.push(value);
  }
  return result;
}
