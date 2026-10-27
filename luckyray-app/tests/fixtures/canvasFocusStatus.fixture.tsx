import { createRoot } from "react-dom/client";
import { CanvasFocusStatus } from "../../src/features/canvas/CanvasFocusStatus";
export function mountFocusStatusFixture(
  target: HTMLElement,
  body: HTMLDivElement,
) {
  const root = createRoot(target);
  const host = { current: body };
  let exits = 0;
  const render = (busy = false, english = false, status = "点击图片标记焦点") =>
    root.render(
      <CanvasFocusStatus
        host={host}
        busy={busy}
        english={english}
        status={status}
        onExit={() => exits++}
      />,
    );
  render();
  return { root, render, exits: () => exits };
}
