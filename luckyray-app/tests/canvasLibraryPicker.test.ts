import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasPickerRows,canvasPickerExcerpt,canvasPreviewPosition} from '../src/core/canvas/libraryPicker.ts';
const folders=[{id:'a',name:'Scenes',parentId:null},{id:'b',name:'Nested',parentId:'a'},{id:'c',name:'Scenes',parentId:null}];
const items=[{id:'root',name:'Root',folderId:null},{id:'one',name:'Silver',folderId:'a',description:'A pocket watch'},{id:'two',name:'Blue',folderId:'b'},{id:'three',name:'Note',folderId:'c',contentText:'Cinematic lighting'}];
const label=(x:typeof items[number])=>x.name;
test('folders and content share one hierarchy with collapsed descendants',()=>{
 assert.deepEqual(canvasPickerRows(items,folders,new Set(),'',label).map(x=>x.key),['folder:a','folder:c','item:root']);
 assert.deepEqual(canvasPickerRows(items,folders,new Set(['a','b']),'',label).map(x=>[x.key,x.depth]),[['folder:a',0],['folder:b',1],['item:two',2],['item:one',1],['folder:c',0],['item:root',0]]);
});
test('global search matches names, content, prompt and paths without changing order or identity',()=>{
 assert.deepEqual(canvasPickerRows(items,folders,new Set(),'cinematic',label).map(x=>x.item?.id),['three']);
 assert.equal(canvasPickerRows(items,folders,new Set(),'nested',label)[0].path,'Scenes / Nested');
 assert.equal(canvasPickerRows(items,folders,new Set(),'watch',label)[0].item,items[1]);
 assert.equal(canvasPickerExcerpt({id:'x',description:'fallback',materialGenerationProvenance:{request:{sourcePrompt:'original\n prompt',prompt:'compiled'}}}),'original prompt');
});
test('orphan items remain reachable and malformed cycles do not hang or duplicate',()=>{
 const cyclic=[{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}];
 const result=canvasPickerRows([...items,{id:'orphan',name:'Orphan',folderId:'missing'}],cyclic,new Set(['a','b']),'',label);
 assert.equal(new Set(result.map(x=>x.key)).size,result.length);assert.ok(result.find(x=>x.item?.id==='orphan'));
});
test('hover preview flips and stays inside small viewports',()=>{
 for(const width of [180,240,320,800,1440]) for(const left of [0,width/2,width-20]){const r=canvasPreviewPosition({left,right:left+200,top:1000},{width,height:600});assert.ok(r.left>=12);assert.ok(r.left+r.width<=width-12);assert.ok(r.top+370<=600-12);}
});
test('large library paths perform bounded folder work instead of rebuilding all folders per item',()=>{
 let idReads=0,nameReads=0;
 const count=600;
 const manyFolders=Array.from({length:count},(_,index)=>({get id(){idReads++;return `folder-${index}`;},get name(){nameReads++;return `Folder ${index}`;},parentId:null}));
 const manyItems=Array.from({length:count*3},(_,index)=>({id:`item-${index}`,name:`Item ${index}`,folderId:`folder-${index%count}`}));
 const matches=canvasPickerRows(manyItems,manyFolders,new Set(),'item',item=>item.name);
 assert.equal(matches.length,manyItems.length);
 assert.equal(matches[count+1].path,'Folder 1');
 assert.ok(idReads<count*10,`folder id reads should be linear, got ${idReads}`);
 assert.ok(nameReads<=count,`each path should be resolved once, got ${nameReads}`);
 idReads=0;nameReads=0;
 const all=canvasPickerRows(manyItems,manyFolders,new Set(Array.from({length:count},(_,index)=>`folder-${index}`)),'',item=>item.name);
 assert.equal(all.length,count+manyItems.length);
 assert.ok(idReads<count*20,`expanded tree folder work should be linear, got ${idReads}`);
 assert.ok(nameReads<=count,`expanded tree should reuse folder paths, got ${nameReads}`);
});
test('nested path caching preserves order, and cycles remain relative to the starting folder',()=>{
 const hierarchy=[{id:'root',name:'Root',parentId:null},{id:'child',name:'Child',parentId:'root'},{id:'leaf',name:'Leaf',parentId:'child'}];
 const data=[{id:'leaf-item',name:'Item',folderId:'leaf'},{id:'root-item',name:'Item',folderId:'root'},{id:'child-item',name:'Item',folderId:'child'}];
 assert.deepEqual(canvasPickerRows(data,hierarchy,new Set(),'item',item=>item.name).map(row=>row.path),['Root / Child / Leaf','Root','Root / Child']);
 const cycles=[{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'},{id:'c',name:'Child',parentId:'a'}];
 const cyclicItems=cycles.map(folder=>({id:folder.id,name:'Item',folderId:folder.id}));
 assert.deepEqual(canvasPickerRows(cyclicItems,cycles,new Set(),'item',item=>item.name).map(row=>row.path),['B / A','A / B','B / A / Child']);
 const collapsed=canvasPickerRows([{id:'hidden',name:'Hidden',folderId:'leaf'}],hierarchy,new Set(),'',item=>item.name);
 assert.deepEqual(collapsed.map(row=>row.key),['folder:root']);
});
test('deep expanded hierarchy is stack safe',()=>{
 const count=6000;
 const hierarchy=Array.from({length:count},(_,index)=>({id:String(index),name:'F',parentId:index?String(index-1):null}));
 const all=canvasPickerRows([{id:'deep',name:'Deep',folderId:String(count-1)}],hierarchy,new Set(hierarchy.map(folder=>folder.id)),'',item=>item.name);
 assert.equal(all.length,count+1);
 assert.equal(all.at(-1)?.depth,count);
 assert.equal(all.at(-1)?.item?.id,'deep');
});
