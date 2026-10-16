import { useRef, type PointerEvent } from "react";
import { filmPreciseTime, filmTime, type FilmMark, type FilmThumbnail } from "./materialFilmTools";

type Props = {
  duration: number; time: number; thumbs: FilmThumbnail[]; line: boolean; marks: FilmMark[];
  thumbState: "loading" | "ready" | "partial" | "unavailable";
  range: { start: number | null; end: number | null } | null; selected: string | null;
  seek: (value: number) => void; select: (mark: FilmMark) => void;
  scrub: (active: boolean) => void;
};

/** A media locator, not an editing timeline. Markers/ranges never move source bytes. */
export function MaterialFilmTimeline({ duration, time, thumbs, line, thumbState, marks, range, selected, seek, select, scrub }: Props) {
  const pointer = useRef<number | null>(null);
  const locate = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width > 0) seek(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * duration);
  };
  const finish = () => { if (pointer.current !== null) { pointer.current = null; scrub(false); } };
  const percent = (value: number) => duration ? Math.max(0, Math.min(100, value / duration * 100)) : 0;
  return <div className="material-film-locator">
    <div className="material-film-ticks" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i}>{filmTime(duration * i / 4)}</span>)}</div>
    <div className={`material-film-timeline ${!line ? "filmstrip" : "line"}`} aria-busy={!line && thumbState === "loading"}>
      {!line && thumbState !== "ready" && <span className="material-film-thumb-status" role="status">{thumbState === "loading" ? "正在生成时间线预览…" : thumbState === "partial" ? "部分预览未生成，仍可定位播放" : "时间线预览不可用，仍可定位"}</span>}
      {!line && thumbs.length > 0 && <div className="material-film-thumbs" aria-hidden="true">{thumbs.map(frame => <img key={frame.time} src={frame.src} data-sample-time={frame.time} alt="" draggable={false} style={{ left: `${percent(frame.start)}%`, width: `${percent(frame.end) - percent(frame.start)}%` }}/>)}</div>}
      <div className="material-film-progress" style={{ width: `${percent(time)}%` }}/>
      {range && <div className="material-film-draft-range" aria-label="片段草稿" style={{ left: `${percent(range.start ?? range.end ?? 0)}%`, width: `${range.start !== null && range.end !== null ? percent(range.end) - percent(range.start) : 0}%` }}/>}
      <div className="material-film-seek" role="slider" tabIndex={0} aria-label="视频时间线" aria-valuemin={0} aria-valuemax={duration || 1} aria-valuenow={time} aria-disabled={!duration} aria-valuetext={`${filmPreciseTime(time)} / ${filmTime(duration)}`}
        onPointerDown={event => { if (event.button !== 0 || !duration) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); scrub(true); locate(event); }}
        onPointerMove={event => { if (pointer.current === event.pointerId) { event.preventDefault(); locate(event); } }}
        onPointerUp={event => { if (pointer.current === event.pointerId) { locate(event); finish(); event.currentTarget.releasePointerCapture(event.pointerId); } }}
        onPointerCancel={finish} onLostPointerCapture={finish} onBlur={finish}/>
      <div className="material-film-playhead" aria-hidden="true" style={{ left: `${percent(time)}%` }}/>
      <div className="material-film-marks">{marks.map(mark => <button key={mark.id} title={`${filmPreciseTime(mark.start)} ${mark.note || "标记"}`} aria-label={`${mark.end === null ? "标记" : "片段"} ${filmTime(mark.start)} ${mark.note}`} aria-pressed={selected === mark.id}
        style={{ left: `${percent(mark.start)}%`, ...(mark.end !== null ? { width: `${percent(mark.end) - percent(mark.start)}%` } : {}) }} className={mark.end !== null ? "range" : ""} onClick={() => select(mark)}/>)}</div>
    </div>
  </div>;
}
