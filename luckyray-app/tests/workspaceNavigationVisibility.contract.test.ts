import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPresentation,spaceControls,filterControls} from '../src/workspace/presentation.ts';
import {navigationEntries,setNavigationVisible,resolveNavigationPresentation,navigationRouteHidden,visibleNavigationFallback,newlyHiddenNavigationFallback,type NavigationVisibility} from '../src/workspace/navigationVisibility.ts';
import {LayoutStore} from '../src/workspace/layoutStore.ts';

test('built-in visibility survives reload without changing direct drag order',()=>{
 const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)};
 const store=new LayoutStore('main',storage),before=defaultPresentation();before.navigation.space.order.reverse();
 assert.equal(store.applyPresentation(before),true);
 assert.equal(store.applyPresentation(setNavigationVisible(store.getSnapshot().presentation!,'graph',false)),true);
 const reloaded=new LayoutStore('main',storage).getSnapshot().presentation!;
 assert.deepEqual(reloaded.navigation.space.order,before.navigation.space.order);assert.deepEqual(reloaded.navigation.space.hidden,['graph']);
 const restored=setNavigationVisible(reloaded,'graph',true);assert.deepEqual(restored.navigation.space.order,before.navigation.space.order);assert.deepEqual(restored.navigation.space.hidden,[]);
 assert.equal(setNavigationVisible(restored,'settings',false),restored);
 assert.equal(setNavigationVisible(restored,'future-unknown',false),restored);
 assert.deepEqual(navigationEntries.map(entry=>entry.id),[...spaceControls,...filterControls]);
});

test('newly hidden current entries fall back safely, while direct links remain usable',()=>{
 const before:NavigationVisibility={presentation:defaultPresentation(),pluginKeys:['pkg-a/page','pkg-b/page']};
 const after={...before,presentation:setNavigationVisible(before.presentation,'materials',false)};
 assert.equal(newlyHiddenNavigationFallback('materials',before,after),'notes');
 assert.equal(newlyHiddenNavigationFallback('materials',after,after),null,'a later direct link is not blocked');
 assert.equal(newlyHiddenNavigationFallback('settings',before,after),null);
 assert.equal(newlyHiddenNavigationFallback('notes/document',before,after),null);
 assert.equal(newlyHiddenNavigationFallback('plugins/pkg-a/page',before,{...before,pluginKeys:['pkg-b/page']}),'materials');
 assert.equal(newlyHiddenNavigationFallback('plugins/pkg-b/page',before,{...before,pluginKeys:['pkg-b/page']}),null);
 assert.equal(newlyHiddenNavigationFallback('collection',before,{...before,presentation:setNavigationVisible(before.presentation,'collection',false)}),'materials');
});

test('hide-all always leaves Settings as a usable fallback and storage failure leaves visibility intact',()=>{
 let layout=defaultPresentation();for(const entry of navigationEntries)layout=setNavigationVisible(layout,entry.id,false);
 const hidden={presentation:layout,pluginKeys:[]};
 assert.equal(visibleNavigationFallback(hidden),'settings');assert.equal(navigationRouteHidden('settings',hidden),false);
 assert.equal(newlyHiddenNavigationFallback('materials',null,hidden),null,'startup deep links remain usable');
 assert.equal(newlyHiddenNavigationFallback('materials',{presentation:defaultPresentation(),pluginKeys:[]},hidden),'settings');
 assert.equal(newlyHiddenNavigationFallback('plugins/unpinned/home',null,hidden),null,'an unpinned plugin startup is not a hide event');
 const store=new LayoutStore('main',{getItem:()=>null,setItem:()=>{throw Error('quota');}}),before=store.getSnapshot();
 assert.equal(store.applyPresentation(layout),false);assert.equal(store.getSnapshot(),before);assert.ok(store.storageError);
});


test('Collection visibility is part of each saved presentation, independent of the legacy General flag',()=>{
 const old=defaultPresentation();
 const legacyHidden=resolveNavigationPresentation(old,false);assert.ok(legacyHidden.navigation.filters.hidden.includes('collection'));
 const a=resolveNavigationPresentation(old,true),b=setNavigationVisible(a,'collection',false);
 assert.equal(resolveNavigationPresentation(a,false),a,'a saved visible layout ignores later legacy flags');
 assert.equal(resolveNavigationPresentation(b,true),b,'a saved hidden layout ignores later legacy flags');
 const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)};
 const store=new LayoutStore('main',storage);store.applyPresentation(b);store.applyPresentation(a);
 const reloaded=new LayoutStore('main',storage).getSnapshot().presentation!;
 assert.equal(reloaded.navigationVisibilityVersion,1);assert.equal(navigationRouteHidden('collection',{presentation:resolveNavigationPresentation(reloaded,false),pluginKeys:[]}),false);
});
