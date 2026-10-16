import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultPresentation,reorderVisibleControl,decodePresentation,materialsToolbarControls} from '../src/workspace/presentation.ts';
import {LayoutStore} from '../src/workspace/layoutStore.ts';
import {IntegratedPresets} from '../src/workspace/integratedPresets.ts';
import {captureIntegratedLayouts,registerIntegratedLayout,restoreIntegratedLayouts} from '../src/workspace/integratedLayoutRegistry.ts';
const storage=()=>{const data=new Map<string,string>();return {data,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};};
test('visible reorder preserves hidden controls and appends drop correctly',()=>{
 const config={order:['a','hidden','b','c'],hidden:['hidden']};
 assert.deepEqual(reorderVisibleControl(config,'c',0,['a','b','c']).order,['c','a','hidden','b']);
 assert.deepEqual(reorderVisibleControl(config,'a',2,['a','b','c']).order,['hidden','b','c','a']);
 assert.equal(reorderVisibleControl(config,'foreign',0,['a','b','c']),config);
});
test('materials order is schema-validated and independent of trial toolbar',()=>{
 const original=defaultPresentation();const value=decodePresentation({...original,materialsToolbar:{order:[...materialsToolbarControls].reverse(),hidden:[]}})!;
 assert.deepEqual(value.toolbar,original.toolbar);assert.equal(value.materialsToolbar?.order[0],'export');
 assert.equal(decodePresentation({...original,materialsToolbar:{order:['view','view'],hidden:[]}}),null);
});
test('integrated presets preserve original workspace key and reject duplicate names/corruption',()=>{
 const disk=storage();disk.setItem('luckyray-workspace-presets-v1:main','untouched');const presets=new IntegratedPresets(disk);
 const snapshot={name:'Research',route:'notes',presentation:defaultPresentation(),pages:{notes:{version:1,tabs:['note-1']}}};
 const first=presets.save(snapshot);assert.equal(presets.list().length,1);assert.equal(disk.getItem('luckyray-workspace-presets-v1:main'),'untouched');
 assert.throws(()=>presets.save({...snapshot,name:'research'}));presets.save({...snapshot,name:'Writing'},first.id);assert.equal(presets.list()[0].name,'Writing');
 presets.remove(first.id);assert.equal(presets.list().length,0);
 disk.setItem('luckyray-integrated-layouts-v1','broken');assert.throws(()=>presets.save(snapshot));assert.equal(disk.getItem('luckyray-integrated-layouts-v1'),'broken');
});
test('registry preflight and rollback preserve live state when a provider refuses',async()=>{
 let notes=1,graph=2;
 const a=registerIntegratedLayout('notes',{capture:()=>notes,checkpoint:()=>{const original=notes;return async()=>{notes=original;};},validate:v=>typeof v==='number',restore:async v=>{notes=v as number;return true;}});
 const b=registerIntegratedLayout('graph',{capture:()=>graph,checkpoint:()=>{const original=graph;return async()=>{graph=original;};},validate:v=>typeof v==='number',restore:async v=>{if(v===99)return false;graph=v as number;return true;}});
 assert.deepEqual(captureIntegratedLayouts(),{notes:1,graph:2});
 await assert.rejects(restoreIntegratedLayouts({notes:3,graph:'invalid'}));assert.equal(notes,1);
 await assert.rejects(restoreIntegratedLayouts({notes:3,graph:99}));assert.equal(notes,1);assert.equal(graph,2);
 a();b();await assert.rejects(restoreIntegratedLayouts({notes:1}));
});
test('production shell owns direct controls and compact popup; native file-drop remains enabled',()=>{
 const sidebar=readFileSync(new URL('../src/app/AppSidebar.tsx',import.meta.url),'utf8');
 assert.match(sidebar,/beginControlPointerDrag/);assert.match(sidebar,/materials-feature-tools/);assert.match(sidebar,/IntegratedLayoutManager/);
 assert.doesNotMatch(sidebar,/CustomizeControls|setCustomizingNavigation|luckyray:graph-reset/);
 assert.match(sidebar,/graphSessionStore\.select/);assert.match(sidebar,/beginNotesTabPointerDrag/);
 const config=readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8');assert.doesNotMatch(config,/"dragDropEnabled"\s*:\s*false/);
});

test('storage failure rolls pages back exactly and never changes live shell/history',async()=>{
 const disk=storage();let fail=false;const store=new LayoutStore('main',{getItem:disk.getItem,setItem:(key,value)=>{if(fail&&key==='luckyray-workspace-v1:main')throw Error('quota');disk.setItem(key,value);}});
 const initial=store.getSnapshot();let pages=['original'];
 const release=registerIntegratedLayout('graph',{capture:()=>pages,validate:Array.isArray,checkpoint:()=>{const before=[...pages];return async()=>{pages=before;};},restore:async value=>{pages=[...pages,...value as string[]];return true;}});
 const preset=defaultPresentation();preset.navigation.space.order.reverse();fail=true;
 await assert.rejects(restoreIntegratedLayouts({graph:['new-view']},()=>{if(!store.applyPresentation(preset))throw Error('quota');}));
 assert.deepEqual(pages,['original']);assert.equal(store.getSnapshot(),initial);store.undo();assert.equal(store.getSnapshot(),initial);
 fail=false;await restoreIntegratedLayouts({graph:['new-view']},()=>{assert.equal(store.applyPresentation(preset),true);});
 assert.deepEqual(pages,['original','new-view']);assert.deepEqual(store.getSnapshot().presentation,preset);release();
});

test('valid shell pages can save layouts and invalid routes show a meaningful error',()=>{
 const presets=new IntegratedPresets(storage());
 for(const route of ['attachments','browser','plugins'])assert.equal(presets.save({name:route,route,presentation:defaultPresentation(),pages:{}}).route,route);
 assert.throws(()=>presets.save({name:'valid name',route:'foreign',presentation:defaultPresentation(),pages:{}}),/页面或布局/);
});

test('single graph group uses titlebar tabs and split groups use one local strip each',()=>{
 const sidebar=readFileSync(new URL('../src/app/AppSidebar.tsx',import.meta.url),'utf8');
 const graph=readFileSync(new URL('../src/features/graph/GraphPage.tsx',import.meta.url),'utf8');
 assert.match(sidebar,/graphTabStrip = isGraph && graphSession.groups.length === 1/);
 assert.match(graph,/const grouped = state.groups.length > 1/);
 assert.match(graph,/grouped && <div[^>]*graph-session-tab-strip/);
});

test('effect re-registration cannot separate a restore from its exact rollback owner',async()=>{
 let state='original',didMutate=false,newRestoreCalled=false;
 let releaseReplacement=()=>{};
 const release=registerIntegratedLayout('notes',{
  capture:()=>state,validate:()=>true,
  checkpoint:()=>{const original=state;releaseReplacement=registerIntegratedLayout('notes',{capture:()=>state,validate:()=>true,checkpoint:()=>async()=>{},restore:async()=>{newRestoreCalled=true;state='replacement';return true;}});return async()=>{if(didMutate)state=original;};},
  restore:async()=>{didMutate=true;state='preset';return true;}
 });
 await assert.rejects(restoreIntegratedLayouts({notes:'preset'},()=>{throw Error('quota');}));
 assert.equal(newRestoreCalled,false);assert.equal(state,'original');releaseReplacement();release();
});

test('A and B capture independent live snapshots and survive apply, reload, and update',async()=>{
 const disk=storage(),store=new LayoutStore('main',disk),presets=new IntegratedPresets(disk);
 let live={panes:[{id:'one',ratio:.25}]};
 const release=registerIntegratedLayout('notes',{capture:()=>live,validate:value=>!!value&&typeof value==='object',checkpoint:()=>{const before=structuredClone(live);return async()=>{live=before;};},restore:async value=>{live=structuredClone(value) as typeof live;return true;}});
 const save=(name:string,id?:string)=>presets.save({name,route:'notes',presentation:store.getSnapshot().presentation??defaultPresentation(),pages:captureIntegratedLayouts()},id);
 const apply=async(id:string)=>{const row=presets.list().find(item=>item.id===id)!;await restoreIntegratedLayouts(row.pages,()=>{assert.equal(store.applyPresentation(row.presentation),true);});};
 const a=save('A');
 const second=defaultPresentation();second.navigation.space.order.reverse();second.materialsToolbar={order:[...materialsToolbarControls].reverse(),hidden:['export']};
 store.dispatch({type:'presentation',presentation:second});live.panes[0].ratio=.7;live.panes.push({id:'two',ratio:.5});
 const b=save('B');
 assert.notDeepEqual(a.presentation,b.presentation);assert.notDeepEqual(a.pages,b.pages);
 for(let repeat=0;repeat<3;repeat++){
  await apply(a.id);assert.deepEqual(live,{panes:[{id:'one',ratio:.25}]});assert.deepEqual(store.getSnapshot().presentation,a.presentation);
  await apply(b.id);assert.deepEqual(live,{panes:[{id:'one',ratio:.7},{id:'two',ratio:.5}]});assert.deepEqual(store.getSnapshot().presentation,b.presentation);
 }
 const reloaded=new IntegratedPresets(disk);assert.deepEqual(reloaded.list().map(row=>row.pages),[a.pages,b.pages]);
 live.panes[0].ratio=.9;save('B',b.id);assert.deepEqual(reloaded.list()[0],a);assert.equal((reloaded.list()[1].pages.notes as typeof live).panes[0].ratio,.9);
 release();
});

test('saved values do not alias caller-owned page snapshots',()=>{
 const presets=new IntegratedPresets(storage()),pages={notes:{panes:[{ratio:.3}]}};
 const saved=presets.save({name:'A',route:'notes',presentation:defaultPresentation(),pages});
 pages.notes.panes[0].ratio=.8;
 assert.equal((saved.pages.notes as typeof pages.notes).panes[0].ratio,.3);
 assert.deepEqual(presets.list()[0].pages,saved.pages);
});
