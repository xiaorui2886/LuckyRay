/** UI-only destination model. A null folder always means this library's root. */
export type CanvasLibraryFolder = { id: string; name: string; parentId: string | null };
export type CanvasLibraryFolderSnapshot = { libraryId: string; libraryName?: string; folders: readonly CanvasLibraryFolder[] };
export type CanvasLibraryDestination = { libraryId: string; folderId: string | null };

export function canvasFolderBreadcrumbs(folders: readonly CanvasLibraryFolder[], folderId: string | null): CanvasLibraryFolder[] {
  const byId = new Map(folders.map(folder => [folder.id, folder])), seen = new Set<string>(), path: CanvasLibraryFolder[] = [];
  let id = folderId;
  while (id !== null && !seen.has(id)) {
    seen.add(id); const folder = byId.get(id); if (!folder) break;
    path.unshift(folder); id = folder.parentId;
  }
  return path;
}

export function canvasFolderChildren(folders: readonly CanvasLibraryFolder[], folderId: string | null): CanvasLibraryFolder[] {
  return folders.filter(folder => folder.parentId === folderId);
}
