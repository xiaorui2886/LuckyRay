import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadRecorder() {
  const protocolSource = await readFile(new URL("../browser-extension-prototype/extension-protocol.js", import.meta.url), "utf8");
  const recorderSource = await readFile(new URL("../browser-extension-prototype/offscreen.js", import.meta.url), "utf8");
  const listeners = [];
  const outbound = [];
  const stored = {};
  const timers = new Map();
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  let nextTimer = 0;
  let blobCalls = 0;
  let fileReaderCalls = 0;

  class FixtureRecorder {
    static last = null;
    static isTypeSupported() { return true; }
    constructor() {
      this.state = "inactive";
      this.mimeType = "video/webm";
      FixtureRecorder.last = this;
    }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.({}); }
    emit(size) { this.ondataavailable?.({ data: { size } }); }
    fail() { this.onerror?.({ error: new Error("PRIVATE C:\\secret\\stack") }); }
  }

  const sandbox = {
    Date,
    Math,
    Number,
    Object,
    Promise,
    MediaRecorder: FixtureRecorder,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    Blob: class {
      constructor(chunks, options) {
        blobCalls += 1;
        this.size = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
        this.type = options.type;
      }
    },
    FileReader: class {
      readAsDataURL() { fileReaderCalls += 1; }
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.chrome = {
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage(message) { outbound.push(message); },
    },
    storage: { session: { async set(value) { Object.assign(stored, value); } } },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(protocolSource, context, { filename: "extension-protocol.js" });
  vm.runInContext(recorderSource, context, { filename: "offscreen.js" });

  async function send(message) {
    for (const listener of listeners) {
      const response = await new Promise((resolve, reject) => {
        let settled = false;
        const sendResponse = (value) => { settled = true; resolve(value); };
        try {
          const keepAlive = listener(message, {}, sendResponse);
          if (keepAlive !== true && !settled) resolve(undefined);
        } catch (error) { reject(error); }
      });
      if (response !== undefined) return response;
    }
    return undefined;
  }

  return {
    send,
    FixtureRecorder,
    tracks,
    outbound,
    stored,
    fireTimers() { for (const callback of [...timers.values()]) callback(); },
    counters() { return { blobCalls, fileReaderCalls }; },
  };
}

const startMessage = {
  type: "luckyray-offscreen-record-start",
  streamId: "fixture-stream",
  recordingId: "fixture-recording-1",
  tabId: 7,
};

test("record cancel releases tracks without constructing a blob or base64 payload", async () => {
  const harness = await loadRecorder();
  assert.equal((await harness.send(startMessage)).ok, true);
  harness.FixtureRecorder.last.emit(1024);
  assert.equal((await harness.send({
    type: "luckyray-offscreen-record-cancel",
    recordingId: "fixture-recording-1",
  })).ok, true);
  assert.deepEqual(harness.counters(), { blobCalls: 0, fileReaderCalls: 0 });
  assert.equal(harness.tracks[0].stopped, true);
  const status = await harness.send({ type: "luckyray-offscreen-record-status" });
  assert.equal(status.active, false);
  assert.doesNotMatch(JSON.stringify({ status, stored: harness.stored, outbound: harness.outbound }), /fixture-stream|PRIVATE|C:\\secret/);
});

test("duration and recorder errors publish only fixed safe codes", async () => {
  const duration = await loadRecorder();
  assert.equal((await duration.send(startMessage)).ok, true);
  duration.fireTimers();
  assert.deepEqual(JSON.parse(JSON.stringify(duration.outbound)), [
    { type: "luckyray-record-fail", code: "recording-duration-limit", recordingId: "fixture-recording-1" },
  ]);

  const failure = await loadRecorder();
  assert.equal((await failure.send(startMessage)).ok, true);
  failure.FixtureRecorder.last.fail();
  assert.deepEqual(JSON.parse(JSON.stringify(failure.outbound)), [
    { type: "luckyray-record-fail", code: "recording-media-error", recordingId: "fixture-recording-1" },
  ]);
  assert.doesNotMatch(JSON.stringify({ outbound: failure.outbound, stored: failure.stored }), /PRIVATE|secret|stack/i);
});

test("the offscreen document loads the shared protocol before the recorder", async () => {
  const html = await readFile(new URL("../browser-extension-prototype/offscreen.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="extension-protocol.js"') < html.indexOf('src="offscreen.js"'));
});
