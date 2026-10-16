// D65-R1 正式画布 bridge 入口修复
// 把 App.tsx 内的 bridge 组装逻辑抽到独立模块，
// 让 main.tsx 的 #canvas-main / #canvas-spike 路由也能复用，
// 避免正式画布入口因绕过 App.tsx 拿不到桥。

import type { LuckyRayBridge } from "./core/bridge/bridgeTypes"; // Runtime App import below is intentionally retained.

let installedBridge: LuckyRayBridge | null = null;
let installingPromise: Promise<LuckyRayBridge> | null = null;

// 标记：本模块必须被 App.tsx 或 main.tsx 加载一次。
// 优先复用已安装的 bridge，避免重复初始化。
export function isBridgeInstalled(): boolean {
  return installedBridge !== null || (typeof window !== "undefined" && !!(window as any).__LUCKYRAY__);
}

// 内部注入到 window.__LUCKYRAY__，并广播 luckyray:bridge-ready 事件。
// 同时确保已挂过的对象（重复调用）不会丢函数。
function attachToWindow(bridge: LuckyRayBridge) {
  if (typeof window === "undefined") return;
  (window as any).__LUCKYRAY__ = bridge;
  window.dispatchEvent(new CustomEvent("luckyray:bridge-ready"));
}

// 安装 LuckyRay bridge 到 window.__LUCKYRAY__。
// 返回安装好的 bridge 对象，调用方可继续注入到 iframe.contentWindow。
// 重复调用返回同一对象，幂等。
export async function installLuckyRayBridge(): Promise<LuckyRayBridge> {
  if (installedBridge) {
    attachToWindow(installedBridge);
    return installedBridge;
  }
  if (installingPromise) return installingPromise;

  installingPromise = (async (): Promise<LuckyRayBridge> => {
    // 这里直接 import App.tsx 让它的副作用/函数定义跑起来；
    // 然后从 App 模块取它已经组装好的全局对象。
    // 简化做法：让 App.tsx 暴露 buildBridge()，下面 import 后调用。
    const mod = await import("./App");
    const bridge = mod.buildLuckyRayBridge();
    installedBridge = bridge;
    attachToWindow(bridge);
    return bridge;
  })();

  return installingPromise;
}

// 给 main.tsx 用的便捷等待：bridge 已在 window 上时立即 resolve。
export function waitForBridge(timeoutMs = 3000): Promise<LuckyRayBridge | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const existing = (window as any).__LUCKYRAY__ as LuckyRayBridge | undefined;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("luckyray:bridge-ready", handler);
      resolve(null);
    }, timeoutMs);
    const handler = () => {
      clearTimeout(timer);
      window.removeEventListener("luckyray:bridge-ready", handler);
      const b = (window as any).__LUCKYRAY__ as LuckyRayBridge | undefined;
      resolve(b || null);
    };
    window.addEventListener("luckyray:bridge-ready", handler);
  });
}
