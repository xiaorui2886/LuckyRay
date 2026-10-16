// Shared tree shape used by the vault adapter and core knowledge store.
export type KnowledgeSourceMode = "real-vault";

export type KnowledgeTreeNode = {
  id: string;
  kind: "folder" | "document";
  title: string;
  relativePath?: string;
  absolutePath?: string;
  parentId?: string | null;
  children?: KnowledgeTreeNode[];
  updatedAt?: string;
  source: KnowledgeSourceMode;
};
