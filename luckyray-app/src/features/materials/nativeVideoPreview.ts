import { invoke } from "@tauri-apps/api/core";
import { filmSampleTimes, type FilmThumbnail } from "./materialFilmTools";

export type NativeVideoMetadata = { width: number; height: number; duration: number; codec: string; sourceRevision: string };
type Queued = { run: () => void; signal: AbortSignal; reject: (error: Error) => void };
const queue: Queued[] = [];
let active = 0;
const aborted = () => new Error("native-video-preview-cancelled");
function pump() {
  while (active < 2 && queue.length) {
    const next = queue.shift()!;
    if (next.signal.aborted) { next.reject(aborted()); continue; }
    active++; next.run();
  }
}
function request<T>(input: object, signal: AbortSignal, foreground = false): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  if (queue.length >= 64) return Promise.reject(new Error("native-video-preview-busy"));
  return new Promise((resolve, reject) => {
    const entry: Queued = { signal, reject, run: () => {
      const job = crypto.randomUUID();
      const cancel = () => { void invoke("material_video_preview_command", { request: { op: "cancel", job } }).catch(() => {}); };
      signal.addEventListener("abort",cancel,{ once:true });
      void invoke<T>("material_video_preview_command", { request: { ...input, job } }).then(value => { if (signal.aborted) reject(aborted()); else resolve(value); }, reject)
        .finally(() => { signal.removeEventListener("abort",cancel); active--; pump(); });
    } };
    // Opening a viewer must not sit behind a screenful of background covers.
    // Existing active jobs keep their two-process bound and cancellation rules.
    if (foreground) queue.unshift(entry); else queue.push(entry);
    pump();
  });
}
export const nativeVideoMetadata = (libraryId: string, assetId: string, signal: AbortSignal, foreground = false) => request<NativeVideoMetadata>({ op: "metadata", libraryId, assetId }, signal, foreground);
export const nativeVideoThumbnail = (libraryId: string, assetId: string, revision: string, seconds: number, signal: AbortSignal, purpose: "filmstrip" | "cover" = "filmstrip") => request<{ src: string; time: number }>({ op: "thumbnail", libraryId, assetId, revision, seconds, cover: purpose === "cover" }, signal);

export async function nativeFilmstrip(libraryId: string, assetId: string, revision: string, signal: AbortSignal, count: number, onProgress: (rows: FilmThumbnail[]) => void): Promise<FilmThumbnail[]> {
  const rows: FilmThumbnail[] = [], local = new AbortController();
  const cancel = () => local.abort(); signal.addEventListener("abort",cancel,{once:true});
  const deadline = setTimeout(cancel, 15000);
  try {
    if (signal.aborted) return rows;
    const metadata = await nativeVideoMetadata(libraryId,assetId,local.signal);
    if (metadata.sourceRevision !== revision) throw new Error("native-video-source-changed");
    const samples = filmSampleTimes(metadata.duration,count);
    const coarse = [...new Set([0,1,2,3].map(i=>Math.floor(i*samples.length/4)))];
    for (const index of [...coarse,...samples.map((_,i)=>i).filter(i=>!coarse.includes(i))]) {
      if (local.signal.aborted) break;
      const frame = await nativeVideoThumbnail(libraryId,assetId,revision,samples[index],local.signal);
      rows.push({ ...frame, start: index/samples.length*metadata.duration, end: (index+1)/samples.length*metadata.duration });
      rows.sort((a,b)=>a.time-b.time); if (!signal.aborted) onProgress([...rows]);
    }
  } catch { /* Partial filmstrip remains usable; caller reports its exact state. */ }
  finally { clearTimeout(deadline); signal.removeEventListener("abort",cancel); }
  return rows;
}
