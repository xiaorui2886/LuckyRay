import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=path=>readFileSync(fileURLToPath(new URL(path,import.meta.url)),'utf8');
const css=source('../src/app/appShell.css');
const app=source('../src/app/AppSidebar.tsx');
const rule=selector=>css.slice(css.indexOf(selector+' {')).split('}')[0];
test('horizontal root tabs own only the editor track, never the index track',()=>{
 const block=rule('.react-nav-shell .notes-titlebar-horizontal.notes-titlebar-index-open .notes-titlebar-pane-root');
 assert.match(block,/grid-column:\s*2;/);
 assert.doesNotMatch(block,/padding-left/);
});
test('vertical root tabs reserve index space outside the drop target',()=>{
 const block=rule('.react-nav-shell .notes-titlebar-pane-groups.notes-titlebar-index-open:not(.notes-titlebar-horizontal) .notes-titlebar-pane-root');
 assert.match(block,/margin-left:\s*var\(--notes-index-width\)/);
 assert.doesNotMatch(block,/padding-left/);
});
test('single tab strip unmounts while split-specific targets exist',()=>{
 assert.match(app,/\{!notesTitlebarSplit && <div className=\{`titlebar-tabs/);
 assert.doesNotMatch(app,/style=\{notesTitlebarSplit \? \{[^}]+display:\s*"none"/);
});
