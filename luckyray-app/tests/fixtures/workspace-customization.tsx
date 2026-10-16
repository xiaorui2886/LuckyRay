import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../../src/core/i18n/index';
import {AppSidebar,type ShellRoute} from '../../src/app/AppSidebar';
import {WorkspaceToolbar} from '../../src/workspace/WorkspaceToolbar';
import {windowLayoutStore} from '../../src/workspace/layoutStore';
import '../../src/core/theme/themeTokens.css';
import '../../src/app/appShell.css';
import '../../src/workspace/workspace.css';
const store=windowLayoutStore('main');(window as any).workspaceStore=store;
function App(){const [route,setRoute]=useState<ShellRoute>('workspace');return <I18nProvider locale="zh-CN"><div className="react-nav-shell"><AppSidebar route={route} onNavigate={setRoute}/><main style={{flex:1,minWidth:0}}><WorkspaceToolbar store={store} onAction={()=>{}}/><p>当前视图：{route}</p></main></div></I18nProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
