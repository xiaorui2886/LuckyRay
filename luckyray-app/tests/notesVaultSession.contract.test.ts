// R3 batch A — vault-switch session isolation.
//
// These tests drive the REAL production rules from vaultSessionBarrier.ts (the
// same authority NotesPage consults), not a parallel model. They were written
// against the pre-fix behaviour and fail there (the tab strip was shared
// across vaults; async continuations had no session token to validate).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  LEGACY_NOTE_TABS_STATE_KEY,
  createVaultSessionAuthority,
  noteTabsStorageKey,
  persistNoteTabsForVault,
  readSavedNoteTabsForVault,
} from "../src/features/notes/vaultSessionBarrier.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    dump: () => values,
  };
}

test("a session token minted before a vault switch stops authorising results afterwards", () => {
  const authority = createVaultSessionAuthority();
  const cs = authority.begin("vault-cs");
  assert.ok(authority.isCurrent(cs, "vault-cs"));

  // The switch: vault 22 begins its own session. Every continuation still
  // holding the CS token must be rejected — including one that also checks
  // the vault id, because the id alone moved on.
  const twentyTwo = authority.begin("vault-22");
  assert.equal(authority.isCurrent(cs), false, "stale token is rejected");
  assert.equal(authority.isCurrent(cs, "vault-cs"), false, "stale token with old vault id is rejected");
  assert.ok(authority.isCurrent(twentyTwo, "vault-22"), "current token is accepted");
  assert.ok(authority.currentVaultId(), "vault-22");

  // A→B→A: returning to the first vault mints a NEW token; the original CS
  // token stays dead, so a very late CS response cannot re-enter either.
  const csAgain = authority.begin("vault-cs");
  assert.ok(authority.isCurrent(csAgain, "vault-cs"));
  assert.equal(authority.isCurrent(cs), false, "the original token never revives");
  assert.equal(authority.latest() > cs, true, "tokens are monotonic");
});

test("tokens are never reused and an invalidated authority authorises nothing", () => {
  const authority = createVaultSessionAuthority();
  assert.equal(authority.currentVaultId(), null);
  assert.equal(authority.isCurrent(authority.latest()), false, "no session before begin()");

  const token = authority.begin("vault-a");
  authority.invalidate();
  assert.equal(authority.isCurrent(token), false);
  assert.equal(authority.currentVaultId(), null);
  assert.equal(authority.isCurrent(authority.begin("vault-b")), true, "a fresh session works after invalidate");
});

test("the saved tab strip is scoped per vault and cannot leak through colliding paths", () => {
  const storage = memoryStorage();
  // Pre-upgrade state: one shared slot holding vault CS's tabs.
  storage.setItem(LEGACY_NOTE_TABS_STATE_KEY, JSON.stringify({
    tabs: [{ id: "real-vault:链接.md", kind: "note" }],
    activeId: "real-vault:链接.md",
  }));

  // First open of vault 22 after the upgrade: no own slot yet, so the legacy
  // payload is still readable (the caller filters by the vault's note ids).
  const legacy = readSavedNoteTabsForVault("vault-22", storage);
  assert.ok(legacy, "legacy payload is readable on first open");
  assert.deepEqual(legacy.tabs, [{ id: "real-vault:链接.md", kind: "note" }]);

  // Vault 22 persists its own tabs…
  persistNoteTabsForVault("vault-22", JSON.stringify({
    tabs: [{ id: "real-vault:链接.md", kind: "note", title: "22 的链接" }],
    activeId: "real-vault:链接.md",
  }), storage);
  assert.ok(storage.dump().has(noteTabsStorageKey("vault-22")), "vault 22 owns a slot");

  // …and from now on vault 22 never sees the legacy (potentially CS) payload
  // again, even though the note ids collide.
  const after = readSavedNoteTabsForVault("vault-22", storage);
  assert.deepEqual(
    after.tabs,
    [{ id: "real-vault:链接.md", kind: "note", title: "22 的链接" }],
    "own slot wins over the shared legacy slot",
  );

  // A different vault reading the same legacy slot gets it only until it has
  // persisted its own — and its own slot is disjoint from vault 22's.
  persistNoteTabsForVault("vault-cs", JSON.stringify({
    tabs: [{ id: "real-vault:链接.md", kind: "note", title: "CS 的链接" }],
    activeId: null,
  }), storage);
  const csRead = readSavedNoteTabsForVault("vault-cs", storage);
  assert.deepEqual(csRead.tabs, [{ id: "real-vault:链接.md", kind: "note", title: "CS 的链接" }]);
  assert.notDeepEqual(
    readSavedNoteTabsForVault("vault-22", storage).tabs,
    csRead.tabs,
    "same relative path in two vaults stays two different tab strips",
  );
});

test("malformed saved state fails closed instead of restoring garbage", () => {
  const storage = memoryStorage();
  storage.setItem(noteTabsStorageKey("vault-x"), "{not json");
  assert.equal(readSavedNoteTabsForVault("vault-x", storage), null);
  storage.setItem(noteTabsStorageKey("vault-x"), JSON.stringify({ activeId: "a" }));
  assert.equal(readSavedNoteTabsForVault("vault-x", storage), null, "tabs must be an array");
  assert.equal(readSavedNoteTabsForVault("vault-never", storage), null, "unknown vault has no state");
});

test("NotesPage consults the session authority on every vault activation and pane load", async () => {
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");

  // The production authority is constructed and used — not a parallel model.
  assert.match(page, /import \{[^}]*createVaultSessionAuthority[^}]*\} from "\.\/vaultSessionBarrier"/);
  assert.match(page, /const vaultSessionRef = useRef\(createVaultSessionAuthority\(\)\)/);

  // Every vault activation mints a session: the switch path, the re-enter
  // path and the bootstrap path (a bootstrap that skips begin() would leave
  // the first vault's session unguarded).
  const begins = page.match(/vaultSessionRef\.current\.begin\(/g) ?? [];
  assert.ok(begins.length >= 3, `every vault activation mints a session (found ${begins.length})`);

  // Async continuations validate the session after awaiting a document.
  assert.match(page, /const paneSession = vaultSessionRef\.current\.latest\(\)/);
  assert.match(page, /if \(!vaultSessionRef\.current\.isCurrent\(paneSession\)\) return false;/);

  // The full reset clears the pane state that outlived switches before.
  assert.match(page, /setNotesPaneDocuments\(\{\}\)/);
  assert.match(page, /notesPaneDocumentCacheRef\.current\.clear\(\)/);
  // Full flat views replaced the old pane-only editor refs. Both view ownership
  // and every live/source/content ref must be retired at the vault barrier.
  assert.match(page, /notesPaneViewsRef\.current\.clear\(\)/);
  assert.match(page, /notesViewRefsRef\.current\.clear\(\)/);
  assert.match(page, /notesPaneScrollPositionsRef\.current\.clear\(\)/);

  // Tab persistence is vault-scoped and the restore syncs the ref it reads.
  assert.match(page, /persistNoteTabsForVault\(/);
  assert.match(page, /readSavedNoteTabsForVault\(/);
  assert.match(page, /openTabsRef\.current = normalizedTabs/);

  // The old draft is flushed BEFORE the write source flips to the new vault,
  // so an old note's content can never be written through the new vault's
  // identity at a colliding relative path.
  const activation = page.slice(page.indexOf("const activateRealVault"), page.indexOf("setCurrentVault(vault);"));
  const resetAt = activation.indexOf("resetActiveDocumentForSource(");
  const flipAt = activation.indexOf("activateKnowledgeWritesForVault(");
  assert.ok(resetAt >= 0 && flipAt >= 0 && resetAt < flipAt,
    "activateRealVault flushes the old draft before switching the write source");
});
