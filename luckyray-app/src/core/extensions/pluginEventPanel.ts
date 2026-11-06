import { invoke } from "@tauri-apps/api/core";
import type { PluginUi } from "./runtime";

export type PluginEventKind = "knowledge.saved" | "materials.imported";
export type PluginEventStatus = { state: "running" | "done" | "failed"; ui?: PluginUi; error?: string };

export function pluginEventSubscriptions(id: string): Promise<PluginEventKind[]> {
  return invoke("extension_runtime", { request: JSON.stringify({ op: "eventSubscriptions", id }) });
}

export async function cancelPluginEventSubscription(id: string, kind: PluginEventKind): Promise<void> {
  await invoke("extension_runtime", { request: JSON.stringify({ op: "cancelEventSubscription", id, kind }) });
  window.dispatchEvent(new CustomEvent("luckyray:plugin-subscriptions-changed", { detail: { id } }));
}
