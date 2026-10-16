import assert from 'node:assert/strict';
import test from 'node:test';
import {updateGraphLabels,type GraphLabelState,type GraphLabelCandidate} from '../src/features/graph/graphPresentation.ts';
const measure=(text:string)=>Array.from(text).length*7;
const name:GraphLabelCandidate={id:0,text:'Stable name',x:300,y:300,radius:4,priority:0,degree:1,alpha:.66};

test('fixed-scale moving occluders never make an admitted name breathe or swap side',()=>{
  const memory=new Map<number,GraphLabelState>();
  for(let t=0;t<=300;t+=20)updateGraphLabels([name],800,600,measure,memory,t);
  const top=memory.get(0)!.label.top;
  const trace=[];
  for(let t=320;t<=3200;t+=20){
    const blocked=Math.floor(t/400)%2===1;
    const candidates=blocked?[name,{...name,id:1,y:315,alpha:0},{...name,id:2,y:283,alpha:0}]:[name];
    const result=updateGraphLabels(candidates,800,600,measure,memory,t);
    const label=result.labels.find(l=>l.id===0);
    trace.push({t,opacity:label?.opacity??0,top:label?.top});
  }
  assert.ok(trace.every(f=>f.opacity===1&&f.top===top),JSON.stringify(trace.filter(f=>f.opacity!==1).slice(0,8)));
});

test('camera exit, zoom hiding and topology removal invalidate labels without a timer',()=>{
  const memory=new Map<number,GraphLabelState>();
  const show=(c:GraphLabelCandidate[])=>updateGraphLabels(c,800,600,measure,memory,500,true);
  assert.equal(show([name]).labels.length,1);
  assert.equal(show([{...name,x:-200}]).labels.length,0);
  assert.equal(memory.size,1);assert.equal(memory.get(0)!.opacity,0);
  show([name]);assert.equal(show([{...name,alpha:0}]).labels.length,0);assert.equal(memory.size,0);
  show([name]);assert.equal(show([]).labels.length,0);assert.equal(memory.size,0);
  assert.equal(show([]).animating,false);
});

test('long labels keep their anchor as the canvas clips at viewport edges',()=>{
  const memory=new Map<number,GraphLabelState>();
  let offset: {x:number;y:number}|undefined;
  for(const [x,y] of [[100,90],[3,90],[197,90],[100,3],[100,177]]){
    const result=updateGraphLabels([{...name,text:'长名字😀'.repeat(20),x,y,priority:3}],200,180,measure,memory,0,true);
    if(y===177){assert.equal(result.labels.length,0);continue;}
    assert.equal(result.labels.length,1);
    const label=result.labels[0];
    offset ??= {x:label.left-x,y:label.top-y};
    assert.equal(label.left-x,offset.x);assert.equal(label.top-y,offset.y);
    assert.ok(label.left<200&&label.left+label.width>0&&label.top<180&&label.top+label.height>0);
    assert.ok(!/[\uD800-\uDBFF]…/.test(label.text));
  }
});
