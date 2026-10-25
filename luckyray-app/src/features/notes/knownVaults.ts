import type { BridgeVaultMetadata } from "../../core/bridge/bridgeTypes";

const KNOWN_NOTES_VAULTS_KEY = "luckyray-notes-known-vaults-v1";
// Persist registered locations independently of the recent-menu display size.
const KNOWN_NOTES_VAULTS_LIMIT = 10000;

type VaultReferenceStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;

function vaultPathKey(rootPath: string): string {
  return rootPath.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function isVaultMetadata(value: unknown): value is BridgeVaultMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BridgeVaultMetadata>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.rootPath === "string"
    && candidate.rootPath.trim().length > 0
    && typeof candidate.mode === "string"
    && typeof candidate.createdAt === "string"
    && typeof candidate.lastOpenedAt === "string"
    && typeof candidate.schemaVersion === "number";
}

function openedAt(value: BridgeVaultMetadata): number {
  const parsed = Date.parse(value.lastOpenedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mergeKnownNotesVaults(
  current: readonly BridgeVaultMetadata[],
  incoming: readonly BridgeVaultMetadata[],
): BridgeVaultMetadata[] {
  const byPath = new Map<string, BridgeVaultMetadata>();
  for (const candidate of [...current, ...incoming]) {
    if (!isVaultMetadata(candidate)) continue;
    const key = vaultPathKey(candidate.rootPath);
    const previous = byPath.get(key);
    if (!previous || openedAt(candidate) >= openedAt(previous)) byPath.set(key, candidate);
  }
  const byId = new Map<string, BridgeVaultMetadata>();
  for (const candidate of byPath.values()) {
    const previous = byId.get(candidate.id);
    if (!previous || openedAt(candidate) >= openedAt(previous)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()]
    .sort((left, right) => openedAt(right) - openedAt(left) || left.name.localeCompare(right.name))
    .slice(0, KNOWN_NOTES_VAULTS_LIMIT);
}

export function readKnownNotesVaults(
  storage: VaultReferenceStorage = window.localStorage,
): BridgeVaultMetadata[] {
  try {
    const parsed = JSON.parse(storage.getItem(KNOWN_NOTES_VAULTS_KEY) || "[]") as unknown;
    const vaults = Array.isArray(parsed) ? mergeKnownNotesVaults([], parsed.filter(isVaultMetadata)) : [];
    syncKnownNotesVaultsToNative(vaults);
    return vaults;
  } catch {
    return [];
  }
}

export function rememberKnownNotesVault(
  vault: BridgeVaultMetadata,
  storage: VaultReferenceStorage = window.localStorage,
): BridgeVaultMetadata[] {
  const next = mergeKnownNotesVaults(readKnownNotesVaults(storage), [vault]);
  try {
    storage.setItem?.(KNOWN_NOTES_VAULTS_KEY, JSON.stringify(next));
  } catch {
    // A restricted WebView may deny localStorage; the current Vault remains authoritative.
  }
  syncKnownNotesVaultsToNative(next);
  return next;
}

// Import only the exact saved UI list. No filesystem discovery and no active
// Vault selection. Failure leaves localStorage intact for the next retry.
let lastNativeMigration = "";
let nativeMigration: Promise<void> = Promise.resolve();
export function syncKnownNotesVaultsToNative(vaults: readonly BridgeVaultMetadata[]): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const snapshot = mergeKnownNotesVaults([], vaults);
  const signature = JSON.stringify(snapshot);
  nativeMigration = nativeMigration.then(async () => {
    if (signature === lastNativeMigration) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("knowledge_migrate_saved_vaults", { vaults: snapshot });
    lastNativeMigration = signature;
  }).catch(() => {
    // Offline/older hosts can retry on the next saved-list read or update.
  });
}
