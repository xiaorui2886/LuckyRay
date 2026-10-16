import test from 'node:test';
import assert from 'node:assert/strict';
import {canReopenSavedNote,preloadNotesLayout} from '../src/features/notes/notesLayoutReopen.ts';
import {validateNotesLayoutSnapshot,restoreNotesLayoutState,type NotesLayoutSnapshot,type NotesPaneState} from '../src/features/notes/notesPaneModel.ts';
const current:NotesPaneState={layout:{kind:'pane',id:'now'},tabs:{now:[{id:'real-vault:Draft.md'}]},activeTabs:{now:'real-vault:Draft.md'},activePaneId:'now'};
const preset:NotesLayoutSnapshot={version:1,vaultId:'vault',state:{layout:{kind:'pane',id:'saved'},tabs:{saved:[{id:'real-vault:Closed.md',kind:'note'}]},activeTabs:{saved:'real-vault:Closed.md'},activePaneId:'saved'},modes:{saved:'live'},indexOpen:true,indexWidth:272};
const document=(path:string,content='disk')=>({id:path,relativePath:path,title:path,contentText:content,source:'real-vault' as const,revision:'r1'});
test('validated saved identities reopen after close/restart without discarding current draft tab',async()=>{
 assert.equal(validateNotesLayoutSnapshot(preset,'vault',current),false);
 assert.equal(validateNotesLayoutSnapshot(preset,'vault',current,canReopenSavedNote),true);
 const reads:string[]=[];const prepared=await preloadNotesLayout(preset,()=>false,async path=>{reads.push(path);return document(path);},()=>true);
 assert.deepEqual(reads,['Closed.md']);assert.equal(prepared.get('real-vault:Closed.md')?.contentText,'disk');
 assert.deepEqual(restoreNotesLayoutState(current,preset).tabs.saved.map(tab=>tab.id),['real-vault:Closed.md','real-vault:Draft.md']);
});
test('foreign vault, traversal, absolute path and retired document IDs cannot reopen',()=>{
 assert.equal(validateNotesLayoutSnapshot(preset,'foreign',current,canReopenSavedNote),false);
 for(const id of ['legacy-id','real-vault:../secret.md','real-vault:/root.md','real-vault:C:/x.md','real-vault:a\\b.md','real-vault:notes.txt','real-vault:x/./a.md'])assert.equal(canReopenSavedNote({id}),false,id);
});
test('missing file prevents all layout application; reads never write placeholder content',async()=>{
 const snapshot=structuredClone(preset);snapshot.state.tabs.saved.push({id:'real-vault:Missing.md'});const original=JSON.stringify(current);let writes=0;
 await assert.rejects(preloadNotesLayout(snapshot,()=>false,async path=>{if(path==='Missing.md')throw Error('not found');return document(path);},()=>true),/Missing.md.*当前标签和草稿/);
 assert.equal(JSON.stringify(current),original);assert.equal(writes,0);
});
test('source changes during a delayed read abort instead of loading into another vault',async()=>{
 let same=true;await assert.rejects(preloadNotesLayout(preset,()=>false,async path=>{same=false;return document(path);},()=>same),/知识库或当前布局已变化/);
});
test('a mismatched backend identity is never accepted and duplicate views load once',async()=>{
 await assert.rejects(preloadNotesLayout(preset,()=>false,async()=>document('Other.md'),()=>true),/无法读取/);
 const snapshot=structuredClone(preset);snapshot.state.tabs.other=[{id:'real-vault:Closed.md'}];let reads=0;
 await preloadNotesLayout(snapshot,()=>false,async path=>{reads++;return document(path);},()=>true);assert.equal(reads,1);
});
