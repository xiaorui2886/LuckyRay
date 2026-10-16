import assert from 'node:assert/strict';
import test from 'node:test';
import {updateGraphLabels,placeGraphLabels,type GraphLabelState,type GraphLabelCandidate} from '../src/features/graph/graphPresentation.ts';
const measure=(text:string)=>Array.from(text).length*10;
const text='长中文名称😀与链接上下文'.repeat(8);
const intersects=(l:{left:number;top:number;width:number;height:number},w:number,h:number)=>l.left<w&&l.left+l.width>0&&l.top<h&&l.top+l.height>0;

test('four edges and corners, outward and return, keep node-relative label geometry',()=>{
  for(const [w,h] of [[800,600],[220,180]])for(const priority of [0,2,3])for(const side of ['above','below'] as const){
    for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]){
      const node:GraphLabelCandidate={id:1,text,x:w/2,y:h/2,radius:6,priority,degree:1,alpha:.66};
      const initial=placeGraphLabels([node],w,h,measure,new Map([[1,side]]))[0];
      const memory=new Map<number,GraphLabelState>([[1,{label:initial,side,opacity:1}]]);
      const offsets=[...Array.from({length:101},(_,i)=>i/100),...Array.from({length:101},(_,i)=>(100-i)/100)];
      let previous:{x:number;y:number;left:number;top:number}|undefined;
      for(const t of offsets){
        const current={...node,x:node.x+dx*(w/2+initial.width+50)*t,y:node.y+dy*(h/2+60)*t};
        const expected={left:current.x+initial.left-node.x,top:current.y+initial.top-node.y,width:initial.width,height:initial.height};
        const result=updateGraphLabels([current],w,h,measure,memory,t*1000);
        assert.equal(result.labels.length,intersects(expected,w,h)?1:0,`${w}/${side}/${dx},${dy}/${t}: draw exactly the intersecting text rectangle`);
        if(result.labels.length){const actual=result.labels[0];
          assert.ok(Math.abs(actual.left-expected.left)<1e-8&&Math.abs(actual.top-expected.top)<1e-8,'text follows node without edge clamping or side flip');
          assert.equal(actual.text,initial.text,'clipping does not change truncation');
          if(previous){assert.ok(Math.abs(actual.left-previous.left-(current.x-previous.x))<1e-8);assert.ok(Math.abs(actual.top-previous.top-(current.y-previous.y))<1e-8);}
          previous={x:current.x,y:current.y,left:actual.left,top:actual.top};
        }else previous=undefined;
        assert.equal(result.animating,false);assert.ok(memory.size<=1);
      }
    }
  }
});

test('text intersection survives a node centre beyond the old 32px rejection',()=>{
  const node={id:1,text,x:-70,y:80,radius:6,priority:3,degree:1,alpha:.66};
  const result=updateGraphLabels([node],800,600,measure,new Map(),0);
  assert.equal(result.labels.length,1);assert.ok(result.labels[0].left<0&&result.labels[0].left+result.labels[0].width>0);
});

test('offscreen anchor retention is bounded and removes deleted or zoom-hidden identities',()=>{
  const memory=new Map<number,GraphLabelState>();
  for(let id=0;id<200;id++){
    const current={id,text:'Node '+id,x:100,y:100,radius:4,priority:0,degree:1,alpha:.66};
    updateGraphLabels([current,...[...memory.keys()].map(key=>({...current,id:key,x:-500-key}))],240,180,measure,memory,id);
    assert.ok(memory.size<=id+1,'one anchor per current eligible topology node');
  }
  updateGraphLabels([],240,180,measure,memory,2000);assert.equal(memory.size,0);
});
