import {NoteRuntimeError,type NoteParentAction} from './NoteRuntime';
import type {EditorRange} from '../../core/services/editor';
export type NoteViewActionCapture={epoch:number;mode:'live'|'source'|'preview';selection:EditorRange};
export function assertNoteViewActionCurrent(action:NoteParentAction,before:NoteViewActionCapture,now:NoteViewActionCapture){
  if(before.epoch!==now.epoch||before.mode!==now.mode)throw new NoteRuntimeError('stale-result','视图已切换，操作结果未应用。');
  if('selection' in action&&(before.selection.start!==now.selection.start||before.selection.end!==now.selection.end))
    throw new NoteRuntimeError('stale-result','编辑位置已改变，插入结果未应用。');
}
