import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import surfaceState from "../src-tauri/dsh-host/luckyray-dsh-native-surface-state/client.js";
import {
  createOpenIntentSlot,
  resolveOpenIntentImageResource,
} from "../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs";

function normalizedSha256(value) {
  return createHash("sha256").update(value.replaceAll("\r\n", "\n")).digest("hex");
}

test("the Rust runtime seal matches both image-intent host assets", async () => {
  const rust = await readFile(new URL("../src-tauri/src/dsh_host.rs", import.meta.url), "utf8");
  const webserver = await readFile(
    new URL("../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs", import.meta.url),
    "utf8",
  );
  const client = await readFile(
    new URL("../src-tauri/dsh-host/luckyray-dsh-native-surface-state/client.js", import.meta.url),
    "utf8",
  );
  assert.match(rust, new RegExp(`const SURFACE_PLUGIN_SHA256:[\\s\\S]+?"${normalizedSha256(webserver)}";`, "u"));
  assert.match(rust, new RegExp(`const SURFACE_STATE_CLIENT_SHA256:[\\s\\S]+?"${normalizedSha256(client)}";`, "u"));
});

const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
});

function sessionHarness({ imageLimitsReady = true } = {}) {
  const writes = [];
  const attachmentIds = [];
  const projectionListeners = new Set();
  let imageLimits = imageLimitsReady ? IMAGE_LIMITS : undefined;
  let draft = "";
  const input = {
    state: {
      getSnapshot: () => ({ draft, attachmentIds: [...attachmentIds], phase: "plain" }),
    },
    setDraft: (value) => { draft = value; writes.push(value); },
    addAttachments: (ids) => {
      attachmentIds.push(...ids);
      return true;
    },
    removeAttachment: (id) => {
      const index = attachmentIds.indexOf(id);
      if (index >= 0) attachmentIds.splice(index, 1);
    },
  };
  const session = {
    projections: {
      faceOf: (key) => ({
        getSnapshot: () => key === "imageLimits" ? imageLimits : undefined,
        subscribe: (listener) => {
          if (key !== "imageLimits") return () => undefined;
          projectionListeners.add(listener);
          return () => projectionListeners.delete(listener);
        },
      }),
    },
  };
  const harness = {
    writes,
    attachmentIds,
    input,
    currentSessionKey: "session-one",
    publishImageLimits() {
      imageLimits = IMAGE_LIMITS;
      for (const listener of projectionListeners) listener();
    },
    sessions: {
      list: {
        getSnapshot: () => ({ phase: "ready", byId: { "session-one": {}, "session-two": {} } }),
        subscribe: () => () => undefined,
      },
      scope: () => ({}),
      binding: () => ({ session }),
    },
  };
  harness.selectedSession = {
    getSnapshot: () => ({ key: harness.currentSessionKey }),
    subscribe: (listener) => harness.sessions.list.subscribe(listener),
  };
  return harness;
}

test("an uncommitted official composer write is not acknowledged as delivered", async () => {
  const harness = sessionHarness();
  harness.input.setDraft = () => undefined;
  let posts = 0;
  const intent = {
    intentId: "intent-00000006-0000-4000-8000-000000000000",
    localResources: [], source: "notes", text: "合成笔记正文",
  };
  const request = async (_path, init = {}) => {
    if (init.method === "POST") { posts += 1; return new Response(null, { status: 204 }); }
    return Response.json(intent);
  };
  const conversation = { input: { for: () => harness.input }, createDrafts: () => [],
    resolveDraftAttachments: () => [], releaseDraftAttachments: () => undefined };
  const consumer = surfaceState.createOpenIntentConsumer(harness.sessions, conversation, request, new EventTarget(), harness.selectedSession);
  try {
    await assert.rejects(() => consumer.run(), /dsh-open-intent-draft-not-applied/u);
    assert.equal(posts, 0);
  } finally { consumer.dispose(); }
});

test("lost outer result after real composer ACK cannot append the same intent twice", async () => {
  const harness = sessionHarness();
  const slot = createOpenIntentSlot();
  const intent = {
    intentId: "intent-00000009-0000-4000-8000-000000000000",
    localResources: [], source: "notes", text: "合成笔记引用",
  };
  const encoded = Buffer.from(JSON.stringify(intent), "utf8").toString("base64url");
  slot.bind(13);
  slot.stage(13, encoded);
  let acknowledgements = 0;
  const request = async (_path, init = {}) => {
    if (init.method === "POST") {
      acknowledgements += 1;
      const body = JSON.parse(init.body);
      return new Response(null, { status: slot.acknowledge(13, body.intentId) ? 204 : 409 });
    }
    return slot.read(13) ? Response.json(slot.read(13)) : new Response(null, { status: 204 });
  };
  const conversation = { input: { for: () => harness.input }, createDrafts: () => [],
    resolveDraftAttachments: () => [], releaseDraftAttachments: () => undefined };
  const consumer = surfaceState.createOpenIntentConsumer(harness.sessions, conversation, request, new EventTarget(), harness.selectedSession);
  try {
    await consumer.run();
    assert.equal(slot.status(13, intent.intentId), "applied");
    assert.deepEqual(harness.writes, ["合成笔记引用"]);
    // The outer status result is deliberately withheld. Its retry carries
    // the same identity and payload, as the production coordinator does.
    slot.stage(13, encoded);
    await consumer.run();
    assert.deepEqual(harness.writes, ["合成笔记引用"]);
    assert.equal(acknowledgements, 1);
    assert.equal(slot.status(13, intent.intentId), "applied");
  } finally { consumer.dispose(); }
});

test("a session switch during image resolution cannot write the old intent into the new composer", async () => {
  const harness = sessionHarness();
  let releaseImage;
  let posts = 0;
  const intent = {
    intentId: "intent-00000007-0000-4000-8000-000000000000",
    localResources: [{ kind: "material", assetId: "a", canonicalPath: "C:\\Library\\a.png", delivery: "image-attachment" }],
    source: "materials", text: "",
  };
  const request = async (path, init = {}) => {
    if (path.includes("open-intent-resource")) {
      await new Promise((resolve) => { releaseImage = resolve; });
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200,
        headers: { "content-type": "image/png", "content-length": "4" } });
    }
    if (init.method === "POST") { posts += 1; return new Response(null, { status: 204 }); }
    return Response.json(intent);
  };
  const released = [];
  const conversation = { input: { for: () => harness.input },
    createDrafts: (_id, files) => [{ id: "late-image", kind: "image", file: files[0] }],
    resolveDraftAttachments: () => [],
    releaseDraftAttachments: (items) => released.push(...items.map((item) => item.id)) };
  const consumer = surfaceState.createOpenIntentConsumer(harness.sessions, conversation, request, new EventTarget(), harness.selectedSession);
  try {
    while (!releaseImage) await new Promise((resolve) => setTimeout(resolve, 0));
    harness.currentSessionKey = "session-two";
    releaseImage();
    await consumer.run().catch(() => undefined);
    assert.deepEqual(harness.attachmentIds, []);
    assert.deepEqual(harness.writes, []);
    assert.equal(posts, 0);
    assert.deepEqual(released, [], "the stale image was rejected before draft allocation");
    await assert.rejects(() => consumer.run(), /dsh-open-intent-session-changed/u);
    assert.deepEqual(harness.writes, [], "a later poll cannot replay that intent into the new session");
  } finally { consumer.dispose(); }
});

test("an image handoff retries when rc.2 publishes imageLimits after the session becomes current", async () => {
  const harness = sessionHarness({ imageLimitsReady: false });
  const intent = {
    intentId: "intent-00000004-0000-4000-8000-000000000000",
    localResources: [{
      kind: "material",
      assetId: "asset-image",
      canonicalPath: "C:\\Library\\late.png",
      delivery: "image-attachment",
    }],
    source: "materials",
    text: "",
  };
  let acknowledge;
  const acknowledged = new Promise((resolve) => { acknowledge = resolve; });
  const request = async (path, init = {}) => {
    if (path.includes("/_luckyray/open-intent-resource/")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "4" },
      });
    }
    if ((init.method || "GET") === "POST") {
      acknowledge();
      return new Response(null, { status: 204 });
    }
    return Response.json(intent);
  };
  const conversation = {
    input: { for: () => harness.input },
    createDrafts: (sessionId, files) => [{ id: "draft-image-late", kind: "image", file: files[0] }],
    resolveDraftAttachments: () => [],
    releaseDraftAttachments: () => assert.fail("a retried attachment must remain in the draft"),
  };
  const consumer = surfaceState.createOpenIntentConsumer(
    harness.sessions,
    conversation,
    request,
    new EventTarget(),
    harness.selectedSession,
  );
  try {
    await consumer.run().catch(() => undefined);
    harness.publishImageLimits();
    await Promise.race([
      acknowledged,
      new Promise((_, reject) => setTimeout(() => reject(new Error("late image limits did not wake the handoff")), 500)),
    ]);
    assert.deepEqual(harness.attachmentIds, ["draft-image-late"]);
    assert.deepEqual(harness.writes, [""]);
  } finally {
    consumer.dispose();
  }
});

test("a new open intent is discovered after the persistent LightSeek surface has already gone idle", async () => {
  const harness = sessionHarness();
  const intent = {
    intentId: "intent-00000005-0000-4000-8000-000000000000",
    localResources: [],
    source: "notes",
    text: "稍后到达的笔记内容。",
  };
  let staged = false;
  let acknowledged = false;
  const request = async (_path, init = {}) => {
    if ((init.method || "GET") === "POST") {
      acknowledged = true;
      return new Response(null, { status: 204 });
    }
    if (!staged || acknowledged) return new Response(null, { status: 204 });
    return Response.json(intent);
  };
  const conversation = {
    input: { for: () => harness.input },
    createDrafts: () => [],
    resolveDraftAttachments: () => [],
    releaseDraftAttachments: () => undefined,
  };
  const consumer = surfaceState.createOpenIntentConsumer(
    harness.sessions,
    conversation,
    request,
    new EventTarget(),
    harness.selectedSession,
  );
  try {
    await consumer.run();
    staged = true;
    await new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (!acknowledged) return;
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }, 20);
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error("idle surface did not discover the new intent"));
      }, 800);
    });
    assert.deepEqual(harness.writes, ["稍后到达的笔记内容。"]);
  } finally {
    consumer.dispose();
  }
});

test("image attachments and path-only files reach the draft without generated prompt text", async () => {
  const harness = sessionHarness();
  const calls = [];
  const intent = {
    intentId: "intent-00000001-0000-4000-8000-000000000000",
    localResources: [
      {
        kind: "material",
        assetId: "asset-image",
        canonicalPath: "C:\\Library\\参考图.png",
        delivery: "image-attachment",
      },
      {
        kind: "material",
        assetId: "asset-video",
        canonicalPath: "C:\\Library\\参考视频.mp4",
        delivery: "path-reference",
      },
    ],
    source: "materials",
    text: "",
  };
  let acknowledged = false;
  const request = async (path, init = {}) => {
    calls.push([path, init.method || "GET"]);
    if (path === "/_luckyray/open-intent") {
      if ((init.method || "GET") === "POST") {
        acknowledged = true;
        return new Response(null, { status: 204 });
      }
      if (acknowledged) return new Response(null, { status: 204 });
      return Response.json(intent);
    }
    if (path.includes("/_luckyray/open-intent-resource/")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "4" },
      });
    }
    return new Response(null, { status: 404 });
  };
  const conversation = {
    input: { for: () => harness.input },
    createDrafts(sessionId, files) {
      assert.equal(files.length, 1);
      assert.equal(files[0].name, "参考图.png");
      assert.equal(files[0].type, "image/png");
      return [{ id: "draft-image-one", kind: "image", file: files[0] }];
    },
    resolveDraftAttachments: () => [],
    releaseDraftAttachments: () => assert.fail("accepted attachments must stay owned by the official draft"),
  };
  const consumer = surfaceState.createOpenIntentConsumer(
    harness.sessions,
    conversation,
    request,
    new EventTarget(),
    harness.selectedSession,
  );
  try {
    await consumer.run();
    assert.deepEqual(harness.attachmentIds, ["draft-image-one"]);
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0], "C:\\Library\\参考视频.mp4");
    assert.equal(harness.writes[0].includes("参考图.png"), false);
    assert.equal(harness.writes[0].includes("本地素材路径"), false);
    assert.deepEqual(calls.slice(0, 3).map(([path, method]) => method), ["GET", "GET", "POST"]);
  } finally {
    consumer.dispose();
  }
});

test("the authenticated carrier exposes only the staged image resource and revokes it on acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-lightseek-image-"));
  try {
    const imagePath = join(await realpath(root), "reference.png");
    await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
    const canonicalPath = await realpath(imagePath);
    const intent = {
      intentId: "intent-00000002-0000-4000-8000-000000000000",
      localResources: [{
        kind: "material",
        assetId: "asset-image",
        canonicalPath,
        delivery: "image-attachment",
      }],
      source: "materials",
      text: "",
    };
    const slot = createOpenIntentSlot();
    slot.bind(7);
    slot.stage(7, Buffer.from(JSON.stringify(intent), "utf8").toString("base64url"));

    const resource = resolveOpenIntentImageResource(slot, 7, intent.intentId, 0);
    assert.equal(resource.canonicalPath, canonicalPath);
    assert.equal(resource.mediaType, "image/png");
    assert.equal(resource.bytes, 4);
    assert.equal(slot.acknowledge(7, intent.intentId), true);
    assert.throws(
      () => resolveOpenIntentImageResource(slot, 7, intent.intentId, 0),
      /dsh-open-intent-image-unavailable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the authenticated carrier accepts Rust's Windows verbatim spelling of a canonical image", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-lightseek-verbatim-image-"));
  try {
    const imagePath = join(await realpath(root), "reference.png");
    await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
    const canonicalPath = await realpath(imagePath);
    const verbatimPath = canonicalPath.startsWith("\\\\?\\")
      ? canonicalPath
      : `\\\\?\\${canonicalPath}`;
    const intent = {
      intentId: "intent-00000004-0000-4000-8000-000000000000",
      localResources: [{
        kind: "material",
        assetId: "asset-verbatim-image",
        canonicalPath: verbatimPath,
        delivery: "image-attachment",
      }],
      source: "materials",
      text: "",
    };
    const slot = createOpenIntentSlot();
    slot.bind(9);
    slot.stage(9, Buffer.from(JSON.stringify(intent), "utf8").toString("base64url"));

    const resource = resolveOpenIntentImageResource(slot, 9, intent.intentId, 0);
    assert.equal(resource.canonicalPath, canonicalPath);
    assert.equal(resource.mediaType, "image/png");
    assert.equal(resource.bytes, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused official image admission restores the prior draft and releases the temporary attachment", async () => {
  const harness = sessionHarness();
  let draft = "原有草稿";
  const removed = [];
  harness.input.state.getSnapshot = () => ({ draft, attachmentIds: [], phase: "plain" });
  harness.input.setDraft = (value) => { draft = value; };
  harness.input.addAttachments = () => false;
  harness.input.removeAttachment = (id) => removed.push(id);
  const released = [];
  const intent = {
    intentId: "intent-00000003-0000-4000-8000-000000000000",
    localResources: [{
      kind: "material",
      assetId: "asset-image",
      canonicalPath: "C:\\Library\\reference.png",
      delivery: "image-attachment",
    }],
    source: "materials",
    text: "",
  };
  const request = async (path, init = {}) => {
    if (path.includes("/_luckyray/open-intent-resource/")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "4" },
      });
    }
    if ((init.method || "GET") === "POST") assert.fail("a refused attachment must not acknowledge the intent");
    return Response.json(intent);
  };
  const conversation = {
    input: { for: () => harness.input },
    createDrafts: (sessionId, files) => [{ id: "draft-image-refused", kind: "image", file: files[0] }],
    resolveDraftAttachments: () => [],
    releaseDraftAttachments: (attachments) => released.push(...attachments.map((attachment) => attachment.id)),
  };
  const consumer = surfaceState.createOpenIntentConsumer(
    harness.sessions,
    conversation,
    request,
    new EventTarget(),
    harness.selectedSession,
  );
  try {
    await assert.rejects(() => consumer.run(), /dsh-open-intent-image-add-failed/u);
    assert.equal(draft, "原有草稿");
    assert.deepEqual(removed, ["draft-image-refused"]);
    assert.deepEqual(released, ["draft-image-refused"]);
  } finally {
    consumer.dispose();
  }
});
