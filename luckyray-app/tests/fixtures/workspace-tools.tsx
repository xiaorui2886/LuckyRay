import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../../src/core/i18n/index';
import {WorkspaceHost} from '../../src/workspace/WorkspaceHost';
import {WorkspaceNoteView} from '../../src/workspace/NoteView';
import {LayoutStore} from '../../src/workspace/layoutStore';
import {DocumentSessions} from '../../src/workspace/documentSession';
import {ToolRegistry,WorkspaceToolsContext} from '../../src/workspace/toolRegistry';
import {ToolDeck} from '../../src/workspace/ToolDeck';
import {emptyTools,moveTool} from '../../src/workspace/toolLayout';
import {LayoutLibrary} from '../../src/workspace/LayoutLibrary';
import '../../src/core/theme/themeTokens.css';
const store=new LayoutStore('tool-fixture');const sessions=new DocumentSessions();const tools=new ToolRegistry();const fixture=window as any;fixture.workspaceStore=store;fixture.refuseSave=false;
fixture.documentSessions=sessions;
for(const id of ['A','B'])store.dispatch({type:'open',view:{id,kind:'note',title:`笔记 ${id}`,library:{kind:'knowledge',id:'test'},resourceId:`${id}.md`},groupId:'workspace-group-1'});
function App(){const [open,setOpen]=useState(false);return <I18nProvider locale="zh-CN"><div className="workspace-page"><div className="workspace-toolbar"><button onClick={()=>store.dispatch({type:'tools',tools:moveTool(store.getSnapshot().tools??emptyTools(),'outline','right')})}>打开大纲</button><button onClick={()=>setOpen(true)}>命名布局</button></div>
 <WorkspaceToolsContext.Provider value={tools}><ToolDeck store={store} registry={tools}><WorkspaceHost store={store} renderView={view=><WorkspaceNoteView view={view} session={sessions.get({libraryId:'test',resourceId:view.resourceId!},()=>({read:async()=>({content:`# ${view.id} 章节\n\n初始正文\n\n## 子标题`,revision:'1'}),write:async content=>({content,revision:crypto.randomUUID()})}))}/>}/></ToolDeck></WorkspaceToolsContext.Provider>
 {open&&<LayoutLibrary store={store} beforeRestore={async()=>!fixture.refuseSave&&await sessions.flushAll()} onClose={()=>setOpen(false)}/>}
 </div></I18nProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
