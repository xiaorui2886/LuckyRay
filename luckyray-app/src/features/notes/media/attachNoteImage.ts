import { takeRecentImage, releaseImage, warmRecentImage } from "./noteImageResources";
import { applyRememberedMediaGeometry, rememberDecodedMediaGeometry } from "./noteMediaReadyCache";
import { setNoteMediaAspect } from "./noteMediaGeometry";

/** One displayed lease and one shared original decode. A known preview stays
 * mounted until the original is decoded; failure remains visible and honest. */
export function attachNoteImage(options: {
  root: HTMLElement; viewport: HTMLElement; source: string; preview?: string;
  alt: string; onState: (state: "loading" | "preview" | "ready" | "error") => void;
}) {
  const { root, viewport, alt, onState } = options;
  let source = options.source;
  let generation = 0;
  let disposed = false;
  let shown: HTMLImageElement | null = null;
  let originalShown = false;
  const loading = new Set<HTMLImageElement>();
  if (applyRememberedMediaGeometry(root, source) || applyRememberedMediaGeometry(root, options.preview || "")) {
    // A watcher can invalidate every visible URL at once. Reserve the old
    // geometry until new pixels arrive so scrollHeight cannot collapse and
    // clamp the editor's scrollTop to zero before CM restores its anchor.
    viewport.style.aspectRatio = root.style.getPropertyValue("--note-media-ratio");
    viewport.style.maxHeight = "var(--note-media-height, none)";
    viewport.dataset.reservedImage = "true";
  }
  const show = (image: HTMLImageElement, url: string, final: boolean) => {
    loading.delete(image);
    image.onload = null; image.onerror = null;
    if (disposed || (!final && originalShown)) { releaseImage(image); return; }
    originalShown = final;
    image.alt = alt;
    if (shown) { shown.replaceWith(image); releaseImage(shown); }
    else viewport.prepend(image);
    shown = image;
    viewport.style.removeProperty("aspect-ratio");
    viewport.style.removeProperty("max-height");
    delete viewport.dataset.reservedImage;
    rememberDecodedMediaGeometry(url, image.naturalWidth, image.naturalHeight);
    if (!applyRememberedMediaGeometry(root, source)) setNoteMediaAspect(root, image.naturalWidth, image.naturalHeight);
    root.style.setProperty("--asset-aspect", `${image.naturalWidth} / ${image.naturalHeight}`);
    onState(final ? "ready" : "preview");
  };
  const acquire = (url: string, final: boolean) => {
    const revision = generation;
    const image = takeRecentImage(url);
    if (image.complete && image.naturalWidth) { show(image, url, final); return; }
    loading.add(image);
    image.onload = () => { void image.decode().then(() => {
      // Disposal may have returned this decoded node to the pool and another
      // pane may already own it. Only the current lease may mount/release it.
      if (revision === generation && loading.has(image)) show(image, url, final);
    }, () => {
      if (revision !== generation) return;
      if (!loading.delete(image)) return;
      releaseImage(image); if (!disposed && final) onState("error");
    }); };
    image.onerror = () => {
      if (revision !== generation) return;
      if (!loading.delete(image)) return;
      releaseImage(image); if (!disposed && final) onState("error");
    };
    image.src = url;
  };
  const load = (nextSource: string, previewSource?: string) => {
    const revision = ++generation;
    source = nextSource;
    originalShown = false;
    for (const image of loading) releaseImage(image);
    loading.clear();
    const cached = takeRecentImage(source);
    if (cached.complete && cached.naturalWidth) { show(cached, source, true); return; }
    releaseImage(cached);
    // Same-reference refreshes retain their mounted, decoded preview. They
    // never re-key stale pixels as a new version or report the new one ready.
    onState(shown ? "preview" : "loading");
    if (!shown && previewSource && previewSource !== source) {
      const preview = takeRecentImage(previewSource);
      if (preview.complete && preview.naturalWidth) show(preview, previewSource, false);
      else {
        releaseImage(preview);
        void warmRecentImage(previewSource).then(ok => {
          if (disposed || revision !== generation || shown || !ok) return;
          acquire(previewSource, false);
        });
      }
    }
    void warmRecentImage(source).then(ok => {
      if (disposed || revision !== generation) return;
      if (!ok) { onState("error"); return; }
      // Concurrent panes own distinct nodes. If another lease took the pooled
      // node, the browser's decoded cache supplies this one independently.
      acquire(nextSource, true);
    });
  };
  load(source, options.preview);
  const dispose = () => {
    disposed = true;
    for (const image of loading) releaseImage(image);
    loading.clear();
    if (shown) { releaseImage(shown); shown = null; }
  };
  return Object.assign(dispose, { updateSource(nextSource: string, preview?: string) {
    if (!disposed && nextSource !== source) load(nextSource, preview);
  } });
}
