import { parseReferenceMentions } from "./referenceMentions";
import type { CanvasLibraryFolder } from './libraryFolders';

export type CanvasPickerItem = { id: string; name?: string; title?: string; folderId?: string | null; kind?: string; thumbnailUrl?: string; previewUrl?: string; originalPath?: string; libraryPath?: string | null; contentText?: string; description?: string; materialGenerationProvenance?: { request?: { sourcePrompt?: string; prompt?: string } }; };
export type CanvasPickerRow<T> = { key: string; depth: number; folder?: CanvasLibraryFolder; item?: T; path: string };
export function canvasLibraryDisplayText(value: string): string {
  return parseReferenceMentions(value).map(part => part.type === 'text' ? part.text : part.focus?.label || '参考素材').join('').replace(/\s+/g, ' ').trim();
}
export function canvasPickerExcerpt(item: CanvasPickerItem): string {
  const request = item.materialGenerationProvenance?.request;
  return canvasLibraryDisplayText(request?.sourcePrompt || request?.prompt || item.contentText || item.description || '');
}
/** One scroll surface for folders and content. Invalid/cyclic hierarchies remain reachable, never recurse forever. */
export function canvasPickerRows<T extends CanvasPickerItem>(items: readonly T[], folders: readonly CanvasLibraryFolder[] | null, expanded: ReadonlySet<string>, query: string, label: (item: T) => string): CanvasPickerRow<T>[] {
  const q = query.trim().toLocaleLowerCase();
  const list = folders || [], byId = new Map(list.map(folder => [folder.id, folder]));
  const cyclicComponents = new Map<string, boolean>(), paths = new Map<string, string>();
  const isCyclicComponent = (id: string): boolean => {
    const chain: string[] = [], seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor && byId.has(cursor) && !cyclicComponents.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor); chain.push(cursor); cursor = byId.get(cursor)!.parentId;
    }
    const cyclic = !!cursor && (cyclicComponents.get(cursor) === true || seen.has(cursor));
    for (const key of chain) cyclicComponents.set(key, cyclic);
    return cyclic;
  };
  // Resolve each valid folder path once. Rebuilding the whole folder map per item
  // turns a large library search into quadratic work on every keystroke.
  const path = (id?: string | null): string => {
    if (!id || !byId.has(id)) return '';
    if (paths.has(id)) return paths.get(id)!;
    const cyclic = isCyclicComponent(id), chain: CanvasLibraryFolder[] = [], seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor && byId.has(cursor) && !seen.has(cursor) && (cyclic || !paths.has(cursor))) {
      seen.add(cursor); const folder: CanvasLibraryFolder = byId.get(cursor)!; chain.push(folder); cursor = folder.parentId;
    }
    if (cyclic) {
      // A cycle's breadcrumb is relative to the starting folder. Do not reuse an
      // ancestor's cached path, which could repeat folders or change its order.
      const value = chain.reverse().map(folder => folder.name).join(' / ');
      paths.set(id, value); return value;
    }
    let value = cursor ? paths.get(cursor) || '' : '', hasPrefix = !!cursor && paths.has(cursor);
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const folder = chain[index]; value = hasPrefix ? `${value} / ${folder.name}` : folder.name; hasPrefix = true; paths.set(folder.id, value);
    }
    return paths.get(id) || '';
  };
  if (q) {
    const matches: CanvasPickerRow<T>[] = [];
    for (const item of items) {
      const itemPath = path(item.folderId);
      if ([label(item), canvasPickerExcerpt(item), itemPath].some(text => text.toLocaleLowerCase().includes(q))) {
        matches.push({key: `item:${item.id}`, depth: 0, item, path: itemPath});
      }
    }
    return matches;
  }
  const result: CanvasPickerRow<T>[] = [], visited = new Set<string>();
  const children = new Map<string | null, CanvasLibraryFolder[]>(), contents = new Map<string | null, T[]>();
  for (const folder of list) { const parent = folder.parentId && byId.has(folder.parentId) ? folder.parentId : null; const siblings = children.get(parent); if (siblings) siblings.push(folder); else children.set(parent, [folder]); }
  for (const item of items) { const parent = item.folderId && byId.has(item.folderId) ? item.folderId : null; const siblings = contents.get(parent); if (siblings) siblings.push(item); else contents.set(parent, [item]); }
  function append(parent: string | null, depth: number) {
    type Pending = { parent: string | null; depth: number } | { folder: CanvasLibraryFolder; depth: number } | { item: T; depth: number };
    const pending: Pending[] = [{ parent, depth }];
    while (pending.length) {
      const next = pending.pop()!;
      if ('item' in next) { result.push({key: `item:${next.item.id}`, depth: next.depth, item: next.item, path: path(next.item.folderId)}); continue; }
      if ('folder' in next) {
        const folder = next.folder;
        if (visited.has(folder.id)) continue;
        visited.add(folder.id); result.push({key: `folder:${folder.id}`, depth: next.depth, folder, path: path(folder.id)});
        if (expanded.has(folder.id)) pending.push({ parent: folder.id, depth: next.depth + 1 });
        continue;
      }
      // LIFO keeps the existing order: each folder subtree, then this folder's items.
      const parentItems = contents.get(next.parent) || [], parentFolders = children.get(next.parent) || [];
      for (let index = parentItems.length - 1; index >= 0; index -= 1) pending.push({ item: parentItems[index], depth: next.depth });
      for (let index = parentFolders.length - 1; index >= 0; index -= 1) pending.push({ folder: parentFolders[index], depth: next.depth });
    }
  }
  append(null, 0);
  // Only promote unreachable cycles; descendants of intentionally collapsed folders stay hidden.
  for (const folder of list) {
    if (!visited.has(folder.id) && isCyclicComponent(folder.id)) {
      visited.add(folder.id); result.push({key: `folder:${folder.id}`, depth: 0, folder, path: path(folder.id)});
      if (expanded.has(folder.id)) append(folder.id, 1);
    }
  }
  return result;
}

export function canvasPreviewPosition(anchor: {left: number; right: number; top: number}, viewport: {width: number; height: number}, height = 370) {
  const width = Math.min(292, Math.max(0, viewport.width - 24)), gap = 10;
  const fitsRight = anchor.right + gap + width <= viewport.width - 12;
  const left = fitsRight ? anchor.right + gap : anchor.left - gap - width;
  return {left: Math.max(12, Math.min(left, viewport.width - width - 12)), top: Math.max(12, Math.min(anchor.top, viewport.height - height - 12)), width};
}
