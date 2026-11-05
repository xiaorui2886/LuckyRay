import test from "node:test";
import assert from "node:assert/strict";
import { createMacLegacyNote } from "../src/core/services/macLegacyNoteCreate.ts";
import type { ActiveKnowledgeSource } from "../src/core/services/knowledgeSource.ts";
import { clearActiveKnowledgeSource, readActiveKnowledgeWriteSource, setActiveKnowledgeSource } from "../src/core/services/knowledgeSource.ts";

const input = { vault: { id: "v1", rootPath: "/Vault" }, parentRelativePath: "Nested", name: "Page.md" };
const origin = (): ActiveKnowledgeSource => ({ mode: "real-vault", vaultId: "v1", rootPath: "/Vault" });
const activation = { vaultId: "v1", sourceEpoch: 12 };

test("Mac legacy creation carries the original source epoch", async () => {
  const source = origin(); const calls: unknown[] = [];
  const result = await createMacLegacyNote(input, { readSource: () => source,
    ensureSource: async () => activation, invoke: async args => { calls.push(args); return "created"; } });
  assert.equal(result, "created");
  assert.deepEqual(calls, [{ ...input, sourceEpoch: 12 }]);
});

test("Mac legacy creation rejects a different vault root before sending anything", async () => {
  let invoked = false;
  await assert.rejects(createMacLegacyNote(input, { readSource: () => ({ ...origin(), rootPath: "/Other" }),
    ensureSource: async () => activation, invoke: async () => { invoked = true; } }), /knowledge-source-inactive/);
  assert.equal(invoked, false);
});

test("Mac legacy creation rejects a retired source before dispatch", async () => {
  let source = origin(); let invoked = false;
  await assert.rejects(createMacLegacyNote(input, { readSource: () => source,
    ensureSource: async () => { source = origin(); return activation; },
    invoke: async () => { invoked = true; } }), /knowledge-source-inactive/);
  assert.equal(invoked, false);
});

test("Mac legacy creation treats a source switch after dispatch as unconfirmed", async () => {
  let source = origin();
  await assert.rejects(createMacLegacyNote(input, { readSource: () => source,
    ensureSource: async () => activation, invoke: async () => { source = origin(); return "created"; } }),
    /knowledge-create-unconfirmed/);
});

test("Mac legacy creation preserves an already-exists result for copy and graph callers", async () => {
  const source = origin();
  await assert.rejects(createMacLegacyNote(input, { readSource: () => source,
    ensureSource: async () => activation, invoke: async () => { throw "already-exists: fixture"; } }),
    error => String(error).includes("already-exists"));
});

test("Mac legacy creation leaves explicit uncertain failures visible", async () => {
  const source = origin();
  await assert.rejects(createMacLegacyNote(input, { readSource: () => source,
    ensureSource: async () => activation, invoke: async () => { throw "knowledge-create-unconfirmed: fixture"; } }),
    error => error instanceof Error && error.message.includes("knowledge-create-unconfirmed"));
});

test("Mac legacy creation waits for the actual source lifecycle and stops after suspension", async () => {
  let calls = 0;
  const deps = { readSource: readActiveKnowledgeWriteSource,
    ensureSource: async () => activation,
    invoke: async () => { calls++; return "created"; } };
  clearActiveKnowledgeSource();
  try {
    await assert.rejects(createMacLegacyNote(input, deps), /knowledge-source-inactive/);
    assert.equal(calls, 0);
    setActiveKnowledgeSource(origin());
    assert.equal(await createMacLegacyNote(input, deps), "created");
    clearActiveKnowledgeSource();
    await assert.rejects(createMacLegacyNote(input, deps), /knowledge-source-inactive/);
    assert.equal(calls, 1);
  } finally {
    clearActiveKnowledgeSource();
  }
});

test("Mac legacy creation rejects a paused source while activation is pending", async () => {
  const pending = Promise.withResolvers<typeof activation>();
  let calls = 0;
  setActiveKnowledgeSource(origin(), true);
  const result = createMacLegacyNote(input, { readSource: readActiveKnowledgeWriteSource,
    ensureSource: () => pending.promise, invoke: async () => { calls++; } });
  clearActiveKnowledgeSource();
  pending.resolve(activation);
  await assert.rejects(result, /knowledge-source-inactive/);
  assert.equal(calls, 0);
});
