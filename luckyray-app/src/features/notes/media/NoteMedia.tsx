import { attachNoteImage } from "./attachNoteImage";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { attachVideoPreview } from "../editor/videoPreview";
import { openImageViewer } from "./imageViewer";
import { expandNoteVideo, expandMediaIcon, resolveNoteMediaSources, setNoteMediaAspect } from "./noteMediaGeometry";
import { applyRememberedMediaGeometry, readDecodedMediaGeometry, rememberDecodedMediaGeometry } from "./noteMediaReadyCache";
import "./noteMedia.css";

type NoteMediaAsset = { kind?: string; name?: string; previewUrl?: string | null; thumbnailUrl?: string | null };

/** Reading-mode media uses the same geometry and video lifecycle as live widgets. */
export function NoteMedia({ asset, alt, width, height, inline = false, onOpenAsset }: {
  asset: NoteMediaAsset;
  alt: string;
  width?: number | null;
  height?: number | null;
  inline?: boolean;
  onOpenAsset?: () => void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const imageViewport = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const viewer = useRef<(() => void) | null>(null);
  const controller = useRef<ReturnType<typeof attachVideoPreview> | null>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const { videoSource, imageSource } = resolveNoteMediaSources(asset);
  const source = videoSource || imageSource;
  const isVideo = asset.kind?.toLowerCase() === "video";
  // Reserve the space a previous decode already measured, and skip the
  // loading placeholder when this image was already decoded this session:
  // the browser's cache paints it with no visible swap. A cold source keeps
  // the existing placeholder, which the measured aspect keeps the right shape.
  const [status, setStatus] = useState<{ source: string; message: string | null }>(() => ({
    source,
    message: videoSource
      ? "正在读取视频预览帧"
      : imageSource
        ? readDecodedMediaGeometry(imageSource) ? null : "图片加载中"
        : "媒体源不可用，可打开素材检查文件",
  }));
  const fallbackMessage = videoSource
    ? "正在读取视频预览帧"
    : imageSource
      ? readDecodedMediaGeometry(imageSource) ? null : "图片加载中"
      : "媒体源不可用，可打开素材检查文件";
  const message = status.source === source ? status.message : fallbackMessage;
  useEffect(() => () => { viewer.current?.(); }, [source]);
  useEffect(() => {
    if (root.current && source) applyRememberedMediaGeometry(root.current, source);
  }, [source]);
  useEffect(() => {
    if (!videoSource || !video.current) return;
    const session = attachVideoPreview(video.current, {
      source, thumbnail: asset.thumbnailUrl, controls: true,
      onAspect: (w, h) => {
        if (root.current) setNoteMediaAspect(root.current, w, h);
        rememberDecodedMediaGeometry(source, w, h);
      },
      onState: (state, detail) => setStatus({ source, message: detail || (state === "ready" ? null : "正在读取视频预览帧") }),
    });
    controller.current = session;
    return () => { session.destroy(); controller.current = null; };
  }, [source, videoSource, asset.thumbnailUrl]);
  useLayoutEffect(() => {
    if (videoSource || !imageSource || !root.current || !imageViewport.current) return;
    return attachNoteImage({ root: root.current, viewport: imageViewport.current, source: imageSource,
      preview: asset.thumbnailUrl || undefined, alt,
      onState: state => setStatus({ source, message: state === "error" ? "图片读取失败，可打开引用检查文件" : state === "loading" ? "图片加载中" : null }),
    });
  }, [source, imageSource, videoSource, asset.thumbnailUrl, alt]);
  const expand = (opener: HTMLElement) => {
    if (isVideo) {
      if (video.current) void expandNoteVideo(video.current, (detail) => setStatus({ source, message: detail }));
      else onOpenAsset?.();
    } else {
      viewer.current?.();
      viewer.current = openImageViewer({ src: source, alt }, opener);
    }
  };
  const style: CSSProperties = {
    ...(width ? { width: Math.min(Math.max(width, 180), 720) } : {}),
    ...(height ? { "--note-media-height": `${Math.min(height, 720)}px` } as CSSProperties : {}),
  };
  return <span ref={root} className={`note-media${inline ? " inline" : " block"}`} data-kind={isVideo ? "video" : "image"}
    data-media-loading={message ? "true" : undefined} style={style} title={asset.name || alt}
    onMouseEnter={() => controller.current?.enter()} onMouseLeave={() => controller.current?.leave()}>
    <span ref={imageViewport} className="note-media-viewport" onDoubleClick={event => { if (!isVideo) expand(expandButton.current || event.currentTarget); }}>
      {videoSource ? <video ref={video} aria-label={alt} controls playsInline /> : null}
      {message && <span className="note-media-status" role="status">{message}</span>}
    </span>
    <span className="note-media-actions">
      {onOpenAsset && <button type="button" title="打开素材详情" aria-label="打开素材详情" onClick={onOpenAsset}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 2h5v5M8 8l6-6"/></svg>
      </button>}
      <button ref={expandButton} type="button" title={isVideo ? videoSource ? "全屏播放" : "打开视频" : "放大图片"} aria-label={isVideo ? videoSource ? "全屏播放" : "打开视频" : "放大图片"}
        onClick={(event) => expand(event.currentTarget)} dangerouslySetInnerHTML={{ __html: expandMediaIcon }} />
    </span>
  </span>;
}
