import assert from "node:assert/strict";
import test from "node:test";
import { appDataChildPath, formatShortcutForDisplay, isMacAbsolutePath, isMacPlatform, joinMacPath, macRelativeWatchPath, sameManagedLibraryPath } from "../src/app/macosPresentation.ts";
import { matchesShortcut } from "../src/app/shortcuts.ts";

test("macOS paths preserve case, spaces, unicode, and literal backslashes", () => {
  const platform = "MacIntel";
  const root = "/Users/测试 User/Library/Application Support/com.luckyray.desktop";
  assert.equal(appDataChildPath(root, "asset-library", platform), `${root}/asset-library`);
  assert.equal(appDataChildPath("/", "thumbnails", platform), "/thumbnails");
  assert.equal(appDataChildPath("", "luckyray.db", platform), "");
  assert.equal(sameManagedLibraryPath(`${root}/素材/`, `${root}/素材`, platform), true);
  assert.equal(sameManagedLibraryPath(`${root}/Photos`, `${root}/photos`, platform), false);
  assert.equal(sameManagedLibraryPath(`${root}/image `, `${root}/image`, platform), false);
  assert.equal(sameManagedLibraryPath(`${root}/a\\b`, `${root}/a/b`, platform), false);
  assert.equal(sameManagedLibraryPath("", "/", platform), false);
  assert.equal(joinMacPath(`${root}/a\\b`, "子 文件/note.md"), `${root}/a\\b/子 文件/note.md`);
  assert.equal(joinMacPath("/", "note.md"), "/note.md");
  assert.equal(joinMacPath("", "note.md"), "");
  assert.equal(joinMacPath(root, "../outside"), "");
  assert.equal(joinMacPath(root, "/outside"), "");
  assert.equal(isMacAbsolutePath("/"), true);
  assert.equal(isMacAbsolutePath("relative"), false);
  assert.equal(isMacAbsolutePath("//server/share"), false);
  assert.equal(isMacAbsolutePath("/tmp/../secret"), false);
  assert.equal(isMacAbsolutePath("/tmp/\0secret"), false);
  assert.equal(joinMacPath("/tmp/../elsewhere", "note.md"), "");
  assert.equal(macRelativeWatchPath(root, `${root}/素材/a\\b.md`), "素材/a\\b.md");
  assert.equal(macRelativeWatchPath("/", "/素材/a.md"), "素材/a.md");
  assert.equal(macRelativeWatchPath(root, `${root.toLowerCase()}/other.md`), null);
  assert.equal(macRelativeWatchPath(root, `${root}-other/file.md`), null);
  assert.equal(macRelativeWatchPath(root, `${root}/../outside.md`), null);
});

test("Windows path presentation and comparison preserve their existing behavior", () => {
  const platform = "Win32";
  assert.equal(appDataChildPath("C:\\Users\\Ray", "asset-library", platform), "C:\\Users\\Ray\\asset-library");
  assert.equal(sameManagedLibraryPath(" C:/Users/Ray/Library/ ", "c:\\users\\ray\\library", platform), true);
  assert.equal(formatShortcutForDisplay("Ctrl+Shift+K", platform), "Ctrl+Shift+K");
  assert.equal(isMacPlatform(platform), false);
});

test("macOS shortcut labels match the existing Command modifier handling", () => {
  const platform = "MacIntel";
  assert.equal(isMacPlatform(platform), true);
  assert.equal(formatShortcutForDisplay("Ctrl+S", platform), "Cmd+S");
  assert.equal(formatShortcutForDisplay("Meta+Shift+K", platform), "Cmd+Shift+K");
  assert.equal(formatShortcutForDisplay("CommandOrControl+Alt+K", platform), "Cmd+Option+K");
  assert.equal(formatShortcutForDisplay("navigation notes", platform), "navigation notes");
  const event = { key: "s", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false } as KeyboardEvent;
  assert.equal(matchesShortcut(event, "knowledgeSave", { knowledgeSave: "Ctrl+S" }), true);
  assert.equal(matchesShortcut({ ...event, metaKey: false, ctrlKey: true } as KeyboardEvent, "knowledgeSave", { knowledgeSave: "Ctrl+S" }), true);
});
