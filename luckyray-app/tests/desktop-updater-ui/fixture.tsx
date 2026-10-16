import React from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../../src/core/i18n/index';
import DesktopUpdateCard from '../../src/features/settings/DesktopUpdateCard';
import {useState} from 'react';
function App(){const[visible,setVisible]=useState(true);return <I18nProvider locale="zh-CN"><main className="luckyray-settings-page"><h1>应用更新</h1><button id="toggle" onClick={()=>setVisible(!visible)}>切换设置页</button>{visible&&<DesktopUpdateCard version="1.9.6" active={true} openLink={async()=>{}}/>}</main></I18nProvider>}
createRoot(document.getElementById('root')!).render(<App/>);
