import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const repoUrl = new URL("../", import.meta.url);

const source = (path: string) => readFile(new URL(path, repoUrl), "utf8");

test("notes titlebar actions stay hidden until the knowledge snapshot is usable", async () => {
  const sidebar = await source("src/app/AppSidebar.tsx");

  // The gate reuses the existing typed knowledge loading authority.
  assert.match(sidebar, /import \{ hasUsableKnowledgeSnapshot, knowledgeStore \} from "\.\.\/core\/services\/knowledgeStore";/);
  assert.match(sidebar, /const notesTitlebarActionsReady = hasUsableKnowledgeSnapshot\(knowledgeSnapshot\);/);
  assert.match(
    sidebar,
    /useSyncExternalStore\(subscribeKnowledgeStore, knowledgeStore\.getSnapshot, knowledgeStore\.getSnapshot\)/,
  );

  // Split controls and every notes new-tab button respect the gate: the three
  // titlebar action surfaces (split panes, child split strip, tab strip).
  assert.match(sidebar, /isNotes && notesTitlebarActionsReady && notesTitlebarSplit/);
  assert.match(sidebar, /isNotesHorizontalSplit && notesTitlebarActionsReady/);
  assert.match(sidebar, /\{notesTitlebarActionsReady && \(<>/);
});

test("knowledge usability flips once and stays stable across background refreshes", async () => {
  const store = await source("src/core/services/knowledgeStore.ts");
  // `loaded` never resets while content stays usable, so actions will not
  // flash away during a background refresh.
  assert.match(store, /status: this\.snapshot\.loaded \? "refreshing" : "loading"/);
  assert.match(store, /export function hasUsableKnowledgeSnapshot\(snapshot: Pick<KnowledgeStoreSnapshot, "loaded">\): boolean \{\s*return snapshot\.loaded;\s*\}/);
});
