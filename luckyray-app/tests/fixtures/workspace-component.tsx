import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceHost } from '../../src/workspace/WorkspaceHost';
import { LayoutStore } from '../../src/workspace/layoutStore';
import { LiveMarkdownEditor } from '../../src/features/notes/editor/LiveMarkdownEditor';
import MaterialsPage from '../../src/features/materials/MaterialsPage';
import { I18nProvider } from '../../src/core/i18n/index';
import '../../src/core/theme/themeTokens.css';
import '../../src/features/notes/notes.css';
import '../../src/features/materials/materials.css';

const fixture = window as unknown as Record<string,any>;
localStorage.setItem('luckyray-settings-v1', JSON.stringify({ 'materials.importModePromptSeen': true }));
const image = 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#636391"/></svg>');
const assets=[{id:'workspace-image',name:'工作区测试图片.svg',kind:'image',mimeType:'image/svg+xml',sizeBytes:145,thumbnailUrl:image,previewUrl:image,folderId:null,storageMode:'linked',importedAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z'}];
const bridge={listAssets:async()=>assets,listAssetsFiltered:async()=>assets,listFolders:async()=>[],getAssetsByIds:async()=>assets,getMaterialChangeState:async()=>null,listFavoriteItems:async()=>[],getFavoriteItemCounts:async()=>({material:0,note:0}),listVaults:async()=>[],getCollectionServerBaseUrl:async()=>null};
Object.defineProperty(window,'__LUCKYRAY__',{value:bridge,configurable:true});
fixture.mounts={}; fixture.unmounts={}; fixture.drafts={};
function NoteView({id}:{id:string}){
  const [text,setText]=useState('初始笔记\n\n'+Array.from({length:50},(_,i)=>`段落 ${i}`).join('\n\n'));
  useEffect(()=>{fixture.mounts[id]=(fixture.mounts[id]||0)+1;return()=>{fixture.unmounts[id]=(fixture.unmounts[id]||0)+1;};},[id]);
  return <div className="note-live-editor-host" style={{height:'100%',overflow:'auto'}}>
    <LiveMarkdownEditor value={text} assets={[]} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={[]} currentNoteId={id}
      onChange={value=>{setText(value);fixture.drafts[id]=value;}}/>
  </div>;
}
const store=new LayoutStore('workspace-fixture'); fixture.workspaceStore=store;
for(const id of ['note-a','note-b'])store.dispatch({type:'open',view:{id,kind:'note',title:id,library:{kind:'knowledge',id:'fixture-vault'},resourceId:id},groupId:'workspace-group-1'});
store.dispatch({type:'open',view:{id:'materials-a',kind:'materials',title:'素材库',library:{kind:'materials',id:'fixture-material-library'}},groupId:'workspace-group-1'});
store.dispatch({type:'activate',viewId:'note-a'});
createRoot(document.getElementById('root')!).render(<I18nProvider locale="zh-CN"><WorkspaceHost store={store} renderView={view=>view.kind==='note'?<NoteView id={view.id}/>:<MaterialsPage/>}/></I18nProvider>);
