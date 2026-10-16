import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NamedLayouts} from '../src/workspace/namedLayouts.ts';
import {createLayout,reduceLayout} from '../src/workspace/layout.ts';
import {LayoutStore} from '../src/workspace/layoutStore.ts';
function fixture(){
 const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 const library=new NamedLayouts('main',storage);return {values,storage,library};
}
const layout=()=>reduceLayout(createLayout('main'),{type:'open',groupId:'workspace-group-1',view:{id:'note',title:'笔记',kind:'note',library:{kind:'knowledge',id:'A'},resourceId:'note.md'}});
test('named layouts are explicit snapshots, never overwritten by automatic recovery',()=>{
 const {library,storage}=fixture();const store=new LayoutStore('main',storage);store.restore(layout());
 const saved=library.save(' 写作 ',store.getSnapshot());store.dispatch({type:'close',viewId:'note'});
 assert.equal(library.list()[0].name,'写作');assert.ok(library.list()[0].layout.views.note);
 assert.equal(new LayoutStore('main',storage).getSnapshot().views.note,undefined);
 assert.ok(store.restore(saved.layout));assert.ok(store.getSnapshot().views.note);store.undo();assert.equal(store.getSnapshot().views.note,undefined);
});
test('save strips document content and rejects foreign windows',()=>{
 const {library,values}=fixture();const state=layout();Object.assign(state.views.note,{draft:'DO-NOT-SAVE',token:'SECRET'});
 library.save('A',state);assert.ok(!values.get(library.key)?.includes('DO-NOT-SAVE'));assert.ok(!values.get(library.key)?.includes('SECRET'));
 assert.throws(()=>library.save('B',{...state,windowId:'other'}));assert.equal(library.list().length,1);
});
test('duplicate and replacement operations are explicit; removal only affects templates',()=>{
 const {library}=fixture();const first=library.save('Write',layout());assert.throws(()=>library.save(' write ',layout()));
 assert.throws(()=>library.save('New',layout(),'missing'));library.save('Read',createLayout('main'),first.id);
 assert.equal(library.list().length,1);assert.equal(library.list()[0].name,'Read');library.remove(first.id);assert.deepEqual(library.list(),[]);
});
test('corrupt data is reported and never overwritten by a new save/remove',()=>{
 for(const raw of ['{',JSON.stringify([null]),JSON.stringify({}),JSON.stringify([{name:'broken'}])]){
  const {library,values}=fixture();values.set(library.key,raw);assert.throws(()=>library.list());assert.throws(()=>library.save('new',layout()));assert.throws(()=>library.remove('x'));assert.equal(values.get(library.key),raw);
 }
});
test('preset count and quota failures do not erase existing data',()=>{
 const {library,values,storage}=fixture();for(let i=0;i<24;i++)library.save(`布局${i}`,layout());const before=values.get(library.key);
 assert.throws(()=>library.save('overflow',layout()));assert.equal(values.get(library.key),before);
 const broken=new NamedLayouts('main',{...storage,setItem:()=>{throw Error('quota');}});assert.throws(()=>broken.remove(library.list()[0].id));assert.equal(values.get(library.key),before);
});
