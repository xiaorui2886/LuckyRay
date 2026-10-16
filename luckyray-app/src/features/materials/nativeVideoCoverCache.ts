import type { NativeVideoMetadata } from './nativeVideoPreview';

type Identity = { id: string; contentHash?: string | null; libraryPath?: string | null; originalPath?: string; sizeBytes?: number | null };
type Cover = { src: string; aspect: number; metadata: NativeVideoMetadata };
const storageKey = 'luckyray-native-video-covers-v1';
const covers = new Map<string, Cover>();
let loaded = false;
const key = (library: string | null | undefined, asset: Identity) => JSON.stringify([library, asset.id, asset.contentHash, asset.libraryPath, asset.originalPath, asset.sizeBytes]);
function load() {
  if (loaded) return; loaded = true;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 2_000_000) return;
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    for (const [id, cover] of rows.slice(-32)) {
      if (typeof id === 'string' && typeof cover?.src === 'string' && /^data:image\/(jpeg|png);base64,/.test(cover.src)
        && Number.isFinite(cover.aspect) && cover.aspect > 0 && cover.metadata?.sourceRevision) covers.set(id, cover);
    }
  } catch { /* Optional disposable presentation cache; never blocks the library. */ }
}
export function cachedNativeVideoCover(library: string | null | undefined, asset: Identity) {
  load(); return covers.get(key(library, asset)) ?? null;
}
export function retainNativeVideoCover(library: string, asset: Identity, cover: Cover) {
  load(); const id = key(library, asset); covers.delete(id); covers.set(id, cover);
  let serialized = JSON.stringify([...covers]);
  while (covers.size > 32 || serialized.length > 2_000_000) {
    covers.delete(covers.keys().next().value!); serialized = JSON.stringify([...covers]);
  }
  try { localStorage.setItem(storageKey, serialized); } catch { /* Private/quota mode keeps memory cache. */ }
}
