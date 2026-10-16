import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadProbeHarness(initialGlobals = {}) {
  const source = await readFile(new URL("../browser-extension-prototype/page-media-probe.js", import.meta.url), "utf8");
  const emitted = [];
  const listeners = new Map();
  class FakeCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  class FakeSourceBuffer {
    appendBuffer(_value) { return undefined; }
  }
  class FakeMediaSource {
    addSourceBuffer(_type) { return new FakeSourceBuffer(); }
  }
  class FakeResponse {
    constructor(url, value) { this.url = url; this.value = value; this.stream = new FakeReadableStream(value); }
    async arrayBuffer() { return this.value; }
    async blob() { return new FakeBlob(this.value); }
    async json() { return this.value; }
    async text() { return typeof this.value === "string" ? this.value : JSON.stringify(this.value); }
    get body() { return this.stream; }
  }
  class FakeBlob {
    constructor(value) { this.value = value; }
    async arrayBuffer() { return this.value; }
  }
  class FakeXhr {
    constructor(url = "", value = null, responseType = "json") {
      this.responseURL = url;
      this.response = value;
      this.responseType = responseType;
      this.responseText = responseType === "" || responseType === "text"
        ? (typeof value === "string" ? value : JSON.stringify(value))
        : "";
      this.listeners = new Map();
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send() { this.listeners.get("loadend")?.(); }
  }
  class FakeReadableStreamDefaultReader {
    constructor(value) { this.value = value; this.done = false; }
    async read() {
      if (this.done) return { done: true, value: undefined };
      this.done = true;
      return { done: false, value: new Uint8Array(this.value) };
    }
  }
  class FakeReadableStream {
    constructor(value) { this.value = value; }
    getReader() { return new FakeReadableStreamDefaultReader(this.value); }
  }
  const document = {
    addEventListener(type, listener) {
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      if (event.type === "__luckyray_page_media_probe_v1__") emitted.push(event.detail);
      return true;
    },
  };
  let blobSequence = 0;
  const FakeURL = class extends URL {};
  FakeURL.createObjectURL = () => `blob:https://page.test/player-${++blobSequence}`;
  FakeURL.revokeObjectURL = () => {};
  const sandbox = {
    URL: FakeURL,
    Response: FakeResponse,
    Blob: FakeBlob,
    XMLHttpRequest: FakeXhr,
    ReadableStream: FakeReadableStream,
    ReadableStreamDefaultReader: FakeReadableStreamDefaultReader,
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBuffer,
    CustomEvent: FakeCustomEvent,
    document,
    performance: { now: () => 10 },
    Date,
    setTimeout,
    clearTimeout,
    AbortController,
    ArrayBuffer,
    Uint8Array,
    WeakMap,
    Map,
    Set,
    location: { href: "https://page.test/watch" },
    ...initialGlobals,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "page-media-probe.js" });
  return { sandbox, emitted };
}

test("the MAIN-world probe publishes one bounded Bilibili video and audio track pair", async () => {
  const { emitted } = await loadProbeHarness({
    location: { href: "https://www.bilibili.com/video/BV1xx411c7mD" },
    __playinfo__: {
      data: {
        dash: {
          video: [
            { baseUrl: "https://v.example.bilivideo.com/video-low.m4s", width: 640, height: 360, bandwidth: 300_000 },
            { baseUrl: "https://v.example.bilivideo.com/video-high.m4s", width: 1920, height: 1080, bandwidth: 3_000_000 },
          ],
          audio: [
            { baseUrl: "https://a.example.bilivideo.com/audio-low.m4s", bandwidth: 64_000 },
            { baseUrl: "https://a.example.bilivideo.com/audio-high.m4s", bandwidth: 192_000 },
          ],
        },
      },
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{
    version: 1,
    kind: "site-track-pair",
    pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
    videoUrl: "https://v.example.bilivideo.com/video-high.m4s",
    audioUrl: "https://a.example.bilivideo.com/audio-high.m4s",
    contentType: "video/mp4",
    width: 1920,
    height: 1080,
    bitrate: 3_000_000,
  }]);
});

test("the MAIN-world probe publishes the best public YouTube adaptive video and audio pair", async () => {
  const { emitted } = await loadProbeHarness({
    location: { href: "https://www.youtube.com/watch?v=fixture123" },
    ytInitialPlayerResponse: {
      streamingData: {
        adaptiveFormats: [
          {
            url: "https://v.example.googlevideo.com/videoplayback?id=video-720",
            mimeType: "video/mp4; codecs=avc1",
            width: 1280,
            height: 720,
            bitrate: 1_000_000,
          },
          {
            url: "https://v.example.googlevideo.com/videoplayback?id=video-1080",
            mimeType: "video/mp4; codecs=avc1",
            width: 1920,
            height: 1080,
            bitrate: 3_000_000,
          },
          {
            url: "https://a.example.googlevideo.com/videoplayback?id=audio",
            mimeType: "audio/mp4; codecs=mp4a",
            bitrate: 192_000,
          },
        ],
      },
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{
    version: 1,
    kind: "site-track-pair",
    pageUrl: "https://www.youtube.com/watch?v=fixture123",
    videoUrl: "https://v.example.googlevideo.com/videoplayback?id=video-1080",
    audioUrl: "https://a.example.googlevideo.com/videoplayback?id=audio",
    contentType: "video/mp4",
    width: 1920,
    height: 1080,
    bitrate: 3_000_000,
  }]);
});

test("the MAIN-world probe binds the highest X MP4 variant to the exact status id", async () => {
  const { sandbox, emitted } = await loadProbeHarness({
    location: { href: "https://x.com/luckyray/status/1234567890" },
  });
  const response = new sandbox.Response("https://x.com/i/api/graphql/fixture/TweetDetail", {
    data: {
      entries: [
        {
          result: {
            rest_id: "9999999999",
            legacy: {
              extended_entities: { media: [{ type: "video", video_info: { variants: [{
                bitrate: 9_000_000,
                content_type: "video/mp4",
                url: "https://video.twimg.com/ext_tw_video/wrong/pu/vid/1920x1080/wrong.mp4",
              }] } }] },
            },
          },
        },
        {
          result: {
            rest_id: "1234567890",
            legacy: {
              extended_entities: { media: [{ type: "video", video_info: { variants: [
                {
                  bitrate: 256_000,
                  content_type: "video/mp4",
                  url: "https://video.twimg.com/ext_tw_video/right/pu/vid/320x180/low.mp4",
                },
                {
                  bitrate: 2_176_000,
                  content_type: "video/mp4",
                  url: "https://video.twimg.com/ext_tw_video/right/pu/vid/1280x720/high.mp4",
                },
              ] } }] },
            },
          },
        },
      ],
    },
  });

  await response.json();

  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{
    version: 1,
    kind: "site-video-candidate",
    pageUrl: "https://x.com/luckyray/status/1234567890",
    videoUrl: "https://video.twimg.com/ext_tw_video/right/pu/vid/1280x720/high.mp4",
    contentType: "video/mp4",
    bitrate: 2_176_000,
  }]);
});

test("the MAIN-world probe also observes X GraphQL responses consumed as text", async () => {
  const { sandbox, emitted } = await loadProbeHarness({
    location: { href: "https://x.com/luckyray/status/1234567890" },
  });
  const response = new sandbox.Response("https://x.com/i/api/graphql/fixture/TweetDetail", JSON.stringify({
    data: {
      result: {
        rest_id: "1234567890",
        legacy: {
          extended_entities: { media: [{ type: "video", video_info: { variants: [{
            bitrate: 2_176_000,
            content_type: "video/mp4",
            url: "https://video.twimg.com/ext_tw_video/right/pu/vid/1280x720/high.mp4",
          }] } }] },
        },
      },
    },
  }));

  await response.text();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].kind, "site-video-candidate");
  assert.equal(emitted[0].videoUrl, "https://video.twimg.com/ext_tw_video/right/pu/vid/1280x720/high.mp4");
});

test("the MAIN-world probe projects one bounded Pinterest pin catalog with its preview and detail qualities", async () => {
  const { sandbox, emitted } = await loadProbeHarness({
    location: { href: "https://www.pinterest.com/" },
  });
  const response = new sandbox.Response("https://www.pinterest.com/resource/PinResource/get/", {
    resource_response: {
      data: {
        id: "987654321",
        videos: {
          video_list: {
            V_360P: { url: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW", width: 360, height: 416 },
            V_720P: { url: "https://v1.pinimg.com/videos/pin-a_720w.cmfv?token=PRIVATE-HIGH", width: 720, height: 960 },
          },
        },
      },
    },
  });

  await response.json();

  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{
    version: 1,
    kind: "pinterest-video-catalog",
    pinId: "987654321",
    pageUrl: "https://www.pinterest.com/pin/987654321/",
    variants: [
      { url: "https://v1.pinimg.com/videos/pin-a_720w.cmfv?token=PRIVATE-HIGH", width: 720, height: 960 },
      { url: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW", width: 360, height: 416 },
    ],
  }]);
});

test("the MAIN-world probe observes Pinterest catalogs delivered through XMLHttpRequest", async () => {
  const { sandbox, emitted } = await loadProbeHarness({
    location: { href: "https://www.pinterest.com/" },
  });
  const xhr = new sandbox.XMLHttpRequest("https://www.pinterest.com/resource/PinResource/get/", {
    resource_response: {
      data: {
        id: "987654322",
        videos: {
          video_list: {
            V_360P: { url: "https://v1.pinimg.com/videos/pin-b_360w.cmfv", width: 360, height: 416 },
            V_720P: { url: "https://v1.pinimg.com/videos/pin-b_720w.cmfv", width: 720, height: 960 },
          },
        },
      },
    },
  }, "json");

  xhr.send();

  assert.equal(emitted.length, 1, "Pinterest XHR JSON must reach the production catalog projector");
  assert.equal(emitted[0].kind, "pinterest-video-catalog");
  assert.equal(emitted[0].variants[0].height, 960);
});

test("an explicit Pinterest detail request resolves the exact Pin catalog once", async () => {
  const requests = [];
  const payload = {
    resource_response: {
      data: {
        id: "987654323",
        videos: {
          video_list: {
            V_360P: { url: "https://v1.pinimg.com/videos/pin-c_360w.cmfv", width: 360, height: 416 },
            V_720P: { url: "https://v1.pinimg.com/videos/pin-c_720w.cmfv", width: 720, height: 960 },
          },
        },
      },
    },
  };
  const { sandbox, emitted } = await loadProbeHarness({
    location: { href: "https://www.pinterest.com/" },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, url: String(url), json: async () => payload };
    },
  });

  sandbox.document.dispatchEvent(new sandbox.CustomEvent("__luckyray_pinterest_detail_request_v1__", {
    detail: {
      version: 1,
      requestId: "pdetail:fixture-1",
      pinId: "987654323",
      pageUrl: "https://www.pinterest.com/pin/987654323/",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/www\.pinterest\.com\/resource\/PinResource\/get\/\?data=/);
  assert.equal(requests[0].options.credentials, "include");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers["X-Pinterest-PWS-Handler"], "www/[username].js");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].requestId, "pdetail:fixture-1");
  assert.equal(emitted[0].pinId, "987654323");
  assert.equal(emitted[0].variants[0].height, 960);
});

test("the MAIN-world probe binds interleaved response buffers to their exact MediaSource", async () => {
  const { sandbox, emitted } = await loadProbeHarness();
  const firstSource = new sandbox.MediaSource();
  const secondSource = new sandbox.MediaSource();
  const firstBlob = sandbox.URL.createObjectURL(firstSource);
  const secondBlob = sandbox.URL.createObjectURL(secondSource);
  const firstBuffer = firstSource.addSourceBuffer("video/mp4");
  const secondBuffer = secondSource.addSourceBuffer("video/mp4");

  const firstBytes = await new sandbox.Response("https://media.test/first_720w.cmfv", new ArrayBuffer(16)).arrayBuffer();
  const secondBytes = await new sandbox.Response("https://media.test/second_1080w.cmfv", new ArrayBuffer(24)).arrayBuffer();
  secondBuffer.appendBuffer(secondBytes);
  firstBuffer.appendBuffer(firstBytes);

  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [
    {
      version: 1,
      kind: "mse-candidate",
      blobUrl: secondBlob,
      candidateUrl: "https://media.test/second_1080w.cmfv",
      contentType: "video/mp4",
    },
    {
      version: 1,
      kind: "mse-candidate",
      blobUrl: firstBlob,
      candidateUrl: "https://media.test/first_720w.cmfv",
      contentType: "video/mp4",
    },
  ]);
});

test("the MAIN-world probe does not publish unbounded or non-http media hints", async () => {
  const { sandbox, emitted } = await loadProbeHarness();
  const source = new sandbox.MediaSource();
  sandbox.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer("video/mp4");
  const unsafe = await new sandbox.Response("data:video/mp4,PRIVATE", new ArrayBuffer(8)).arrayBuffer();
  const oversized = await new sandbox.Response(`https://media.test/${"a".repeat(5_000)}.mp4`, new ArrayBuffer(8)).arrayBuffer();
  buffer.appendBuffer(unsafe);
  buffer.appendBuffer(oversized);
  buffer.appendBuffer(new ArrayBuffer(8));
  assert.equal(emitted.length, 0);
});

test("the MAIN-world probe preserves the response URL through a Blob conversion", async () => {
  const { sandbox, emitted } = await loadProbeHarness();
  const source = new sandbox.MediaSource();
  const blobUrl = sandbox.URL.createObjectURL(source);
  const sourceBuffer = source.addSourceBuffer("video/mp4");
  const responseBlob = await new sandbox.Response(
    "https://media.test/blob-path_720w.cmfv",
    new ArrayBuffer(32),
  ).blob();
  sourceBuffer.appendBuffer(await responseBlob.arrayBuffer());
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{
    version: 1,
    kind: "mse-candidate",
    blobUrl,
    candidateUrl: "https://media.test/blob-path_720w.cmfv",
    contentType: "video/mp4",
  }]);
});

test("the MAIN-world probe preserves a streamed fetch chunk URL through getReader", async () => {
  const { sandbox, emitted } = await loadProbeHarness();
  const source = new sandbox.MediaSource();
  const blobUrl = sandbox.URL.createObjectURL(source);
  const sourceBuffer = source.addSourceBuffer("video/mp4");
  const response = new sandbox.Response(
    "https://media.test/streamed-videoplayback",
    new ArrayBuffer(48),
  );
  const chunk = (await response.body.getReader().read()).value;
  sourceBuffer.appendBuffer(chunk);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{
    version: 1,
    kind: "mse-candidate",
    blobUrl,
    candidateUrl: "https://media.test/streamed-videoplayback",
    contentType: "video/mp4",
  }]);
});
