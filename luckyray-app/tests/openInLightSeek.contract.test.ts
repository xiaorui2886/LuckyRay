import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createOpenInLightSeekCoordinator } from "../src/core/services/openInLightSeek.ts";

test("OpenInLightSeek keeps one bounded pending draft intent and never silently overwrites it", async () => {
  const routes: string[] = [];
  let index = 0;
  const coordinator = createOpenInLightSeekCoordinator({
    navigate: () => routes.push("ai"),
    createId: () => `intent-0000000${++index}-0000-4000-8000-000000000000`,
  });
  let notifications = 0;
  const unsubscribe = coordinator.subscribe(() => { notifications += 1; });
  const first = coordinator.stage({ source: "notes", text: "  请整理这段笔记  " });
  assert.equal(first.text, "请整理这段笔记");
  assert.equal(coordinator.peek(), first);
  assert.throws(() => coordinator.stage({ source: "search", text: "解释搜索结果" }), /lightseek-open-intent-busy/u);
  const delivered = coordinator.wait(first.intentId);
  assert.equal(coordinator.complete(first.intentId), true);
  await delivered;
  const latest = coordinator.stage({ source: "search", text: "解释搜索结果" });
  assert.equal(coordinator.peek(), latest);
  assert.equal(coordinator.complete(first.intentId), false, "a stale delivery cannot clear the latest intent");
  assert.equal(coordinator.complete(latest.intentId), true);
  assert.equal(coordinator.peek(), null);
  assert.deepEqual(routes, ["ai", "ai"]);
  assert.equal(notifications, 2);
  unsubscribe();
});

test("OpenInLightSeek rejects unknown sources and controls, while marking an oversized summary as truncated", () => {
  let navigations = 0;
  const coordinator = createOpenInLightSeekCoordinator({
    navigate: () => { navigations += 1; },
    createId: () => "intent-00000001-0000-4000-8000-000000000000",
  });
  for (const request of [
    { source: "unknown", text: "valid" },
    { source: "notes", text: "" },
    { source: "notes", text: "bad\u0000text" },
  ]) {
    assert.throws(
      () => coordinator.stage(request as Parameters<typeof coordinator.stage>[0]),
      /lightseek-open-intent-invalid/u,
    );
  }
  const bounded = coordinator.stage({ source: "notes", text: "你".repeat(8_000) });
  assert.match(bounded.text, /内容已截断/u);
  assert.ok(new TextEncoder().encode(bounded.text).byteLength <= 12 * 1024);
  assert.equal(navigations, 1);
  coordinator.complete(bounded.intentId);
  const redacted = coordinator.stage({
    source: "materials",
    text: "请处理 C:\\Users\\Example User\\Vault\\secret.md\n并参考 file:///D:/private/item.png 和 /data/private/note.md",
  });
  assert.equal(redacted.text.includes("C:\\"), false);
  assert.equal(redacted.text.includes("file:///"), false);
  assert.equal(redacted.text.includes("/data/private"), false);
  assert.match(redacted.text, /本地路径已省略/u);
});

test("OpenInLightSeek preserves only app-owned typed material paths", () => {
  const coordinator = createOpenInLightSeekCoordinator({
    navigate: () => undefined,
    createId: () => "intent-00000001-0000-4000-8000-000000000000",
  });
  const canonicalPath = "C:\\素材 空间\\图像 #1 (终稿)`版`.png";
  const intent = coordinator.stage({
    source: "materials",
    text: "请分析以下本地素材。",
    localResources: [{ kind: "material", assetId: "asset-one", canonicalPath, delivery: "path-reference" }],
  });
  assert.deepEqual(intent.localResources, [
    { kind: "material", assetId: "asset-one", canonicalPath, delivery: "path-reference" },
  ]);

  coordinator.complete(intent.intentId);

  const untrusted = coordinator.stage({
    source: "notes",
    text: "请读取 C:\\Users\\Example\\private.png",
  });
  assert.deepEqual(untrusted.localResources, []);
  assert.equal(untrusted.text.includes("C:\\"), false);
  coordinator.complete(untrusted.intentId);
  assert.throws(
    () => coordinator.stage({
      source: "graph",
      text: "请分析素材。",
      localResources: [{ kind: "material", assetId: "asset-two", canonicalPath, delivery: "path-reference" }],
    }),
    /lightseek-open-intent-invalid/u,
  );
});

test("OpenInLightSeek distinguishes official image attachments from path-only resources", () => {
  const coordinator = createOpenInLightSeekCoordinator({
    navigate: () => undefined,
    createId: () => "intent-00000003-0000-4000-8000-000000000000",
  });
  const noteIntent = coordinator.stage({
    source: "notes",
    text: "",
    localResources: [{
      kind: "material",
      assetId: "asset-image",
      canonicalPath: "C:\\Library\\reference.png",
      delivery: "image-attachment",
    }],
  });
  assert.equal(noteIntent.localResources[0]?.delivery, "image-attachment");
  assert.equal(noteIntent.text, "");
  coordinator.complete(noteIntent.intentId);
  const pathOnly = coordinator.stage({
    source: "notes",
    text: "",
    localResources: [{
      kind: "material",
      assetId: "note-one",
      canonicalPath: "C:\\Vault\\ordered.md",
      delivery: "path-reference",
    }],
  });
  assert.equal(pathOnly.text, "");
  assert.equal(pathOnly.localResources[0]?.canonicalPath, "C:\\Vault\\ordered.md");
  coordinator.complete(pathOnly.intentId);
  assert.throws(
    () => coordinator.stage({
      source: "collection",
      text: "请整理这个收集项。",
      localResources: [{
        kind: "material",
        assetId: "asset-image",
        canonicalPath: "C:\\Library\\reference.png",
        delivery: "image-attachment",
      }],
    }),
    /lightseek-open-intent-invalid/u,
  );
});

test("a failed delivery rejects its waiting producer and leaves the next action available", async () => {
  let index = 0;
  const coordinator = createOpenInLightSeekCoordinator({
    navigate: () => undefined,
    createId: () => `intent-0000000${++index}-0000-4000-8000-000000000000`,
  });
  const first = coordinator.stage({ source: "notes", text: "合成内容" });
  const waiting = coordinator.wait(first.intentId);
  assert.equal(coordinator.fail(first.intentId), true);
  await assert.rejects(waiting, /lightseek-open-intent-not-delivered/u);
  const second = coordinator.stage({ source: "notes", text: "另一份合成内容" });
  assert.notEqual(second.intentId, first.intentId);
});

test("an uncertain retry keeps its intent identity but a new action after success does not", () => {
  let index = 0;
  const coordinator = createOpenInLightSeekCoordinator({
    navigate: () => undefined,
    createId: () => `intent-0000000${++index}-0000-4000-8000-000000000000`,
  });
  const request = { source: "notes" as const, text: "同一笔记引用" };
  const first = coordinator.stage(request);
  assert.equal(coordinator.fail(first.intentId), true);
  const retry = coordinator.stage(request);
  assert.equal(retry.intentId, first.intentId, "an ambiguous ACK cannot allocate a duplicate identity");
  assert.equal(retry.recoveryOnly, true, "an uncertain retry may only query the prior receipt");
  coordinator.complete(retry.intentId);
  const later = coordinator.stage(request);
  assert.notEqual(later.intentId, first.intentId, "a separate deliberate action is allowed after success");
  assert.equal(later.recoveryOnly, false);
});

test("a proven pre-admission refusal lets the same producer retry normally", async () => {
  let index = 0;
  const coordinator = createOpenInLightSeekCoordinator({
    navigate: () => undefined,
    createId: () => `intent-0000000${++index}-0000-4000-8000-000000000000`,
  });
  const request = { source: "materials" as const, text: "同一素材" };
  const first = coordinator.stage(request);
  const waiting = coordinator.wait(first.intentId);
  assert.equal(coordinator.fail(first.intentId, "not-staged"), true);
  await assert.rejects(waiting, /lightseek-open-intent-not-delivered/u);
  const retry = coordinator.stage(request);
  assert.notEqual(retry.intentId, first.intentId);
  assert.equal(retry.recoveryOnly, false);
});

test("an explicitly verified new action can retire an uncertain receipt guard", () => {
  let index = 0;
  const coordinator = createOpenInLightSeekCoordinator({
    navigate: () => undefined,
    createId: () => `intent-0000000${++index}-0000-4000-8000-000000000000`,
  });
  const request = { source: "notes" as const, text: "同一笔记引用" };
  const first = coordinator.stage(request);
  coordinator.fail(first.intentId);
  assert.equal(coordinator.uncertainIntentId(), first.intentId);
  assert.equal(coordinator.allowNewActionAfterReview("intent-other"), false);
  assert.equal(coordinator.allowNewActionAfterReview(first.intentId), true);
  assert.equal(coordinator.uncertainIntentId(), null);
  const next = coordinator.stage(request);
  assert.notEqual(next.intentId, first.intentId);
  assert.equal(next.recoveryOnly, false);
});

test("all active producers use the single draft-only handoff and retire legacy prefill state", async () => {
  const sources = await Promise.all([
    "../src/features/materials/MaterialsPage.tsx",
    "../src/features/notes/NotesPage.tsx",
    "../src/features/collection/CollectionPage.tsx",
    "../src/features/graph/GraphPage.tsx",
    "../src/features/search/SearchOverlay.tsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.match(source, /openInLightSeek/u);
    assert.doesNotMatch(source, /luckyray:ai-prefill|luckyray:ai-add-asset|luckyray:ai-note-context/u);
  }
  const combined = sources.join("\n");
  assert.match(combined, /发送到 LightSeek/u);
  assert.match(sources[0], /resolveMaterialLightSeekAttachments/u);
  assert.match(sources[2], /resolveLegacyMaterialLightSeekResources/u);
  assert.match(combined, /已将素材路径填入 LightSeek（不是图片附件）/u);
  assert.doesNotMatch(combined, /请分析这个素材：\$\{asset\.name\}|manualAttachment/u);
  const handoffSource = await readFile(new URL("../src/core/services/openInLightSeek.ts", import.meta.url), "utf8");
  assert.doesNotMatch(handoffSource, /sessionStorage|localStorage/u);
  assert.doesNotMatch(combined, /conversation\.send|\.submit\(/u);
});
