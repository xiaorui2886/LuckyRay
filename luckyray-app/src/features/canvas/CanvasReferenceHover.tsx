import { canvasReferenceText } from "../../core/canvas/generationInputCompiler";
import {
  referenceIssueText,
  type ReferenceEntry,
} from "../../core/canvas/referencePlan";
import { CanvasReferencePreview } from "./CanvasReferencePreview";
import "./canvasReferenceHover.css";
/** Passive content preview: no repeated title, navigation buttons, or detail-card chrome. */
export function CanvasReferenceHover({
  entry,
  english = false,
}: {
  entry: ReferenceEntry;
  english?: boolean;
}) {
  const ref = entry.reference;
  return (
    <div
      className="canvas-composer-popover canvas-reference-hover"
      role="tooltip"
    >
      {ref.kind === "image" ? (
        <CanvasReferencePreview
          thumbnail={ref.thumbnailUrl}
          original={ref.mediaUrl}
          label={ref.label}
          unavailable={english ? "Preview unavailable" : "预览不可用"}
        />
      ) : ref.kind === "video" ? (
        <CanvasReferencePreview
          thumbnail={ref.thumbnailUrl}
          label={ref.label}
          unavailable={english ? "Video" : "视频"}
        />
      ) : (
        <pre>
          {canvasReferenceText(ref).slice(0, 500) ||
            (english ? "No body text" : "正文为空")}
        </pre>
      )}
      {entry.usage === "label-only" && !entry.issue ? (
        <small>
          {english
            ? "Name only; this channel does not receive the media."
            : "仅作为名称参考，本通道未接收媒体内容"}
        </small>
      ) : null}
      {entry.issue ? (
        <small>{referenceIssueText(entry.issue, english)}</small>
      ) : null}
    </div>
  );
}
