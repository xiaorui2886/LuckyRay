import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupLinuxSyntheticChildren } from "./fixtures/dshLinuxSyntheticCleanup.mjs";
import { createDshHostProtocol, createNativeSurfaceOwner, signCanonicalHostFrame } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

// Portable real official runtime smoke. This exercises the actual private fd5/6
// carrier channel; it does not certify Win32 process jobs, Tauri or WebView2.
// Only status and intentionally invalid cancel are submitted: no model turn.
test("official carrier handles canvas status and isolated error on the existing authenticated host", {
  skip: process.env.DSH_M1_RUNTIME_ROOT ? false : "requires official DSH runtime fixture",
  timeout: 90_000,
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "luckyray-canvas-carrier-"));
  const children = [], frames = [];
  let owner;
  try {
    for (const name of ["dsh-authenticated-webserver", "dsh-resource-tools", "dsh-native-surface-state", "dsh-lightseek-ui"]) {
      const target = join(stateRoot, "profiles", "node_modules", "@luckyray", name);
      await mkdir(target, {recursive: true});
      await cp(new URL(`../src-tauri/dsh-host/luckyray-${name}/`, import.meta.url), target, {recursive: true});
    }
    const surfacePatch = join(stateRoot, "luckyray-dsh-native-surface.generated.patch.yml");
    await writeFile(surfacePatch, await readFile(new URL("../src-tauri/dsh-host/luckyray-dsh-native-surface.patch.yml", import.meta.url)));
    owner = createNativeSurfaceOwner({runtimeRoot: process.env.DSH_M1_RUNTIME_ROOT, stateRoot,
      surfaceHome: stateRoot, surfacePatch, onChildStarted: child => children.push(child)});
    const ready = await owner.open();
    assert.equal(ready.stage, "surface-ready", JSON.stringify(ready));
    assert.equal(children.length, 1);
    const host = createDshHostProtocol({writeFrame: frame => frames.push(frame), nativeSurface: owner});
    const challenge = "d".repeat(64);
    await host.accept(JSON.stringify({type: "bootstrap", protocol: 1, generation: 1, challenge}));
    const dispatch = async (seq, request) => {
      const frame = {type: "canvas-agent", protocol: 1, generation: 1, seq, requestId: `canvas-${seq}`,
        payload: Buffer.from(JSON.stringify(request)).toString("base64url")};
      await host.accept(JSON.stringify({...frame, mac: signCanonicalHostFrame(challenge, "parent", frame)}));
      return frames.at(-1);
    };
    const first = await dispatch(1, {op: "status", canvasId: "canvas-wire-smoke"});
    assert.equal(first.outcome, "accepted");
    const snapshot = JSON.parse(Buffer.from(first.payload, "base64url").toString("utf8"));
    assert.equal(snapshot.canvasId, "canvas-wire-smoke");
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.sessionId, null);
    const invalid = await dispatch(2, {op: "cancel", canvasId: "canvas-wire-smoke", runId: "nonexistent-run"});
    assert.equal(invalid.outcome, "rejected");
    assert.equal(invalid.reason, "canvas-agent-run-conflict");
    const second = await dispatch(3, {op: "status", canvasId: "canvas-wire-smoke"});
    assert.equal(second.outcome, "accepted");
    assert.deepEqual(JSON.parse(Buffer.from(second.payload, "base64url").toString("utf8")), snapshot);
    const models = await dispatch(4, {op:"models",canvasId:"canvas-wire-smoke"});
    assert.equal(models.outcome,"accepted",JSON.stringify(models));
    const catalog=JSON.parse(Buffer.from(models.payload,"base64url").toString("utf8"));
    assert.ok(Array.isArray(catalog.models.available));assert.equal(catalog.sessionId,null);
    const rotation = { op: "newConversation", canvasId: "canvas-wire-smoke", requestId: "wire-rotation", expectedConversationId: snapshot.conversationId };
    const rotated = await dispatch(5, rotation); assert.equal(rotated.outcome, "accepted", JSON.stringify(rotated));
    const fresh = JSON.parse(Buffer.from(rotated.payload, "base64url").toString("utf8"));
    assert.notEqual(fresh.conversationId, snapshot.conversationId); assert.equal(fresh.sessionId, null); assert.equal(fresh.status, "idle");
    const retried = await dispatch(6, rotation); assert.equal(retried.outcome, "accepted");
    assert.deepEqual(JSON.parse(Buffer.from(retried.payload, "base64url").toString("utf8")), fresh);
    assert.equal(children.length, 1, "no second official carrier is created by canvas requests");
    await owner.close();
  } finally {
    await owner?.shutdown();
    await cleanupLinuxSyntheticChildren(children);
    await rm(stateRoot, {recursive: true, force: true});
  }
});
