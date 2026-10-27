import test from 'node:test';
import assert from 'node:assert/strict';
import { imageResultsStripLayout, mergeImageResults, selectPrimaryResultImage } from '../src/core/canvas/imageResults';
import { splitImageSource } from '../src/core/canvas/imageGrid';
import { selectedCanvasMedia } from '../src/core/canvas/mediaSelection';
import { canvasNodeLibraryCandidates } from '../src/core/canvas/nodeSaving';

test('promoting primary reorders once and synchronizes original/thumbnail without mutating history', () => {
  const items = [{url:'a', thumbnailUrl:'a-small'}, {url:'b'}, {url:'c', thumbnailUrl:'c-small'}];
  const task = {id:'task', status:'succeeded', request:{kind:'image'}, output:{mediaItems:items}};
  const data = {kind:'generator', generationKind:'image', resultMediaItems:items, resultMediaUrl:'a', resultThumbnailUrl:'a-small', generationTask:task};
  const before = JSON.stringify(data);
  const next = selectPrimaryResultImage(data, 2);
  assert.deepEqual(next.resultMediaItems.map(item => item.url), ['c','a','b']);
  assert.equal(next.resultMediaUrl, 'c'); assert.equal(next.resultThumbnailUrl, 'c-small');
  assert.equal(JSON.stringify(data), before); assert.equal(next.generationTask, task);
  assert.equal(splitImageSource(next), 'c');
  assert.equal(selectedCanvasMedia([{id:'n',data:next}],['n'],s=>s)[0].source, 'c');
  assert.equal(canvasNodeLibraryCandidates(next as never, [])[0].mediaUrl, 'c');
  const withoutThumbnail = selectPrimaryResultImage(next, 2);
  assert.equal(withoutThumbnail.resultThumbnailUrl, null);
  assert.equal(withoutThumbnail.resultMediaUrl, 'b');
  assert.deepEqual(items.map(item=>item.url), ['a','b','c']);
});
test('invalid and already-primary picks are identity no-ops, preserving undo and dirty state', () => {
  const data = {resultMediaItems:[{url:'a'},{url:'b'}]};
  for (const index of [0,-1,2,NaN,Infinity,.5]) assert.equal(selectPrimaryResultImage(data,index),data);
  const empty = {}; assert.equal(selectPrimaryResultImage(empty,1), empty);
});

test('expanded strip stays within screen-space stage at low/high zoom and both edges', () => {
  for (const zoom of [.25, .5, 1, 2, 4]) {
    for (const rootLeft of [-100, 100, 700, 950]) {
      const layout = imageResultsStripLayout({rootLeft,rootWidth:300*zoom,viewportLeft:80,viewportRight:1000,zoom,count:8});
      const left = rootLeft + layout.left * zoom, right = left + layout.width * zoom;
      assert.ok(left >= 92, `left ${left} at ${zoom}`); assert.ok(right <= 988, `right ${right} at ${zoom}`);
      assert.equal(layout.itemWidth, 300);
    }
  }
  const right = imageResultsStripLayout({rootLeft:700,rootWidth:300,viewportLeft:0,viewportRight:1024,zoom:1,count:3});
  assert.ok(right.left < 0);
  const narrow = imageResultsStripLayout({rootLeft:0,rootWidth:300,viewportLeft:0,viewportRight:200,zoom:2,count:3});
  assert.equal(narrow.width, 88); assert.equal(narrow.itemWidth, 150);
});

test('same-node repeated generations keep old images in the existing switcher', () => {
  const previous = {resultMediaUrl:'old', resultThumbnailUrl:'old-small'};
  const output = {mediaUrl:'new', mediaItems:[{url:'new'}, {url:'new-2'}]};
  const snapshot = JSON.stringify({previous,output});
  const items = mergeImageResults(previous,output);
  assert.deepEqual(items.map(item=>item.url), ['new','new-2','old']);
  assert.equal(JSON.stringify({previous,output}),snapshot);
  const selected = selectPrimaryResultImage({resultMediaItems:items,resultMediaUrl:'new'},2);
  assert.equal(selected.resultMediaUrl,'old');
  assert.deepEqual(mergeImageResults(selected,{mediaUrl:'third'}).map(item=>item.url),['third','old','new','new-2']);
  assert.deepEqual(mergeImageResults({resultMediaItems:items},output),items);
  const reloaded = JSON.parse(JSON.stringify(selected));
  assert.equal(selectPrimaryResultImage(reloaded,1).resultMediaUrl,'new');
});

test('saving an older same-node image uses that image’s historical prompt/model/task', () => {
 const task={id:'latest',sourceNodeId:'n',resultNodeId:'n',status:'succeeded',request:{kind:'image',prompt:'Latest prompt',model:'new-model'},createdAt:'new-date'};
 const history=[{id:'old-history',taskId:'old',sourceNodeId:'n',resultNodeId:'n',status:'succeeded',kind:'image',prompt:'Old prompt',model:'old-model',createdAt:'old-date',outputMediaUrl:'old'}];
 const data={kind:'generator',generationKind:'image',resultMediaItems:[{url:'old'},{url:'new'}],resultMediaUrl:'old',generationTask:task};
 const candidates=canvasNodeLibraryCandidates(data as never,history as never);
 assert.equal(candidates[0].taskId,'old');assert.equal(candidates[0].historyId,'old-history');assert.equal(candidates[0].prompt,'Old prompt');assert.equal(candidates[0].model,'old-model');assert.equal(candidates[0].createdAt,'old-date');assert.equal(candidates[1].taskId,'latest');
});
