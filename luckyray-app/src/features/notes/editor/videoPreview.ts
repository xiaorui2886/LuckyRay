import { resolveMaterialPreviewTarget } from "../../../core/services/materialCatalog";
import { attachNoteVideoFullscreen } from "../media/noteMediaGeometry";

export type VideoPreviewState = "loading" | "ready" | "error";

/** One element owns decoding; use the existing material authority for genuine image posters. */
export function attachVideoPreview(video: HTMLVideoElement, options: {
  source: string;
  thumbnail?: string | null;
  controls?: boolean;
  onState: (state: VideoPreviewState, message?: string) => void;
  onAspect?: (width: number, height: number) => void;
}) {
  let active = false;
  let disposed = false;
  let userControlled = false;
  const useControls = () => { userControlled = true; active = false; };
  const disposeFullscreen = options.controls ? attachNoteVideoFullscreen(video, useControls) : undefined;
  video.controls = Boolean(options.controls);
  if (options.controls) {
    video.addEventListener("pointerdown", useControls);
    video.addEventListener("keydown", useControls);
  }
  const target = resolveMaterialPreviewTarget({ kind: "video", previewUrl: options.source, thumbnailUrl: options.thumbnail });
  const hasPoster = target?.kind === "image";
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "metadata";
  if (hasPoster) video.poster = target.url;
  else video.removeAttribute("poster");
  const state = (value: VideoPreviewState, message?: string) => { if (!disposed) options.onState(value, message); };
  const ready = () => { if (video.readyState >= 2 && !video.seeking) state("ready"); };
  const play = () => {
    if (disposed || !active) return;
    video.play().then(() => { if (disposed || (!active && !userControlled)) video.pause(); else ready(); }).catch((error: DOMException) => {
      if (disposed || !active || error.name === "AbortError") return;
      if (video.error) failure();
      else state(hasPoster || video.readyState >= 2 ? "ready" : "error", error.name === "NotAllowedError"
        ? "浏览器阻止了视频播放，请打开文件播放"
        : "视频播放请求失败，请重试或打开文件播放");
    });
  };
  const showFrame = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    // Same bounded preview position as the existing Materials hover preview.
    const previewTime = Math.min(0.25, video.duration / 2);
    if (Math.abs(video.currentTime - previewTime) > 0.01) {
      try { video.currentTime = previewTime; } catch { state("error", "视频预览帧无法读取，请打开文件检查"); }
    } else ready();
  };
  const metadata = () => {
    if (disposed) return;
    options.onAspect?.(video.videoWidth, video.videoHeight);
    if (active) play(); else showFrame();
  };
  const failure = () => state("error", video.error?.code === 3
    ? "视频解码失败，请检查编码或文件是否损坏"
    : video.error?.code === 4
      ? "视频源不可用或格式不受支持，请打开文件检查"
      : "视频预览读取失败，请检查文件是否可访问");
  video.addEventListener("loadedmetadata", metadata);
  video.addEventListener("loadeddata", ready);
  video.addEventListener("seeked", ready);
  video.addEventListener("error", failure);
  state(hasPoster ? "ready" : "loading");
  video.src = options.source;
  return {
    enter() { if (!disposed && !userControlled) { active = true; play(); } },
    leave() { if (!disposed && !userControlled) { active = false; video.pause(); showFrame(); } },
    destroy() {
      disposeFullscreen?.();
      disposed = true;
      active = false;
      video.removeEventListener("loadedmetadata", metadata);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("seeked", ready);
      video.removeEventListener("error", failure);
      video.removeEventListener("pointerdown", useControls);
      video.removeEventListener("keydown", useControls);
      video.pause(); video.removeAttribute("src"); video.load();
    },
  };
}
