import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveApplicationModalTabTarget } from "../src/app/applicationModalIsolation.ts";

const repoUrl = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, repoUrl), "utf8");
}

test("modal focus resolution wraps at both edges and falls back to the surface", () => {
  const candidate = (tabIndex = 0) => ({
    hidden: false,
    tabIndex,
    getAttribute: () => null,
    hasAttribute: () => false,
    matches: () => false,
    closest: () => null,
    getClientRects: () => [1],
  }) as unknown as HTMLElement;
  const first = candidate();
  const last = candidate();
  const surface = {
    querySelectorAll: () => [first, last],
  } as unknown as HTMLElement;

  assert.equal(resolveApplicationModalTabTarget(surface, first, true), last);
  assert.equal(resolveApplicationModalTabTarget(surface, last, false), first);
  assert.equal(resolveApplicationModalTabTarget(surface, first, false), null);
  assert.equal(resolveApplicationModalTabTarget(surface, null, false), first);

  const emptySurface = { querySelectorAll: () => [] } as unknown as HTMLElement;
  assert.equal(resolveApplicationModalTabTarget(emptySurface, null, false), emptySurface);
});

test("B1 extends the existing application modal authority instead of creating a second manager", async () => {
  const [authority, tags, smart, notes, settings] = await Promise.all([
    source("src/app/applicationModalIsolation.ts"),
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
    source("src/features/notes/NotesPage.tsx"),
    source("src/features/settings/SettingsPage.tsx"),
  ]);

  assert.match(authority, /export function useApplicationModalSurface/);
  assert.match(authority, /useApplicationModalIsolationLease\(active\)/);
  assert.match(authority, /resolveApplicationModalTabTarget/);
  assert.match(authority, /returnFocusRef/);
  assert.match(authority, /document\.addEventListener\("focusin", containFocus, true\)/);
  assert.match(authority, /activeApplicationModalSurfaces/);
  assert.match(authority, /candidate\.closest<HTMLElement>\("\[hidden\], \[aria-hidden='true'\], \[inert\]"\)/);
  assert.match(authority, /candidate\.matches\(":disabled"\)/);
  assert.match(authority, /event\.key === "Escape" && closeOnEscape/);
  assert.match(authority, /event\.target !== event\.currentTarget/);
  assert.match(authority, /restoreApplicationModalFocus\(returnTarget\)/);
  assert.match(authority, /if \(!target\?\.isConnected\) return/);
  assert.equal((authority.match(/createContext(?:<|\()/g) || []).length, 1);

  for (const pilot of [tags, smart, notes, settings]) {
    assert.match(pilot, /useApplicationModalSurface/);
  }
});

test("B1 appearance primitives are theme-derived, motion-bounded, and exclude DSH", async () => {
  const css = await source("src/components/experienceLayer.css");

  for (const token of [
    "--experience-overlay",
    "--experience-surface",
    "--experience-border",
    "--experience-focus-ring",
    "--experience-shadow",
    "--experience-duration-fast",
    "--experience-duration-standard",
    "--experience-easing-standard",
  ]) {
    assert.match(css, new RegExp(token));
  }
  assert.match(css, /var\(--bg-elevated\)/);
  assert.doesNotMatch(css, /--experience-focus-accent/);
  assert.match(css, /\.react-nav-shell \.experience-dialog :is\(button, input, select, textarea\):focus-visible,[\s\S]*?box-shadow:\s*none;/);
  assert.match(css, /\.react-nav-shell \.experience-dialog :is\(input, select, textarea\):focus-visible[\s\S]*?outline-offset:\s*0;/);
  assert.match(css, /var\(--border\)/);
  assert.match(css, /var\(--accent\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:root\[data-animations="off"\]/);
  assert.match(css, /\.react-nav-shell \.settings-confirm\.experience-dialog/);
  assert.match(css, /\.react-nav-shell \.experience-toast\.materials-toast-react/);
  assert.match(css, /\.react-nav-shell \.experience-progress-track\.material-import-progress-track > span/);
  assert.match(css, /\.react-nav-shell \.tag-color-tone/);
  assert.doesNotMatch(css, /dsh-native|DshNative|iframe|webview/iu);
});

test("pilot dialogs keep business copy quiet and use the shared surface anatomy", async () => {
  const [tags, smart, notes, settings] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
    source("src/features/notes/NotesPage.tsx"),
    source("src/features/settings/SettingsPage.tsx"),
  ]);

  const tagDialog = tags.slice(tags.indexOf("function TagDialog"));
  const smartDelete = smart.slice(smart.indexOf("{deleteTarget ?"), smart.indexOf("function SmartFolderOverview"));
  const smartEditor = smart.slice(smart.indexOf("function SmartFolderEditor"), smart.indexOf("function TimeWindow"));
  const vaultDialog = notes.slice(notes.indexOf("function NotesIndexPopover"), notes.indexOf("function KnowledgeSearchDialog"));
  const settingsConfirm = settings.slice(settings.indexOf("{confirmAction &&"), settings.indexOf("const panelSearchText"));

  for (const dialog of [tagDialog, smartDelete, smartEditor, vaultDialog, settingsConfirm]) {
    assert.match(dialog, /experience-dialog/);
    assert.match(dialog, /aria-modal="true"/);
  }
  for (const dialog of [tagDialog, smartDelete, smartEditor, vaultDialog]) {
    assert.doesNotMatch(dialog, /editorial-dialog-kicker|editorial-dialog-subtitle/);
  }
  assert.match(tags, /data-modal-initial-focus/);
  assert.match(smartEditor, /data-modal-initial-focus/);
  assert.doesNotMatch(tags, /autoFocus/);
  assert.doesNotMatch(smartEditor, /autoFocus/);
});

test("existing Settings and Materials notification authorities use the shared toast appearance", async () => {
  const [settings, materials] = await Promise.all([
    source("src/features/settings/SettingsPage.tsx"),
    source("src/features/materials/MaterialsPage.tsx"),
  ]);

  assert.match(settings, /window\.setTimeout\([\s\S]{0,180}, error \? 3000 : 1500\)/);
  const overlay = await source("src/components/ExperienceOverlay.tsx");
  assert.match(materials, /useExperienceNotices\(\)/);
  assert.match(materials, /<ExperienceNotices/);
  assert.match(overlay, /5000 : 3000/);
  for (const view of [settings, overlay]) {
    assert.match(view, /experience-toast/);
    assert.match(view, /aria-live=/);
  }
  assert.doesNotMatch(settings + materials + overlay, /createNotificationStore|NotificationProvider|notificationHistory/);
});

test("Knowledge activity projects the typed store state without fake stages, timers, or percentages", async () => {
  const [notes, css] = await Promise.all([
    source("src/features/notes/NotesPage.tsx"),
    source("src/components/experienceLayer.css"),
  ]);
  const activity = notes.slice(notes.indexOf("function KnowledgeActivity"), notes.indexOf("function NotesPaneTabStrip"));

  assert.match(notes, /useSyncExternalStore/);
  assert.match(notes, /knowledgeStore\.getSnapshot/);
  assert.match(notes, /knowledgeSnapshot\.status/);
  assert.match(notes, /const vaultBootstrapReady = hasUsableKnowledgeSnapshot\(knowledgeSnapshot\)/);
  assert.doesNotMatch(notes, /setVaultBootstrapReady/);
  assert.match(activity, /experience-knowledge-activity/);
  assert.match(activity, /common\.action\.retry/);
  assert.doesNotMatch(activity, /knowledgeSnapshot\.error|<p>\{error\}<\/p>|aria-busy/);
  assert.doesNotMatch(activity, /[\u4e00-\u9fff]/u);
  assert.doesNotMatch(activity, /setTimeout|setInterval|progress:\s*\d|percent|连接仓库.*读取目录.*建立索引/su);
  assert.match(css, /\.experience-knowledge-activity\s*\{[^}]*flex:\s*1 1 auto;[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
  assert.match(css, /\.material-import-progress-track\.experience-progress-track\.indeterminate > span/);
});

test("existing determinate and indeterminate progress stays honest and accessible", async () => {
  const materials = await source("src/features/materials/MaterialsPage.tsx");
  const progress = materials.slice(materials.indexOf("function ImportProgressOverlay"));

  assert.match(progress, /role="progressbar"/);
  assert.match(progress, /aria-valuemin=\{0\}/);
  assert.match(progress, /aria-valuemax=\{100\}/);
  assert.match(progress, /aria-valuenow=\{indeterminate \? undefined : percent\}/);
  assert.match(progress, /experience-progress/);
  assert.doesNotMatch(progress.slice(0, progress.indexOf("function ImportModePrompt")), /aria-busy/);
  assert.doesNotMatch(progress, /progress\.indeterminate[^\n]+\? 100/);
});

test("pilot loading, empty, and error surfaces use the common state appearance", async () => {
  const [tags, smart, notes] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
    source("src/features/notes/NotesPage.tsx"),
  ]);

  assert.match(tags, /experience-skeleton/);
  assert.match(tags, /experience-skeleton" role="status" aria-live="polite"/);
  assert.match(tags, /tag-visually-hidden/);
  assert.match(tags, /experience-empty/);
  assert.match(smart, /experience-skeleton/);
  assert.match(smart, /experience-skeleton" role="status" aria-live="polite"/);
  assert.match(smart, /smart-visually-hidden/);
  assert.match(smart, /experience-empty/);
  assert.match(smart, /experience-error/);
  assert.match(notes, /experience-error/);
});

test("Tag create and rename use a compact equal-size labeled color palette", async () => {
  const [tags, css] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/tags/tags.css"),
  ]);
  const palette = tags.slice(tags.indexOf("function ColorSwatches"), tags.indexOf("function TagDialog"));

  assert.match(palette, /tag-color-field/);
  assert.match(palette, /tag-color-label/);
  assert.match(palette, /aria-labelledby=\{labelId\}/);
  assert.match(palette, /role="radio"/);
  assert.match(palette, /aria-checked=\{selected\}/);
  assert.match(css, /\.tag-color-swatches\s*\{[^}]*grid-template-columns:\s*repeat\(8, 34px\)/s);
  assert.match(css, /\.tag-color-tone\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border-radius:\s*50%/s);
  assert.match(css, /\.tag-color-tone\s*\{[^}]*border:\s*1px solid var\(--text-primary\)/s);
  assert.match(css, /\.tag-color-swatch\.active \.tag-color-tone\s*\{[^}]*box-shadow:/s);
  assert.doesNotMatch(css, /\.tag-color-swatch\.active::before/);
});
