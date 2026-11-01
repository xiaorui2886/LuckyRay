import assert from "node:assert/strict";
import test from "node:test";
import { mergeKnownNotesVaults } from "../src/features/notes/knownVaults.ts";

const vault = (id: string, rootPath: string) => ({
  id, name: id, rootPath, mode: "vault-bound", createdAt: "2026-01-01",
  lastOpenedAt: "2026-10-23", schemaVersion: 1,
});

test("macOS saved vaults do not collapse distinct case or literal filename characters", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
    const paths = ["/Volumes/Notes", "/Volumes/notes", "/Volumes/a\\b", "/Volumes/a/b", "/Volumes/trailing ", "/Volumes/trailing"];
    const merged = mergeKnownNotesVaults([], paths.map((path, index) => vault(`v${index}`, path)));
    assert.deepEqual(new Set(merged.map((entry) => entry.rootPath)), new Set(paths));
    assert.equal(merged.length, paths.length);

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "Win32" } });
    const windows = mergeKnownNotesVaults([], [vault("v1", "C:\\Notes\\Main"), vault("v2", "c:/notes/main/")]);
    assert.equal(windows.length, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
