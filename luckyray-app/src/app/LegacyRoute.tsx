// D72: 旧页面路由容器
// 渲染现有 iframe（luckyray-ui.html），保持和当前 App.tsx 一样的行为。
// 当 feature flag 开启时，由 AppShell 决定渲染 React 页面而非此组件。

import { useRef, useCallback } from "react";
import { buildLuckyRayBridge, getDb, dbInitError } from "../App";

export default function LegacyRoute() {
  const frameRef = useRef<HTMLIFrameElement>(null);

  const installBridge = useCallback(async () => {
    const bridge = buildLuckyRayBridge();
    window.__LUCKYRAY__ = bridge;
    const frameWindow = frameRef.current?.contentWindow;
    if (frameWindow) {
      frameWindow.__LUCKYRAY__ = bridge;
      frameWindow.dispatchEvent(new CustomEvent("luckyray:bridge-ready"));
    }
    getDb()
      .then(() => {
        (bridge as Record<string, unknown>).dbInitError = dbInitError;
        const latestFrameWindow = frameRef.current?.contentWindow;
        if (latestFrameWindow) {
          latestFrameWindow.__LUCKYRAY__ = bridge;
          latestFrameWindow.dispatchEvent(new CustomEvent("luckyray:bridge-ready"));
        }
      })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        (bridge as Record<string, unknown>).dbInitError = msg;
      });
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden" }}>
      <iframe
        ref={frameRef}
        className="luckyray-prototype-frame"
        src="/luckyray-ui.html"
        title="luckyray"
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
        onLoad={installBridge}
      />
    </div>
  );
}
