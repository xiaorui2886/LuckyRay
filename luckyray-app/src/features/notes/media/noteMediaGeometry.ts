import { resolveMaterialPreviewTarget } from "../../../core/services/materialCatalog";

export function resolveNoteMediaSources(asset: { kind?: string; previewUrl?: string | null; thumbnailUrl?: string | null }) {
  const target = resolveMaterialPreviewTarget(asset);
  const isVideo = asset.kind?.toLowerCase() === "video";
  return {
    videoSource: isVideo ? asset.previewUrl || "" : "",
    imageSource: isVideo ? target?.kind === "image" ? target.url : "" : asset.previewUrl || (target?.kind === "image" ? target.url : ""),
  };
}

/** Geometry and fullscreen controls shared by live widgets and reading media. */
export function setNoteMediaAspect(element: HTMLElement, width: number, height: number) {
  if (width > 0 && height > 0) {
    element.style.setProperty("--note-media-ratio", String(width / height));
    element.style.setProperty("--note-media-intrinsic-width", `${width}px`);
  }
}

export const expandMediaIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';

const fullscreenSessions = new WeakMap<HTMLVideoElement, { prepare: () => void }>();

/** Keep the document's space and scroll position while the video is in the top
 * layer. Desktop window bounds can return after fullscreenchange, via resize. */
export function attachNoteVideoFullscreen(video: HTMLVideoElement, takeControl: () => void = () => {}) {
  const viewport = video.parentElement;
  const owner = video.ownerDocument;
  const window = owner?.defaultView;
  if (!viewport || !window) return () => {};
  let saved: {
    height: number;
    windowWidth: number;
    windowHeight: number;
    scroll: { element: HTMLElement; top: number; left: number }[];
  } | undefined;
  let fullscreen = false;
  let restoring = false;
  let frame: number | undefined;
  let originalHeight = "";
  const capture = () => {
    if (fullscreen || restoring || owner.fullscreenElement) return;
    const scroll = [];
    for (let element: HTMLElement | null = viewport; element; element = element.parentElement) {
      scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
    }
    saved = { height: viewport.getBoundingClientRect().height, windowWidth: window.innerWidth, windowHeight: window.innerHeight, scroll };
  };
  const prepare = () => {
    if (owner.fullscreenElement) return;
    takeControl();
    restoring = false;
    capture();
  };
  const prepareForKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") prepare();
  };
  const restore = () => {
    if (!restoring || !saved || owner.fullscreenElement) return;
    for (const { element, top, left } of saved.scroll) {
      if (element.isConnected) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    }
    if (window.innerWidth === saved.windowWidth && window.innerHeight === saved.windowHeight) {
      restoring = false;
      capture();
    }
  };
  const afterLayout = () => {
    if (!restoring) return;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      restore();
    });
  };
  const cancelRestoration = () => {
    if (!restoring || owner.fullscreenElement) return;
    restoring = false;
    capture();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  };
  const cancelForScrollKey = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      cancelRestoration();
    }
  };
  const changed = () => {
    if (owner.fullscreenElement === video) {
      takeControl();
      fullscreen = true;
      originalHeight = viewport.style.height;
      if (saved) viewport.style.height = `${saved.height}px`;
    } else if (fullscreen) {
      fullscreen = false;
      viewport.style.height = originalHeight;
      restoring = true;
      afterLayout();
    }
  };
  // Native UA controls can consume pointer events before page listeners. Keep
  // the latest normal layout/ancestor scroll snapshot for that entry path.
  const onScroll = (event: Event) => {
    if ((event.target as HTMLElement)?.contains?.(viewport)) capture();
  };
  const observer = new ResizeObserver(capture);
  observer.observe(viewport);
  const onResize = () => {
    if (restoring) afterLayout();
    else capture();
  };
  fullscreenSessions.set(video, { prepare });
  video.addEventListener("pointerdown", prepare, true);
  video.addEventListener("keydown", prepareForKey, true);
  owner.addEventListener("fullscreenchange", changed);
  owner.addEventListener("scroll", onScroll, true);
  owner.addEventListener("pointerdown", cancelRestoration, true);
  owner.addEventListener("wheel", cancelRestoration, true);
  owner.addEventListener("keydown", cancelForScrollKey, true);
  window.addEventListener("resize", onResize);
  return () => {
    fullscreenSessions.delete(video);
    video.removeEventListener("pointerdown", prepare, true);
    video.removeEventListener("keydown", prepareForKey, true);
    owner.removeEventListener("fullscreenchange", changed);
    owner.removeEventListener("scroll", onScroll, true);
    observer.disconnect();
    owner.removeEventListener("pointerdown", cancelRestoration, true);
    owner.removeEventListener("wheel", cancelRestoration, true);
    owner.removeEventListener("keydown", cancelForScrollKey, true);
    window.removeEventListener("resize", onResize);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    if (fullscreen) viewport.style.height = originalHeight;
  };
}

export async function expandNoteVideo(video: HTMLVideoElement, onError: (message: string) => void) {
  try {
    if (!video.requestFullscreen) throw new Error("Fullscreen unavailable");
    fullscreenSessions.get(video)?.prepare();
    await video.requestFullscreen();
  } catch {
    onError("无法进入全屏，可使用视频控件或打开原文件播放");
  }
}
