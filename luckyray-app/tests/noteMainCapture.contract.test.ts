import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {EditorState,EditorSelection,Transaction,StateField} from '@codemirror/state';
import {history,historyField,undo,redo,undoDepth,redoDepth,isolateHistory} from '@codemirror/commands';
import {codeFolding,foldEffect,foldState,foldedRanges} from '@codemirror/language';
import {search,SearchQuery,setSearchQuery,getSearchQuery} from '@codemirror/search';
import {assertNotesNativeBaseline,type NotesNativeViewBinding} from '../src/features/notes/notesNativeViewRegistry';
import {capturePortableLiveEditor,restorePortableLiveEditor,validateNoteViewPresentation,captureNoteSource,captureNoteScroll,noteContentScrollElement,captureNoteMedia,portableRetainedEditor,restoreNoteSource,restoreNoteMedia,restoreNotePresentationLayout,type NoteViewBaseline,type NoteViewPresentationSnapshot,type NoteViewMode} from '../src/features/notes/noteViewPresentation';

const source=readFileSync(new URL('../src/features/notes/NotesPage.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('NotesPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let registration:ts.FunctionDeclaration|undefined;
function findRegistration(node:ts.Node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='MainNotePresentationRegistration')registration=node;ts.forEachChild(node,findRegistration);}
findRegistration(ast);assert.ok(registration);
function productionMethod(name:'capture'|'restore',context:Record<string,unknown>){
 let method:ts.MethodDeclaration|undefined;
 function visit(node:ts.Node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)===name)method=node;ts.forEachChild(node,visit);}
 visit(registration!);assert.ok(method,`production ${name} method`);
 const js=ts.transpileModule(`({${method.getText(ast)}}).${name}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function('context',`with(context){return ${js}}`)(context);
}
const extraField=StateField.define({create:()=>({privateExtension:true}),update:value=>value,toJSON:value=>value,fromJSON:value=>value});
const extensions=[history(),codeFolding(),search(),EditorState.allowMultipleSelections.of(true),extraField];
const initial='# Heading\nbody\nmore\n';
function change(command:typeof undo,state:EditorState){let next=state;assert.equal(command({state,dispatch:transaction=>{next=transaction.state;}}),true);return next;}
function editedState(){
 let state=EditorState.create({doc:initial,extensions});
 state=state.update({changes:{from:10,insert:'first '},annotations:[Transaction.userEvent.of('input'),isolateHistory.of('full')]}).state;
 state=state.update({changes:{from:16,insert:'second '},annotations:[Transaction.userEvent.of('input'),isolateHistory.of('full')]}).state;
 state=change(undo,state);
 return state.update({selection:EditorSelection.create([EditorSelection.range(4,1),EditorSelection.cursor(6)],0),effects:[foldEffect.of({from:9,to:state.doc.length-1}),setSearchQuery.of(new SearchQuery({search:'body',replace:'text',regexp:true,caseSensitive:true,literal:true,wholeWord:true}))]}).state;
}
function geometry(top=0,left=0){return {clientHeight:100,clientWidth:100,scrollHeight:1500,scrollWidth:600,scrollTop:top,scrollLeft:left,querySelector:()=>null,querySelectorAll:()=>[]};}
function fixture(mode:NoteViewMode='live'){
 let state=editedState();
 const authority={vaultId:'vault-a',sourceId:'captured-native-source',documentId:'kdoc-a'};
 // Exact native workspace_notes_metadata::NoteSnapshot shape, not a narrowed DTO.
 const native={authority,documentRef:{vaultId:'vault-a',relativePath:'A.md'},content:state.doc.toString(),revision:'saved-revision',title:'A'};
 const binding={viewId:'view-a',vaultId:'vault-a',documentId:'kdoc-a',workspaceSourceId:authority.sourceId} as NotesNativeViewBinding;
 const content=geometry(45,7),liveScroll=geometry(87,9);
 const area={...geometry(22,3),value:native.content,selectionStart:4,selectionEnd:9,selectionDirection:'backward',setSelectionRange(start:number,end:number,direction:string){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}};
 const live={captureSession:()=>({state,scrollTop:liveScroll.scrollTop,scrollLeft:liveScroll.scrollLeft}),capturePortableSession:()=>capturePortableLiveEditor(state,{top:liveScroll.scrollTop,left:liveScroll.scrollLeft}),async restorePortableSession(snapshot:Parameters<typeof restorePortableLiveEditor>[0]){state=restorePortableLiveEditor(snapshot,native.content,extensions);},getScrollElement:()=>liveScroll};
 const current={mode,content:native.content,media:{assets:[],embeds:[]},retained:live.captureSession(),viewRefs:{live:{current:mode==='live'?live:null},source:{current:mode==='source'?area:null},content:{current:content},contentScroll:{top:45,left:7}},changeMode(next:NoteViewMode){this.mode=next;this.viewRefs.live.current=next==='live'?live:null;this.viewRefs.source.current=next==='source'?area:null;}};
 const captured={current:null as NoteViewPresentationSnapshot|null},rollback={current:null as NoteViewPresentationSnapshot|null};
 const adapter={} as {capture:(baseline:NoteViewBaseline)=>Promise<NoteViewPresentationSnapshot>;restore:(baseline:NoteViewBaseline,input:NoteViewPresentationSnapshot)=>Promise<void>};
 const context={locked:{current:true},expected:(value:NoteViewBaseline)=>assertNotesNativeBaseline(binding,{revision:native.revision,content:native.content},state.doc.toString(),value),captured,rollback,latest:{current},retained:{current:null},sourceState:{current:undefined},restoreSequence:{current:0},adapter,
  validateNoteViewPresentation,captureNoteSource,captureNoteScroll,noteContentScrollElement,captureNoteMedia,portableRetainedEditor,restoreNoteSource,restoreNoteMedia,
  nextNotePresentationFrame:async()=>{},restoreNotePresentationLayout:(snapshot:NoteViewPresentationSnapshot,refs:Parameters<typeof restoreNotePresentationLayout>[1],check:()=>void)=>restoreNotePresentationLayout(snapshot,refs,check,async()=>{})};
 adapter.capture=productionMethod('capture',context);adapter.restore=productionMethod('restore',context);
 return {native,adapter,captured,rollback,context,current,state:()=>state};
}
const presentationKeys=['authority','content','contentScroll','live','media','mode','revision','sourceScroll','sourceSelection','version'].sort();

for(const mode of ['live','source','preview'] as const)test(`actual Main capture projects the full native DTO in ${mode} mode and revalidates cached capture`,async()=>{
 const f=fixture(mode),before=f.state(),nativeBefore=JSON.stringify(f.native),snapshot=await f.adapter.capture(f.native);
 assert.deepEqual(Object.keys(snapshot).sort(),presentationKeys);assert.equal(snapshot.mode,mode);assert.ok(snapshot.live);
 assert.deepEqual(Object.keys(snapshot.live.state).sort(),['doc','folds','history','selection']);
 assert.deepEqual(snapshot.live.state,JSON.parse(JSON.stringify(before.toJSON({history:historyField,folds:foldState}))));
 assert.equal(JSON.stringify(f.native),nativeBefore,'native DTO remains intact');assert.strictEqual(f.state(),before,'capture leaves source EditorState intact');
 assert.deepEqual(await f.adapter.capture(f.native),snapshot);
 await assert.rejects(f.adapter.capture({...f.native,revision:'other'}),/authorized saved revision/);
 assert.deepEqual(f.captured.current,snapshot);
 if(mode==='source')assert.deepEqual(snapshot.sourceSelection,{start:4,end:9,direction:'backward'});
});

test('actual Main capture roundtrips real edited history, redo, backward multiple selection, folds and search',async()=>{
 const f=fixture(),original=f.state(),snapshot=await f.adapter.capture(f.native);
 assert.ok(undoDepth(original)>0);assert.ok(redoDepth(original)>0);assert.equal(original.selection.ranges.length,2);assert.equal(original.selection.mainIndex,0);assert.ok(original.selection.main.anchor>original.selection.main.head);
 let restored=restorePortableLiveEditor(JSON.parse(JSON.stringify(snapshot.live)),f.native.content,extensions);
 assert.equal(undoDepth(restored),undoDepth(original));assert.equal(redoDepth(restored),redoDepth(original));
 assert.ok(restored.selection.eq(original.selection));assert.ok(getSearchQuery(restored).eq(getSearchQuery(original)));
 const folds:number[]=[];foldedRanges(restored).between(0,restored.doc.length,(from,to)=>folds.push(from,to));assert.deepEqual(folds,[9,original.doc.length-1]);
 restored=change(redo,restored);assert.match(restored.doc.toString(),/first second body/);
 restored=change(undo,restored);assert.equal(restored.doc.toString(),f.native.content);restored=change(undo,restored);assert.equal(restored.doc.toString(),initial);
});

test('actual Main restore captures a strict rollback from the full native DTO before applying incoming state',async()=>{
 const source=fixture(),incoming=await source.adapter.capture(source.native),target=fixture(),original=target.state();
 incoming.live!.search.search='incoming search';incoming.live!.state.selection=EditorSelection.create([EditorSelection.range(9,2)]).toJSON();
 assert.equal(target.rollback.current,null);await target.adapter.restore(target.native,incoming);
 const rollback=target.rollback.current!;assert.deepEqual(Object.keys(rollback).sort(),presentationKeys);
 assert.deepEqual(rollback.live!.state,JSON.parse(JSON.stringify(original.toJSON({history:historyField,folds:foldState}))));
 assert.equal(rollback.live!.search.search,'body');assert.equal(getSearchQuery(target.state()).search,'incoming search');
 assert.ok(!target.state().selection.eq(original.selection));
 await target.adapter.restore(target.native,rollback);
 assert.ok(target.state().selection.eq(original.selection));assert.ok(getSearchQuery(target.state()).eq(getSearchQuery(original)));
 assert.equal(undoDepth(target.state()),undoDepth(original));assert.equal(redoDepth(target.state()),redoDepth(original));
});

test('projection does not weaken incoming top-level, editor-state, or search whitelists',async()=>{
 const f=fixture(),snapshot=await f.adapter.capture(f.native);
 for(const name of ['documentRef','title','unrecognized'])assert.throws(()=>validateNoteViewPresentation({...snapshot,[name]:'injected'},f.native),/unknown snapshot field/);
 for(const name of ['language','extensionState'])assert.throws(()=>validateNoteViewPresentation({...snapshot,live:{...snapshot.live,state:{...snapshot.live!.state,[name]:{injected:true}}}},f.native),/unknown snapshot field/);
 assert.throws(()=>validateNoteViewPresentation({...snapshot,live:{...snapshot.live,search:{...snapshot.live!.search,unknown:true}}},f.native),/unknown snapshot field/);
 await assert.rejects(f.adapter.restore(f.native,{...snapshot,title:'injected'} as NoteViewPresentationSnapshot),/unknown snapshot field/);
 assert.equal(f.rollback.current,null,'invalid input is rejected before rollback or editor mutation');
});
