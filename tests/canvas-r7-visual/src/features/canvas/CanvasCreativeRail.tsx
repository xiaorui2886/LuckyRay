import { useEffect, useId, useRef, useState } from "react";
export type CreativeAction = "agent" | "packs" | "workflows" | "editImage" | "export" | "storyboard";
const icons: Record<CreativeAction, string> = {
  agent: "m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z",
  packs: "M4 7h6l2 2h8v11H4zM4 7V4h6l2 2h8v3",
  workflows: "M3 4h6v6H3zM15 8h6v8h-6zM3 15h6v5H3zM9 7h3v5h3M9 17h3v-5",
  editImage: "M5 2v15a2 2 0 0 0 2 2h15M2 5h15a2 2 0 0 1 2 2v15M9 9h6v6",
  storyboard: "M3 4h18v16H3zM3 9h18M3 15h18M9 4v16M15 4v16",
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
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLElement>(null);
  const cancelTimer = () => { clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = () => { cancelTimer(); setHover(false); setPinned(false); setFocus(false); };
  const id = useId();
  const pendingFocus = useRef<number | null>(null);
  const expanded = alwaysVisible || hover || focus || pinned;
  useEffect(() => {
    if (expanded && pendingFocus.current !== null) {
      root.current?.querySelectorAll<HTMLButtonElement>('nav button')[pendingFocus.current]?.focus();
      pendingFocus.current = null;
    }
  }, [expanded]);
  useEffect(() => {
    if (!expanded || alwaysVisible) return;
    const outside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      setHover(false); setPinned(false); setFocus(false);
    };
    // Canvas nodes/panes may stop bubbling; dismissal must not swallow their action.
    document.addEventListener('pointerdown', outside, true);
  
  return () => document.removeEventListener('pointerdown', outside, true);
  }, [expanded, alwaysVisible]);
  const labels = english
    ? ["Canvas Agent", "Reference packs", "Workflow templates", "Image tools", "Storyboard", "Export results"]
    : ["画布 Agent", "参考包", "创作模板", "图片精修", "分镜板", "成品导出"];
  const descriptions = english ? ["", "Keep references together", "Start with a connected structure", "Crop, rotate and resize locally", "Write and arrange your shots", "Save original media as a ZIP"] : ["", "整理角色、产品与风格参考", "从现成结构开始创作", "本地裁剪、旋转与调尺寸", "编排镜头、台词与画面", "打包选中的原始成品"];
  return (
    <aside
      ref={root}
      className={`canvas-creative-rail nodrag nopan nowheel ${expanded ? "is-expanded" : ""}`}
      aria-label={english ? "Creation tools" : "创作工具"}
      onPointerLeave={() => { cancelTimer(); timer.current = setTimeout(() => setHover(false), 160); }}
      onFocusCapture={() => setFocus(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocus(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          close();
          root.current?.querySelector<HTMLButtonElement>(".canvas-creative-rail-handle")?.focus();
          setFocus(false);
          event.stopPropagation();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("nav button") || []);
          if (!items.length) return;
          event.preventDefault();
          setPinned(true);
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowUp" ? (current <= 0 ? items.length - 1 : current - 1) : (current + 1) % items.length;
          if (expanded) items[index]?.focus();
          else pendingFocus.current = index;
        }
      }}
    >
      <button
        type="button"
        className="canvas-creative-rail-handle"
        aria-label={english ? "Show creation tools" : "展开创作工具"}
        aria-controls={id}
        aria-expanded={expanded}
        onPointerEnter={(event) => {
          cancelTimer();
          if (event.pointerType !== "touch" && event.buttons === 0)
            timer.current = setTimeout(() => setHover(true), 240);
        }}
        onPointerLeave={() => cancelTimer()}
        onPointerDown={() => cancelTimer()}
        onClick={() => { cancelTimer(); if (pinned) close(); else setPinned(true); }}
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
        onPointerEnter={() => { cancelTimer(); if (expanded) setHover(true); }}
      >
        {(Object.keys(icons) as CreativeAction[]).map((action, index) => action === 'agent' ? null : (
          <button
            key={action}
            type="button"
            aria-pressed={active === action}
            onClick={() => { close(); onAction(action); }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={icons[action]} />
            </svg>
            <span className="canvas-creative-rail-copy"><strong>{labels[index]}</strong><small>{descriptions[index]}</small></span><svg className="canvas-creative-rail-forward" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          </button>
        ))}
      </nav>
    </aside>
  );
}
