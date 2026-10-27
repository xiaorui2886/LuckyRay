import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveContainedMaterialMediaRect, resolveMaterialMediaDimensions } from "../src/features/materials/materialViewerInteraction.ts";
import { SHORTCUT_REFERENCE_GROUPS, matchingShortcutReferences } from "../src/app/shortcutReference.ts";
import { SHORTCUT_COMMANDS } from "../src/app/shortcuts.ts";
const source = (name: string) => readFileSync(new URL('../'+name, import.meta.url), 'utf8');
test('small images upscale to contain while landscape and portrait retain ratio', () => {
 assert.deepEqual(resolveContainedMaterialMediaRect({width:1000,height:600},{width:100,height:100}), {width:600,height:600});
 assert.deepEqual(resolveContainedMaterialMediaRect({width:1000,height:600},{width:4000,height:2000}), {width:1000,height:500});
 assert.deepEqual(resolveContainedMaterialMediaRect({width:1000,height:600},{width:200,height:400}), {width:300,height:600});
 for (const width of [0,-1,NaN,Infinity]) assert.deepEqual(resolveContainedMaterialMediaRect({width,height:600},{width:100,height:100}),{width:0,height:0});
});
test('dimensions from another material/revision cannot affect the current viewer', () => {
 const snap={assetId:'a',sourceUrl:'blob:a',sourceIdentity:'v1',width:30,height:20};
 assert.equal(resolveMaterialMediaDimensions(snap,'b','blob:a','v1'),null);
 assert.equal(resolveMaterialMediaDimensions(snap,'a','blob:a','v2'),null);
 assert.deepEqual(resolveMaterialMediaDimensions(snap,'a','blob:a','v1'),{width:30,height:20});
});
test('viewer image receives the same explicit contain rectangle as video (source contract)', () => {
 const page=source('src/features/materials/MaterialsPage.tsx');
 assert.match(page,/variant="viewer"[\s\S]{0,600}style=\{containedVideoStyle\}/);
 assert.match(page,/style=\{style\}/);
});
test('materials and tags share one accessible selection check (source contract)', () => {
 assert.match(source('src/features/materials/MaterialsPage.tsx'),/<SelectionCheck/);
 assert.match(source('src/features/tags/TagDetail.tsx'),/<SelectionCheck/);
 assert.match(source('src/components/SelectionCheck.tsx'),/role="checkbox" aria-checked=\{checked\}/);
});
test('native film hardware fallback retains bounded total deadline and existing source/cancel gates (static contract, not Rust execution)', () => {
 const native=source('src-tauri/src/material_native_video/preview.rs');
 assert.match(native,/-hwaccel/); assert.match(native,/timeline_hardware_candidate\(metadata.as_ref\(\), cover\)/);
 assert.match(native,/if Instant::now\(\) >= deadline \{ return Err\(error\); \}/);
 assert.match(native,/cover, false, deadline/); assert.match(native,/native_video_source\(&asset, &revision\)/);
 assert.match(native,/remember_software_only\(&source_key\)/);
});
test('fixed shortcut references are separate from configurable registry and include view owners', () => {
 assert.ok(SHORTCUT_COMMANDS.length>35);
 assert.equal(new Set(SHORTCUT_COMMANDS.map(c=>c.id)).size,SHORTCUT_COMMANDS.length);
 for (const group of SHORTCUT_REFERENCE_GROUPS) { assert.ok(group.source); assert.ok(group.rows.length); for(const row of group.rows) assert.ok(row.every(Boolean)); }
 assert.ok(SHORTCUT_REFERENCE_GROUPS.some(g=>g.title==='图片对比'));
 assert.ok(SHORTCUT_REFERENCE_GROUPS.some(g=>g.scope==='knowledge'));
 assert.ok(SHORTCUT_REFERENCE_GROUPS.some(g=>g.scope==='canvas'));
});

test('fixed-key search crosses scopes and searches both localized group titles', () => {
 assert.ok(matchingShortcutReferences('global','F3').some(group=>group.scope==='knowledge'));
 assert.ok(matchingShortcutReferences('global','折叠').some(group=>group.scope==='knowledge'));
 assert.ok(matchingShortcutReferences('materials','Menus and dialogs').some(group=>group.scope==='global'));
 assert.ok(matchingShortcutReferences('canvas','').every(group=>group.scope==='canvas'));
 assert.deepEqual(matchingShortcutReferences('global','not-a-real-shortcut'),[]);
});
