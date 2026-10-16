import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Execute the actual NotesPage activation callback, not a duplicate resolver.
// The seam replaces React setters/events only; document authority maps and the
// callback's complete branching logic are real. Native end-to-end evidence
// separately covers DOM/editor/save integration.
const file='luckyray-app/src/features/notes/NotesPage.tsx';
const source=process.env.R8_TEST_SOURCE_REF
 ?execFileSync('git',['show',`${process.env.R8_TEST_SOURCE_REF}:${file}`],{encoding:'utf8'})
 :readFileSync(new URL('../src/features/notes/NotesPage.tsx',import.meta.url),'utf8');
const start=source.indexOf('  const syncActiveNotesPaneDocument = useCallback(');
const end=source.indexOf('  const loadNotesPaneDocument = useCallback(',start);
assert.ok(start>0&&end>start,'Actual production callback must be found');
const compiled=ts.transpileModule(source.slice(start,end)+'\nglobalThis.activate=syncActiveNotesPaneDocument;',
 {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(latest,{existing=true,saved='base'}={}){
 const id='real-vault:synthetic.md',updates={};
 const latestMap=new Map(latest===undefined?[]:[[id,latest]]),savedMap=new Map([[id,saved]]);
 const scope={notes:existing?[{id,title:'synthetic',contentText:'base'}]:[],t:x=>x,useCallback:f=>f,
  activeNotesSplitPaneRef:{current:'p1'},selectedNoteIdRef:{current:null},selectedNoteRef:{current:null},
  realVaultLatestContentRef:{current:latestMap},realVaultSavedContentRef:{current:savedMap},
  noteFromKnowledgeDocument:d=>({...d,contentJson:d.contentText}),isRealVaultNoteId:v=>v.startsWith('real-vault:'),
  window:{dispatchEvent(){}},CustomEvent:class {constructor(name,options){this.name=name;this.options=options;}}};
 for(const key of ['ActiveEmptyTabId','SelectedNoteId','SelectedNote','EditTitle','EditContent','SourceContentDraft'])scope['set'+key]=v=>updates[key]=v;
 vm.createContext(scope);vm.runInContext(compiled,scope);
 const activate=(pane='p1',content='base')=>scope.activate(pane,{id,kind:'note'},{title:'synthetic',contentText:content,loaded:true});
 return {activate,scope,updates,latestMap,savedMap,id};
}
for(const existing of [true,false])test(`stale pane cannot overwrite CHILD, existing note=${existing}`,()=>{
 const f=fixture('base\nCHILD-R4',{existing});f.activate();
 assert.equal(f.updates.EditContent,'base\nCHILD-R4');
 assert.equal(f.updates.SelectedNote.contentText,'base\nCHILD-R4');
 assert.equal(f.scope.selectedNoteRef.current.contentJson,'base\nCHILD-R4');
});
test('unsaved draft remains authoritative across repeated independent panes',()=>{
 const f=fixture('base\nCHILD-R4\nDIRTY-R4',{saved:'base\nCHILD-R4'});
 for(let i=0;i<24;i++){const pane=i%2?'p1':'p2';f.scope.activeNotesSplitPaneRef.current=pane;f.activate(pane);assert.equal(f.updates.EditContent,'base\nCHILD-R4\nDIRTY-R4');}
 assert.equal(f.savedMap.get(f.id),'base\nCHILD-R4');
});
test('empty latest draft is not replaced by stale nonempty pane',()=>{
 const f=fixture('');f.activate();assert.equal(f.updates.EditContent,'');assert.equal(f.latestMap.get(f.id),'');assert.equal(f.savedMap.get(f.id),'base');
});
test('first document load falls back only when authority has no entry',()=>{
 const f=fixture(undefined);f.activate('p1','first');assert.equal(f.updates.EditContent,'first');assert.equal(f.latestMap.get(f.id),'first');
});
test('inactive pane request cannot replace active view state',()=>{
 const f=fixture('latest');f.activate('p2');assert.deepEqual(f.updates,{});assert.equal(f.latestMap.get(f.id),'latest');
});
