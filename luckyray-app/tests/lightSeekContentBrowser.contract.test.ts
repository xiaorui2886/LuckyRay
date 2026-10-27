import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("LightSeek titlebar content browser reuses the existing material, knowledge, and handoff authorities", async () => {
  const [shell, titlebar, page, browser] = await Promise.all([
    source("src/app/AppShell.tsx"),
    source("src/app/AppSidebar.tsx"),
    source("src/features/ai/DshNativeSurfacePage.tsx"),
    source("src/features/ai/LightSeekContentBrowser.tsx"),
  ]);

  assert.match(titlebar, /onToggleAiContentBrowser/u);
  assert.match(titlebar, /titlebar\.ai\.openContentBrowser/u);
  assert.match(shell, /setAiContentBrowserOpen/u);
  assert.doesNotMatch(shell, /luckyray:lsh-content-outside/u, "native composer focus must not dismiss the content drawer");
  assert.doesNotMatch(shell, /closest\("\.lightseek-content-browser, \[data-lightseek-content-toggle\]"\)/u, "outside pointer dismissal stays removed");
  assert.match(shell, /event\.key === "Escape" && !event\.isComposing/u);
  assert.match(shell, /if \(!current\) setAiPersonalBrowserOpen\(false\)/u);
  assert.match(shell, /if \(!current\) setAiContentBrowserOpen\(false\)/u);
  assert.match(page, /contentBrowserOpen \? <LightSeekContentBrowser \/>/u);
  assert.match(browser, /materialStore\.ensureSnapshot/u);
  assert.match(browser, /\(\) => materialStore\.getSnapshot\(\)/u);
  assert.doesNotMatch(browser, /useSyncExternalStore\([^)]*materialStore\.getSnapshot/u);
  assert.match(browser, /listNotes\(\)/u);
  assert.match(browser, /getNote\(note\.id\)/u);
  assert.match(browser, /resolveKnowledgeDocumentAbsolutePath/u);
  assert.doesNotMatch(browser, /projectNoteMaterialEmbedsForLightSeek|note\.prompt|material\.prompt/u);
  assert.match(browser, /resolveMaterialLightSeekAttachments/u);
  assert.match(browser, /openInLightSeek/u);
  assert.doesNotMatch(browser, /new MaterialStore|new KnowledgeStore|setInterval|setTimeout/u);
});
