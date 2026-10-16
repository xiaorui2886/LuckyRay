export type WindowChromeTarget =
  | "surface"
  | "label"
  | "button"
  | "input"
  | "textarea"
  | "select"
  | "tab"
  | "link"
  | "contenteditable";

export type WindowChromeInteraction = {
  gestureOwner: "native" | "interactive";
  draggable: boolean;
  selectable: boolean;
};

export const nativeTitlebarDragRegion = { "data-tauri-drag-region": "true" } as const;

export function resolveWindowChromeInteraction(target: WindowChromeTarget): WindowChromeInteraction {
  if (target === "surface" || target === "label") {
    return { gestureOwner: "native", draggable: true, selectable: false };
  }
  return {
    gestureOwner: "interactive",
    draggable: false,
    selectable: target === "input" || target === "textarea" || target === "select" || target === "contenteditable",
  };
}
