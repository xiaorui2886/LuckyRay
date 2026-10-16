import test from 'node:test';
import assert from 'node:assert/strict';
import {applyWorkspaceNoteCommand} from '../src/workspace/noteCommands.ts';
import {DocumentSession} from '../src/workspace/documentSession.ts';
import type {LiveMarkdownEditorHandle} from '../src/features/notes/editor/LiveMarkdownEditor';
async function setup(){
 const session=new DocumentSession({read:async()=>({content:'正文',revision:'1'}),write:async content=>({content,revision:'2'})});await session.load();
 const changes:unknown[]=[];let selection={start:0,end:2};
 const editor={getValue:()=>session.getSnapshot().content,replaceRange:(text:string,range:{start:number;end:number})=>{changes.push({text,range});const content=session.getSnapshot().content;session.edit(content.slice(0,range.start)+text+content.slice(range.end));},setSelection:(next:typeof selection)=>{selection=next;},focus:()=>{}} as LiveMarkdownEditorHandle;
 return {session,editor,changes,selection:()=>selection};
}
test('existing formatting commands apply as one minimal undoable editor transaction',async()=>{
 const {session,editor,changes}=await setup();await applyWorkspaceNoteCommand(editor,session,'heading6',{start:0,end:2});
 assert.equal(session.getSnapshot().content,'###### 正文');assert.deepEqual(changes,[{text:'###### ',range:{start:0,end:0}}]);
});
test('clipboard completion cannot overwrite input that arrived during permission/read',async()=>{
 const {session,editor,changes}=await setup();let finish!:(s:string)=>void;
 const clipboard={readText:()=>new Promise<string>(resolve=>{finish=resolve;}),writeText:async()=>{}};
 const paste=applyWorkspaceNoteCommand(editor,session,'paste',{start:0,end:2},clipboard);session.edit('正文新增');finish('旧操作');
 await assert.rejects(paste,/内容已变化/);assert.equal(session.getSnapshot().content,'正文新增');assert.deepEqual(changes,[]);
});
test('selection-only command leaves the document and undo history untouched',async()=>{
 const {session,editor,changes,selection}=await setup();await applyWorkspaceNoteCommand(editor,session,'select-all',{start:1,end:1});
 assert.equal(session.getSnapshot().dirty,false);assert.deepEqual(changes,[]);assert.deepEqual(selection(),{start:0,end:2});
});
