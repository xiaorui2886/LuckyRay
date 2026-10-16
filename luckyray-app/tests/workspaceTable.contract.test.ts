import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEditableTableSource,serializeEditableTableSource,applyEditableTableCommand,resolveEditableTableRange} from '../src/features/notes/editor/tableCommands.ts';
import {applyWorkspaceTableCommand} from '../src/workspace/noteTableCommands.ts';
import {DocumentSession} from '../src/workspace/documentSession.ts';
import type {LiveMarkdownEditorHandle} from '../src/features/notes/editor/LiveMarkdownEditor';
const source='| 名称 | 数量 |\n| :--- | ---: |\n| 茶 \\| 花 | 10 |\n| 中文 | 2 | ^stock';
const context={from:0,to:source.length,lineOffset:2,columnIndex:1,rowCount:2,columnCount:2};
test('shared table commands preserve escapes, block identity, numeric sorting and alignment',()=>{
 const table=parseEditableTableSource(source)!;
 assert.equal(table.rows.length,2);
 const sorted=applyEditableTableCommand(table,context,'sort-asc');
 assert.deepEqual(sorted.rows.map(row=>row[1]),['2','10']);
 assert.deepEqual(sorted.alignments,['left','right']);
 const serialized=serializeEditableTableSource(sorted);
 assert.ok(serialized.endsWith('^stock'));assert.ok(serialized.includes('茶 \\| 花'));
 assert.equal(parseEditableTableSource(serialized)!.rows.length,2);
 assert.deepEqual(applyEditableTableCommand(table,context,'column-left').headers,['名称','','数量']);
 assert.equal(applyEditableTableCommand(table,context,'row-below').rows.length,3);
});
test('table range does not include following prose or another block',()=>{
 const content='上文\n\n'+source+'\n\n后文';
 const range=resolveEditableTableRange(content,{...context,from:4,to:4+source.length})!;
 assert.equal(content.slice(range.from,range.to),source);
});
test('workspace table edit is a single transaction; stale menu cannot edit a newer document',async()=>{
 const session=new DocumentSession({read:async()=>({content:source,revision:'1'}),write:async content=>({content,revision:'2'})});await session.load();
 const changes:string[]=[];
 const editor={getValue:()=>session.getSnapshot().content,replaceRange:(text:string,range:{start:number;end:number})=>{changes.push(text);const content=session.getSnapshot().content;session.edit(content.slice(0,range.start)+text+content.slice(range.end));},setSelection:()=>{},focus:()=>{}} as unknown as LiveMarkdownEditorHandle;
 let copied='';const clipboard={writeText:async(text:string)=>{copied=text;}};
 await applyWorkspaceTableCommand(editor,session,context,'column-copy',source,clipboard);
 assert.equal(copied,'数量\n10\n2');assert.equal(changes.length,0);
 await applyWorkspaceTableCommand(editor,session,context,'row-below',source,clipboard);
 assert.equal(changes.length,1);const current=session.getSnapshot().content;
 await assert.rejects(applyWorkspaceTableCommand(editor,session,context,'column-delete',source,clipboard),/已变化/);
 assert.equal(session.getSnapshot().content,current);assert.equal(changes.length,1);
});
