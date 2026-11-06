import { useSyncExternalStore } from "react";
import { normalizeGenerationConcurrencyPolicy, type GenerationConcurrencyPolicy } from "../canvas/generationScheduler";
const KEY = "luckyray.generationConcurrency.v1";
let cached: GenerationConcurrencyPolicy | undefined;
const listeners = new Set<() => void>();
export function readGenerationConcurrencyPolicy(): GenerationConcurrencyPolicy {
  if (!cached) {
    let value: unknown;
    try { value = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* Defaults; no destructive overwrite. */ }
    cached = normalizeGenerationConcurrencyPolicy(value);
  }
  return cached;
}
export function saveGenerationConcurrencyPolicy(value: unknown) {
  const next = normalizeGenerationConcurrencyPolicy(value);
  localStorage.setItem(KEY, JSON.stringify(next));
  cached = next;
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useGenerationConcurrencyPolicy() { return useSyncExternalStore(subscribe, readGenerationConcurrencyPolicy, readGenerationConcurrencyPolicy); }
