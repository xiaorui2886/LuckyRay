import type {LiveEditorTableContext,LiveMarkdownEditorHandle} from '../features/notes/editor/LiveMarkdownEditor';
import type {TableEditorCommand} from '../features/notes/editor/EditorContextMenu';
import {resolveEditableTableRange,parseEditableTableSource,serializeEditableTableSource,applyEditableTableCommand,copyEditorTableRowText,copyEditorTableColumnText} from '../features/notes/editor/tableCommands';
import type {DocumentSession} from './documentSession';

/** A context menu refers to the exact table version that was clicked. A peer
 * update while the menu is open must never make its coordinates edit a new row. */
export async function applyWorkspaceTableCommand(editor:LiveMarkdownEditorHandle,session:DocumentSession,context:LiveEditorTableContext,command:TableEditorCommand,expectedContent:string,clipboard:Pick<Clipboard,'writeText'>){
 const content=editor.getValue();
 if(content!==expectedContent||session.getSnapshot().content!==content)throw Error('表格内容已变化，请重新右键选择后重试。');
 const range=resolveEditableTableRange(content,context);
 if(!range)throw Error('无法定位当前表格。');
 const source=content.slice(range.from,range.to),table=parseEditableTableSource(source);
 if(!table)throw Error('无法读取当前表格。');
 if(command==='row-copy'||command==='column-copy'){
  await clipboard.writeText(command==='row-copy'?copyEditorTableRowText(table,context):copyEditorTableColumnText(table,context));
  return;
 }
 const next=serializeEditableTableSource(applyEditableTableCommand(table,context,command));
 if(next!==source)editor.replaceRange(next,{start:range.from,end:range.to});
 editor.setSelection({start:range.from,end:range.from});editor.focus();
}
