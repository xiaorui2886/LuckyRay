import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeAttachmentBatch,
  attachmentResolutionMatches,
  type AttachmentMatch,
} from "../src/core/services/vaultAttachmentResolution.ts";
import { attachmentErrorMessage } from "../src/core/services/vaultAttachmentErrors.ts";

test("all 129 visible cache entries survive one transient failure while successes refresh", () => {
  const match = (key: string): AttachmentMatch => ({
    relativePath: key,
    absolutePath: "C:/fixture/" + key,
    exists: true,
    isFile: true,
    matchKind: "exact",
    version: "old",
  });
  const keys = Array.from({ length: 129 }, (_, i) => String(i));
  const previous = Object.fromEntries(keys.map((key) => [key, [match(key)]]));
  const next = mergeAttachmentBatch(previous, {
    keys,
    entries: keys
      .slice(1)
      .map((key) => [key, [{ ...match(key), version: "new" }]]),
    errors: ["temporarily unavailable"],
  });
  assert.equal(Object.keys(next).length, 129);
  assert.deepEqual(next["0"], previous["0"]);
  assert.equal(next["128"][0].version, "new");
});
test("confirmed native missing clears a prior success, while unread keys are not fabricated", () => {
  const next = mergeAttachmentBatch(
    {
      a: [
        {
          relativePath: "a",
          absolutePath: "C:/a",
          exists: true,
          isFile: true,
          matchKind: "exact",
        },
      ],
    },
    { keys: ["a", "b"], entries: [["a", []]], errors: ["b unavailable"] },
  );
  assert.deepEqual(next.a, []);
  assert.equal(Object.hasOwn(next, "b"), false);
});
test("structured native errors produce actionable text without JSON or internal codes", () => {
  const message = attachmentErrorMessage(
    JSON.stringify({
      code: "knowledge-vault-unavailable",
      message: "Knowledge Vault root identity is unavailable",
    }),
  );
  assert.match(message, /重新检查/);
  assert.doesNotMatch(message, /knowledge-vault|\{"|identity/);
});


test("approved external native result with no relative path uses the existing card match", () => {
  const matches = attachmentResolutionMatches({ status: "resolved", candidates: [], relativePath: null, absolutePath: "C:/outside/image #1.png", fragment: "", version: "v1" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].absolutePath, "C:/outside/image #1.png");
  assert.equal(matches[0].exists, true);
  assert.equal(matches[0].relativePath, "C:/outside/image #1.png");
});
test("unapproved external references never fabricate an accessible card", () => {
  const matches = attachmentResolutionMatches({ status: "external-attachment-not-approved", candidates: [], relativePath: null, absolutePath: null, fragment: "" });
  assert.equal(matches[0].exists, false);
  assert.equal(matches[0].absolutePath, "");
});

test("only a resolved native candidate carries its authorized material identity through the bridge", () => {
  const resolved = { status: "resolved", candidates: [] as string[], relativePath: null, absolutePath: "C:/native/physical.png", fragment: "", version: "native:1", materialAssetId: "catalog-id" };
  assert.equal(attachmentResolutionMatches(resolved)[0].materialAssetId, "catalog-id");
  const relative = attachmentResolutionMatches({ ...resolved, candidates: ["image.png"], relativePath: "image.png" });
  assert.equal(relative[0].materialAssetId, "catalog-id");
  assert.equal(relative[0].version, "native:1");
  const ambiguous = attachmentResolutionMatches({ ...resolved, status: "ambiguous", candidates: ["one.png", "two.png"], absolutePath: null });
  assert.ok(ambiguous.every((match) => match.materialAssetId === null));
  const unbound = attachmentResolutionMatches({ ...resolved, materialAssetId: null });
  assert.equal(unbound[0].materialAssetId, null);
  const merged = mergeAttachmentBatch({}, { keys: ["image"], entries: [["image", relative]], errors: [] });
  assert.equal(merged.image[0].materialAssetId, "catalog-id");
});

import { attachmentAccessMessage } from "../src/core/services/vaultAttachmentErrors.ts";
import { attachmentIssueLabel } from "../src/core/services/vaultAttachmentWorkflow.ts";
test("unregistered external attachment explains reconnection in both locales without exposing a code", () => {
  assert.equal(attachmentAccessMessage("external-unregistered", "zh-CN"), "外部文件尚未连接，请重新选择原文件");
  assert.equal(attachmentAccessMessage("external-unregistered", "en-US"), "External file is not connected. Select the original file again.");
  assert.equal(attachmentAccessMessage("external-attachment-not-approved", "zh-CN"), attachmentAccessMessage("external-unregistered", "zh-CN"));
  assert.equal(attachmentErrorMessage({code:"external-unregistered",message:"unregistered"},"en-US"), attachmentAccessMessage("external-unregistered","en-US"));
  assert.equal(attachmentIssueLabel("external-unregistered"), attachmentAccessMessage("external-unregistered","zh-CN"));
  assert.equal(attachmentAccessMessage("unrelated-status", "en-US"), null);
});
