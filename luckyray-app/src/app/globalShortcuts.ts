import { SHORTCUT_COMMANDS, getShortcutValue, type ShortcutCommandId } from "./shortcuts";

export const GLOBAL_SHORTCUTS: ShortcutCommandId[] = SHORTCUT_COMMANDS
  .filter((command) => "desktopGlobal" in command && command.desktopGlobal)
  .map((command) => command.id);

const GLOBAL_SHORTCUT_LABELS: Partial<Record<ShortcutCommandId, string>> = {
  globalSearch: "Global search",
  commandPalette: "Command palette",
  captureClip: "Quick clipboard capture",
};

const GLOBAL_SHORTCUT_FALLBACKS: Partial<Record<ShortcutCommandId, string[]>> = {
  globalSearch: ["Ctrl+Alt+K", "Ctrl+Shift+F", "Ctrl+Alt+Space"],
  commandPalette: ["Ctrl+Alt+P", "Ctrl+Alt+Shift+P", "Ctrl+Shift+K"],
  captureClip: ["Ctrl+Alt+C", "Ctrl+Alt+Shift+C", "Ctrl+Alt+V"],
};

type RegisteredShortcut = {
  id: ShortcutCommandId;
  shortcut: string;
};

type ShortcutSnapshotItem = {
  id: string;
  name?: string;
  value: string;
};

export type GlobalShortcutRegistrationStatus = {
  available: boolean;
  registered: RegisteredShortcut[];
  failures: Array<RegisteredShortcut & { message: string }>;
  updatedAt: number;
};

export type GlobalShortcutSuggestion = {
  id: ShortcutCommandId;
  name: string;
  failedShortcut: string;
  message: string;
  suggestions: string[];
};

const GLOBAL_SHORTCUT_STATUS_KEY = "luckyray-global-shortcut-status-v1";
const GLOBAL_SHORTCUT_STATUS_EVENT = "luckyray:global-shortcut-status";

function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error");
}

function publishGlobalShortcutStatus(status: GlobalShortcutRegistrationStatus) {
  try {
    localStorage.setItem(GLOBAL_SHORTCUT_STATUS_KEY, JSON.stringify(status));
  } catch {
    // Keep the event path even when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<GlobalShortcutRegistrationStatus>(GLOBAL_SHORTCUT_STATUS_EVENT, { detail: status }));
}

export function readGlobalShortcutStatus(): GlobalShortcutRegistrationStatus | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(GLOBAL_SHORTCUT_STATUS_KEY);
    return raw ? JSON.parse(raw) as GlobalShortcutRegistrationStatus : null;
  } catch {
    return null;
  }
}

export function subscribeGlobalShortcutStatus(handler: (status: GlobalShortcutRegistrationStatus) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => handler((event as CustomEvent<GlobalShortcutRegistrationStatus>).detail);
  window.addEventListener(GLOBAL_SHORTCUT_STATUS_EVENT, listener);
  return () => window.removeEventListener(GLOBAL_SHORTCUT_STATUS_EVENT, listener);
}

function normalizeShortcutForTauri(value: string): string | null {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;

  const modifiers: string[] = [];
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "commandorcontrol") modifiers.push("CommandOrControl");
    else if (lower === "cmd" || lower === "command" || lower === "meta") modifiers.push("Command");
    else if (lower === "shift") modifiers.push("Shift");
    else if (lower === "alt" || lower === "option") modifiers.push("Alt");
    else if (lower === "esc") key = "Escape";
    else if (lower === "space") key = "Space";
    else key = part.length === 1 ? part.toUpperCase() : part;
  }

  if (!key) return null;
  return [...new Set(modifiers), key].join("+");
}

function normalizeShortcutForComparison(value: string): string {
  return (normalizeShortcutForTauri(value) || value).toLowerCase();
}

function suggestFromCurrentShortcut(value: string): string[] {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  const key = [...parts].reverse().find((part) => {
    const lower = part.toLowerCase();
    return !["ctrl", "control", "cmd", "command", "meta", "shift", "alt", "option"].includes(lower);
  });
  if (!key) return [];
  return [`Ctrl+Alt+${key}`, `Ctrl+Alt+Shift+${key}`];
}

function uniqueShortcuts(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeShortcutForComparison(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

function canRegisterAsDesktopGlobalShortcut(value: string): boolean {
  const normalized = normalizeShortcutForTauri(value);
  if (!normalized) return false;
  const parts = normalized.toLowerCase().split("+");
  const key = parts[parts.length - 1] || "";
  const hasAlt = parts.includes("alt");
  const isFunctionKey = /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(key);
  return hasAlt || isFunctionKey;
}

export function getGlobalShortcutSuggestions(
  status: GlobalShortcutRegistrationStatus | null,
  shortcuts: ShortcutSnapshotItem[],
): GlobalShortcutSuggestion[] {
  if (!status?.failures.length) return [];
  const failures = status.failures.filter((item) => GLOBAL_SHORTCUTS.includes(item.id));
  if (!failures.length) return [];

  const failedIds = new Set(failures.map((item) => item.id));
  const reserved = new Set<string>();
  for (const item of shortcuts) {
    if (failedIds.has(item.id as ShortcutCommandId)) continue;
    const normalized = normalizeShortcutForComparison(item.value);
    if (normalized) reserved.add(normalized);
  }
  for (const item of status.registered) {
    const normalized = normalizeShortcutForComparison(item.shortcut);
    if (normalized) reserved.add(normalized);
  }

  const claimed = new Set<string>();
  return failures.map((failure) => {
    const current = shortcuts.find((item) => item.id === failure.id);
    const failedShortcut = current?.value || failure.shortcut;
    const failedNormalized = normalizeShortcutForComparison(failedShortcut);
    const candidates = uniqueShortcuts([
      ...(GLOBAL_SHORTCUT_FALLBACKS[failure.id] || []),
      ...suggestFromCurrentShortcut(failedShortcut),
    ]);
    const suggestions = candidates.filter((candidate) => {
      const normalized = normalizeShortcutForComparison(candidate);
      if (!normalized || normalized === failedNormalized) return false;
      if (reserved.has(normalized) || claimed.has(normalized)) return false;
      claimed.add(normalized);
      return true;
    });
    return {
      id: failure.id,
      name: current?.name || GLOBAL_SHORTCUT_LABELS[failure.id] || failure.id,
      failedShortcut,
      message: failure.message,
      suggestions,
    };
  });
}

function readGlobalShortcuts(): RegisteredShortcut[] {
  const seen = new Set<string>();
  const shortcuts: RegisteredShortcut[] = [];
  for (const id of GLOBAL_SHORTCUTS) {
    const value = getShortcutValue(id);
    if (!canRegisterAsDesktopGlobalShortcut(value)) continue;
    const shortcut = normalizeShortcutForTauri(value);
    if (!shortcut || seen.has(shortcut)) continue;
    seen.add(shortcut);
    shortcuts.push({ id, shortcut });
  }
  return shortcuts;
}

async function showWindowFromGlobalShortcut() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_window");
  } catch {
    // Browser mode or plugin-less shell: keep application shortcuts as the fallback.
  }
}

export function registerLuckyRayGlobalShortcuts(onCommand: (command: ShortcutCommandId) => void): () => void {
  let disposed = false;
  const registered: string[] = [];

  void (async () => {
    try {
      const { register, unregister } = await import("@tauri-apps/plugin-global-shortcut");
      const requested = readGlobalShortcuts();
      const failures: GlobalShortcutRegistrationStatus["failures"] = [];
      for (const item of requested) {
        if (disposed) break;
        try {
          await register(item.shortcut, (event) => {
            if (event.state !== "Pressed") return;
            void showWindowFromGlobalShortcut();
            onCommand(item.id);
          });
          registered.push(item.shortcut);
        } catch (error) {
          failures.push({ ...item, message: serializeError(error) });
          console.warn(`[luckyray] global shortcut ${item.shortcut} registration failed`, error);
        }
      }
      publishGlobalShortcutStatus({
        available: true,
        registered: requested.filter((item) => registered.includes(item.shortcut)),
        failures,
        updatedAt: Date.now(),
      });
      if (disposed && registered.length) {
        await unregister(registered).catch(() => undefined);
      }
    } catch {
      // Running in a browser tab or without the desktop plugin.
    }
  })();

  return () => {
    disposed = true;
    if (!registered.length) return;
    void import("@tauri-apps/plugin-global-shortcut")
      .then(({ unregister }) => unregister(registered))
      .catch(() => undefined);
  };
}
