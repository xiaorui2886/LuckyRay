/** Exact path components matter on macOS. Do not trim or reinterpret a path
 * that has already been validated by the folder transaction adapter. */
export function folderContainsPath(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}
export function remapFolderPath(path: string, before: string, after: string): string {
  return folderContainsPath(before, path) ? `${after}${path.slice(before.length)}` : path;
}
export function remapFolderRecord<T>(record: Record<string, T>, rename: (id: string) => string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([id, value]) => [rename(id), value]));
}
