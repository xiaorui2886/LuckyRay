import assert from "node:assert/strict";
import test from "node:test";
import { attachmentPresentationVersion, refreshRecentAttachmentVersions } from "../src/core/markdown/realVaultEmbeds.ts";
import type { VaultFileChangeBatch } from "../src/core/services/vaultFileChanges.ts";
const batch: VaultFileChangeBatch = {
  vaultId: "A",
  rootPath: "C:\\Vault",
  session: 1,
  generation: 2,
  reconcileRequired: false,
  observations: [{ type: "modify", paths: ["\\\\?\\C:\\Vault\\a.png"] }],
};
test('inactive recent resolutions remember a content change without replacing unrelated entries',()=>{
  const old={active:[{relativePath:'b.png',version:'same'}],inactive:[{relativePath:'a.png',version:'same'}]};
  const next=refreshRecentAttachmentVersions(old,batch);
  assert.equal(next.inactive[0].version,'same~watch:1:2');
  assert.equal(next.active[0],old.active[0]);
  assert.equal(refreshRecentAttachmentVersions(next,{...batch,generation:3,observations:[{type:'modify',paths:['n.md']}]}),next);
});
test("same-path content update gets a new URL even when the native timestamp stays unchanged", () => {
  assert.equal(
    attachmentPresentationVersion("same", "same", "a.png", batch),
    "same~watch:1:2",
  );
  assert.equal(
    attachmentPresentationVersion("same", "same", "b.png", batch),
    "same",
  );
});
test("unrelated later events and self-written Markdown preserve the refreshed URL", () => {
  assert.equal(
    attachmentPresentationVersion("same", "same~watch:1:2", "a.png", {
      ...batch,
      generation: 3,
      observations: [{ type: "modify", paths: ["C:/Vault/n.md"] }],
    }),
    "same~watch:1:2",
  );
  assert.equal(
    attachmentPresentationVersion("changed", "same~watch:1:2", "a.png", {
      ...batch,
      observations: [],
    }),
    "changed",
  );
});
test("a neighboring Vault prefix is not a child; incomplete batches refresh visible media conservatively", () => {
  assert.equal(
    attachmentPresentationVersion("same", "same", "a.png", {
      ...batch,
      observations: [{ type: "modify", paths: ["C:/Vault-other/a.png"] }],
    }),
    "same",
  );
  assert.equal(
    attachmentPresentationVersion("same", "same", "a.png", {
      ...batch,
      reconcileRequired: true,
    }),
    "same~watch:1:2",
  );
});
