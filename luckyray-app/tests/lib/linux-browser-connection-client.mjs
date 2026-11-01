// Browser-API protocol fixture around the unchanged production JS adapter.
// Native Messaging uses the actual registered ELF and framed stdio; Chromium
// itself is not emulated as an accepted product identity or counted as tested.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import readline from "node:readline";

const [manifestPath, origin, portText] = process.argv.slice(2);
const port = Number(portText);
assert(Number.isInteger(port) && port >= 37418 && port <= 37467);
assert(/^chrome-extension:\/\/[a-p]{32}$/.test(origin));
const fetchHttp = globalThis.fetch;
const counters = { nativeMessages: 0, protectedReads: 0, anonymousBootstrap: 0 };
const history = [];

async function nativeMessage(name, message) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, name);
  assert.equal(manifest.type, "stdio");
  assert(manifest.allowed_origins.includes(`${origin}/`));
  const data = Buffer.from(JSON.stringify(message));
  const length = Buffer.alloc(4); length.writeUInt32LE(data.length);
  return new Promise((resolve, reject) => {
    const child = spawn(manifest.path, [`${origin}/`], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("native fixture timeout")); }, 10000);
    child.on("error", reject);
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024 + 4) child.kill(); else chunks.push(chunk); });
    child.stderr.resume();
    child.on("close", code => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0); const output = Buffer.concat(chunks);
        assert(output.length >= 4 && output.readUInt32LE(0) === output.length - 4);
        resolve(JSON.parse(output.subarray(4)));
      } catch (_) { reject(new Error("native fixture returned an invalid frame")); }
    });
    child.stdin.end(Buffer.concat([length, data]));
  });
}

globalThis.chrome = { runtime: {
  lastError: null, getURL: () => `${origin}/`, getPlatformInfo: callback => callback({ os: "linux" }),
  sendNativeMessage(name, message, callback) {
    counters.nativeMessages += 1;
    nativeMessage(name, message).then(callback, () => {
      chrome.runtime.lastError = { message: "Native host unavailable" };
      callback(undefined); chrome.runtime.lastError = null;
    });
  },
} };
globalThis.__LUCKYRAY_TEST_PORTS__ = [port];
globalThis.fetch = (input, init = {}) => {
  const url = new URL(input);
  assert.equal(url.origin, `http://127.0.0.1:${port}`);
  const headers = new Headers(init.headers); headers.set("Origin", origin);
  if (url.pathname === "/api/v1/folders") counters.protectedReads += 1;
  if (url.pathname === "/api/v1/extension/bootstrap") counters.anonymousBootstrap += 1;
  return fetchHttp(input, { ...init, headers });
};
await import("../../browser-extension-prototype/local-transport-auth.js");
const transport = globalThis.LuckyRayLocalTransport;
let current, first;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  let result;
  try {
    if (command.type === "connect") {
      current = await transport.openBinding(port); first ||= current;
      result = { ok: true, binding: current };
    } else if (command.type === "read" || command.type === "read-first") {
      const response = await transport.fetch(command.type === "read-first" ? first : current, "/api/v1/folders");
      await response.arrayBuffer();
      result = { ok: response.ok, httpStatus: response.status };
    } else if (command.type === "reset") {
      transport.resetSession(); result = { ok: true };
    } else throw new Error("invalid fixture command");
  } catch (error) { result = { ok: false, code: error.code || "fixture-failed", notDispatched: error.notDispatched === true }; }
  history.push({ command: command.type, ...result });
  process.stdout.write(JSON.stringify({ ...result, counters }) + "\n");
}
