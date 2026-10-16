import React from "react";
import ReactDOM from "react-dom/client";
import { applyGlobalSettings, readSavedSettings } from "./features/settings/useSettings";
import { syncWindowSurfaceBackground } from "./app/windowSurfaceBackground";
import { nativeWorkspaceWindowRole } from "./workspace/windowBootstrap";
import { preloadDshBackgroundAtStartup } from "./core/services/dshBackgroundPreload";
import "./App.css";

// D40 护栏说明：
// - luckyray 当前 UI 仍挂在 public/luckyray-ui.html（Vite 仅把它当 static 资源）。
// - App.tsx 主要职责是 TypeScript 端的"能力层"：桥定义 + DB fallback + 缩略图 + 导入/导出逻辑。
// - HTML 通过 window.__LUCKYRAY__ = { ... } 挂载这些能力；React 化时直接 import App.tsx 的导出即可。
// - D41 起新增的 React 组件请优先用 App.tsx 的导出函数，避免再在 HTML 里复制一份实现。
// D42 护栏补充：
// - 旧"收集"页（page-capture）已重写为 page-community（技能/扩展/模板/本地安装状态）。
// - 旧收集箱降级到 设置 → 通用 → 收集历史 折叠面板，仅读 collection_failure / collection_item 历史。
// - 浏览器插件默认直收集；收集箱仅作为失败兜底/手动补录。
// - 远程市场 / 账号 / 评论评分 / 模板安装/卸载 后端对接暂不实现（任务卡明令禁止）。
// D43 护栏补充：
// - 画布 spike 是隔离实验：仅通过 #canvas-spike hash 路由访问，不进主导航，不接主数据。
// - 数据走 localStorage key "luckyray-canvas-spike-v1"，不影响素材库/知识库/AI。
// - 评估期：100 节点不卡顿、500 节点记录观察结果；不替 1.0 画布做技术选型承诺。
// D65 护栏更新：
// - #canvas-spike 与 #canvas-main 都进入正式画布（沿用 D65 文件存储），保留 #canvas-spike 作为兼容入口。
// - 正式用户入口推荐用 #canvas-main（由 page-canvas 跳转）。
// - 压测按钮已从 CanvasSpike 移除，正式页无 DEV 控件。
// D72 护栏：
// - 非画布路由走 AppShell（feature flag 分流：React 页面 or 旧 HTML iframe）
// - 画布路由不变（#canvas-main / #canvas-spike 仍走 CanvasSpike）
// - flag 默认全 false，用户无感知

const root = document.getElementById("root") as HTMLElement;

// Correct the prepaint hint from the same persisted settings authority before any async route work.
applyGlobalSettings(readSavedSettings());
void syncWindowSurfaceBackground();
document.documentElement.dataset.themeReady = "true";

// D76-R2: 所有路由统一基础样式，防止非画布路由（AppShell/LegacyRoute）布局异常
// 画布路由在 boot() 中会追加 canvas 专用样式覆盖
(function applyBaseStyles() {
  const style = document.createElement("style");
  style.id = "luckyray-base-styles";
  style.textContent = "html,body,#root{height:100%;width:100%;margin:0;padding:0;overflow:hidden}";
  document.head.appendChild(style);
})();

const CANVAS_ROUTES = ["#canvas-spike", "#canvas-main"];

function isCanvasRoute(): boolean {
  return CANVAS_ROUTES.some((r) => window.location.hash.startsWith(r));
}

async function boot() {
  // The product entry belongs only to Main. Independent windows are withdrawn;
  // their saved records must not bootstrap a child or inherit Main's services.
  if ('__TAURI_INTERNALS__' in window) {
    const {getCurrentWindow}=await import('@tauri-apps/api/window');
    const nativeWindowLabel = getCurrentWindow().label;
    nativeWorkspaceWindowRole(nativeWindowLabel);
    const {installWorkspaceLifecycle}=await import('./workspace/windowLifecycle');
    await installWorkspaceLifecycle();
    // Only the verified Main renderer owns full hidden host/surface preparation.
    // Do not await it: Settings/materials/notes remain usable while it warms.
    void preloadDshBackgroundAtStartup(nativeWindowLabel);
  }
  // 画布路由：独立渲染 CanvasSpike（和 D65 一样）
  if (isCanvasRoute()) {
    const { installLuckyRayBridge } = await import("./luckyrayBridge");
    await installLuckyRayBridge();
    const { default: CanvasSpike } = await import("./CanvasSpike");
    root.innerHTML = "";
    document.title = "LuckyRay 画布";
    document.body.style.margin = "0";
    const style = document.createElement("style");
    style.textContent = "html, body, #root { height: 100%; overflow: hidden; }";
    document.head.appendChild(style);
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <CanvasSpike />
      </React.StrictMode>
    );
    return;
  }

  // 非画布路由：走 AppShell（feature flag 分流）
  const { default: AppShell } = await import("./app/AppShell");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AppShell />
    </React.StrictMode>
  );
}

boot().catch((error) => {
  console.error("[luckyray] boot failed", error);
  // Fail closed even when native identity/lifecycle bootstrap failed. Rendering
  // App here would install the Main legacy bridge in a scoped content window.
  ReactDOM.createRoot(root).render(
    <div role="alert" style={{ padding: 24 }}>
      <h1>无法打开此窗口</h1>
      <p>窗口初始化失败。请保留其他窗口中的未保存内容，然后重试。</p>
    </div>
  );
});
