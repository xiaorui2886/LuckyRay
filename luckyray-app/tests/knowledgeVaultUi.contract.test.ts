import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  mergeKnownNotesVaults,
  readKnownNotesVaults,
  rememberKnownNotesVault,
} from "../src/features/notes/knownVaults.ts";

const repoUrl = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, repoUrl), "utf8");
}

function vault(id: string, rootPath: string, lastOpenedAt: string) {
  return {
    id,
    name: id,
    rootPath,
    mode: "vault-bound",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastOpenedAt,
    schemaVersion: 1,
  };
}

test("known Vault references are bounded, path-deduplicated presentation data", () => {
  const older = vault("old", "C:\\Knowledge\\Main", "2026-08-01T00:00:00.000Z");
  const replacement = vault("new", "c:/knowledge/main/", "2026-08-03T00:00:00.000Z");
  const second = vault("second", "D:/Notes", "2026-08-02T00:00:00.000Z");
  const moved = vault("second", "E:/Moved Notes", "2026-08-04T00:00:00.000Z");
  const merged = mergeKnownNotesVaults([older], [second, replacement, moved]);
  assert.deepEqual(merged.map((item) => item.id), ["second", "new"]);
  assert.equal(merged[0].rootPath, "E:/Moved Notes");

  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  rememberKnownNotesVault(older, storage);
  rememberKnownNotesVault(second, storage);
  rememberKnownNotesVault(replacement, storage);
  assert.deepEqual(readKnownNotesVaults(storage).map((item) => item.id), ["new", "second"]);
});

test("Knowledge Vault UI reuses the sidebar settings asset and switches via the existing authority", async () => {
  const [page, css, sidebar, chrome] = await Promise.all([
    source("src/features/notes/NotesPage.tsx"),
    source("src/features/notes/notes.css"),
    source("src/app/AppSidebar.tsx"),
    source("src/components/editorialContentChrome.css"),
  ]);

  assert.match(page, /assets\/icons\/lightseek-ui-v2\/settings\.svg/);
  assert.doesNotMatch(page, /function IconSettings\(/);
  assert.match(page, /className="notes-vault-settings-icon"/);
  assert.match(page, /knownVaults=\{knownVaultChoices\}/);
  assert.match(page, /onSwitchVault=\{switchKnownVault\}/);
  assert.match(page, /bridge\.openNotesVault\(candidate\.rootPath\)/);
  assert.doesNotMatch(page, /listNotesVaultFiles\(candidate\)|scan|walkDir/);
  assert.match(page, /role="listbox" aria-label=\{t\("editor\.notes\.vault\.switchAria"\)\}/);
  assert.match(page, /className="editorial-dialog-backdrop notes-vault-modal-overlay experience-dialog-backdrop"/);
  assert.match(page, /"editorial-dialog experience-dialog notes-vault-dialog notes-vault-dialog-" \+ panel/);
  assert.match(page, /className="editorial-dialog-body notes-vault-dialog-body"/);
  assert.match(page, /className="editorial-dialog-header-row"/);
  assert.match(page, /notes-vault-header-icon editorial-dialog-header-icon/);
  assert.match(page, /useApplicationModalSurface<HTMLDivElement>\(true, onClose\)/);
  assert.match(page, /ref=\{dialogSurface\.surfaceRef\}/);
  assert.match(page, /onKeyDown=\{dialogSurface\.onSurfaceKeyDown\}/);
  assert.match(page, /onPointerDown=\{dialogSurface\.onBackdropPointerDown\}/);
  assert.match(css, /\.notes-vault-settings-icon\s*\{[^}]*mask:\s*var\(--notes-vault-settings-icon\) center \/ contain no-repeat/s);
  assert.match(css, /\.notes-vault-switch-list\s*\{/);
  assert.match(css, /\.notes-vault-dialog \.notes-index-popover-header\s*\{[^}]*padding:\s*18px 20px 16px;/s);
  assert.match(css, /\.notes-vault-dialog \.notes-index-popover-header \.editorial-dialog-header-row\s*\{[^}]*width:\s*100%;/s);
  assert.match(chrome, /\.editorial-dialog\s*\{/);
  assert.match(sidebar, /settingsIconUrl/);
});

test("Favorites tabs use the theme accent and Settings alone hides the global add control", async () => {
  const [favoriteCss, sidebar] = await Promise.all([
    source("src/features/favorites/favorites.css"),
    source("src/app/AppSidebar.tsx"),
  ]);
  const activeRule = favoriteCss.match(/\.favorites-tabs button\.active\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(activeRule, /var\(--favorite-accent\)/);
  assert.doesNotMatch(activeRule, /rgba\(124,138,255/);
  assert.match(sidebar, /route !== "favorites" && route !== "smart" && route !== "tags" && route !== "settings"/);
});


test("registered Vault locations survive more than twelve recent openings", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key:string)=>values.get(key) || null, setItem:(key:string,value:string)=>{values.set(key,value);} };
  for(let index=0;index<25;index++) rememberKnownNotesVault(vault(`vault-${index}`,`C:/fixture/vault-${index}`,new Date(Date.UTC(2026,8,1,index)).toISOString()),storage);
  const restored=readKnownNotesVaults(storage);
  assert.equal(restored.length,25);
  assert.equal(restored[0].id,"vault-24");
  assert.equal(restored.find(item=>item.id==="vault-0")?.rootPath,"C:/fixture/vault-0");
  rememberKnownNotesVault(vault("vault-0","D:/moved-vault-0","2026-10-01T00:00:00Z"),storage);
  assert.equal(readKnownNotesVaults(storage).length,25);
  assert.equal(readKnownNotesVaults(storage)[0].rootPath,"D:/moved-vault-0");
});

test("attachment empty collection does not direct users to ordinary material import",async()=>{
 const page=await source("src/features/materials/MaterialsPage.tsx");
 const {translate}=await import("../src/core/i18n/index.ts");
 assert.match(page,/attachmentCollection \? "materials.empty.noteAttachments" : selectedFolderId \? "materials.empty.folder" : "materials.empty.library"/);
 assert.match(page,/attachmentCollection && <small[^>]*>\{t\("materials.empty.noteAttachmentsHint"\)\}/);
 assert.equal(translate("zh-CN","materials.empty.noteAttachments"),"暂无笔记附件");
 assert.equal(translate("zh-CN","materials.empty.noteAttachmentsHint"),"在笔记中插入文件后，会显示在这里");
 assert.equal(translate("en-US","materials.empty.noteAttachmentsHint"),"Insert a file in a note to see it here");
});
