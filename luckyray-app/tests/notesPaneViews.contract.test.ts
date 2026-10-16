import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NotesPaneViews} from '../src/features/notes/notesPaneViews';
import type {NotesPaneLayout,NotesPaneTabs} from '../src/features/notes/notesPaneModel';
const tabs=():NotesPaneTabs=>({root:Array.from({length:7},(_,i)=>({id:`note-${i}`,kind:'note'}))});
const one:NotesPaneLayout={kind:'pane',id:'root'};
const two:NotesPaneLayout={kind:'split',id:'split',orientation:'row',ratio:.5,first:one,second:{kind:'pane',id:'right'}};
test('seven open views retain identities through first split, A-B-A activation and reorders',()=>{
 const views=new NotesPaneViews(), state=tabs(); const before=views.list(one,state); const identities=new Map(before.map(v=>[v.tab.id,v.id]));
 const split={...state,right:[{id:'note-0',kind:'note' as const}]};
 const after=views.list(two,split);
 for(const view of after.filter(v=>v.paneId==='root'))assert.equal(view.id,identities.get(view.tab.id));
 assert.notEqual(after.find(v=>v.paneId==='right')!.id,identities.get('note-0'));
 for(const tabId of ['note-0','note-6','note-0'])assert.equal(views.get('root',tabId),identities.get(tabId));
 state.root.reverse();for(const view of views.list(two,split).filter(v=>v.paneId==='root'))assert.equal(view.id,identities.get(view.tab.id));
});
test('moving an inactive tab and collapsing its pane changes position but not view identity',()=>{
 const views=new NotesPaneViews(), state=tabs(); const before=views.list(one,state); const id=before[4].id;
 views.move('root','note-4','right');
 const next={root:state.root.filter(t=>t.id!=='note-4'),right:[state.root[4]]};
 assert.equal(views.list(two,next).find(v=>v.paneId==='right')!.id,id);
 views.remapPane('right','notes-pane-1',next.right);
 assert.equal(views.get('notes-pane-1','note-4'),id);
});
test('same-document independent view identities survive arrangement and exact rollback',()=>{
 const views=new NotesPaneViews(); const state={root:[{id:'same'}],right:[{id:'same'}]};
 const before=views.list(two,state);assert.notEqual(before[0].id,before[1].id);
 const restore=views.checkpoint();views.arrange(state,{top:[{id:'same'}],bottom:[{id:'same'}]});
 assert.equal(views.get('top','same'),before[0].id);assert.equal(views.get('bottom','same'),before[1].id);
 restore();assert.equal(views.get('root','same'),before[0].id);assert.equal(views.get('right','same'),before[1].id);
});
test('renaming a document retains each independent view and clearing a vault retires all ids',()=>{
 const views=new NotesPaneViews();const first=views.get('root','old'),second=views.get('right','old');
 views.renameDocument('old','new');assert.equal(views.get('root','new'),first);assert.equal(views.get('right','new'),second);
 views.clear();assert.notEqual(views.get('root','new'),first);
});
test('production renderer uses one full surface for all flat keyed hosts and keeps document identity separate',()=>{
 const page=readFileSync(new URL('../src/features/notes/NotesPage.tsx',import.meta.url),'utf8');
 const begin=page.indexOf('  const renderNotesDocumentPane =');const end=page.indexOf('  if (!vaultBootstrapReady)',begin);const adapter=page.slice(begin,end);const surface=readFileSync(new URL('../src/features/notes/NoteDocumentSurface.tsx',import.meta.url),'utf8');
 for(const handler of ['onInsertFiles','onInsertClipboardImage','onInsertAssetReference','handleLiveEditorCommand','onContextMenu','onFocusCapture','onClickCapture'])assert.ok(adapter.includes(handler),handler);
 for(const control of ['note-favorite-action','note-attachments-action','note-tags-bar','ai-note-suggest-panel','editor-status'])assert.ok(surface.includes(control),control);
 assert.match(adapter,/<NoteDocumentSurface/);
 assert.match(surface,/key=\{viewId\}/);assert.match(adapter,/"currentNoteId": selectedNote\?\.id \?\? null/);
 const tree=page.slice(page.indexOf('function NotesPaneTree('),page.indexOf('/* Legacy fixed-two-pane preview'));
 assert.match(tree,/entries\.map/);assert.match(tree,/<div key=\{id\}/);assert.match(tree,/hidden=\{!visible\}/);
 assert.match(tree,/renderDocument\(id,paneId,tab\)/);assert.doesNotMatch(tree,/NotesSplitPanePreview|activePane\}/);
 assert.match(adapter,/selectedNoteIdRef\.current !== tab\.id/);
});
test('rollback invalidates pending reads and preset completion awaits active document load',()=>{
 const page=readFileSync(new URL('../src/features/notes/NotesPage.tsx',import.meta.url),'utf8');
 const adapter=page.slice(page.indexOf('    return registerIntegratedLayout("notes"'),page.indexOf('  const updateNotesSplitPaneContent'));
 assert.match(adapter,/checkpoint:[\s\S]*noteLoadRequestRef\.current \+= 1/);
 assert.match(adapter,/for \(const \[paneId, generation\] of notesPaneLoadRequestRef\.current\) notesPaneLoadRequestRef\.current\.set\(paneId, generation \+ 1\)/);
 assert.match(adapter,/else if \(!await loadNotesPaneDocument\(activePaneId, activeTab\)\) return false/);
 assert.doesNotMatch(adapter,/else.*void (selectNote|loadNotesPaneDocument)/);
});
