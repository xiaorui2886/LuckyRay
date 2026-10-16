import {applyEditorCommand,type EditorCommand,type EditorRange} from '../core/services/editor';
import type {LiveMarkdownEditorHandle} from '../features/notes/editor/LiveMarkdownEditor';
import type {DocumentSession} from './documentSession';

/** Apply through the existing editor transaction API, never replace its state:
 * formatting and clipboard operations stay in the same undo/selection history. */
export async function applyWorkspaceNoteCommand(editor:LiveMarkdownEditorHandle,session:DocumentSession,command:EditorCommand,selection:EditorRange,clipboard?:Pick<Clipboard,'readText'|'writeText'>){
 const content=editor.getValue();
 const result=await applyEditorCommand(command,{content,selectionStart:selection.start,selectionEnd:selection.end,clipboard});
 if(editor.getValue()!==content||session.getSnapshot().content!==content)throw Error('操作期间笔记内容已变化，请重新选择后重试。');
 if(result.changed){
  let from=0,to=content.length,end=result.content.length;
  while(from<to&&from<end&&content[from]===result.content[from])from++;
  while(to>from&&end>from&&content[to-1]===result.content[end-1]){to--;end--;}
  editor.replaceRange(result.content.slice(from,end),{start:from,end:to});
 }
 editor.setSelection(result.selection);editor.focus();return result.status;
}
