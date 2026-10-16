import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CanvasCreativeRail } from "../../src/features/canvas/CanvasCreativeRail";
import { CanvasDeliveryPanel } from "../../src/features/canvas/CanvasDeliveryPanel";
export function mountRail(element: HTMLElement, alwaysVisible = false) {
  const root = createRoot(element),
    events: string[] = [];
  root.render(
    <StrictMode>
      <CanvasCreativeRail
        alwaysVisible={alwaysVisible}
        onAction={(a) => events.push(a)}
      />
    </StrictMode>,
  );
  return { root, events };
}
export function mountDelivery(element: HTMLElement, source: string) {
  const root = createRoot(element),
    events: string[] = [];
  root.render(
    <StrictMode>
      <CanvasDeliveryPanel
        items={[{ id: "a", label: "测试图", kind: "image", source }]}
        onClose={() => events.push("close")}
        onSave={async (bytes) => {
          if (bytes[0] !== 0x50) throw Error("not-zip");
          events.push("save");
          return true;
        }}
      />
    </StrictMode>,
  );
  return { root, events };
}
import { CanvasImageTools } from "../../src/features/canvas/CanvasImageTools";
export function mountImageTools(element: HTMLElement, source: string) {
  const root = createRoot(element),
    events: unknown[] = [];
  root.render(
    <StrictMode>
      <CanvasImageTools
        item={{ id: "a", label: "Synthetic image", kind: "image", source }}
        onClose={() => events.push("close")}
        onSave={async (_item, _blob, edit) => {
          events.push(edit);
          return "saved";
        }}
      />
    </StrictMode>,
  );
  return { root, events };
}
