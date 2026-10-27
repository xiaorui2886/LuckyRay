import { validShot, type StoryboardShot } from "../../core/canvas/storyboard";

/** The same labelled script travels with its card; it is not a model prompt. */
export function CanvasShotSummary({
  shot,
  onOpen,
  english = false,
}: {
  shot?: StoryboardShot;
  onOpen?: () => void;
  english?: boolean;
}) {
  if (!validShot(shot)) return null;
  return (
    <section
      className="canvas-shot-summary nodrag nopan nowheel"
      aria-label={english ? "Shot script" : "镜头脚本"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div>
        <span>{english ? "Shot" : "镜头"}</span>
        <strong>
          {shot.title || (english ? "Untitled shot" : "未命名镜头")}
        </strong>
        {onOpen ? (
          <button type="button" onClick={onOpen}>
            {english ? "Open storyboard" : "打开分镜"}
          </button>
        ) : null}
      </div>
      {shot.description ? (
        <p>
          <span>{english ? "Visual" : "画面"}</span>
          {shot.description}
        </p>
      ) : null}
      {shot.action ? (
        <p>
          <span>{english ? "Action" : "运镜"}</span>
          {shot.action}
        </p>
      ) : null}
      {shot.dialogue ? (
        <p>
          <span>{english ? "Dialogue" : "台词"}</span>
          {shot.dialogue}
        </p>
      ) : null}
    </section>
  );
}
