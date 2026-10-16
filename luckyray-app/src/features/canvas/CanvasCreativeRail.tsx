import { useId, useState } from "react";
export type CreativeAction = "packs" | "workflows" | "editImage" | "export";
const icons: Record<CreativeAction, string> = {
  packs: "M4 7h6l2 2h8v11H4zM4 7V4h6l2 2h8v3",
  workflows: "M3 4h6v6H3zM15 8h6v8h-6zM3 15h6v5H3zM9 7h3v5h3M9 17h3v-5",
  editImage: "M5 2v15a2 2 0 0 0 2 2h15M2 5h15a2 2 0 0 1 2 2v15M9 9h6v6",
  export: "M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5",
};
export function CanvasCreativeRail({
  alwaysVisible,
  active,
  english = false,
  onAction,
}: {
  alwaysVisible: boolean;
  active?: CreativeAction;
  english?: boolean;
  onAction: (action: CreativeAction) => void;
}) {
  const [hover, setHover] = useState(false),
    [focus, setFocus] = useState(false),
    [pinned, setPinned] = useState(false);
  const id = useId();
  const expanded = alwaysVisible || hover || focus || pinned;
  const labels = english
    ? ["Reference packs", "Workflow templates", "Image tools", "Export results"]
    : ["参考包", "创作模板", "图片精修", "成品导出"];
  return (
    <aside
      className={`canvas-creative-rail nodrag nopan nowheel ${expanded ? "is-expanded" : ""}`}
      aria-label={english ? "Creation tools" : "创作工具"}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocusCapture={() => setFocus(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocus(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setPinned(false);
          setHover(false);
          (event.target as HTMLElement).blur();
        }
      }}
    >
      <button
        type="button"
        className="canvas-creative-rail-handle"
        aria-label={english ? "Show creation tools" : "展开创作工具"}
        aria-controls={id}
        aria-expanded={expanded}
        onClick={() => setPinned((v) => !v)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5l7 7-7 7" />
        </svg>
        <span>{english ? "Create" : "创作"}</span>
      </button>
      <nav
        id={id}
        aria-label={english ? "Creation actions" : "创作功能"}
        inert={!expanded}
        aria-hidden={!expanded}
      >
        {(Object.keys(icons) as CreativeAction[]).map((action, index) => (
          <button
            key={action}
            type="button"
            aria-pressed={active === action}
            onClick={() => onAction(action)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={icons[action]} />
            </svg>
            <span>{labels[index]}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
