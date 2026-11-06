import {useEffect, useState} from 'react';
import {nativeComfyVideoCover, nativeVideoMetadata, nativeVideoThumbnail} from '../materials/nativeVideoPreview';
import {materialLibrarySession, type MaterialLibraryRegistry} from '../../core/services/materialLibraryContext';

export type ComfyVideoCover = {src: string; width: number; height: number; duration: number; codec: string; sourceRevision: string};
type Entry = {promise: Promise<ComfyVideoCover>; controller: AbortController; refs: number; settled: boolean; value?: ComfyVideoCover};
const entries = new Map<string, Entry>();

export function comfyVideoResultName(source: string): string | null {
  const name = source.replace(/\\/g, '/').split('/').pop() ?? '';
  return /^comfy-[a-f0-9]{64}\.mp4$/.test(name) ? name : null;
}

// Covers are decoded stills held in RAM. No proxy video or original-file write.
function acquire(name: string) {
  let entry = entries.get(name);
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    entry = {controller, refs: 0, settled: false, promise: Promise.resolve(null as unknown as ComfyVideoCover)};
    const item = entry;
    item.promise = nativeComfyVideoCover(name, controller.signal).then(cover => {
      if (!cover.src.startsWith('data:image/jpeg;base64,') || cover.width <= 0 || cover.height <= 0) throw Error('native-video-cover-invalid');
      item.value = cover;
      return cover;
    }).catch(error => {
      // A failed read must not remain a permanently rejected cache entry.
      if (entries.get(name) === item) entries.delete(name);
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /^(?:native-video|comfyui-video)-[a-z-]+$/.test(message) ? message : 'unknown';
        console.warn('[comfy-cover]', {code}); // No path, prompt, URL or file name.
      }
      throw error;
    }).finally(() => {
      item.settled = true;
      for (const [key, old] of entries) {
        if (entries.size <= 32) break;
        if (!old.refs && old.settled) entries.delete(key);
      }
    });
    entries.set(name, item);
  }
  entry.refs++;
  const item = entry;
  return {promise: item.promise, release: () => {
    if (!--item.refs && !item.settled) item.controller.abort();
  }};
}

export function useComfyVideoCover(source: string, visible = true) {
  const name = comfyVideoResultName(source);
  const [value, setValue] = useState<{name: string; cover: ComfyVideoCover} | null>(null);
  useEffect(() => {
    if (!name || !visible) return;
    let alive = true;
    const request = acquire(name);
    request.promise.then(cover => {if (alive) setValue({name, cover});}).catch(() => {});
    return () => {alive = false; request.release();};
  }, [name, visible]);
  return name && value?.name === name ? value.cover : name ? entries.get(name)?.value : undefined;
}

// Catalog references have an asset identity rather than a Comfy result name.
// Read their still before interaction, using the same legacy catalog binding
// and revision check as playback, never the materials page's active library.
export function useCanvasVideoCover(source: string, assetId: string | undefined, visible = true) {
  const comfyCover = useComfyVideoCover(assetId ? '' : source, visible);
  const [value, setValue] = useState<{source: string; assetId: string; cover: ComfyVideoCover} | null>(null);
  useEffect(() => {
    if (!assetId || !visible) return;
    const controller = new AbortController();
    const read = async () => {
      const registry = await materialLibrarySession.request<MaterialLibraryRegistry>({op: 'registry', include_hidden: false}, null);
      if (controller.signal.aborted || !registry.legacyId) return;
      const metadata = await nativeVideoMetadata(registry.legacyId, assetId, controller.signal);
      if (controller.signal.aborted || metadata.width <= 0 || metadata.height <= 0) return;
      const frame = await nativeVideoThumbnail(registry.legacyId, assetId, metadata.sourceRevision, Math.min(.5, metadata.duration * .1), controller.signal, 'cover');
      if (!controller.signal.aborted && frame.src.startsWith('data:image/jpeg;base64,')) {
        setValue({source, assetId, cover: {...metadata, src: frame.src}});
      }
    };
    void read().catch(() => {}); // Keep playback available when a still is unavailable.
    return () => controller.abort();
  }, [source, assetId, visible]);
  return assetId ? value?.source === source && value.assetId === assetId ? value.cover : undefined : comfyCover;
}
