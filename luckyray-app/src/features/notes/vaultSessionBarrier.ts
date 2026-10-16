// Vault session barrier for the Notes editor.
//
// The Notes page keeps a lot of per-vault session state: split-pane layouts,
// pane tabs, per-pane documents, in-flight loads and the persisted tab strip.
// Real-vault note ids are relative-path scoped (`real-vault:<relativePath>`),
// so two different vaults can produce the SAME note id for different content.
// Anything that survives a vault switch — or any async result that resolves
// after one — can therefore present, or even save, one vault's document under
// another vault's identity.
//
// This module owns the two rules that close that class of leaks:
//
//  1. A session token. Every vault activation mints a new one; every async
//     continuation validates it before applying results. A late response from
//     a previous session can never write state into the current one.
//  2. Vault-scoped tab persistence. The saved tab strip is keyed by vault id,
//     so restoring workspace tabs for vault B can never resurrect vault A's
//     tabs through a colliding relative path.
//
// It is deliberately dependency-free and synchronous so the real rules can be
// exercised directly in tests.

export interface VaultSessionAuthority {
  /** The vault id of the current session, or null before the first begin(). */
  currentVaultId(): string | null;
  /** Mint a new session for `vaultId`. Invalidates every earlier token. */
  begin(vaultId: string): number;
  /** The latest token. Tokens from earlier sessions are never reused. */
  latest(): number;
  /**
   * True when `token` was minted by the current session (and, when given,
   * still for the same vault). A read failure-style API is intentionally not
   * provided: the answer must be a definite boolean, never a fallback.
   */
  isCurrent(token: number, vaultId?: string): boolean;
  /** Drop the session without starting a new one (used by full resets). */
  invalidate(): void;
}

export function createVaultSessionAuthority(): VaultSessionAuthority {
  let session = 0;
  let vaultId: string | null = null;
  return {
    currentVaultId: () => vaultId,
    begin(nextVaultId: string): number {
      session += 1;
      vaultId = nextVaultId;
      return session;
    },
    latest: () => session,
    isCurrent(token: number, expectedVaultId?: string): boolean {
      if (token <= 0) return false;
      if (token !== session) return false;
      if (expectedVaultId !== undefined && vaultId !== expectedVaultId) return false;
      return true;
    },
    invalidate(): void {
      session += 1;
      vaultId = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Vault-scoped note-tab persistence.
// ---------------------------------------------------------------------------

/** Legacy key: shared across vaults. Kept only so old payloads can be read
 *  once (filtered by the target vault's note ids) and then superseded. */
export const LEGACY_NOTE_TABS_STATE_KEY = "luckyray-notes-tabs-state-v1";
const ANOTHER_LEGACY_NOTE_TABS_STATE_KEY = "luckyray.openNoteTabs.v1";

export interface SavedNoteTabsState {
  tabs: unknown;
  activeId: string | null;
}

export type NotesTabStorage = Pick<Storage, "getItem" | "setItem">;

/** The storage slot that belongs to exactly one vault. */
export function noteTabsStorageKey(vaultId: string): string {
  return `luckyray-notes-tabs-state-v2:${vaultId}`;
}

/**
 * Read the saved tab strip for `vaultId`. Prefers this vault's own slot; only
 * falls back to the legacy shared slots when the vault has no slot yet (first
 * open after the upgrade). The caller must still filter the returned tabs by
 * the vault's real note ids — keying alone narrows the blast radius, the
 * filter is what makes it exact.
 */
export function readSavedNoteTabsForVault(vaultId: string, storage: NotesTabStorage): SavedNoteTabsState | null {
  const own = storage.getItem(noteTabsStorageKey(vaultId));
  if (own !== null) return parseSavedNoteTabs(own);
  const legacy = storage.getItem(LEGACY_NOTE_TABS_STATE_KEY)
    ?? storage.getItem(ANOTHER_LEGACY_NOTE_TABS_STATE_KEY);
  if (legacy === null) return null;
  return parseSavedNoteTabs(legacy);
}

export function persistNoteTabsForVault(
  vaultId: string,
  payload: string,
  storage: NotesTabStorage,
): void {
  // The vault's own slot is authoritative. The legacy shared slot is also
  // refreshed so a downgrade keeps some tab state instead of reading another
  // vault's; it can no longer feed this vault because the own slot exists.
  storage.setItem(noteTabsStorageKey(vaultId), payload);
  storage.setItem(LEGACY_NOTE_TABS_STATE_KEY, payload);
}

function parseSavedNoteTabs(raw: string | null): SavedNoteTabsState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedNoteTabsState>;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return { tabs: parsed.tabs, activeId: typeof parsed.activeId === "string" ? parsed.activeId : null };
  } catch {
    return null;
  }
}
