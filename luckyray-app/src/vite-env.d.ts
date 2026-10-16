/// <reference types="vite/client" />

import type { LuckyRayBridge } from "./core/bridge/luckyRayBridge";

declare global {
  interface Window {
    __LUCKYRAY__?: LuckyRayBridge;
  }
}

export {};
