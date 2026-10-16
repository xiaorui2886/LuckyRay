import { useEffect, useRef } from "react";
import { NativeFilmTransport, nativeFilmAvailable, transientNativeVideoError } from "./nativeFilmTransport";
import type { NativeVideoMetadata } from "./nativeVideoPreview";

/** Native decoding, browser composition: canvas scrolls/clips with its card.
 * One silent size-limited decoder and one frame request in flight, no moving HWND. */
export function NativeVideoHover({ libraryId, assetId, metadata, position, onProgress }: {
  libraryId: string; assetId: string; metadata: NativeVideoMetadata;
  position: { ratio: number; serial: number }; onProgress: (ratio: number) => void;
}) {
  const surface = useRef<HTMLCanvasElement>(null), player = useRef<NativeFilmTransport | null>(null);
  const latest = useRef({ position, onProgress }); latest.current = { position, onProgress };
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let transport: NativeFilmTransport | null = null;
    const stop = () => { disposed = true; clearTimeout(timer); transport?.close(); player.current = null; };
    window.addEventListener("luckyray:material-viewer-opening", stop);
    // Passing over cards should not repeatedly load the native decoder.
    timer = setTimeout(() => void (async () => {
      if (!await nativeFilmAvailable(true) || disposed || !surface.current) return;
      try {
        transport = new NativeFilmTransport(() => {});
        await transport.open(libraryId, assetId, metadata.sourceRevision, { x: 0, y: 0, width: 1, height: 1 }, true);
        if (disposed) { transport.close(); return; }
        player.current = transport; transport.muted = true;
        transport.currentTime = latest.current.position.ratio * metadata.duration;
        await transport.play();
        const poll = async () => {
          if (disposed || !transport) return;
          const start = performance.now();
          try {
            const frame = await transport.previewFrame();
            if (disposed) return;
            const picture = new Image(); picture.src = frame.src; await picture.decode();
            if (disposed || !surface.current) return;
            const canvas = surface.current;
            if (canvas.width !== picture.width || canvas.height !== picture.height) {
              canvas.width = picture.width; canvas.height = picture.height;
            }
            canvas.getContext('2d')?.drawImage(picture, 0, 0);
            latest.current.onProgress(metadata.duration ? frame.time / metadata.duration : 0);
            const state = await transport.snapshot();
            if (disposed) return;
            if (state.ended) { transport.currentTime = 0; await transport.play(); }
          } catch (e) { if (!transientNativeVideoError(e) && !String(e).includes('frame-not-settled')) { stop(); return; } }
          if (!disposed) timer = setTimeout(() => void poll(), Math.max(0, 1000 / 15 - (performance.now() - start)));
        };
        void poll();
      } catch { stop(); } // Leave the decoded cover visible if a host cannot open.
    })(), 120);
    return () => { stop(); window.removeEventListener("luckyray:material-viewer-opening", stop); };
  }, [libraryId, assetId, metadata.sourceRevision]);
  useEffect(() => { if (player.current) player.current.currentTime = position.ratio * metadata.duration; }, [position.serial]);
  return <canvas ref={surface} className="native-video-hover" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }} />;
}
