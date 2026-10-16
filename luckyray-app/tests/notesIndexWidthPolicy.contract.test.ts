// Issue-116 C — notes-index width policy and expand-path efficiency.
//
// Drives the REAL production rules in notesIndexWidth.ts and the NotesPage
// wiring. The previous behaviour: one hard 272 px default for every window
// size, persisted on first render (so it could never follow maximize), and an
// expand toggle that ran side effects inside a state updater.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  NOTES_INDEX_DEFAULT_WIDTH,
  NOTES_INDEX_LARGE_DEFAULT_WIDTH,
  clampNotesIndexWidthTo,
  defaultNotesIndexWidthForViewport,
  isLargeNotesIndexViewport,
  notesIndexRestoreWidth,
  resolveNotesIndexWidth,
} from "../src/features/notes/notesIndexWidth.ts";

test("small windows keep the compact default; large windows default wider", () => {
  assert.equal(defaultNotesIndexWidthForViewport(1280), NOTES_INDEX_DEFAULT_WIDTH);
  assert.equal(defaultNotesIndexWidthForViewport(1599), NOTES_INDEX_DEFAULT_WIDTH);
  assert.equal(isLargeNotesIndexViewport(1599), false);
  assert.equal(isLargeNotesIndexViewport(1600), true);
  assert.equal(defaultNotesIndexWidthForViewport(1600), NOTES_INDEX_LARGE_DEFAULT_WIDTH);
  assert.equal(defaultNotesIndexWidthForViewport(2560), NOTES_INDEX_LARGE_DEFAULT_WIDTH);
});

test("a stored drag preference wins and is clamped to the viewport", () => {
  const stored = resolveNotesIndexWidth({ storedWidth: 420, viewportWidth: 2560 });
  assert.deepEqual(stored, { width: 420, userSet: true });
  // A tiny window cannot honour a huge stored width.
  assert.equal(clampNotesIndexWidthTo(420, 900), 420, "420 <= 900-420=480 上限内原样保留");
});

test("without a preference the width follows the viewport, never forcing either way", () => {
  const unset = resolveNotesIndexWidth({ storedWidth: null, viewportWidth: 2560 });
  assert.deepEqual(unset, { width: NOTES_INDEX_LARGE_DEFAULT_WIDTH, userSet: false });

  // Re-expanding after restore-to-small uses the compact default; after
  // maximize it uses the wide one — no cross-contamination in either
  // direction.
  assert.equal(notesIndexRestoreWidth({ lastExpandedWidth: 320, userSet: false, viewportWidth: 1280 }), NOTES_INDEX_DEFAULT_WIDTH);
  assert.equal(notesIndexRestoreWidth({ lastExpandedWidth: 272, userSet: false, viewportWidth: 1920 }), NOTES_INDEX_LARGE_DEFAULT_WIDTH);
  // A real preference restores to itself.
  assert.equal(notesIndexRestoreWidth({ lastExpandedWidth: 380, userSet: true, viewportWidth: 2560 }), 380);
  // Malformed stored values behave like "no preference".
  assert.deepEqual(
    resolveNotesIndexWidth({ storedWidth: Number.NaN, viewportWidth: 1024 }),
    { width: NOTES_INDEX_DEFAULT_WIDTH, userSet: false },
  );
});

test("NotesPage wires the policy and no longer persists the live default", async () => {
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");

  // The old hard-coded default is gone from the page.
  assert.doesNotMatch(page, /const NOTES_INDEX_DEFAULT_WIDTH = 272/);
  assert.match(page, /notesIndexRestoreWidth\(\{/);
  assert.match(page, /defaultNotesIndexWidthForViewport\(window\.innerWidth\)/);
  assert.match(page, /notesIndexWidthUserSetRef\.current = true/);

  // The live default is never written as a preference.
  assert.match(page, /if \(!notesIndexWidthUserSetRef\.current\) return; \/\/ live default, not a preference/);

  // The expand toggle performs its side effects OUTSIDE the state updater
  // (the updater used to dispatch titlebar events and set width inside
  // setPanelOpen, doubling work under StrictMode).
  assert.doesNotMatch(page, /setPanelOpen\(\(open\) => \{[\s\S]{0,200}publishNotesPanelState/);

  // The localStorage read is a lazy state initializer, not a per-render call
  // (a bare call made the drag drop a frame per pointermove).
  assert.match(page, /const \[notesIndexWidthInitial\] = useState\(readSavedNotesIndexWidth\);/);
  assert.doesNotMatch(page, /const notesIndexWidthInitial = readSavedNotesIndexWidth\(\);/);

  // FolderTree is memoized and its hot callbacks are stable, so toggling the
  // panel (or typing) no longer re-renders a ~420-note tree.
  const tree = await readFile(new URL("../src/features/folders/FolderTree.tsx", import.meta.url), "utf8");
  assert.match(tree, /export const FolderTree = memo\(function FolderTree\(/);
  assert.match(page, /onSelect=\{notesIndexFolderSelect\}/);
  assert.match(page, /onSelectDocument=\{notesIndexSelectDocument\}/);
});

test("index resize drags the live CSS variable and commits once at release", async () => {
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");

  // The drag mutates --notes-index-width directly inside rAF, mirroring the
  // right split divider's live drag; a setState per pointermove re-rendered
  // this whole page per frame and the index trailed the cursor.
  assert.match(page, /setProperty\("--notes-index-width"/);
  assert.match(page, /requestAnimationFrame\(applyLiveWidth\)/);
  assert.doesNotMatch(page, /setNotesIndexWidth\(nextWidth\)/);
  assert.match(page, /setNotesIndexWidth\(latestWidth\)/);

  // The automatic-motion 220ms index transition is !important at (0,4,0), so
  // the plain `.notes-index-resizing` kill rule never reached the panel: every
  // drag update restarted the animation. The resize kill must outrank it.
  const css = await readFile(new URL("../src/features/notes/notes.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.notes-index-resizing \.react-nav-shell\[data-sidebar-motion="automatic"\]\[data-route="notes"\] \.note-backlinks\s*\{\s*transition: none !important;/,
  );

  // At the 240px drag minimum the tab row must fit without scrollbars: tabs
  // share the row (flex 1 1 0) and the row never scrolls horizontally; the
  // content area pins overflow-x hidden so a wide child cannot upgrade the
  // visible axis into a matching scrollbar pair.
  assert.doesNotMatch(css, /\.backlinks-tabs\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.backlinks-tab\s*\{[^}]*flex: 1 1 0/);
  assert.match(css, /\.backlinks-content\s*\{[^}]*overflow-x:\s*hidden/);
});
