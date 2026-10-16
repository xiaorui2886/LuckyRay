import test from "node:test";
import assert from "node:assert/strict";
import {
  createAttachmentRelinkController,
  registerAttachmentDraftSession,
} from "../src/core/services/vaultAttachmentSessions.ts";
const plan = {
  files: [{ relativePath: "a.md" }],
  issues: [],
  documentCount: 1,
} as any;
function fixture() {
  const calls: string[] = [];
  const source = {};
  let current: object = source;
  let dirty = false;
  const dispose = registerAttachmentDraftSession({
    vaultId: "v",
    source,
    save: async () => {
      calls.push("save");
    },
    dirty: () => dirty,
    refresh: async () => {
      calls.push("refresh");
    },
  });
  const controller = createAttachmentRelinkController(
    {
      vaultId: "v",
      source,
      assetId: "a",
      newPath: "C:/new.png",
      paths: ["a.md"],
      otherVaultCount: 1,
    },
    {
      current: () => current,
      capture: async () => {
        calls.push("capture");
        return 1;
      },
      preview: async () => {
        calls.push("preview");
        return plan;
      },
      execute: async () => {
        calls.push("execute");
        return { status: "complete" } as any;
      },
    },
  );
  return {
    calls,
    controller,
    dispose,
    switch: () => {
      current = {};
    },
    dirty: () => {
      dirty = true;
    },
  };
}
test("relink saves drafts before preview, waits for review, then refreshes only after execution", async () => {
  const f = fixture();
  try {
    await f.controller.prepare();
    assert.deepEqual(f.calls, ["save", "capture", "preview"]);
    assert.equal(f.controller.phase, "review");
    await f.controller.confirm();
    assert.deepEqual(f.calls, [
      "save",
      "capture",
      "preview",
      "execute",
      "refresh",
    ]);
    assert.equal(f.controller.phase, "finished");
  } finally {
    f.dispose();
  }
});
test("cancelled review never executes", async () => {
  const f = fixture();
  try {
    await f.controller.prepare();
    f.controller.cancel();
    await assert.rejects(f.controller.confirm());
    assert(!f.calls.includes("execute"));
  } finally {
    f.dispose();
  }
});
test("source A-B-A identity change rejects confirmation", async () => {
  const f = fixture();
  try {
    await f.controller.prepare();
    f.switch();
    await assert.rejects(f.controller.confirm(), /知识库已切换/);
    assert(!f.calls.includes("execute"));
  } finally {
    f.dispose();
  }
});
test("new draft edits after preview prevent execution", async () => {
  const f = fixture();
  try {
    await f.controller.prepare();
    f.dirty();
    await assert.rejects(f.controller.confirm(), /新修改/);
    assert(!f.calls.includes("execute"));
  } finally {
    f.dispose();
  }
});
test("disposed draft callbacks cannot be used", async () => {
  const f = fixture();
  f.dispose();
  await assert.rejects(f.controller.prepare(), /笔记页/);
  assert.deepEqual(f.calls, []);
});
