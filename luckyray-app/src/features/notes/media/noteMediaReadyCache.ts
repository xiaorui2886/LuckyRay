// Bounded geometry memory for note media.
//
// Note embeds know their target's path but usually not its pixel size, so a
// freshly mounted media widget renders as a tall dark placeholder until the
// decode finishes — the "黑底卡片先出内容后到" flash. Once a source has been
// decoded anywhere in this session, its aspect ratio and intrinsic width are
// remembered here so the next mount reserves the correct space immediately.
//
// Entries are keyed by the resolved media URL/file identity and hold NUMBERS ONLY (never
// pixels, elements or blobs), bounded by an LRU. The cache is a presentation
// hint: every real load still reports its own geometry through the existing
// onLoad/onAspect path and overwrites the entry, so a file replaced at the
// same path self-corrects on its next actual read.

export interface DecodedMediaGeometry {
  width: number;
  height: number;
}

const MAX_REMEMBERED_GEOMETRY = 96;

const decodedGeometry = new Map<string, DecodedMediaGeometry>();

// Version changes invalidate pixels, not the last known layout. Keep this
// numeric hint scoped to the exact vault/file; real decoding always corrects
// it if a replacement image has different dimensions.
function geometryKey(source: string) {
  return /[?]vault=[^&]+&v=/.test(source) ? source.replace(/(&v=)[^&#]*/, "$1*") : source;
}

export function rememberDecodedMediaGeometry(source: string, width: number, height: number): void {
  if (!source || !(width > 0) || !(height > 0)) return;
  source = geometryKey(source);
  // Refresh recency; enforce the bound by evicting the least recently used.
  decodedGeometry.delete(source);
  decodedGeometry.set(source, { width, height });
  while (decodedGeometry.size > MAX_REMEMBERED_GEOMETRY) {
    const oldest = decodedGeometry.keys().next().value;
    if (oldest === undefined) break;
    decodedGeometry.delete(oldest);
  }
}

export function readDecodedMediaGeometry(source: string): DecodedMediaGeometry | null {
  source = geometryKey(source);
  const entry = decodedGeometry.get(source);
  if (!entry) return null;
  // Refresh recency so hot note switching keeps its geometry.
  decodedGeometry.delete(source);
  decodedGeometry.set(source, entry);
  return entry;
}

/** Apply the remembered geometry to a media root the same way a real decode
 *  would (see setNoteMediaAspect). Returns true when geometry was available. */
export function applyRememberedMediaGeometry(root: HTMLElement, source: string): boolean {
  const entry = readDecodedMediaGeometry(source);
  if (!entry) return false;
  root.style.setProperty("--note-media-ratio", String(entry.width / entry.height));
  root.style.setProperty("--note-media-intrinsic-width", `${entry.width}px`);
  root.style.setProperty("--asset-aspect", `${entry.width} / ${entry.height}`);
  return true;
}

// Decoded pixels require a version, immutable data/blob identity, or a
// content-addressed Catalog filename. Plain mutable asset paths are not safe
// to retain after a same-path file replacement.
export function isSessionReusableMediaUrl(url: string): boolean {
  if (!url) return false;
  if (/[?]vault=[^&]+&v=.+/.test(url)) return true;
  if (/^(data:|blob:)/i.test(url)) return true;
  return /^(?:https?:\/\/asset\.localhost\/|asset:)/i.test(url)
    && /(?:%5c|%2f|[\/\\])[a-f0-9]{64}\.[a-z0-9]+(?:[?#]|$)/i.test(url);
}
