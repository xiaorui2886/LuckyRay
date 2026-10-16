import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createRealVaultDocumentSource, KnowledgeSourceError } from "../src/features/notes/documentSource.ts";
import { KnowledgeServiceError, type KnowledgeDocumentSnapshot } from "../src/core/services/knowledge.ts";

const vault = { id: "vault-a", rootPath: "C:\\Notes", name: "Notes", mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
const ref = { vaultId: vault.id, relativePath: "Folder/A.md" };
const snapshot = (content = "original", revision = "r1", documentRef = ref): KnowledgeDocumentSnapshot => ({
  documentRef, relativePath: documentRef.relativePath, title: "A", content, revision, modifiedAt: "2026-01-01", size: content.length,
});

function fixture() {
  let disk = snapshot();
  let reads = 0;
  let legacyWrites = 0;
  const writes: Array<{ content: string; revision?: string | null }> = [];
  const documents = {
    async read() { reads++; return { ...disk }; },
    async replace(documentRef: typeof ref, content: string, revision?: string | null) {
      writes.push({ content, revision });
      assert.deepEqual(documentRef, ref);
      if (revision !== disk.revision) throw new KnowledgeServiceError("knowledge-revision-conflict", "Changed on disk");
      disk = snapshot(content, `${disk.revision}-next`);
      return { document: { ...disk }, position: "replace" };
    },
  };
  // Keep the old bridge available: a revisioned save must never fall back to it.
  const bridge = { async writeNotesVaultMarkdownFile() { legacyWrites++; throw Error("unsafe legacy writer called"); } };
  const source = createRealVaultDocumentSource({ vault, bridge: { ...bridge, readNotesVaultMarkdownFile: async () => { throw Error("legacy read called"); } }, documents });
  return { source, documents, setDisk: (value: KnowledgeDocumentSnapshot) => { disk = value; }, disk: () => disk, reads: () => reads, legacyWrites: () => legacyWrites, writes };
}

test("production document source saves through backend CAS and returns its committed snapshot", async () => {
  const f = fixture();
  const opened = await f.source.openDocument(ref.relativePath);
  assert.equal(opened.revision, "r1");
  assert.equal(opened.absolutePath, "C:\\Notes\\Folder\\A.md");
  const saved = await f.source.saveDocument(opened, "draft");
  assert.equal(saved.contentText, "draft");
  assert.equal(saved.revision, "r1-next");
  assert.deepEqual(f.writes, [{ content: "draft", revision: "r1" }]);
  assert.equal(f.reads(), 1, "save does not reread and adopt another writer's snapshot");
  assert.equal(f.legacyWrites(), 0);
  assert.equal(opened.contentText, "original", "the editor's baseline is not mutated");
});

test("a competing write after preflight fails CAS and retains the local draft", async () => {
  const f = fixture();
  const opened = await f.source.openDocument(ref.relativePath);
  const localDraft = "my unsaved edit";
  f.setDisk(snapshot("other window", "r2"));
  await assert.rejects(f.source.saveDocument(opened, localDraft), (error: unknown) => error instanceof KnowledgeServiceError && error.code === "knowledge-revision-conflict");
  assert.equal(f.disk().content, "other window");
  assert.equal(localDraft, "my unsaved edit");
  assert.equal(opened.revision, "r1");
  assert.equal(f.legacyWrites(), 0);
});

test("background reads never override the explicit revision of an older editor snapshot", async () => {
  const f = fixture();
  const original = await f.source.openDocument(ref.relativePath);
  f.setDisk(snapshot("newer", "r2"));
  await f.source.openDocument(ref.relativePath);
  await assert.rejects(f.source.saveDocument(original, "draft"), /Changed on disk/);
  assert.equal(f.writes[0].revision, "r1");
});

test("independent window adapters cannot silently overwrite each other's saves", async () => {
  const f = fixture();
  const other = createRealVaultDocumentSource({ vault, bridge: null, documents: f.documents });
  const first = await f.source.openDocument(ref.relativePath);
  const second = await other.openDocument(ref.relativePath);
  await f.source.saveDocument(first, "first writer");
  await assert.rejects(other.saveDocument(second, "second writer"), /Changed on disk/);
  assert.equal(f.disk().content, "first writer");
});

test("ID-only compatibility requires an opened revision and never performs a blind save", async () => {
  const f = fixture();
  await assert.rejects(f.source.saveDocument(ref.relativePath, "blind"), (error: unknown) => error instanceof KnowledgeSourceError && error.code === "knowledge-revision-required");
  assert.equal(f.reads(), 0);
  assert.equal(f.writes.length, 0);
  await f.source.openDocument(ref.relativePath);
  await f.source.saveDocument(ref.relativePath, "first");
  await f.source.saveDocument({ id: ref.relativePath }, "second");
  assert.deepEqual(f.writes.map(write => write.revision), ["r1", "r1-next"]);
});

test("a mismatched Vault or path snapshot is rejected rather than cached", async () => {
  for (const documentRef of [{ ...ref, vaultId: "vault-b" }, { ...ref, relativePath: "Other.md" }]) {
    const f = fixture();
    f.setDisk(snapshot("wrong document", "r2", documentRef));
    await assert.rejects(f.source.openDocument(ref.relativePath), /does not match/);
    await assert.rejects(f.source.saveDocument(ref.relativePath, "draft"), /Open the document/);
    assert.equal(f.writes.length, 0);
  }
});

test("legacy create response gets an exact byte revision without racing a second read", async () => {
  const contentText = "\uFEFF# 标题\r\ncreated\r\n";
  const revision = createHash("sha256").update(contentText, "utf8").digest("hex");
  let savedRevision: string | null | undefined;
  const source = createRealVaultDocumentSource({
    vault,
    bridge: { createNotesVaultMarkdownFile: async () => ({ name: "A.md", relativePath: ref.relativePath, absolutePath: "C:\\Notes\\Folder\\A.md", contentText, mtime: null, size: Buffer.byteLength(contentText) }) },
    documents: {
      read: async () => { throw Error("A reread would adopt a concurrent writer's content"); },
      replace: async (_documentRef, content, expectedRevision) => { savedRevision = expectedRevision; return { document: snapshot(content, "new-revision"), position: "replace" }; },
    },
  });
  const created = await source.createDocument("Folder", "A.md");
  assert.equal(created.revision, revision);
  await source.saveDocument(created, "initial content");
  assert.equal(savedRevision, revision);
});

test("backend write failures propagate without reread, retry, or legacy fallback", async () => {
  const f = fixture();
  const source = createRealVaultDocumentSource({ vault, bridge: null, documents: {
    ...f.documents, replace: async () => { throw new KnowledgeServiceError("knowledge-source-inactive", "Vault was switched"); },
  } });
  const opened = await source.openDocument(ref.relativePath);
  await assert.rejects(source.saveDocument(opened, "draft"), /Vault was switched/);
  assert.equal(f.reads(), 1);
  assert.equal(f.disk().content, "original");
});

test('actual read source proof propagates and equal-text recreated vaults cannot replace it',async()=>{
  const first=`note-source-v1:${'a'.repeat(64)}`,replacement=`note-source-v1:${'b'.repeat(64)}`;
  let disk={...snapshot(),workspaceSourceId:first} as KnowledgeDocumentSnapshot;
  const source=createRealVaultDocumentSource({vault,bridge:null,documents:{read:async()=>disk,replace:async(_ref,content)=>({document:snapshot(content,'written'),position:'replace'})}});
  const opened=await source.openDocument(ref.relativePath);assert.equal(opened.workspaceSourceId,first);
  const written=await source.saveDocument(opened,'same authority, legacy write response');assert.equal(written.workspaceSourceId,first);
  disk={...snapshot(),workspaceSourceId:replacement};
  await assert.rejects(source.openDocument(ref.relativePath),(error:unknown)=>error instanceof KnowledgeSourceError&&error.code==='knowledge-document-source-changed');
  assert.equal(opened.workspaceSourceId,first);
});

test('unproved legacy reads stay unproved until an actual valid native read supplies identity',async()=>{
  let disk=snapshot() as KnowledgeDocumentSnapshot;
  const source=createRealVaultDocumentSource({vault,bridge:null,documents:{read:async()=>disk,replace:async(_ref,content)=>({document:snapshot(content),position:'replace'})}});
  assert.equal((await source.openDocument(ref.relativePath)).workspaceSourceId,undefined);
  disk={...snapshot(),workspaceSourceId:'not-a-native-proof'};
  await assert.rejects(source.openDocument(ref.relativePath),(error:unknown)=>error instanceof KnowledgeSourceError&&error.code==='knowledge-document-source-invalid');
  disk={...snapshot(),workspaceSourceId:`note-source-v1:${'c'.repeat(64)}`};
  assert.equal((await source.openDocument(ref.relativePath)).workspaceSourceId,disk.workspaceSourceId);
});
