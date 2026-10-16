import { isSessionReusableMediaUrl, rememberDecodedMediaGeometry } from "./noteMediaReadyCache";
// Only detached, successfully decoded images are retained. Active widgets own
// separate leases, so two panes can never steal the same DOM element.
const recentImages = new Map<HTMLImageElement, string>();
const MAX_RECENT_IMAGES = 12;
const MAX_RECENT_IMAGE_PIXELS = 24 * 1024 * 1024;
export function takeRecentImage(url: string): HTMLImageElement {
  for (const [image, key] of recentImages) {
    if (key === url) { recentImages.delete(image); return image; }
  }
  const image = document.createElement("img");
  // Versioned sources keep a replaced file from reusing old decoded pixels.
  image.dataset.lrImageKey = isSessionReusableMediaUrl(url) ? url : "";
  return image;
}
/**
 * Warm the shared decoded-image pool for `url`: load and decode it now so a
 * widget mounted afterwards takes an already-decoded element and paints with
 * no visible loading state. Prefetch and rendering share this one resource —
 * there is no second read/decode pipeline. Returns whether the decode
 * succeeded; failures resolve false and leave nothing pooled.
 */
const inflightImages = new Map<string, Promise<boolean>>();
export function warmRecentImage(url: string): Promise<boolean> {
  const existing = inflightImages.get(url);
  if (existing) return existing;
  const pending = loadRecentImage(url).finally(() => inflightImages.delete(url));
  inflightImages.set(url, pending);
  return pending;
}
function loadRecentImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") { resolve(false); return; }
    const image = takeRecentImage(url);
    const done = (ok: boolean) => {
      if (ok) {
        rememberDecodedMediaGeometry(url, image.naturalWidth, image.naturalHeight);
        releaseImage(image);
      } else {
        image.onload = null; image.onerror = null; image.remove(); image.removeAttribute("src");
      }
      resolve(ok);
    };
    image.onload = () => { void image.decode().then(() => done(Boolean(image.naturalWidth && image.naturalHeight)), () => done(false)); };
    image.onerror = () => done(false);
    if (image.complete && image.naturalWidth) { done(true); return; }
    image.decoding = "async";
    image.src = url;
  });
}

export function releaseImage(image: HTMLImageElement) {
  image.onload = null; image.onerror = null; image.remove();
  if (!image.complete || !image.naturalWidth || !image.dataset.lrImageKey) { image.removeAttribute("src"); return; }
  recentImages.set(image, image.dataset.lrImageKey);
  let pixels = [...recentImages.keys()].reduce((total, item) => total + item.naturalWidth * item.naturalHeight, 0);
  while (recentImages.size > MAX_RECENT_IMAGES || pixels > MAX_RECENT_IMAGE_PIXELS) {
    const oldest = recentImages.keys().next().value!;
    pixels -= oldest.naturalWidth * oldest.naturalHeight;
    recentImages.delete(oldest); oldest.removeAttribute("src");
  }
}
