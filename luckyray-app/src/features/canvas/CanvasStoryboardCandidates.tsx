import { useState } from "react";
import type { StoryboardCandidateState } from "../../core/canvas/storyboardCandidates";

/** Candidates stay collapsed until requested; selecting never starts generation. */
export function CanvasStoryboardCandidates({ state, chosenKey, english, resolveUrl, onChoose, onClear }: {
  state: StoryboardCandidateState;
  chosenKey?: string;
  english: boolean;
  resolveUrl: (url: string) => string;
  onChoose?: (key: string) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <div className="canvas-storyboard-candidates" onKeyDown={event => {
    if (open && event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); setOpen(false); }
  }}>
    <div className="canvas-storyboard-candidate-toggle">
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {english ? "Candidates" : "候选"} {state.candidates.length}
      </button>
      {chosenKey ? <small title={english ? "Chosen for export" : "已采用，导出使用此结果"}>✓ {english ? "Chosen" : "已采用"}</small> : null}
    </div>
    {open ? <div className="canvas-storyboard-candidate-picker">
      {!state.candidates.length ? <small>{english ? "No results yet" : "暂无结果"}</small> : null}
      <div className="canvas-storyboard-candidate-grid">
        {state.candidates.map((candidate, index) => {
          const poster = candidate.kind === "video" ? candidate.thumbnailUrl : candidate.thumbnailUrl || candidate.url;
          const chosen = candidate.key === chosenKey;
          return <button type="button" key={candidate.key} aria-pressed={chosen}
            disabled={!candidate.selectable || !onChoose}
            aria-label={`${english ? "Choose candidate" : "采用候选"} ${index + 1}`}
            title={candidate.selectable ? (english ? "Use this result" : "采用此结果") : (english ? "Saved choice" : "已保存的采用结果")}
            onClick={() => onChoose?.(candidate.key)}>
            {poster ? <img src={resolveUrl(poster)} alt="" loading="lazy" /> : <span>{english ? "Video" : "视频"}</span>}
            <small>{chosen ? "✓ " : ""}{index + 1}{candidate.kind === "video" ? (english ? " · Video" : " · 视频") : ""}</small>
          </button>;
        })}
      </div>
      {chosenKey && onClear ? <button type="button" onClick={onClear}>{english ? "Clear choice" : "取消采用"}</button> : null}
      <button type="button" onClick={() => setOpen(false)}>{english ? "Close candidates" : "收起候选"}</button>
    </div> : null}
  </div>;
}
