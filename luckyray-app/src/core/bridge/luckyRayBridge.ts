import type { LuckyRayBridge } from "./bridgeTypes";
export type { LuckyRayBridge } from "./bridgeTypes";
import { installLuckyRayBridge, waitForBridge } from "../../luckyrayBridge";

export function getLuckyRayBridgeSync(): LuckyRayBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __LUCKYRAY__?: LuckyRayBridge }).__LUCKYRAY__ || null;
}

export async function getLuckyRayBridge(): Promise<LuckyRayBridge> {
  return installLuckyRayBridge();
}

export async function waitForLuckyRayBridge(timeoutMs = 3000): Promise<LuckyRayBridge | null> {
  return waitForBridge(timeoutMs);
}

export async function withLuckyRayBridge<T>(task: (bridge: LuckyRayBridge) => Promise<T> | T): Promise<T> {
  const bridge = getLuckyRayBridgeSync() || await getLuckyRayBridge();
  return task(bridge);
}
