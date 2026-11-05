import type { ActiveKnowledgeSource } from "./knowledgeSource";
import type { KnowledgeUiSourceActivation } from "./knowledge";

type Vault = { id: string; rootPath: string };
type Input<T extends Vault> = { vault: T; parentRelativePath: string; name: string };
type Dependencies<T extends Vault, R> = {
  readSource: () => ActiveKnowledgeSource | null;
  ensureSource: () => Promise<KnowledgeUiSourceActivation>;
  invoke: (input: Input<T> & { sourceEpoch: number }) => Promise<R>;
};

/** Keep the original UI session bound through the legacy bridge invocation. */
export async function createMacLegacyNote<T extends Vault, R>(input: Input<T>, deps: Dependencies<T, R>): Promise<R> {
  const origin = deps.readSource();
  if (origin?.mode !== "real-vault" || origin.vaultId !== input.vault.id
      || (origin.rootPath && origin.rootPath !== input.vault.rootPath)) {
    throw new Error("knowledge-source-inactive: Open the current vault before creating a note");
  }
  const active = await deps.ensureSource();
  if (deps.readSource() !== origin || active.vaultId !== input.vault.id) {
    throw new Error("knowledge-source-inactive: The vault changed before note creation started");
  }
  let result: R;
  try {
    result = await deps.invoke({ ...input, sourceEpoch: active.sourceEpoch });
  } catch (failure) {
    // Tauri rejects with a string; make an uncertain result visible to both
    // the Notes and Graph flows instead of reducing it to a generic failure.
    if (typeof failure === "string" && failure.startsWith("knowledge-create-unconfirmed:")) {
      throw new Error(failure);
    }
    throw failure;
  }
  if (deps.readSource() !== origin) {
    throw new Error("knowledge-create-unconfirmed: 笔记可能已创建，请先检查原知识库，再决定是否重试。");
  }
  return result;
}
