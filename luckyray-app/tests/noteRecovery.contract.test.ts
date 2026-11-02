import assert from "node:assert/strict";
import test from "node:test";
import { recoverNoteVersion, recoveryCopyName, type NoteRecoveryItem } from "../src/core/services/noteRecovery.ts";
import { clearActiveKnowledgeSource, setActiveKnowledgeSource } from "../src/core/services/knowledgeSource.ts";

const item: NoteRecoveryItem = { recordPath: ".lrk-remove-test.history", originalPath: "Folder/笔记.md", kind: "removal", pending: false,
  token: "a".repeat(64), canRestore: true, versions: [{ slot: "retained", revision: "b".repeat(64), bytes: 5, preview: "hello", changedSinceRecord: false }], unavailableVersions: 0 };
type Call = { command: string; args: Record<string, unknown> | undefined };
function runtime(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: () => {}, __TAURI_INTERNALS__: { invoke } } });
  return () => { clearActiveKnowledgeSource(); if (old) Object.defineProperty(globalThis, "window", old); else Reflect.deleteProperty(globalThis, "window"); };
}
test("recovery keeps the selected record token and passes the active epoch with a new copy name", async () => {
  const calls: Call[] = [];
  const restore = runtime(async (command, args) => { calls.push({ command, args });
    if (command === "knowledge_activate_ui_source") return { vaultId: "vault-a", sourceEpoch: 71 };
    if (command === "knowledge_recover_note_version") return args?.destination;
    throw new Error(command);
  });
  try {
    setActiveKnowledgeSource({ mode: "real-vault", vaultId: "vault-a", rootPath: "/synthetic/vault" }, true);
    const destination = recoveryCopyName(item.originalPath);
    assert.equal(await recoverNoteVersion("vault-a", item, "retained", destination, false), "Folder/笔记 (恢复副本).md");
    assert.deepEqual(calls.at(-1), { command: "knowledge_recover_note_version", args: { sourceEpoch: 71, vaultId: "vault-a", recordPath: item.recordPath,
      token: item.token, slot: "retained", destination, restoreOriginal: false } });
  } finally { restore(); }
});
test("a Vault switch while activation is pending prevents the recovery mutation", async () => {
  const calls: Call[] = [];
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const activating = new Promise<void>(resolve => { entered = resolve; });
  const activation = new Promise(resolve => { finish = resolve; });
  const restore = runtime(async (command, args) => { calls.push({ command, args });
    if (command === "knowledge_activate_ui_source") { entered(); return activation; }
    if (command === "knowledge_deactivate_ui_source") return undefined;
    throw new Error(command);
  });
  try {
    setActiveKnowledgeSource({ mode: "real-vault", vaultId: "vault-a", rootPath: "/synthetic/vault" }, true);
    const pending = recoverNoteVersion("vault-a", item, "retained", "Copy.md", false);
    const rejected = assert.rejects(pending, /source changed|知识库已切换/i);
    await activating;
    setActiveKnowledgeSource({ mode: "real-vault", vaultId: "vault-b", rootPath: "/synthetic/other" }, true);
    finish({ vaultId: "vault-a", sourceEpoch: 72 });
    await rejected;
    assert.equal(calls.some(call => call.command === "knowledge_recover_note_version"), false);
  } finally { restore(); }
});
