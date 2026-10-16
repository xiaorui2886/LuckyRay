import { useEffect, useRef, useState } from "react";
import { attachVideoPreview, type VideoPreviewState } from "./videoPreview";

export function NoteVideoPreview({ source, thumbnail }: { source: string; thumbnail?: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const controller = useRef<ReturnType<typeof attachVideoPreview> | null>(null);
  const [status, setStatus] = useState<{ state: VideoPreviewState; message?: string }>({ state: "loading" });
  useEffect(() => {
    if (!video.current) return;
    const session = attachVideoPreview(video.current, {
      source, thumbnail, onState: (state, message) => setStatus({ state, message }),
    });
    controller.current = session;
    return () => { session.destroy(); if (controller.current === session) controller.current = null; };
  }, [source, thumbnail]);
  return <span className="note-video-preview" data-video-state={status.state}>
    <video ref={video} className="note-preview-asset-media" muted loop playsInline
      onMouseEnter={() => controller.current?.enter()} onMouseLeave={() => controller.current?.leave()} />
    <span className="lr-live-image-status" role="status" hidden={status.state === "ready" && !status.message}>
      {status.message || "正在读取视频预览帧"}
    </span>
  </span>;
}
