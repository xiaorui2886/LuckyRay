import {useEffect,useState,useSyncExternalStore} from 'react';
import {useI18n,type MessageKey} from '../../core/i18n/index';
import {extensionPackages,packageCompatibility} from '../../core/extensions/packages';
import {pageKey,readSidebarPrefs,scriptContributions,SIDEBAR_PREFS_KEY,withSidebarPref} from '../community/pluginPages';
import {windowLayoutStore} from '../../workspace/layoutStore';
import {defaultPresentation} from '../../workspace/presentation';
import {navigationEntries,setNavigationVisible,resolveNavigationPresentation} from '../../workspace/navigationVisibility';
import {IntegratedLayoutManager} from '../../workspace/IntegratedLayoutManager';
import type {SettingsMap,SettingsValue} from './useSettings';

export default function LayoutSettingsPanel({settings,setSetting,shouldShow}:{settings:SettingsMap;setSetting:(key:string,value:SettingsValue)=>void;shouldShow:(text:string)=>boolean}){
 const {t}=useI18n();
 const [store]=useState(()=>windowLayoutStore('main'));
 const layout=useSyncExternalStore(store.subscribe,store.getSnapshot),presentation=resolveNavigationPresentation(layout.presentation??defaultPresentation(),settings["general.showCollectionNav"]===true);
 const [packages,setPackages]=useState(()=>extensionPackages.snapshot());
 const [error,setError]=useState(''),[managing,setManaging]=useState(false);
 useEffect(()=>extensionPackages.subscribe(()=>setPackages(extensionPackages.snapshot())),[]);
 const pluginPrefs=readSidebarPrefs(settings);
 const pluginEntries:{key:string;label:string;packageName:string;available:boolean;missing?:boolean}[]=packages.packages.filter(entry=>entry.package.manifest.type==='script').flatMap(entry=>scriptContributions(entry).filter(page=>page.kind==='page').map(page=>({key:pageKey(entry.package.manifest.id,page.id),label:page.label,packageName:entry.package.manifest.name,available:entry.enabled&&packageCompatibility(entry.package,packages.hostVersion).compatible})));
 if(packages.ready)for(const key of pluginPrefs)if(!pluginEntries.some(entry=>entry.key===key))pluginEntries.push({key,label:key,packageName:'',available:false,missing:true});
 const toggleBuiltin=(id:string,visible:boolean)=>{
  const current=resolveNavigationPresentation(store.getSnapshot().presentation??defaultPresentation(),settings['general.showCollectionNav']===true);
  if(!store.applyPresentation(setNavigationVisible(current,id,visible))){setError(store.storageError??t('settings.layout.saveFailed'));return;}
  setError('');
 };
 const row=(key:string,label:string,visible:boolean,onChange:()=>void,description?:string,locked=false)=>shouldShow(`${label} ${description??''} 导航 显示 隐藏 visibility navigation`)&&<div className="setting-row" key={key}><div className="setting-label">{label}{description&&<div className="desc">{description}</div>}</div><div className="setting-control"><button type="button" role="switch" data-navigation-entry={key} aria-label={description?`${label} · ${description}`:label} aria-checked={visible} className={`toggle${visible?' on':''}`} onClick={onChange} disabled={locked}/></div></div>;
 return <>
  <h2>{t('settings.tab.layout')}</h2><p className="settings-panel-sub">{t('settings.layout.description')}</p>
  {error&&<p role="alert" className="settings-message error">{error}</p>}
  <div className="setting-group"><h3>{t('settings.layout.builtin')}</h3>
   {navigationEntries.map(entry=>{const label=t(entry.labelKey as MessageKey),visible=!presentation.navigation[entry.section].hidden.includes(entry.id);return row(entry.id,label,visible,()=>toggleBuiltin(entry.id,!visible));})}
   {row('settings',t('sidebar.route.settings'),true,()=>{},t('settings.layout.settingsReachable'),true)}
  </div>
  <div className="setting-group"><h3>{t('settings.layout.plugins')}</h3>
   {pluginEntries.map(entry=>row(entry.key,entry.label,pluginPrefs.includes(entry.key),()=>{try{setSetting(SIDEBAR_PREFS_KEY,JSON.stringify(withSidebarPref(readSidebarPrefs(),entry.key,!pluginPrefs.includes(entry.key))));setError('');}catch(error){setError(String(error));}},entry.missing?t('settings.layout.pluginMissing'):`${entry.packageName}${entry.available?'':` · ${t('settings.layout.pluginUnavailable')}`}`))}
   {!pluginEntries.length&&<p className="settings-panel-sub">{t(packages.ready?'settings.layout.noPlugins':'settings.layout.pluginsLoading')}</p>}
  </div>
  {shouldShow('布局 保存 更新 应用 layout saved')&&<div className="setting-group"><h3>{t('settings.layout.saved')}</h3><p className="settings-panel-sub">{t('settings.layout.dragHint')}</p><button className="settings-btn" type="button" onClick={()=>setManaging(true)}>{t('settings.layout.manage')}</button></div>}
  {managing&&<IntegratedLayoutManager store={store} route="settings" onClose={()=>setManaging(false)}/>}
 </>;
}
