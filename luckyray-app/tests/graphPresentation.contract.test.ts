import assert from 'node:assert/strict';
import test from 'node:test';
import { placeGraphLabels, updateGraphLabels, graphGroupMatches, normalizeGraphColorGroups, normalizeGraphSections, type GraphLabelState, type GraphLabelCandidate } from '../src/features/graph/graphPresentation.ts';
import { normalizeGraphFilters, readGraphViewState, writeGraphViewState } from '../src/core/services/graph.ts';

const measure = (text: string) => Array.from(text).reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 12 : 6), 0);
test('visible names survive brief and sustained collisions without animation frames', () => {
  const memory = new Map<number, GraphLabelState>();
  const name = {...fixture(1)[0], text:'Stable', x:300, y:300};
  const frame = (now:number, blocked=false) => updateGraphLabels(blocked ? [name,{...name,id:1,y:315,alpha:0},{...name,id:2,y:283,alpha:0}] : [name],800,600,measure,memory,now);
  assert.equal(frame(0).labels.length,1);
  frame(100); frame(250);
  const before = frame(270); assert.equal(before.labels[0].opacity,1); assert.equal(before.animating,false);
  const jitter = frame(300,true); assert.equal(jitter.labels[0].top,before.labels[0].top); assert.equal(jitter.labels[0].opacity,1);
  const resumed = frame(330); assert.equal(resumed.labels[0].opacity,1);
  frame(400,true); frame(500,true); frame(660,true);
  const held = frame(700,true); assert.equal(held.labels[0].opacity,1); assert.equal(held.animating,false);
  const removed=updateGraphLabels([],800,600,measure,memory,1200);assert.equal(memory.size,0);assert.equal(removed.animating,false);
});

test('drag focus appears immediately and collision does not dim it after release', () => {
  const memory = new Map<number, GraphLabelState>();
  const name = {...fixture(1)[0],text:'Target',x:300,y:300,priority:3};
  assert.equal(updateGraphLabels([name],800,600,measure,memory,0).labels[0].opacity,1);
  name.priority=0;
  const blocker={...name,id:1,y:315,alpha:0};
  for(let t=10;t<=180;t+=10) updateGraphLabels([name,blocker],800,600,measure,memory,t);
  const fading=updateGraphLabels([name,blocker],800,600,measure,memory,210).labels[0]?.opacity ?? 0;
  const recovered=updateGraphLabels([name],800,600,measure,memory,230).labels[0].opacity;
  assert.equal(fading,1);assert.equal(recovered,1);
  const absent=updateGraphLabels([],800,600,measure,memory,240);
  assert.equal(absent.labels.length,0);assert.equal(memory.size,0);assert.equal(absent.animating,false);
});
function fixture(count: number): GraphLabelCandidate[] {
  return Array.from({length: count}, (_, id) => ({id, text: `长中文笔记名称与附件😀-${id}`, x: 20 + (id * 67) % 1100, y: 20 + (id * 31) % 700, radius: 4, priority: 0, degree: id % 8, alpha: 0.66}));
}
test('dense intersecting labels all draw without collision elections', () => {
  const input = fixture(1800); input[1799].priority = 3;
  const labels = placeGraphLabels(input, 1200, 800, measure);
  assert.equal(labels.at(-1)!.id, 1799, 'focus paints last');
  assert.equal(labels.length,input.length);
  for (const a of labels) {
    assert.ok(a.left < 1200 && a.left + a.width > 0 && a.top < 800 && a.top + a.height > 0);
    assert.ok(!/[\uD800-\uDBFF]…/.test(a.text));
  }
  assert.deepEqual(placeGraphLabels(input.slice().reverse(), 1200, 800, measure), labels);
});
test('overview hides ordinary labels while hovered isolated nodes remain readable', () => {
  const input = fixture(10).map(c => ({...c, alpha: 0}));
  assert.equal(placeGraphLabels(input, 1200, 800, measure).length, 0);
  input[0] = {...input[0], priority: 3, alpha: 0.9, x: 300, y: 300};
  assert.equal(placeGraphLabels(input, 1200, 800, measure)[0].id, 0);
});
test('labels keep a fixed side and full title while narrow panes clip naturally', () => {
  const input = [{...fixture(1)[0], x: 100, y: 100}, {...fixture(2)[1], x: 100, y: 116, alpha: 0}];
  const labels = placeGraphLabels(input, 210, 180, measure);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].top,100+input[0].radius+5);
  assert.equal(labels[0].text,input[0].text);
  assert.equal(labels[0].width,measure(input[0].text)+8);
});
test('color groups validate saved values and tag/path matching is explicit', () => {
  assert.deepEqual(normalizeGraphSections('invalid'), {});
  assert.deepEqual(normalizeGraphSections({filter:false,force:true,groups:'yes',unknown:true}), {filter:false,force:true});
  assert.deepEqual(normalizeGraphColorGroups([null, {query:'x',color:'red'}, {query:'tag:项目',color:'#aabbcc'}]), [{query:'tag:项目',color:'#aabbcc'}]);
  assert.ok(graphGroupMatches('tag:项目', 'A', 'Inbox/A.md', ['#项目']));
  assert.ok(graphGroupMatches('path:Inbox/', 'A', 'Inbox/A.md', []));
  assert.ok(!graphGroupMatches('tag:', 'A', '', ['项目']));
  assert.ok(!graphGroupMatches('tag:项', 'A', '', ['项目']));
  assert.ok(graphGroupMatches('标题', '长中文标题', '', []));
});
test('first-use note layer defaults preserve explicit legacy filters and saved camera', () => {
  assert.deepEqual(normalizeGraphFilters(undefined), {material:false,note:true,tag:false,web:false});
  const filters = {material:true,note:false,tag:true,web:true};
  assert.deepEqual(normalizeGraphFilters(filters), filters);
  const storage = new Map<string,string>();
  Object.defineProperty(globalThis, 'localStorage', {configurable:true,value:{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v)}});
  const view = {filters,scale:1.7,panX:170,panY:-250,colorGroups:[{query:'tag:项目',color:'#aabbcc'}],sections:{force:true,filter:false}};
  writeGraphViewState(view); assert.deepEqual(readGraphViewState(), view);
});
