import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const repoUrl = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, repoUrl), "utf8");
}

test("accepted content routes share the Tags heading and page surface without English eyebrows", async () => {
  const [favorites, smart, tags, chrome] = await Promise.all([
    source("src/features/favorites/FavoritesPage.tsx"),
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
    source("src/features/tags/TagsPage.tsx"),
    source("src/components/editorialContentChrome.css"),
  ]);

  assert.doesNotMatch(favorites, /PERSONAL INSPIRATION|favorites-kicker/);
  const overview = smart.slice(smart.indexOf("function SmartFolderOverview"), smart.indexOf("function DefinitionCard"));
  assert.doesNotMatch(overview, /DYNAMIC ORGANIZATION|smart-kicker/);
  for (const page of [favorites, smart, tags]) {
    assert.match(page, /editorial-page-heading/);
  }
  assert.match(chrome, /\.editorial-page-heading h1\s*\{[^}]*font-size:\s*clamp\(25px, 2\.6vw, 34px\)/s);
  assert.match(chrome, /\.editorial-page-surface\s*\{[^}]*background:\s*var\(--bg-base\)/s);
  assert.match(chrome, /--editorial-page-content-max:\s*1480px/);
  assert.match(chrome, /--editorial-page-gutter:\s*clamp\(24px, 3vw, 44px\)/);
  const [favoritesCss, smartCss] = await Promise.all([
    source("src/features/favorites/favorites.css"),
    source("src/features/smartFolders/smartFolders.css"),
  ]);
  assert.match(favoritesCss, /\.react-nav-shell \.favorites-header\.editorial-page-heading\s*\{[^}]*width:\s*min\(var\(--editorial-page-content-max\), calc\(100% - var\(--editorial-page-gutter\) - var\(--editorial-page-gutter\)\)\)[^}]*margin:\s*var\(--editorial-page-gutter\) auto 22px[^}]*padding:\s*0/s);
  assert.match(smartCss, /\.react-nav-shell \.smart-overview, \.react-nav-shell \.smart-detail\s*\{[^}]*width:\s*min\(var\(--editorial-page-content-max\), calc\(100% - var\(--editorial-page-gutter\) - var\(--editorial-page-gutter\)\)\)[^}]*margin:\s*var\(--editorial-page-gutter\) auto 0[^}]*padding:\s*0 0 72px/s);
  assert.match(smartCss, /\.smart-detail h1\s*\{[^}]*font-size:\s*clamp\(25px, 2\.6vw, 34px\)[^}]*font-weight:\s*700[^}]*line-height:\s*1\.18/s);
});

test("Favorites uses the same AppShell inset and one responsive content column as Tags", async () => {
  const [shell, shellCss, favoritesCss] = await Promise.all([
    source("src/app/AppShell.tsx"),
    source("src/app/appShell.css"),
    source("src/features/favorites/favorites.css"),
  ]);

  assert.match(shell, /route === "favorites" \? "favorites-mode"/);
  assert.match(shellCss, /\.react-nav-shell \.content\.favorites-mode,[\s\S]*?\.react-nav-shell \.content\.tags-mode\s*\{\s*padding:\s*0;/);
  assert.match(favoritesCss, /\.favorites-toolbar\s*\{[^}]*width:\s*min\(var\(--editorial-page-content-max\), calc\(100% - var\(--editorial-page-gutter\) - var\(--editorial-page-gutter\)\)\)/s);
  assert.match(favoritesCss, /\.favorites-viewport\s*\{[^}]*padding:\s*0 var\(--editorial-page-gutter\) 64px/s);
  assert.match(favoritesCss, /\.favorites-grid\s*\{[^}]*max-width:\s*var\(--editorial-page-content-max\)/s);
  assert.doesNotMatch(favoritesCss, /max-width:\s*1552px|max-width:\s*calc\(1680px|padding:\s*0 clamp\(24px, 4vw, 64px\)/);
  assert.match(favoritesCss, /@media \(max-width:\s*560px\)[\s\S]*?\.favorites-page\s*\{[^}]*--editorial-page-gutter:\s*16px/s);
});

test("Tags, Smart, and Knowledge dialogs use the direction-neutral experience surface", async () => {
  const [tags, smart, notes, smartCss, tagsCss, notesCss, chrome, experienceCss, closeIcon] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
    source("src/features/notes/NotesPage.tsx"),
    source("src/features/smartFolders/smartFolders.css"),
    source("src/features/tags/tags.css"),
    source("src/features/notes/notes.css"),
    source("src/components/editorialContentChrome.css"),
    source("src/components/experienceLayer.css"),
    source("src/assets/icons/lightseek-ui-v2/close.svg"),
  ]);

  for (const page of [tags, smart, notes]) {
    assert.match(page, /editorial-dialog-backdrop/);
    assert.match(page, /experience-dialog-backdrop/);
    assert.match(page, /experience-dialog/);
    assert.match(page, /editorial-dialog-header-row/);
    assert.match(page, /editorial-dialog-header-icon/);
    assert.match(page, /editorial-dialog-close/);
    assert.match(page, /useApplicationModalSurface/);
  }
  assert.match(experienceCss, /--experience-overlay:/);
  assert.match(experienceCss, /--experience-surface:\s*var\(--bg-elevated\)/);
  assert.match(experienceCss, /--experience-border:/);
  assert.match(experienceCss, /--experience-duration-standard:\s*180ms/);
  assert.match(experienceCss, /\.editorial-dialog-backdrop\.experience-dialog-backdrop\s*\{[^}]*background:\s*var\(--experience-overlay\);[^}]*backdrop-filter:\s*blur\(2px\)/s);
  assert.match(experienceCss, /\.editorial-dialog\.experience-dialog\s*\{[^}]*border-radius:\s*var\(--experience-radius\);[^}]*box-shadow:\s*var\(--experience-shadow\)/s);
  assert.match(chrome, /\.editorial-dialog-head\s*\{[^}]*padding:\s*14px 16px 12px/s);
  assert.match(chrome, /\.editorial-dialog-header-icon\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*border-radius:\s*8px/s);
  assert.match(chrome, /\.editorial-dialog-head h2,[\s\S]*?\.editorial-dialog-title\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*620/s);
  assert.match(chrome, /\.editorial-dialog-close\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border-radius:\s*9px/s);
  assert.match(chrome, /\.editorial-dialog-footer\s*\{[^}]*padding:\s*10px 16px 12px/s);
  assert.doesNotMatch(chrome, /\.editorial-dialog-(?:kicker|subtitle)\s*\{/);
  assert.match(experienceCss, /@keyframes experienceDialogEnter/);
  assert.match(tags, /actions\?:\s*ReactNode/);
  assert.match(tags, /tag-dialog-actions editorial-dialog-footer/);
  assert.match(tagsCss, /\.tag-dialog-header-icon::before\s*\{[^}]*mask:[^}]*tag\.svg/s);
  assert.match(smartCss, /\.smart-dialog-header-icon::before\s*\{[^}]*mask:[^}]*smart-folder\.svg/s);
  assert.match(notesCss, /\.notes-vault-header-icon::before\s*\{[^}]*mask:[^}]*knowledge-library\.svg/s);
  assert.match(closeIcon, /viewBox="0 0 24 24"/);
  assert.match(closeIcon, /stroke-width="1\.75"/);
  assert.doesNotMatch(closeIcon, /<(?:script|image|foreignObject)\b|\b(?:href|xlink:href)=/i);

  const editor = smart.slice(smart.indexOf("function SmartFolderEditor"));
  assert.doesNotMatch(editor, /NEW DYNAMIC VIEW|EDIT DYNAMIC VIEW/);
  assert.ok(editor.indexOf("smart-source-picker") < editor.indexOf('placeholder={t("field.namePlaceholder")}'));
  assert.match(smartCss, /\.smart-dialog\.editor\s*\{[^}]*overflow:\s*hidden/s);
});

test("primary create actions share Canvas sizing, omit visible pluses, and use the app accent", async () => {
  const [tags, smart, canvas, chrome] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
    source("src/features/canvas/CanvasHomePage.tsx"),
    source("src/components/editorialContentChrome.css"),
  ]);

  assert.match(tags, /className="tag-create-button editorial-primary-action"/);
  assert.match(smart, /className="smart-primary-action editorial-primary-action"/);
  assert.match(canvas, /className="canvas-home-primary editorial-primary-action"/);
  assert.doesNotMatch(tags, /tag-create-button[^>]*>[\s\S]*?<span[^>]*>\+<\/span>/);
  assert.doesNotMatch(smart, /smart-primary-action[^>]*>[\s\S]*?<span[^>]*>＋<\/span>/);
  const primaryRule = chrome.match(/\.react-nav-shell \.editorial-primary-action\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(primaryRule, /height:\s*36px/);
  assert.match(primaryRule, /min-height:\s*36px/);
  assert.match(primaryRule, /background:\s*var\(--accent\)/);
  assert.match(primaryRule, /font-size:\s*12px/);
  assert.match(primaryRule, /font-weight:\s*650/);
  assert.match(chrome, /\.react-nav-shell \.editorial-primary-action:hover\s*\{[^}]*background:\s*var\(--accent-hover\)/s);
});

test("Smart overview has one inline automatic-import home beside Quick Views", async () => {
  const [page, autoImport] = await Promise.all([
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
    source("src/features/smartFolders/AutoImportManager.tsx"),
  ]);

  assert.match(page, /role="tablist"/);
  assert.match(page, /role="tab"[\s\S]*快捷视图/);
  assert.match(page, /role="tab"[\s\S]*自动导入/);
  assert.match(page, /activeOverviewTab === "auto-import"/);
  assert.match(page, /<AutoImportManager mode="inline"/);
  assert.match(page, />自动导入<\/button>/);
  assert.doesNotMatch(page, /autoImportSummary|sourceCount/);
  assert.match(page, /快捷视图/);
  assert.doesNotMatch(page, /内置视图/);
  assert.doesNotMatch(autoImport, /role="dialog"|smart-dialog-backdrop|aria-haspopup="dialog"|AUTOMATIC IMPORT/);
  assert.doesNotMatch(autoImport, /const \[open, setOpen\]/);
  const smartCss = await source("src/features/smartFolders/smartFolders.css");
  assert.match(smartCss, /\.smart-auto-import-region\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent/s);
  assert.match(smartCss, /\.smart-section-heading, \.smart-auto-import-inline-head\s*\{/);
  assert.match(autoImport, /addMaterialWatchSource/);
  assert.match(autoImport, /updateMaterialWatchSource/);
  assert.match(autoImport, /removeMaterialWatchSource/);
});

test("Tags and Smart details share the exact compact return action", async () => {
  const [tags, smart, shell] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
    source("src/app/AppShell.tsx"),
  ]);

  assert.match(tags, /className="tag-back-button editorial-back-action"[\s\S]*<span>返回<\/span>/);
  assert.match(smart, /className="smart-back editorial-back-action"[\s\S]*<span>返回<\/span>/);
  assert.doesNotMatch(tags, />返回全部标签</);
  assert.doesNotMatch(smart, />全部智能文件夹</);
  assert.match(tags, /window\.location\.hash\s*=\s*tagDetailHash\(tag\.id\)/);
  assert.match(tags, /window\.location\.hash\s*=\s*"#tags"/);
  assert.match(shell, /route === "tags" && hashPath\.split\("\/"\)\[1\]/);
  assert.match(shell, /route === "smart" && hashPath\.split\("\/"\)\[1\]/);
  assert.match(shell, /window\.location\.hash = route === "tags" \? "#tags" : "#smart"/);
  assert.match(shell, /canGoBack=\{contextualChildOpen \|\| navState\.index > 0\}/);
  assert.match(shell, /<TagsPage hashPath=\{hashPath\} \/>/);
});

test("Tags detail actions use the audited rounded assets at the unified hit and glyph sizes", async () => {
  const [page, css, edit, merge, remove] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/tags/tags.css"),
    source("src/assets/icons/lightseek-ui-v2/tag-edit-rounded.svg"),
    source("src/assets/icons/lightseek-ui-v2/tag-merge-rounded.svg"),
    source("src/assets/icons/lightseek-ui-v2/tag-delete-rounded.svg"),
  ]);

  assert.match(page, /tag-edit-rounded\.svg/);
  assert.match(page, /tag-merge-rounded\.svg/);
  assert.match(page, /tag-delete-rounded\.svg/);
  assert.match(css, /\.tag-detail-btn\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px;[^}]*border-radius:\s*12px/s);
  assert.match(css, /\.tag-detail-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/s);
  for (const asset of [edit, merge, remove]) {
    assert.match(asset, /viewBox="0 0 24 24"/);
    assert.match(asset, /stroke-width="1\.75"/);
    assert.match(asset, /stroke-linecap="round"/);
    assert.match(asset, /stroke-linejoin="round"/);
    assert.doesNotMatch(asset, /<(?:script|image|foreignObject)\b|\b(?:href|xlink:href)=/i);
  }
});

test("Canvas Home keeps one save-filter handler in the exact Recent Canvas toolbar order", async () => {
  const [page, css] = await Promise.all([
    source("src/features/canvas/CanvasHomePage.tsx"),
    source("src/features/canvas/canvasHome.css"),
  ]);
  const actions = page.match(/<div className="canvas-home-head-actions">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.ok(actions.indexOf("新建画布") < actions.indexOf("保存为智能文件夹"));
  assert.ok(actions.indexOf("保存为智能文件夹") < actions.indexOf("刷新"));
  assert.equal((page.match(/保存为智能文件夹/g) || []).length, 1);
  assert.match(page, /className="canvas-home-primary editorial-primary-action"/);
  assert.match(css, /\.canvas-home-kicker\s*\{[^}]*color:\s*var\(--accent\)/s);
  assert.doesNotMatch(css, /\.canvas-home-save-smart\s*\{/);
});
