import React,{useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../../src/core/i18n/index';
import {AppSidebar,AppTitlebar,type ShellRoute} from '../../src/app/AppSidebar';
import {ApplicationModalIsolationProvider,createApplicationModalIsolationStore,useApplicationModalIsolationSnapshot} from '../../src/app/applicationModalIsolation';
import {windowLayoutStore} from '../../src/workspace/layoutStore';
import '../../src/core/theme/themeTokens.css';
import '../../src/app/appShell.css';
const store=windowLayoutStore('main');(window as any).workspaceStore=store;
const modal=createApplicationModalIsolationStore();
function Surface(){const [route,setRoute]=useState<ShellRoute>('graph');const isolated=useApplicationModalIsolationSnapshot(modal);return <div className="react-nav-shell" style={{height:'100vh'}}><AppSidebar route={route} onNavigate={setRoute} applicationModalIsolated={isolated}/><main style={{flex:1,minWidth:0}}><AppTitlebar route="materials" onOpenSearch={()=>{}} applicationModalIsolated={isolated}/><p data-testid="route">当前视图：{route}</p><p style={{padding:24}}>Production shell controls fixture. The content controller is tested separately.</p></main></div>;}
function App(){return <I18nProvider locale="zh-CN"><ApplicationModalIsolationProvider store={modal}><Surface/></ApplicationModalIsolationProvider></I18nProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
