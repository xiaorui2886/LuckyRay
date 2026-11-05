/** macOS folder operations use a native transaction, never the legacy path API.
 * The native scope owns object identity, the journal, and recovery decisions. */
export type MacFolderOperation = "rename" | "move" | "delete" | "restore";
export type MacFolderMutationResult = {
  operationId: string;
  state: "completed" | "unchanged" | "recovery-required";
  operation: MacFolderOperation;
  oldRelativePath: string;
  newRelativePath: string | null;
  message: string | null;
};
export type MacFolderRecovery = MacFolderMutationResult & { canRestore: boolean };
export type MacFolderMutationInput = {
  sourceEpoch: number;
  relativePath: string;
  operation: Exclude<MacFolderOperation, "restore">;
  expectedSelection: string;
  newName?: string;
  targetParentRelativePath?: string;
};
export type MacFolderClient = {
  prepare(sourceEpoch: number, relativePath: string): Promise<string>;
  mutate(input: MacFolderMutationInput): Promise<MacFolderMutationResult>;
  list(sourceEpoch: number): Promise<MacFolderRecovery[]>;
  restore(sourceEpoch: number, operationId: string): Promise<MacFolderMutationResult>;
};
async function invokeFolder<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}
export const macFolderClient: MacFolderClient = {
  prepare: (sourceEpoch, relativePath) => invokeFolder("macos_prepare_vault_folder", { sourceEpoch, relativePath }),
  mutate: input => invokeFolder("macos_mutate_vault_folder", { ...input }),
  list: sourceEpoch => invokeFolder("macos_list_vault_folder_recoveries", { sourceEpoch }),
  restore: (sourceEpoch, operationId) => invokeFolder("macos_restore_vault_folder", { sourceEpoch, operationId }),
};
