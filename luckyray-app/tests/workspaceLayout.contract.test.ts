import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, reduceLayout, groups, findGroup, decodeLayout, encodeLayout, measureLayout, dropEdge, type ViewRef } from '../src/workspace/layout.ts';
import { LayoutStore } from '../src/workspace/layoutStore.ts';
const view = (id: string): ViewRef => ({ id, title: id, kind: 'note', library: { kind: 'knowledge', id: 'vault-a' }, resourceId: `doc-${id}` });
const initial = () => ['a','b','c'].reduce((layout,id) => reduceLayout(layout, { type:'open', view:view(id), groupId:'workspace-group-1' }), createLayout('main'));
for (const edge of ['left','right','top','bottom'] as const) test(`move ${edge}, collapse source and preserve identity`, () => {
  const a = initial(), b = reduceLayout(a, { type:'move', viewId:'a', targetGroup:a.focusedGroup, edge, groupId:'g2', splitId:'s1' });
  assert.equal(groups(b.root).length,2); assert.equal(b.views.a,a.views.a); assert.deepEqual(findGroup(b,'a')?.tabs,['a']);
  const c = reduceLayout(b,{ type:'move',viewId:'a',targetGroup:'workspace-group-1',edge:'center',index:1 });
  assert.equal(c.root.kind,'group'); assert.deepEqual(findGroup(c,'a')?.tabs,['b','a','c']); assert.ok(decodeLayout(c,'main'));
});
test('reorder uses resulting insertion index, no duplicate tabs', () => {
  const a=initial(); const b=reduceLayout(a,{type:'move',viewId:'a',targetGroup:a.focusedGroup,edge:'center',index:2});
  assert.deepEqual(groups(b.root)[0].tabs,['b','c','a']); assert.deepEqual(groups(a.root)[0].tabs,['a','b','c']);
});
test('close last tab leaves usable empty group',()=>{
  const a=['a','b','c'].reduce((state,viewId)=>reduceLayout(state,{type:'close',viewId}),initial());
  assert.deepEqual(groups(a.root)[0].tabs,[]); assert.ok(decodeLayout(a,'main'));
});
test('invalid targets and colliding split IDs never discard source',()=>{
  const a=initial(); assert.equal(reduceLayout(a,{type:'move',viewId:'a',targetGroup:'missing',edge:'center'}),a);
  assert.equal(reduceLayout(a,{type:'move',viewId:'a',targetGroup:a.focusedGroup,edge:'left',groupId:a.focusedGroup,splitId:'s'}),a);
});
test('restore excludes body/secrets and rejects foreign windows, duplicate tabs, malformed trees',()=>{
  const a=initial(); (a.views.a as unknown as Record<string,unknown>).draft='PRIVATE';
  assert.ok(!encodeLayout(a).includes('PRIVATE')); assert.equal(decodeLayout(a,'other'),null);
  const bad=initial(); if(bad.root.kind==='group')bad.root.tabs.push('a'); assert.equal(decodeLayout(bad,'main'),null);
  assert.equal(decodeLayout({...a,root:{kind:'split',id:'cycle',first:a.root,second:a.root,axis:'row',ratio:NaN}},'main'),null);
});
test('library kind is explicit and cannot cross material/knowledge namespace',()=>{
  const a=initial(); a.views.a.library.kind='materials'; assert.equal(decodeLayout(a,'main'),null);
});
test('geometry fits narrow windows, all edges and split axes',()=>{
  for(const edge of ['left','right','top','bottom'] as const){const a=initial(),b=reduceLayout(a,{type:'move',viewId:'a',targetGroup:a.focusedGroup,edge,groupId:'g2',splitId:'s1'});
    const geometry=measureLayout(b.root,170,90); for(const rect of geometry.groups.values()){assert.ok(rect.width>=0&&rect.height>=0);assert.ok(rect.left+rect.width<=170);assert.ok(rect.top+rect.height<=90);}}
  assert.equal(dropEdge({left:0,top:0,width:600,height:400},300,200),'center');assert.equal(dropEdge({left:0,top:0,width:600,height:400},1,200),'left');
});
test('layout undo/redo is separate from document state and corrupt primary falls back to backup',()=>{
  const values=new Map<string,string>(); const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,v:string)=>{values.set(key,v);}};
  const store=new LayoutStore('main',storage);store.dispatch({type:'open',view:view('a'),groupId:'workspace-group-1'});store.dispatch({type:'open',view:view('b'),groupId:'workspace-group-1'});
  store.dispatch({type:'move',viewId:'a',targetGroup:'workspace-group-1',edge:'right',groupId:'g2',splitId:'s'});store.undo();assert.equal(store.getSnapshot().root.kind,'group');store.redo();assert.equal(store.getSnapshot().root.kind,'split');
  values.set(store.key,'broken');assert.equal(new LayoutStore('main',storage).getSnapshot().root.kind,'group');
});
test('storage quota failure preserves live state',()=>{
  const store=new LayoutStore('main',{getItem:()=>null,setItem:()=>{throw new Error('quota');}});store.dispatch({type:'open',view:view('a'),groupId:'workspace-group-1'});
  assert.ok(store.getSnapshot().views.a);assert.ok(store.storageError);
});
