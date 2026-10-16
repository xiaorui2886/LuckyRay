import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import * as layoutStore from '../src/workspace/layoutStore.ts';
import * as presentation from '../src/workspace/presentation.ts';
import * as visibility from '../src/workspace/navigationVisibility.ts';
import * as registry from '../src/workspace/integratedLayoutRegistry.ts';
import * as presets from '../src/workspace/integratedPresets.ts';
import * as pointer from '../src/workspace/controlPointerDrag.ts';
import * as toolbar from '../src/features/materials/materialsToolbarProtocol.ts';
import {graphSessionStore} from '../src/features/graph/graphSessionStore.ts';
const require=createRequire(import.meta.url), React=require('react');

// Execute the production JSX, hook closures and handlers. The narrow hook host
// explicitly rerenders after state changes; it does not claim native/browser QA.
function hookHost(){
 const slots:any[]=[];let at=0;
 const memo=(make:()=>any,deps?:unknown[])=>{const i=at++,old=slots[i];if(old&&deps&&old.deps&&deps.every((v,j)=>Object.is(v,old.deps[j])))return old.value;const value=make();slots[i]={value,deps};return value;};
 return {render:(Component:any,props:any)=>{at=0;return Component(props);},hooks:{...React,
  useState:(initial:any)=>{const i=at++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],(value:any)=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
  useRef:(value:any)=>memo(()=>({current:value}),[]),useMemo:memo,useCallback:(fn:any,deps:any)=>memo(()=>fn,deps),
  useEffect:()=>{},useLayoutEffect:()=>{},useSyncExternalStore:(_subscribe:any,get:any)=>get(),
 }};
}
function loadComponent(file:string,hooks:any,overrides:Record<string,unknown>={}){
 const source=process.env.LAYOUT_COMPONENT_BASE ? execFileSync('git',['show',`${process.env.LAYOUT_COMPONENT_BASE}:luckyray-app/${file.replace('../','')}`],{encoding:'utf8'}) : readFileSync(new URL(file,import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:any={};
 const mockRequire=(id:string):any=>{
  if(id in overrides)return overrides[id];
  if(id==='react')return hooks;if(id==='react/jsx-runtime')return require(id);if(id==='react-dom')return {createPortal:(child:any)=>child};
  if(id.endsWith('/navigationVisibility'))return visibility;
  if(id.endsWith('/useSettings'))return {readSavedSettings:()=>({})};
  if(id.endsWith('/layoutStore'))return layoutStore;if(id.endsWith('/presentation'))return presentation;
  if(id.endsWith('/integratedLayoutRegistry'))return registry;if(id.endsWith('/integratedPresets'))return presets;
  if(id.endsWith('/controlPointerDrag'))return pointer;if(id.endsWith('/materialsToolbarProtocol'))return toolbar;
  if(id.endsWith('/graphSessionStore'))return {graphSessionStore};
  if(id.endsWith('/knowledgeStore'))return {knowledgeStore:{subscribe:()=>()=>{},getSnapshot:()=>({})},hasUsableKnowledgeSnapshot:()=>false};
  if(id.endsWith('/i18n/index'))return {useI18n:()=>({t:(key:string)=>key,plural:()=>''})};
  if(id.endsWith('/applicationModalIsolation'))return {useApplicationModalSurface:()=>({surfaceRef:{current:null},onBackdropPointerDown:()=>{},onSurfaceKeyDown:()=>{}})};
  return {};
 };
 vm.runInNewContext(compiled,{exports,require:mockRequire,localStorage:(globalThis as any).localStorage,window:(globalThis as any).window,document:(globalThis as any).document,crypto,console});return exports;
}
function elements(tree:any):any[]{if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(elements);return [tree,...elements(tree.props?.children)];}
class Target {
 listeners=new Map<string,Set<(event:any)=>void>>();hidden=false;
 addEventListener(type:string,fn:(event:any)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(fn);}
 removeEventListener(type:string,fn:(event:any)=>void){this.listeners.get(type)?.delete(fn);}
 emit(type:string,extra:any={}){for(const fn of [...this.listeners.get(type)??[]])fn({pointerId:1,clientX:10,clientY:20,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){},...extra});}
}
class Element extends Target {
 dataset:any={};group!:Element;children:Element[]=[];capture:number|null=null;left=0;width=40;
 classList={add(){},remove(){}};contains(other:any){return other===this;}closest(){return this.group;}querySelectorAll(){return this.children;}
 getBoundingClientRect(){return {left:this.left,right:this.left+this.width,top:0,bottom:40,width:this.width,height:40};}
 setPointerCapture(id:number){this.capture=id;}hasPointerCapture(id:number){return this.capture===id;}releasePointerCapture(){this.capture=null;this.emit('lostpointercapture');}
}

test('production Materials toolbar pointer moves save distinct A/B and restore their rendered order',async()=>{
 const data=new Map<string,string>();(globalThis as any).localStorage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)};
 const host=new Target();(host as any).location={hash:''};(globalThis as any).window=host;(globalThis as any).document={body:{},addEventListener(){},removeEventListener(){}};(globalThis as any).Node=Element;
 const titlebarHost=hookHost(),{AppTitlebar}=loadComponent('../src/app/AppSidebar.tsx',titlebarHost.hooks);
 const renderToolbar=()=>{const tree=titlebarHost.render(AppTitlebar,{route:'materials',onOpenSearch(){}});const ordered=elements(tree).find(node=>node.type?.name==='OrderedMaterialControls');assert.ok(ordered);return elements(ordered.type(ordered.props)).filter(node=>node.props?.['data-control-id']);};
 const order=()=>renderToolbar().map(node=>node.props['data-control-id']);
 const drag=(id:string,index:number)=>{
  const controls=renderToolbar(),group=new Element();group.dataset.controlAxis='horizontal';group.width=controls.length*50;
  group.children=controls.map((node,i)=>{const child=new Element();child.dataset.controlId=node.props['data-control-id'];child.left=i*50;child.group=group;return child;});
  const i=controls.findIndex(node=>node.props['data-control-id']===id),source=group.children[i];
  controls[i].props.onPointerDown({button:0,pointerId:1,clientX:source.left+20,clientY:20,currentTarget:source});
  const peers=group.children.filter(child=>child!==source);const x=index>=peers.length?group.width-2:peers[index].left+1;
  host.emit('pointermove',{clientX:x});host.emit('pointerup',{clientX:x});
 };
 const store=layoutStore.windowLayoutStore('main');
 let managerHost=hookHost(),manager=loadComponent('../src/workspace/IntegratedLayoutManager.tsx',managerHost.hooks).IntegratedLayoutManager;
 const renderManager=()=>managerHost.render(manager,{store,route:'materials',onClose(){}});
 const save=(name:string)=>{elements(renderManager()).find(node=>node.type==='input').props.onChange({target:{value:name}});elements(renderManager()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});};
 const apply=async(name:string)=>{elements(renderManager()).find(node=>node.props?.['aria-label']===`应用布局 ${name}`||(node.props?.className==='integrated-layout-apply'&&elements(node).some(child=>child.type==='span'&&child.props.children===name))).props.onClick();await new Promise(resolve=>setImmediate(resolve));};
 drag('import-folder',0);const a=order();assert.equal(a[0],'import-folder');save('A');
 drag('view',5);const b=order();assert.equal(b.at(-1),'view');assert.notDeepEqual(a,b);save('B');
 const diskBefore=data.get('luckyray-integrated-layouts-v1');const saved=new presets.IntegratedPresets((globalThis as any).localStorage).list();
 assert.notDeepEqual(saved[0].presentation.materialsToolbar,saved[1].presentation.materialsToolbar);
 for(let i=0;i<3;i++){await apply('A');assert.deepEqual(order(),a);await apply('B');assert.deepEqual(order(),b);}
 assert.equal(data.get('luckyray-integrated-layouts-v1'),diskBefore,'applying never overwrites a saved row');
 // Recreate the popup so the test includes reading names/snapshots from storage.
 managerHost=hookHost();manager=loadComponent('../src/workspace/IntegratedLayoutManager.tsx',managerHost.hooks).IntegratedLayoutManager;
 await apply('A');assert.deepEqual(order(),a);await apply('B');assert.deepEqual(order(),b);
 if(!process.env.LAYOUT_COMPONENT_BASE){
  drag('missing',0);const updated=order();
  const rowByLabel=(label:string)=>elements(renderManager()).find(node=>node.props?.['aria-label']===label);
  rowByLabel('更新布局 B').props.onClick();
  assert.equal(elements(renderManager()).find(node=>node.type==='input').props.value,'','updating needs no save-as name');
  elements(renderManager()).find(node=>node.type==='button'&&node.props.children==='取消').props.onClick();
  assert.equal(data.get('luckyray-integrated-layouts-v1'),diskBefore,'cancel must not overwrite');
  rowByLabel('更新布局 B').props.onClick();
  elements(renderManager()).find(node=>node.type==='button'&&node.props.children==='确认覆盖').props.onClick();
  await apply('A');assert.deepEqual(order(),a);await apply('B');assert.deepEqual(order(),updated);
  const latest=new presets.IntegratedPresets((globalThis as any).localStorage).list();assert.deepEqual(latest.map(row=>row.name),['A','B']);
 }
});


test('production Layout settings toggles built-ins and stable plugin entries without disabling packages',{skip:Boolean(process.env.LAYOUT_COMPONENT_BASE)},()=>{
 const data=new Map<string,string>();(globalThis as any).localStorage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)};
 const store=layoutStore.windowLayoutStore('main');store.applyPresentation(presentation.defaultPresentation());
 let settings:Record<string,unknown>={'general.showCollectionNav':true};
 const calls:any[]=[];
 const script=(id:string,name:string,enabled=true)=>({package:{manifest:{id,name,type:'script'},resource:{contributions:[{id:'home',label:'Home',kind:'page'}]}},enabled});
 const packages={extensionPackages:{snapshot:()=>({ready:true,hostVersion:'1.9.4',packages:[script('pkg-a','Plugin A'),script('pkg-b','Plugin B',false)]}),subscribe:()=>()=>{},disable(){throw Error('must not disable');},uninstall(){throw Error('must not uninstall');}},packageCompatibility:()=>({compatible:true})};
 const prefs=loadComponent('../src/features/community/pluginPages.ts',{}, {'../../core/extensions/packages':packages,'../settings/useSettings':{readSavedSettings:()=>settings,writeSavedSettingsPatch:(patch:any)=>{settings={...settings,...patch};}},'../../app/shellNav':{pluginPagePath:(a:string,b:string)=>`plugins/${a}/${b}`}});
 const hooks=hookHost(),Panel=loadComponent('../src/features/settings/LayoutSettingsPanel.tsx',hooks.hooks,{'../../core/extensions/packages':packages,'../community/pluginPages':prefs}).default;
 const render=()=>hooks.render(Panel,{settings,setSetting:(key:string,value:any)=>{calls.push([key,value]);settings={...settings,[key]:value};},shouldShow:()=>true});
 const switches=()=>elements(render()).filter(node=>node.props?.role==='switch');
 const get=(id:string)=>switches().find(node=>node.props['data-navigation-entry']===id);
 assert.equal(switches().length,14,'eleven built-ins, fixed Settings, and two installed page entries');
 assert.equal(get('settings').props.disabled,true);assert.equal(get('settings').props['aria-checked'],true);
 const orderBefore=[...store.getSnapshot().presentation!.navigation.space.order];
 get('graph').props.onClick();assert.equal(get('graph').props['aria-checked'],false);assert.deepEqual(store.getSnapshot().presentation!.navigation.space.order,orderBefore);
 get('graph').props.onClick();assert.equal(get('graph').props['aria-checked'],true);
 get('collection').props.onClick();assert.equal(get('collection').props['aria-checked'],false);assert.equal(settings['general.showCollectionNav'],true,'legacy flag is no longer a second write authority');
 get('pkg-b/home').props.onClick();assert.deepEqual(JSON.parse(settings['extensions.sidebarPages'] as string),['pkg-b/home']);
 get('pkg-a/home').props.onClick();assert.deepEqual(JSON.parse(settings['extensions.sidebarPages'] as string),['pkg-b/home','pkg-a/home']);
 get('pkg-b/home').props.onClick();assert.deepEqual(JSON.parse(settings['extensions.sidebarPages'] as string),['pkg-a/home']);
 settings={...settings,'extensions.sidebarPages':JSON.stringify(['pkg-a/home','missing/home'])};
 assert.equal(get('missing/home').props['aria-checked'],true,'missing saved choices remain manageable');
 get('missing/home').props.onClick();assert.deepEqual(JSON.parse(settings['extensions.sidebarPages'] as string),['pkg-a/home']);
 assert.ok(calls.every(([key])=>key==='extensions.sidebarPages'));
});

test('production plugin projection preserves missing IDs through a successful empty load and reinstall',{skip:Boolean(process.env.LAYOUT_COMPONENT_BASE)},()=>{
 let settings:Record<string,unknown>={'extensions.sidebarPages':JSON.stringify(['pkg-a/home','missing/home'])};
 const entry={package:{manifest:{id:'pkg-a',name:'Plugin A',type:'script'},resource:{contributions:[{id:'home',label:'Home',kind:'page'}]}},enabled:true};
 let snapshot:any={ready:false,packages:[],hostVersion:'1.9.4'};
 const packages={extensionPackages:{snapshot:()=>({...snapshot}),subscribe:()=>()=>{}},packageCompatibility:()=>({compatible:true})};
 const prefs=loadComponent('../src/features/community/pluginPages.ts',{}, {'../../core/extensions/packages':packages,'../settings/useSettings':{readSavedSettings:()=>settings,writeSavedSettingsPatch:(patch:any)=>{settings={...settings,...patch};}},'../../app/shellNav':{pluginPagePath:(a:string,b:string)=>`plugins/${a}/${b}`}});
 const host=hookHost();host.hooks.useEffect=(effect:any)=>{effect();};
 const hook=loadComponent('../src/app/usePluginSidebarPages.ts',host.hooks,{'@tauri-apps/api/core':{isTauri:()=>false},'../core/extensions/packages':packages,'../features/community/pluginPages':prefs}).usePluginSidebarPages;
 const project=()=>host.render(hook,settings);
 assert.equal(project().length,0);
 snapshot={...snapshot,ready:true,packages:[entry]};assert.equal(project()[0].key,'pkg-a/home');
 snapshot={...snapshot,packages:[]};assert.equal(project().length,0);assert.deepEqual(Array.from(prefs.readSidebarPrefs()),['pkg-a/home','missing/home']);
 snapshot={...snapshot,packages:[entry]};assert.equal(project()[0].key,'pkg-a/home');assert.deepEqual(Array.from(prefs.readSidebarPrefs()),['pkg-a/home','missing/home']);
});
