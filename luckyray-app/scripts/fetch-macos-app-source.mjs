// One bounded request for the pinned public source, followed by the existing
// offline import boundary. No archive content is extracted or executed here.
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "./macos-build-common.mjs";
import { requireInternalContext } from "./check-macos-internal.mjs";
import { FFMPEG_SOURCE_INPUT, STAGED_FFMPEG_SOURCE, stagePinnedSource } from "./import-macos-app-source.mjs";

export const OFFICIAL_SOURCE_URL = "https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz";
const TRAILER_PREFIX = "\nLR_HTTP_STATUS:";
const TRAILER_BYTES = Buffer.byteLength(`${TRAILER_PREFIX}200\n`);
const fail = kind => new Error(`macos-source-fetch-${kind}`);
// Only bounded, non-sensitive categories may leave the disposable runner.
// Unknown errors, raw curl stderr and URLs remain private and discarded.
const SAFE_FAILURES = new Set([
  "macos-source-fetch-http-denied", "macos-source-fetch-curl-config-present", "macos-source-fetch-tls-keylog-configured",
  "macos-source-fetch-http-redirect", "macos-source-fetch-http-rate-limited", "macos-source-fetch-http-client-error", "macos-source-fetch-http-server-error",
  "macos-source-fetch-curl-timeout", "macos-source-fetch-curl-resolution-connect", "macos-source-fetch-curl-tls",
  "macos-source-fetch-transfer-failed", "macos-source-fetch-size-invalid", "macos-source-fetch-digest-invalid",
  "macos-source-fetch-stream-failed", "macos-source-fetch-launch-failed", "macos-source-fetch-timeout",
  "macos-source-import-directory-unsafe", "macos-source-import-directory-changed", "macos-source-import-object-changed",
  "macos-source-import-output-unsafe", "macos-source-import-file-unsafe", "macos-source-import-bytes-invalid",
]);
export function safeSourceFetchFailure(error) {
  try {
    const message = error?.message;
    return typeof message === "string" && SAFE_FAILURES.has(message) ? message : "macos-source-fetch-failed";
  } catch { return "macos-source-fetch-failed"; }
}

// Disable curl's optional per-user config only after establishing that no such
// config exists. A configured proxy in the inherited environment is retained;
// a curlrc that could encode an additional policy stops this operation instead
// of silently bypassing that policy or allowing URL/TLS overrides.
export async function requireNoCurlConfig(env, accountHome) {
  if (env.SSLKEYLOGFILE) throw fail("tls-keylog-configured");
  const paths = [
    env.CURL_HOME && join(env.CURL_HOME, ".curlrc"),
    env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, "curlrc"),
    env.HOME && join(env.HOME, ".curlrc"),
    accountHome && join(accountHome, ".curlrc"),
  ].filter(Boolean);
  for (const path of new Set(paths)) {
    try { await lstat(path); throw fail("curl-config-present"); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  }
}

// The descriptor and process launcher are supplied only by trusted build code;
// synthetic descriptors/processes permit offline tests of the same reader.
export async function fetchPinnedSource(input, {
  launch = spawn, env = process.env, accountHome = userInfo().homedir, timeoutMs = 125_000,
} = {}) {
  if (!Number.isSafeInteger(input?.bytes) || input.bytes <= 0 || input.bytes > 128 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(input.sha256)) throw fail("descriptor-invalid");
  await requireNoCurlConfig(env, accountHome);
  const args = ["-q", "--silent", "--show-error", "--fail", "--no-insecure", "--no-proxy-insecure",
    // Keep a single bounded request, while allowing a slow runner connection
    // more than the previous 15 seconds to establish TLS.
    "--connect-timeout", "45", "--max-time", "120", "--max-filesize", String(input.bytes),
    "--proto", "=https", "--max-redirs", "0", "--output", "-",
    "--write-out", `${TRAILER_PREFIX}%{http_code}\n`, OFFICIAL_SOURCE_URL];

  let child;
  try { child = launch("/usr/bin/curl", args, { stdio: ["ignore", "pipe", "pipe"], env }); }
  catch { throw fail("launch-failed"); }
  return new Promise((resolveResult, rejectResult) => {
    const body = Buffer.alloc(input.bytes);
    let total = 0, filled = 0, tail = Buffer.alloc(0), failure, settled = false, killTimer, hardTimer;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true; clearTimeout(watchdog); clearTimeout(killTimer); clearTimeout(hardTimer);
      if (error) rejectResult(error); else resolveResult(bytes);
    };
    const terminate = reason => {
      if (failure || settled) return;
      failure = reason;
      try { child.kill("SIGTERM"); } catch { /* fail closed */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* fail closed */ }
        hardTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(fail(failure)); }, 1000);
      }, 1000);
    };
    const watchdog = setTimeout(() => terminate("timeout"), timeoutMs);
    child.stderr.resume(); // Never emit raw curl output, headers or environment values.
    child.stdout.once("error", () => terminate("stream-failed"));
    child.stderr.once("error", () => terminate("stream-failed"));
    child.stdout.on("data", chunk => {
      if (failure || settled) return;
      total += chunk.length;
      if (total > input.bytes + TRAILER_BYTES) { terminate("size-invalid"); return; }
      const count = Math.min(input.bytes - filled, chunk.length);
      if (count > 0) { chunk.copy(body, filled, 0, count); filled += count; }
      tail = chunk.length >= TRAILER_BYTES ? chunk.subarray(chunk.length - TRAILER_BYTES)
        : Buffer.concat([tail, chunk]).subarray(-TRAILER_BYTES);
    });
    child.once("error", () => finish(fail("launch-failed")));
    child.once("close", (code, signal) => {
      if (failure) return finish(fail(failure));
      const match = /^\nLR_HTTP_STATUS:(\d{3})\n$/.exec(tail.toString("ascii"));
      const status = match ? Number(match[1]) : 0;
      if ([401, 403, 451].includes(status)) return finish(fail("http-denied"));
      if (status >= 300 && status < 400) return finish(fail("http-redirect"));
      if (status === 429) return finish(fail("http-rate-limited"));
      if (status >= 400 && status < 500) return finish(fail("http-client-error"));
      if (status >= 500 && status < 600) return finish(fail("http-server-error"));
      if (signal === null && code === 28) return finish(fail("curl-timeout"));
      if (signal === null && [5, 6, 7].includes(code)) return finish(fail("curl-resolution-connect"));
      if (signal === null && [35, 51, 60, 77, 90].includes(code)) return finish(fail("curl-tls"));
      if (code !== 0 || signal !== null || status !== 200) return finish(fail("transfer-failed"));
      if (total !== input.bytes + TRAILER_BYTES || filled !== input.bytes) return finish(fail("size-invalid"));
      if (sha256(body) !== input.sha256) return finish(fail("digest-invalid"));
      return finish(null, body);
    });
  });
}

export async function fetchAndStagePinnedSource(input, path, options) {
  const bytes = await fetchPinnedSource(input, options);
  return stagePinnedSource(input, bytes, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2 || FFMPEG_SOURCE_INPUT.url !== OFFICIAL_SOURCE_URL
        || FFMPEG_SOURCE_INPUT.bytes !== 12_036_420
        || FFMPEG_SOURCE_INPUT.sha256 !== "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635")
      throw fail("arguments-invalid");
    // Check the same native, repository, exact-HEAD and disposable-worktree
    // boundary used by the worker before initiating any network request.
    await requireInternalContext();
    const result = await fetchAndStagePinnedSource(FFMPEG_SOURCE_INPUT, STAGED_FFMPEG_SOURCE);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(safeSourceFetchFailure(error));
    process.exitCode = 1;
  }
}
