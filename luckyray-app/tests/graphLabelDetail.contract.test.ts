import assert from 'node:assert/strict';
import test from 'node:test';
import {graphLabelDetail,graphLabelFocusAlpha,placeGraphLabels,updateGraphLabels,type GraphLabelState} from '../src/features/graph/graphPresentation.ts';

test('name size and opacity progress continuously and reversibly through zoom',()=>{
  for(const reveal of [0,.45,1.6]){
    let old=graphLabelDetail(.025,reveal);
    const start=.85+reveal*.6,end=start*3;
    assert.equal(graphLabelDetail(start,reveal).alpha,0);
    assert.equal(graphLabelDetail(end,reveal).alpha,.88);
    assert.ok(Math.abs(graphLabelDetail(Math.sqrt(start*end),reveal).alpha-.44)<1e-12);
    for(let scale=.025;scale<12;scale*=1.005){
      const current=graphLabelDetail(scale,reveal);
      assert.ok(current.alpha>=old.alpha&&current.fontSize>=old.fontSize);
      assert.ok(current.alpha-old.alpha<.016&&current.fontSize-old.fontSize<.03);
      assert.deepEqual(graphLabelDetail(scale,reveal),current,'no temporal state or delayed fade');
      old=current;
    }
  }
  assert.ok(graphLabelDetail(.4,.45).fontSize<graphLabelDetail(1.6,.45).fontSize);
});

test('overview is silent, first detail faint, and reading contrast comes later',()=>{
  for(const scale of [.3,.5,.7,.9,1]) assert.equal(graphLabelDetail(scale,.25).alpha,0);
  assert.ok(graphLabelDetail(1.2,.25).alpha>0&&graphLabelDetail(1.2,.25).alpha<.08);
  assert.ok(graphLabelDetail(1.5,.25).alpha<.3);
  assert.ok(graphLabelDetail(2,.25).alpha>.5);
  assert.equal(graphLabelDetail(3,.25).alpha,.88);
});

test('overview hover shows target without forcing all neighbour names on',()=>{
  assert.equal(graphLabelFocusAlpha(0,true,false,true),.95);
  assert.equal(graphLabelFocusAlpha(0,false,true,true),0);
  assert.equal(graphLabelFocusAlpha(.2,false,true,true),.2);
  assert.equal(graphLabelFocusAlpha(.2,false,false,true),.072);
  assert.equal(graphLabelFocusAlpha(.2,false,false,false),.2);
});

test('full Unicode titles do not change with hover, pan, scale or pane width',()=>{
  const text='完整中文标题和 emoji 👨‍👩‍👧‍👦 — 标题末尾',measure=(s:string)=>Array.from(s).length*8;
  for(const fontSize of [8,10,12,15,18])for(const width of [200,800]){
    const memory=new Map<number,GraphLabelState>();
    for(const priority of [0,2,3,0])for(const x of [100,10,-10,110]){
      const c={id:0,text,x,y:50,radius:4,priority,degree:1,alpha:.4,fontSize};
      const label=updateGraphLabels([c],width,120,measure,memory,0).labels[0];
      assert.ok(label);assert.equal(label.text,text);
      assert.equal(label.width,measure(text)*fontSize/12+8);
      assert.equal(label.height,fontSize*1.5);assert.equal(label.top,59);
    }
  }
});

test('overlapping focus title paints after all ordinary and neighbour text',()=>{
  const labels=[3,0,2].map((priority,id)=>({id,priority,text:'Overlap',x:80,y:50,radius:4,degree:2,alpha:.6}));
  assert.deepEqual(placeGraphLabels(labels,200,160,()=>70).map(l=>l.priority),[0,2,3]);
});
