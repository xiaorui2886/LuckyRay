import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasFolderBreadcrumbs, canvasFolderChildren } from '../src/core/canvas/libraryFolders.ts';
import { canvasNodeDisplayName, canvasMaterialDefaultNames } from '../src/core/canvas/materialNaming.ts';

test('folder hierarchy keeps duplicate names distinct and navigates to root', () => {
 const folders = [{id:'a',name:'Scenes',parentId:null},{id:'b',name:'Scenes',parentId:'a'},{id:'c',name:'Scenes',parentId:null}];
 assert.deepEqual(canvasFolderChildren(folders,null).map(x=>x.id),['a','c']);
 assert.deepEqual(canvasFolderBreadcrumbs(folders,'b').map(x=>x.id),['a','b']);
 assert.deepEqual(canvasFolderBreadcrumbs(folders,null),[]);
 assert.deepEqual(canvasFolderBreadcrumbs(folders,'missing'),[]);
});
test('malformed cyclic folder data does not hang navigation', () => {
 assert.equal(canvasFolderBreadcrumbs([{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}],'a').length,2);
});
test('node labels win over prompts; unnamed results use a short local phrase', () => {
 assert.equal(canvasNodeDisplayName('My campaign','other prompt','image'),'My campaign');
 assert.equal(canvasNodeDisplayName('Image','Create a crisp studio still life: a silver mechanical watch, woven blue fabric','image',true),'a silver mechanical watch');
 assert.equal(canvasNodeDisplayName('图片生成','生成雨夜街道，霓虹灯','image'),'雨夜街道');
 assert.ok(canvasNodeDisplayName('', 'x'.repeat(200),'image').length<=36);
 const candidate={historyId:'h',taskId:'t',kind:'image' as const,mediaUrl:'x',prompt:'new prompt',model:'m',createdAt:''};
 assert.deepEqual(canvasMaterialDefaultNames([candidate],false,'My node'),['My node']);
 assert.deepEqual(canvasMaterialDefaultNames([{...candidate,name:'Image'},candidate],false,'My node'),['Image','My node 02']);
});

test('automatic names strip internal reference tokens without changing explicit labels', () => {
 assert.equal(canvasNodeDisplayName('图片生成', '[[lr-ref:asset%3Aa]] 生成海边日落，温暖光线', 'image'), '海边日落');
 assert.equal(canvasNodeDisplayName('品牌主视觉', '[[lr-focus:%7B%7D]] other', 'image'), '品牌主视觉');
});
