import assert from 'node:assert/strict';
import test from 'node:test';
import {updateGraphLabels,type GraphLabelState} from '../src/features/graph/graphPresentation.ts';
const measure=(s:string)=>s.length*7;
const nodes=Array.from({length:300},(_,id)=>({id,text:'Node name '+id,x:100+(id%15)*38,y:80+Math.floor(id/15)*21,radius:4,degree:id%9,priority:0,alpha:.2}));
test('panning draws every intersecting eligible name, including unadmitted crowded names',()=>{
  const memory=new Map<number,GraphLabelState>();
  for(const x of [0,-200,-400,-200,0]){
    const candidates=nodes.map(n=>({...n,x:n.x+x}));
    const result=updateGraphLabels(candidates,800,600,measure,memory,0);
    for(const n of candidates){
      const w=measure(n.text)+8,left=n.x-w/2,top=n.y+n.radius+5;
      if(left<800&&left+w>0&&top<600&&top+18>0){
        const label=result.labels.find(l=>l.id===n.id);
        assert.ok(label,'no label election while panning: '+n.id);
        assert.equal(label.top,top);assert.equal(label.alpha,n.alpha);
      }
    }
    assert.equal(result.animating,false);
  }
});
test('zoom alpha is not cut off at the old 0.035 threshold',()=>{
  for(const alpha of [.00001,.001,.01,.034,.035,.036,.2]){
    const result=updateGraphLabels([{...nodes[0],alpha}],800,600,measure,new Map(),0);
    assert.equal(result.labels.length,1);assert.equal(result.labels[0].alpha,alpha);
  }
});
test('a moving occluder never chooses whether a label exists or which side it uses',()=>{
  for(const y of [110,100,80,90,110]){
    const result=updateGraphLabels([nodes[0],{...nodes[1],x:100,y}],800,600,measure,new Map(),0);
    assert.equal(result.labels.length,2);assert.equal(result.labels.find(l=>l.id===0)!.top,89);
  }
});
