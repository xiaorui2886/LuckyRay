export type LiveEditorSelection = {
  start: number;
  end: number;
};

export type LiveEditorTokenContext = {
  kind: "asset" | "note" | "tag" | "external";
  from: number;
  to: number;
  label: string;
  href?: string | null;
  assetId?: string | null;
  noteId?: string | null;
  tagId?: string | null;
  createTitle?: string | null;
  openOptions?: LiveNoteOpenOptions;
  missing?: boolean;
};

export type LiveNote = {
  id: string;
  title: string;
  folderId?: string | null;
  folderPath?: string;
  contentText?: string;
  snippet?: string;
};

export type LiveTag = {
  id: string;
  name: string;
  noteCount?: number;
  assetCount?: number;
};

export type LiveAsset = {
  id: string;
  name: string;
  kind?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  originalPath?: string;
  libraryPath?: string | null;
};

export type LiveNoteLink = {
  targetTitle: string;
  toNoteId: string | null;
  isMissing: number;
};

export type LiveNoteEmbed = {
  resolutionStatus?: string;
  targetName: string;
  assetId: string | null;
  isMissing: number;
};

export type LiveNoteOpenOptions = {
  blockId?: string | null;
  headingPath?: string | null;
};
