import React from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../../src/core/i18n/index';
import {materialLibrarySession} from '../../src/core/services/materialLibraryContext';
import {WorkspaceHost} from '../../src/workspace/WorkspaceHost';
import {LayoutStore} from '../../src/workspace/layoutStore';
import {ToolDeck} from '../../src/workspace/ToolDeck';
import {ToolRegistry,WorkspaceToolsContext} from '../../src/workspace/toolRegistry';
import {moveTool,emptyTools} from '../../src/workspace/toolLayout';
import MaterialsPage from '../../src/features/materials/MaterialsPage';
import '../../src/core/theme/themeTokens.css';
import '../../src/features/materials/materials.css';

const fixture=window as any;fixture.calls=[];
localStorage.setItem('luckyray-settings-v1',JSON.stringify({'materials.importModePromptSeen':true}));
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#636391"/></svg>');
const collections=Object.fromEntries(['A','B'].map(library=>[library,[1,2].map(index=>({id:`same-${index}`,name:`${library} 图片 ${index}`,kind:'image',mimeType:'image/svg+xml',sizeBytes:200,thumbnailUrl:image,previewUrl:image,folderId:null,storageMode:'linked',importedAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z'}))]));
const registry={activeId:'A',legacyId:'A',libraries:['A','B'].map(id=>({id,name:id,rootPath:null,storageMode:'managed',visible:true,state:'ready',preferences:{},version:1}))};
materialLibrarySession.request=async(action:any,libraryId?:string|null):Promise<any>=>{
 fixture.calls.push({libraryId,action});
 const assets=collections[libraryId??'A'];
 switch(action.op){
  case 'registry':return registry;
  case 'select':registry.activeId=libraryId!;return null;
  case 'list':return assets.filter(asset=>!action.filter?.query||asset.name.includes(action.filter.query));
  case 'get':return assets.filter(asset=>action.ids.includes(asset.id));
  case 'update':{const asset=assets.find(asset=>asset.id===action.id)!;Object.assign(asset,action.patch);return {...asset};}
  case 'folders':case 'tags':case 'assetTags':case 'favorites':case 'missing':return [];
  case 'favoriteCounts':return {material:0,note:0};
  case 'tasks':return {exports:[],csv:[]};
  case 'sourcePage':case 'change':case 'preferences':return null;
  default:throw Error(`Fixture unsupported ${action.op}`);
 }
};
Object.defineProperty(window,'__LUCKYRAY__',{value:{listAssets:async()=>[],listAssetsFiltered:async()=>[],listFolders:async()=>[],getAssetsByIds:async()=>[],getMaterialChangeState:async()=>null,listFavoriteItems:async()=>[],getCollectionServerBaseUrl:async()=>null},configurable:true});
await materialLibrarySession.initialize();fixture.changeGlobalLibrary=()=>materialLibrarySession.select('B');
const store=new LayoutStore('material-fixture');fixture.workspaceStore=store;
for(const id of ['A','B'])store.dispatch({type:'open',view:{id,kind:'materials',title:`素材 ${id}`,library:{kind:'materials',id}},groupId:store.getSnapshot().focusedGroup});
store.dispatch({type:'move',viewId:'B',targetGroup:store.getSnapshot().focusedGroup,edge:'right',groupId:'right',splitId:'split'});
const tools=new ToolRegistry();fixture.openTool=(kind:any)=>store.dispatch({type:'tools',tools:moveTool(store.getSnapshot().tools??emptyTools(),kind,'right')});
createRoot(document.getElementById('root')!).render(<I18nProvider locale="zh-CN"><div className="workspace-page"><WorkspaceToolsContext.Provider value={tools}><ToolDeck store={store} registry={tools}><WorkspaceHost store={store} renderView={(view,context)=><MaterialsPage workspace={{viewId:view.id,libraryId:view.library.id,visible:context.visible,focused:context.focused}}/>}/></ToolDeck></WorkspaceToolsContext.Provider></div></I18nProvider>);
