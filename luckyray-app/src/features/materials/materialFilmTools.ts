export type FilmMark = { id: string; start: number; end: number | null; note: string };
export type FilmMarks = { sourceRevision: string; marks: FilmMark[] };
export type FilmThumbnail = { src: string; time: number; start: number; end: number };
// Session cache only: bounded and keyed by Catalog source revision, never a path alone.
const filmstripCache = new Map<string, FilmThumbnail[]>();
export function cachedFilmstrip(key: string): FilmThumbnail[] | undefined {
  const value = filmstripCache.get(key);
  if (value) { filmstripCache.delete(key); filmstripCache.set(key, value); }
  return value;
}
export function retainFilmstrip(key: string, images: FilmThumbnail[]): void {
  filmstripCache.delete(key); filmstripCache.set(key, images);
  let bytes = [...filmstripCache.values()].reduce((sum, rows) => sum + rows.reduce((n, image) => n + image.src.length * 2, 0), 0);
  while (filmstripCache.size > 8 || bytes > 8 * 1024 * 1024) {
    const oldest = filmstripCache.keys().next().value;
    if (oldest === undefined) break;
    bytes -= filmstripCache.get(oldest)!.reduce((n, image) => n + image.src.length * 2, 0);
    filmstripCache.delete(oldest);
  }
}
export function filmThumbnailCount(width: number, aspect: number): number {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? Math.max(.5, Math.min(2, aspect)) : 16 / 9;
  return Math.max(8, Math.min(48, Math.ceil((Number.isFinite(width) ? Math.max(0, width) : 0) / (48 * ratio))));
}
export function filmTime(time: number): string {
  const n = Math.max(0, Number.isFinite(time) ? time : 0);
  const seconds = Math.floor(n % 60).toString().padStart(2, "0");
  const minutes = Math.floor(n / 60 % 60).toString().padStart(2, "0");
  return `${n >= 3600 ? `${Math.floor(n / 3600)}:` : ""}${minutes}:${seconds}`;
}
/** Seconds, not a fabricated frame count (variable-frame-rate media is valid). */
export function filmPreciseTime(time: number): string {
  const milliseconds = Math.round(Math.max(0, Number.isFinite(time) ? time : 0) * 1000);
  return `${filmTime(milliseconds / 1000)}.${String(milliseconds % 1000).padStart(3, "0")}`;
}
export function parseFilmPosition(value: string, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0 || !/^\d+(?::[0-5]?\d){0,2}(?:\.\d{1,3})?$/.test(value.trim())) return null;
  const parts = value.trim().split(":").map(Number);
  const time = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(time) && time >= 0 && time <= duration ? time : null;
}
export function filmSampleTimes(duration: number, count = 12): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const bounded = Math.min(48, Math.max(1, Number.isFinite(count) ? Math.floor(count) : 12));
  return Array.from({ length: bounded }, (_, i) => (i + .5) / bounded * duration);
}
function mediaEvent(video: HTMLVideoElement, name: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener(name, done); video.removeEventListener("error", fail); signal.removeEventListener("abort", fail); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("媒体不可解码或缩略图已取消")); };
    const timer = setTimeout(fail, 2500);
    video.addEventListener(name, done, { once: true }); video.addEventListener("error", fail, { once: true }); signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
  });
}
/** One current-video decoder, <=48 aspect-preserving thumbnails, <=12s total. */
export async function filmstrip(source: string, signal: AbortSignal, count = 12, onProgress?: (images: FilmThumbnail[]) => void): Promise<FilmThumbnail[]> {
  const worker = document.createElement("video");
  worker.muted = true; worker.preload = "auto"; worker.playsInline = true; worker.crossOrigin = "anonymous";
  const local = new AbortController();
  const cancel = () => local.abort(); signal.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(cancel, 12000);
  const images: FilmThumbnail[] = [];
  try {
    if (signal.aborted) throw new Error("已取消");
    const loaded = mediaEvent(worker, "loadeddata", local.signal); worker.src = source; worker.load(); await loaded;
    if (!worker.videoWidth || !worker.videoHeight) return [];
    const canvas = document.createElement("canvas");
    const scale = Math.min(144 / worker.videoWidth, 96 / worker.videoHeight);
    canvas.width = Math.max(1, Math.round(worker.videoWidth * scale)); canvas.height = Math.max(1, Math.round(worker.videoHeight * scale));
    const ctx = canvas.getContext("2d"); if (!ctx) return [];
    const samples = filmSampleTimes(worker.duration, count);
    if (!samples.length) return [];
    // Populate across the whole track first, then fill the remaining intervals.
    const coarse = [...new Set([0, 1, 2, 3].map(i => Math.floor(i * samples.length / 4)))];
    const order = [...coarse, ...samples.map((_, i) => i).filter(i => !coarse.includes(i))];
    for (const index of order) {
      if (local.signal.aborted) break;
      const time = samples[index];
      const sought = mediaEvent(worker, "seeked", local.signal); worker.currentTime = time; await sought;
      ctx.drawImage(worker, 0, 0, canvas.width, canvas.height);
      images.push({ src: canvas.toDataURL("image/jpeg", .7), time, start: index / samples.length * worker.duration, end: (index + 1) / samples.length * worker.duration });
      images.sort((a, b) => a.time - b.time);
      if (!local.signal.aborted) onProgress?.([...images]);
    }
    return images;
  } catch { return images; }
  finally { clearTimeout(deadline); signal.removeEventListener("abort", cancel); worker.pause(); worker.removeAttribute("src"); worker.load(); }
}
/** Synchronously freeze the currently decoded frame before any asynchronous work. */
export function displayedFilmFrame(video: HTMLVideoElement): Promise<Blob> {
  if (video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) throw new Error("画面尚未就绪，请定位完成后再截帧");
  if (video.videoWidth * video.videoHeight > 33_177_600) throw new Error("当前画面超过 8K 截帧范围");
  const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("当前环境无法读取视频画面");
  ctx.drawImage(video, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("此媒体不支持截帧")), "image/png"));
}
