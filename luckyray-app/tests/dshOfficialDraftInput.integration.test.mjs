import assert from "node:assert/strict";
import { writeFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import surfaceState from "../src-tauri/dsh-host/luckyray-dsh-native-surface-state/client.js";
import { openSyntheticCarrier } from "./fixtures/dshAuthenticatedSyntheticCarrier.mjs";
import { createOfficialAttachmentHarness } from "./fixtures/dshOfficialAttachmentHarness.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOQAAAABJRU5ErkJggg==", "base64");
const id = number => `intent-${String(number).padStart(8, "0")}-0000-4000-8000-000000000000`;
const resourceRequest = path => path.includes("/_luckyray/open-intent-resource/");
const intentFor = (number, resources, text = "") => ({ intentId: id(number), source: "notes", text, localResources: resources });

async function resource(carrier, name, bytes, delivery = "file-attachment") {
  const path = join(carrier.root, name);
  await writeFile(path, bytes);
  return { kind: "material", assetId: name, canonicalPath: await realpath(path), delivery };
}

async function scenario(run) {
  const c = await openSyntheticCarrier();
  let h, consumer;
  try {
    h = await createOfficialAttachmentHarness({ baseUrl: c.origin });
    const start = (request = c.fetch) => {
      consumer = surfaceState.createOpenIntentConsumer(h.sessions, h.conversation, request, new EventTarget(), h.selectedSession);
      return consumer;
    };
    await run({ c, h, start });
    assert.equal(h.forbiddenCalls.length, 0, "no prompt, submit, or model action occurred");
  } finally {
    consumer?.dispose();
    await h?.dispose();
    await c.dispose();
  }
}

test("official 0.2.1 composer consumes actual authenticated resource bytes without model calls", {
  skip: !process.env.DSH_M1_RUNTIME_ROOT,
}, async t => {
  t.diagnostic("Boundary: real authenticated LuckyRay resource/ACK HTTP and unchanged official Conversation/InputHub/SessionInputShell/Lexical/FileUploadRuntime; upload receipts are synthetic, session/navigation/presentation services are fixtures.");
  await t.test("saved MD/PDF/MP4/PNG retain bytes, names, MIME and session; existing draft survives", async () => scenario(async ({ c, h, start }) => {
    const contents = [Buffer.from("# 中文笔记\n原文🙂\n"), Buffer.from("%PDF-1.7\nsynthetic PDF fixture\n%%EOF"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 255, 1]), PNG];
    const names = ["中文 笔记.md", "资料 原文.pdf", "片段.mp4", "参考图.png"];
    const resources = [];
    for (let i = 0; i < names.length; i++) resources.push(await resource(c, names[i], contents[i], i === 3 ? "image-attachment" : "file-attachment"));
    const session = h.selectedSession.getSnapshot().key;
    h.input.setDraft("existing 用户草稿");
    const existingFile = new File(["prior saved file"], "existing.txt", { type: "application/octet-stream" });
    const existing = h.conversation.createDrafts(session, [existingFile]);
    assert.equal(h.input.addAttachments(existing.map(value => value.id)), true);
    await h.waitForUploads();
    const intent = intentFor(301, resources, "查看这些文件");
    await c.stage(intent);
    const consumer = start();
    await consumer.run();
    await h.waitForUploads();
    const snapshot = h.input.state.getSnapshot();
    assert.equal(snapshot.draft, "existing 用户草稿\n\n查看这些文件");
    assert.equal(snapshot.attachmentIds.length, 5);
    assert.equal(snapshot.attachmentIds[0], existing[0].id);
    const attachments = h.conversation.resolveDraftAttachments(snapshot.attachmentIds);
    assert.equal(attachments[0].file, existingFile);
    assert.deepEqual(attachments.slice(1).map(value => value.kind), ["file", "file", "file", "image"]);
    assert.deepEqual(attachments.slice(1).map(value => value.file.name), names);
    assert.deepEqual(attachments.slice(1).map(value => value.file.type), ["application/octet-stream", "application/octet-stream", "application/octet-stream", "image/png"]);
    for (let i = 0; i < contents.length; i++) {
      assert.ok(attachments[i + 1].file instanceof File);
      assert.deepEqual(Buffer.from(await attachments[i + 1].file.arrayBuffer()), contents[i]);
    }
    assert.equal(h.uploadedFiles.length, 4, "images remain browser drafts; generic files upload on intake");
    for (let i = 0; i < 3; i++) {
      const upload = h.uploadedFiles[i + 1];
      assert.equal(upload.sessionId, session);
      assert.equal(upload.name, names[i]);
      assert.equal(upload.type, "application/octet-stream");
      assert.deepEqual(upload.bytes, contents[i]);
      assert.equal(upload.file, attachments[i + 1].file, "real uploader receives exact draft File object");
    }
    assert.equal(h.inputFor("qualification-session-two").state.getSnapshot().attachmentIds.length, 0);
    assert.equal((await c.owner.intentStatus(intent.intentId)).payload, "applied");
    assert.equal((await c.raw(`/_luckyray/open-intent-resource/${intent.intentId}/0`)).status, 403);
    await consumer.run();
    assert.deepEqual(h.input.state.getSnapshot(), snapshot, "repeat wake cannot duplicate consumed intent");
  }));

  await t.test("lost real ACK response and repeated wake do not duplicate official drafts", async () => scenario(async ({ c, h, start }) => {
    const bytes = Buffer.from("saved markdown\n");
    const intent = intentFor(302, [await resource(c, "retry.md", bytes)]);
    await c.stage(intent);
    let posts = 0;
    const consumer = start(async (path, init = {}) => {
      const response = await c.fetch(path, init);
      if (init.method === "POST") {
        posts++;
        assert.equal(response.status, 204, "actual host consumed ACK before response loss");
        throw new Error("synthetic-lost-ack-response");
      }
      return response;
    });
    await assert.rejects(consumer.run(), /synthetic-lost-ack-response/u);
    await h.waitForUploads();
    const before = h.input.state.getSnapshot();
    assert.equal(before.attachmentIds.length, 1);
    assert.equal((await c.owner.intentStatus(intent.intentId)).payload, "applied");
    await Promise.all([consumer.run(), consumer.run()]);
    assert.deepEqual(h.input.state.getSnapshot().attachmentIds, before.attachmentIds);
    assert.equal(h.uploadedFiles.length, 1);
    assert.deepEqual(h.uploadedFiles[0].bytes, bytes);
    assert.equal(posts, 1);
  }));

  await t.test("session switch during actual resource resolution inserts into neither composer", async () => scenario(async ({ c, h, start }) => {
    const intent = intentFor(303, [await resource(c, "switch.md", Buffer.from("must not move sessions"))]);
    await c.stage(intent);
    h.input.setDraft("first draft");
    const originalSession = h.selectedSession.getSnapshot().key;
    const second = h.inputFor("qualification-session-two");
    second.setDraft("second draft");
    let resourceArrived, releaseResource;
    const arrived = new Promise(resolve => { resourceArrived = resolve; });
    const released = new Promise(resolve => { releaseResource = resolve; });
    let posts = 0;
    const consumer = start(async (path, init = {}) => {
      if (init.method === "POST") posts++;
      const response = await c.fetch(path, init);
      if (resourceRequest(path)) { resourceArrived(); await released; }
      return response;
    });
    const running = consumer.run();
    const rejected = assert.rejects(running, /dsh-open-intent-session-changed/u);
    await arrived;
    h.selectedSession.set({ key: "qualification-session-two" });
    releaseResource();
    await rejected;
    consumer.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.input.state.getSnapshot().draft, "first draft");
    assert.equal(second.state.getSnapshot().draft, "second draft");
    assert.equal(h.input.state.getSnapshot().attachmentIds.length, 0);
    assert.equal(second.state.getSnapshot().attachmentIds.length, 0);
    assert.equal(h.uploadedFiles.length, 0);
    assert.equal(posts, 0);
    assert.notEqual((await c.owner.intentStatus(intent.intentId)).payload, "applied");
    h.selectedSession.set({ key: originalSession });
    await start().run();
    await h.waitForUploads();
    assert.equal(h.input.state.getSnapshot().draft, "first draft");
    assert.equal(h.input.state.getSnapshot().attachmentIds.length, 1);
    assert.equal(second.state.getSnapshot().draft, "second draft");
    assert.equal(second.state.getSnapshot().attachmentIds.length, 0);
    assert.equal(h.uploadedFiles.length, 1);
    assert.deepEqual(h.uploadedFiles[0].bytes, Buffer.from("must not move sessions"));
    assert.equal((await c.owner.intentStatus(intent.intentId)).payload, "applied",
      "returning to the original session recovers the same pending intent, not a new request");
  }));

  for (const invalid of ["missing", "oversize"]) await t.test(`${invalid} resource response is refused with no ACK or draft mutation`, async () => scenario(async ({ c, h, start }) => {
    const saved = await resource(c, `${invalid}.md`, Buffer.from("saved fixture"));
    const intent = intentFor(invalid === "missing" ? 304 : 305, [saved]);
    await c.stage(intent);
    h.input.setDraft("preserve me");
    if (invalid === "missing") await rm(saved.canonicalPath);
    let posts = 0;
    let rejectOversize = invalid === "oversize";
    const consumer = start(async (path, init = {}) => {
      if (init.method === "POST") posts++;
      if (rejectOversize && resourceRequest(path)) return new Response(new Uint8Array(), {
        headers: { "content-type": "application/octet-stream", "content-length": String(200 * 1024 * 1024 + 1) },
      });
      return c.fetch(path, init);
    });
    await assert.rejects(consumer.run(), invalid === "missing" ? /dsh-open-intent-image-read-failed/u : /dsh-open-intent-image-rejected/u);
    assert.equal(h.input.state.getSnapshot().draft, "preserve me");
    assert.equal(h.input.state.getSnapshot().attachmentIds.length, 0);
    assert.equal(h.uploadedFiles.length, 0);
    assert.equal(posts, 0);
    assert.notEqual((await c.owner.intentStatus(intent.intentId)).payload, "applied");
    if (invalid === "missing") await writeFile(saved.canonicalPath, "saved fixture");
    rejectOversize = false;
    await consumer.run();
    await h.waitForUploads();
    assert.equal(posts, 1);
    assert.equal(h.input.state.getSnapshot().draft, "preserve me");
    assert.equal(h.input.state.getSnapshot().attachmentIds.length, 1);
    assert.equal(h.uploadedFiles.length, 1);
    assert.deepEqual(h.uploadedFiles[0].bytes, Buffer.from("saved fixture"));
    assert.equal((await c.owner.intentStatus(intent.intentId)).payload, "applied",
      "repairing the resource recovers the existing pending intent without clearing its receipt");
  }));
});
