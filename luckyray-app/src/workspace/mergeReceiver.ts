import {DocumentSessions} from './documentSession';
import {LayoutStore} from './layoutStore';
import {noteTransport,workspaceCommand} from './nativeClient';
import type {ViewRef} from './layout';
export type MergeOffer={id:string;source:string;sourceViewId?:string;accepted:boolean;revision:string;view:{id:string;kind:string;libraryId:string;resourceId:string;title:string}};

/** Native has already copied the source's fixed grant. Read with that grant,
 * mount the real editor, then ACK. Source remains intact on every failure. */
export async function receiveNoteMerge(offer:MergeOffer,store:LayoutStore,sessions:DocumentSessions){
  if(offer.view.kind!=='note')throw Error('此窗口类型尚不能合并。');
  const view:ViewRef={id:offer.view.id,kind:'note',title:offer.view.title,resourceId:offer.view.resourceId,library:{kind:'knowledge',id:offer.view.libraryId}};
  const session=sessions.get({libraryId:view.library.id,resourceId:view.resourceId!},()=>noteTransport(view,false));
  await session.load();await session.refresh();
  if(session.getSnapshot().revision!==offer.revision||session.getSnapshot().dirty||session.getSnapshot().status!=='ready')throw Error('目标笔记未能安全读取，原窗口仍保留。');
  store.dispatch({type:'open',view,groupId:store.getSnapshot().focusedGroup});
  for(let attempt=0;attempt<80;attempt++){
    if(document.querySelector(`[data-workspace-view="${CSS.escape(view.id)}"] .cm-editor`)){
      // Let the mounted editor apply its content transaction before ACK.
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      if(session.getSnapshot().revision!==offer.revision||session.getSnapshot().dirty)throw Error('接收期间版本已变化，原窗口仍保留。');
      await workspaceCommand({op:'acceptMerge',id:offer.id,revision:offer.revision});return;
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('目标编辑器未就绪，原窗口仍保留。');
}
