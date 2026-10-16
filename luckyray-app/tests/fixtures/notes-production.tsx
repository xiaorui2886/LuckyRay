import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import NotesPage from '../../src/features/notes/NotesPage';
import {I18nProvider} from '../../src/core/i18n';
import {knowledgeStore} from '../../src/core/services/knowledgeStore';
import {EditorView} from '@codemirror/view';
import {undo,redo} from '@codemirror/commands';
import {openSearchPanel} from '@codemirror/search';
import {beginNotesTabPointerDrag} from '../../src/features/notes/notesPaneDocking';
import {captureIntegratedLayouts,restoreIntegratedLayouts} from '../../src/workspace/integratedLayoutRegistry';
import '../../src/core/theme/themeTokens.css';
import '../../src/App.css';
const fixture=window as any;
const vault={id:'browser-preview',name:'Notes production fixture',rootPath:'/fixture',mode:'real-vault',createdAt:'2026-10-06',lastOpenedAt:'2026-10-06',schemaVersion:1};
const rows=['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta'].map((title,i)=>({documentRef:{vaultId:vault.id,relativePath:title+'.md'},title,relativePath:title+'.md',content:`# ${title}\n\nOriginal paragraph ${i}.\n\nSecond paragraph.`,revision:'initial-'+i,modifiedAt:'2026-10-06T00:00:00Z',size:70}));
localStorage.setItem('luckyray:knowledge-preview-v1',JSON.stringify(rows));
localStorage.setItem('luckyray-notes-tabs-state-v2:browser-preview',JSON.stringify({tabs:rows.map(r=>({id:'real-vault:'+r.relativePath,kind:'note'})),activeId:'real-vault:Alpha.md'}));
const readRows=()=>JSON.parse(localStorage.getItem('luckyray:knowledge-preview-v1')||'[]');
const bridge={
 getCurrentNotesVault:async()=>vault,listNotesVaults:async()=>[vault],listVaults:async()=>[],
 listNotesVaultFiles:async()=>({kind:'folder',name:'fixture',relativePath:'',absolutePath:'/fixture',mtime:null,size:0,children:readRows().map((r:any)=>({kind:'file',name:r.relativePath,relativePath:r.relativePath,absolutePath:'/fixture/'+r.relativePath,children:[],mtime:r.modifiedAt,size:r.content.length}))}),
 getNotesVaultMarkdownIndex:async()=>({vaultId:vault.id,rootPath:vault.rootPath,version:1,generatedAt:'2026-10-06',documents:readRows().map((r:any)=>({...r,fileName:r.relativePath,absolutePath:'/fixture/'+r.relativePath,headings:[],wikiLinks:[],embeds:[],tags:[],frontmatterTags:[],inlineTags:[],plainText:r.content,excerpt:r.content,contentLength:r.content.length,mtime:r.modifiedAt})),errors:[],changedPaths:[],removedPaths:[]}),
 listFavoriteItems:async()=>[],getFavoriteItemCounts:async()=>({material:0,note:0}),listTags:async()=>[],listAssets:async()=>[],getNoteTags:async()=>[],getNotesLinkingToNote:async()=>[],getUnlinkedNoteMentions:async()=>[],getNoteLinks:async()=>[],getNoteEmbeds:async()=>[],getAssetsForNote:async()=>[],getNoteAiSuggestion:async()=>null,getCollectionServerBaseUrl:async()=>null,
};
fixture.__LUCKYRAY__=bridge;
fixture.undoEditor=undo;fixture.redoEditor=redo;
fixture.captureLayouts=captureIntegratedLayouts;fixture.restoreLayouts=restoreIntegratedLayouts;
fixture.editor=(pane='notes-pane-1')=>EditorView.findFromDOM(document.querySelector(`.notes-document-host:not([hidden]) [data-notes-dock-pane="${pane}"] .cm-editor`)!);
fixture.openSearch=(pane?:string)=>openSearchPanel(fixture.editor(pane));
fixture.undo=(pane?:string)=>undo(fixture.editor(pane));fixture.redo=(pane?:string)=>redo(fixture.editor(pane));
function Fixture(){
 const [tabs,setTabs]=useState<any>({tabs:[],activeId:null});const [split,setSplit]=useState<any>(null);
 useEffect(()=>{const a=(e:Event)=>setTabs((e as CustomEvent).detail), b=(e:Event)=>setSplit((e as CustomEvent).detail);window.addEventListener('luckyray:notes-tabs',a);window.addEventListener('luckyray:notes-titlebar-split',b);return()=>{window.removeEventListener('luckyray:notes-tabs',a);window.removeEventListener('luckyray:notes-titlebar-split',b);};},[]);
 const strip=(paneId:string,state:any)=><div className="fixture-strip" data-notes-dock-tabs={paneId}>{state.tabs.map((tab:any)=><div key={tab.id} role="tab" tabIndex={0} aria-selected={state.activeId===tab.id} data-notes-dock-tab={tab.id} onPointerDown={event=>beginNotesTabPointerDrag(event,{sourcePaneId:paneId,tabId:tab.id,title:tab.title})} onClick={()=>window.dispatchEvent(new CustomEvent(split?'luckyray:notes-titlebar-pane-activate':'luckyray:notes-tab-select',{detail:split?{paneId,tabId:tab.id}:{tabId:tab.id,noteId:tab.kind==='empty'?null:tab.id,kind:tab.kind}}))}>{tab.title}</div>)}</div>;
 return <><style>{`html,body,#root{margin:0;height:100%;width:100%;overflow:hidden}#root{display:flex;flex-direction:column}#page-notes{display:flex;flex:1;min-height:0}.fixture-titlebar{height:40px;flex:none;display:flex;background:#24232a}.fixture-strip{display:flex;flex:1;min-width:0}.fixture-strip>[role=tab]{min-width:130px;padding:10px 16px;box-sizing:border-box;cursor:default}.fixture-strip>[aria-selected=true]{background:#313039;color:#bbb0ff}.notes-layout{flex:1;min-height:0;width:100%}.note-live-editor-host{height:100%}`}</style><div className="fixture-titlebar">{strip(split?.rootPaneId||'notes-pane-1',split?.root||tabs)}{split?.pane&&strip(split.paneId,split.pane)}</div><NotesPage/></>;
}
await knowledgeStore.revalidate({reason:'notes-production-fixture'});
createRoot(document.getElementById('root')!).render(<I18nProvider locale="zh-CN"><Fixture/></I18nProvider>);
