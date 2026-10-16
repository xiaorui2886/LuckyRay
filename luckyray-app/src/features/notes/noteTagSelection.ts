import {noteAuthorityKey,NoteRuntimeError,type NoteActionValue,type NoteAuthority,type NoteParentAction} from './NoteRuntime';
import type {DocumentState} from '../../workspace/documentSession';
export type NoteTagSelectionBaseline=Readonly<{revision:string;content:string;authority:NoteAuthority;viewId:string}>;
/** A tag replacement is the user's reviewed whole set. Never attach that old
 * set to a newer CAS revision merely because the controller has refreshed. */
export function submitNoteTagSelection(
 read:()=>DocumentState,baseline:NoteTagSelectionBaseline,names:readonly string[],
 request:(action:NoteParentAction)=>Promise<NoteActionValue>,
 identity:{authority:NoteAuthority;viewId:string},
):Promise<NoteActionValue>{
 const current=read();
 if(!baseline.revision||noteAuthorityKey(identity.authority)!==noteAuthorityKey(baseline.authority)||identity.viewId!==baseline.viewId||current.revision!==baseline.revision||current.content!==baseline.content||current.dirty||current.status!=='ready')
  return Promise.reject(new NoteRuntimeError('stale-result','标签面板打开后笔记已变化。请重新载入标签并核对后保存；当前选择已保留。'));
 return request({kind:'apply-document-tags',names:[...names],mode:'replace'});
}
