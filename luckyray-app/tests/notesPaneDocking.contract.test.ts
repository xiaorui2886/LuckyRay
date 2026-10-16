import assert from "node:assert/strict";
import test from "node:test";
import { dockNotesTab, notesDockZoneAt, notesPaneIds, type NotesPaneState } from "../src/features/notes/notesPaneModel";

const ids = { paneId: "new", splitId: "new-split", emptyTab: { id: "empty-new", kind: "empty" as const } };
const a = { id: "real-vault:A.md", kind: "note" as const };
const b = { id: "real-vault:B.md", kind: "note" as const };
const c = { id: "real-vault:C.md", kind: "note" as const };
const single = (): NotesPaneState => ({ layout: { kind: "pane", id: "root" }, tabs: { root: [a, b, c] }, activeTabs: { root: b.id }, activePaneId: "root" });
const split = (): NotesPaneState => ({
  layout: { kind: "split", id: "split", orientation: "row", ratio: .4, first: { kind: "pane", id: "root" }, second: { kind: "pane", id: "other" } },
  tabs: { root: [a, b], other: [c] }, activeTabs: { root: b.id, other: c.id }, activePaneId: "root",
});

test("reordering uses insertion slots on either side without changing document identity", () => {
  const state = single();
  const moved = dockNotesTab(state, { sourcePaneId: "root", tabId: a.id, targetPaneId: "root", zone: "center", targetIndex: 3 }, ids);
  assert.deepEqual(moved.tabs.root, [b, c, a]);
  assert.equal(moved.tabs.root[2], a);
  assert.deepEqual(state.tabs.root, [a, b, c]);
  const back = dockNotesTab(moved, { sourcePaneId: "root", tabId: a.id, targetPaneId: "root", zone: "center", targetIndex: 0 }, ids);
  assert.deepEqual(back.tabs.root, [a, b, c]);
});

test("same-slot drop neither duplicates nor removes a tab", () => {
  for (const targetIndex of [1, 2]) {
    const result = dockNotesTab(single(), { sourcePaneId: "root", tabId: b.id, targetPaneId: "root", zone: "center", targetIndex }, ids);
    assert.deepEqual(result.tabs.root, [a, b, c]);
  }
});

for (const direction of ["left", "right", "up", "down"] as const) {
  test(`directional ${direction} move creates an ordered split using the same document object`, () => {
    const result = dockNotesTab(single(), { sourcePaneId: "root", tabId: b.id, targetPaneId: "root", zone: direction }, ids);
    assert.equal(result.layout.kind, "split");
    if (result.layout.kind !== "split") return;
    assert.equal(result.layout.orientation, direction === "left" || direction === "right" ? "row" : "column");
    assert.deepEqual(notesPaneIds(result.layout), direction === "left" || direction === "up" ? ["new", "root"] : ["root", "new"]);
    assert.deepEqual(result.tabs.root, [a, c]);
    assert.equal(result.tabs.new[0], b);
    assert.equal(result.activeTabs.new, b.id);
    assert.equal(result.activePaneId, "new");
  });
}

test("splitting a sole tab leaves an empty usable source rather than duplicating its document", () => {
  const state = single(); state.tabs.root = [a]; state.activeTabs.root = a.id;
  const result = dockNotesTab(state, { sourcePaneId: "root", tabId: a.id, targetPaneId: "root", zone: "down" }, ids);
  assert.deepEqual(result.tabs.root, [ids.emptyTab]);
  assert.deepEqual(result.tabs.new, [a]);
});

test("cross-pane move collapses the empty source and retains the target active document", () => {
  const result = dockNotesTab(split(), { sourcePaneId: "other", tabId: c.id, targetPaneId: "root", zone: "center", targetIndex: 1 }, ids);
  assert.deepEqual(result.layout, { kind: "pane", id: "root" });
  assert.deepEqual(result.tabs.root, [a, c, b]);
  assert.equal(result.tabs.other, undefined);
  assert.equal(result.activeTabs.root, c.id);
});

test("cross-pane duplicate identities merge into one tab without touching other documents", () => {
  const state = split(); state.tabs.other = [b, c];
  const result = dockNotesTab(state, { sourcePaneId: "root", tabId: b.id, targetPaneId: "other", zone: "center" }, ids);
  assert.deepEqual(result.tabs.root, [a]);
  assert.deepEqual(result.tabs.other, [c, b]);
});

test("nested directional drops collapse only the emptied source branch", () => {
  const state = split();
  const result = dockNotesTab(state, { sourcePaneId: "other", tabId: c.id, targetPaneId: "root", zone: "up" }, ids);
  assert.deepEqual(notesPaneIds(result.layout), ["new", "root"]);
  assert.deepEqual(result.tabs.root, [a, b]);
  assert.deepEqual(result.tabs.new, [c]);
});

test("stale pane/document and invalid zone requests fail closed", () => {
  const state = split();
  for (const patch of [{ sourcePaneId: "gone" }, { targetPaneId: "gone" }, { tabId: "missing" }, { zone: "invalid" }]) {
    assert.equal(dockNotesTab(state, { sourcePaneId: "root", tabId: a.id, targetPaneId: "other", zone: "center", ...patch } as any, ids), state);
  }
});

test("drop hit-testing chooses the nearest edge, center, and cancels outside", () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };
  assert.equal(notesDockZoneAt(rect, 105, 200), "left");
  assert.equal(notesDockZoneAt(rect, 495, 200), "right");
  assert.equal(notesDockZoneAt(rect, 300, 55), "up");
  assert.equal(notesDockZoneAt(rect, 300, 345), "down");
  assert.equal(notesDockZoneAt(rect, 300, 200), "center");
  assert.equal(notesDockZoneAt(rect, 99, 200), null);
  assert.equal(notesDockZoneAt({ ...rect, width: 0 }, 100, 200), null);
});

import { restoreNotesLayoutState, validateNotesLayoutSnapshot, type NotesLayoutSnapshot } from "../src/features/notes/notesPaneModel";
const snapshot = (): NotesLayoutSnapshot => ({ version: 1, vaultId: "vault", state: split(), modes: { root: "live", other: "source" }, indexOpen: true, indexWidth: 320 });
test("layout snapshots validate only current-vault still-open identities", () => {
  assert.equal(validateNotesLayoutSnapshot(snapshot(), "vault", split()), true);
  assert.equal(validateNotesLayoutSnapshot(snapshot(), "other-vault", split()), false);
  const state = split(); state.tabs.other = [];
  assert.equal(validateNotesLayoutSnapshot(snapshot(), "vault", state), false);
});
test("layout restore preserves additional current tabs and the saved active tab", () => {
  const current = split(); const extra = { id: "real-vault:Unsaved.md" }; current.tabs.root.push(extra);
  const saved = snapshot(); saved.state.tabs.root.reverse();
  const result = restoreNotesLayoutState(current, saved);
  assert.deepEqual(result.tabs.root, [b, a, extra]);
  assert.equal(result.activeTabs.root, b.id);
  assert.deepEqual(current.tabs.root, [a, b, extra]);
});
test("malformed, duplicated, cyclic and invalid-ratio layout snapshots reject", () => {
  for (const invalid of [null, {}, { ...snapshot(), indexWidth: Infinity }, { ...snapshot(), state: { ...split(), activePaneId: "missing" } }]) {
    assert.equal(validateNotesLayoutSnapshot(invalid, "vault", split()), false);
  }
  const invalid = snapshot(); invalid.state.layout = { kind: "split", id: "x", orientation: "row", ratio: .5, first: {kind:"pane",id:"root"}, second: {kind:"pane",id:"root"} };
  assert.equal(validateNotesLayoutSnapshot(invalid, "vault", split()), false);
  (invalid.state.layout as any).first = invalid.state.layout;
  assert.equal(validateNotesLayoutSnapshot(invalid, "vault", split()), false);
});

test("cross-pane duplicate insertion slots account for the removed target copy", () => {
  const state = split(); state.tabs.other = [b,c];
  const result = dockNotesTab(state, {sourcePaneId:"root",tabId:b.id,targetPaneId:"other",zone:"center",targetIndex:1}, ids);
  assert.deepEqual(result.tabs.other,[b,c]);
});
