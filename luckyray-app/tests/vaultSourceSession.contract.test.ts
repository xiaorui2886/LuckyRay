import assert from "node:assert/strict";
import test from "node:test";
import {
  activateKnowledgeWritesForVault,
  clearActiveKnowledgeSource,
  readActiveKnowledgeWriteSource,
  setActiveKnowledgeSource,
} from "../src/core/services/knowledgeSource.ts";
test("index refresh preserves source identity; explicit reopen and A-B-A replace it", () => {
  const source = {
    mode: "real-vault" as const,
    vaultId: "A",
    rootPath: "root-A",
  };
  activateKnowledgeWritesForVault(source);
  const first = readActiveKnowledgeWriteSource();
  setActiveKnowledgeSource({ ...source });
  assert.equal(readActiveKnowledgeWriteSource(), first);
  activateKnowledgeWritesForVault({ ...source });
  const reopened = readActiveKnowledgeWriteSource();
  assert.notEqual(reopened, first);
  setActiveKnowledgeSource({ ...source, vaultId: "B" });
  setActiveKnowledgeSource(source);
  assert.notEqual(readActiveKnowledgeWriteSource(), reopened);
  clearActiveKnowledgeSource();
  assert.equal(readActiveKnowledgeWriteSource(), null);
});
