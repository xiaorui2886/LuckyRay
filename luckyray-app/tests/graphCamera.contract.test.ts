import assert from 'node:assert/strict';
import test from 'node:test';
import {wheelCamera, wheelZoomPoint, stepCamera, fitGraphCamera, GRAPH_MIN_SCALE, GRAPH_MAX_SCALE} from '../src/features/graph/graphCamera.ts';
import {graphScreenRadius, graphSeedPositions} from '../src/features/graph/graphSpatial.ts';
import {placeGraphLabels} from '../src/features/graph/graphPresentation.ts';

test('continuous zoom keeps the world point beneath each new pointer anchor', () => {
  let displayed = {scale:0.21,panX:82,panY:-16}, target = {...displayed};
  for (let i=0;i<40;i++) {
    const point = {x:200+i*11,y:300+i*3};
    const world = {x:(point.x-displayed.panX)/displayed.scale,y:(point.y-displayed.panY)/displayed.scale};
    target = wheelCamera(displayed,target,point,-18);
    displayed = stepCamera(displayed,target,point,16).camera;
    assert.ok(Math.hypot(world.x*displayed.scale+displayed.panX-point.x,world.y*displayed.scale+displayed.panY-point.y)<1e-9);
  }
});
test('a small reverse input changes direction on the very next frame', () => {
  const displayed = {scale:1,panX:0,panY:0}, point = {x:480,y:300};
  const oldTarget = wheelCamera(displayed,displayed,point,-200);
  const halfway = stepCamera(displayed,oldTarget,point,8).camera;
  const reversed = wheelCamera(halfway,oldTarget,point,3);
  assert.ok(stepCamera(halfway,reversed,point,8).camera.scale<halfway.scale);
});

test('off-centre node stays at one screen position through wheel reversal and settling',()=>{
  const node={x:-120,y:780};let camera={scale:.55,panX:310,panY:-120},target={...camera};
  const origin=wheelZoomPoint(camera,{x:0,y:0},node),pointer={x:origin.x+2,y:origin.y-1};
  for(const delta of [-120,-120,-60,12,120,120,60,-12]){
    const anchor=wheelZoomPoint(camera,pointer,node);target=wheelCamera(camera,target,anchor,delta);
    for(let frame=0;frame<22;frame++){
      camera=stepCamera(camera,target,anchor,16).camera;
      const position=wheelZoomPoint(camera,pointer,node);
      assert.ok(Math.hypot(position.x-origin.x,position.y-origin.y)<1e-9);
    }
  }
  assert.deepEqual(wheelZoomPoint(camera,pointer,null),pointer,'empty space remains cursor anchored');
});
test('wheel travel settles within 300ms, with no changing anchor or overshoot', () => {
  for (const scale of [0.025,0.3,1,8]) {
    let camera = {scale,panX:70,panY:-200};
    const anchor={x:550,y:400}, target=wheelCamera(camera,camera,anchor,-120);
    let elapsed=0, moving=true;
    while (moving && elapsed<1000) { const step=stepCamera(camera,target,anchor,16); camera=step.camera;moving=step.moving;elapsed+=16; assert.ok(camera.scale<=target.scale+1e-10); }
    assert.ok(elapsed<=300,`settled in ${elapsed}ms at ${scale}`);
    assert.deepEqual(camera,target);
    assert.equal(stepCamera(camera,target,anchor,16).moving,false);
  }
});
test('bounds, reduced motion and tiny/large viewport fit remain finite', () => {
  const camera={scale:1,panX:0,panY:0},point={x:350,y:300};
  assert.equal(wheelCamera(camera,camera,point,1e5).scale,GRAPH_MIN_SCALE);
  const target=wheelCamera(camera,camera,point,-1e5);
  assert.equal(target.scale,GRAPH_MAX_SCALE);
  assert.deepEqual(stepCamera(camera,target,point,16,true),{camera:target,moving:false});
  assert.equal(fitGraphCamera([],100,100),null);
  for(const width of [240,1200]) { const fit=fitGraphCamera([{x:-4000,y:-3000},{x:4000,y:3000}],width,800)!;assert.ok(fit.scale>0&&fit.scale<1); }
});
test('screen radius stays continuous and bounded at all supported zoom levels', () => {
  let before=0;
  for(let scale=.025;scale<=12;scale+=.025) {const r=graphScreenRadius(7,scale);assert.ok(r>=before&&r<=10);before=r;}
});
test('retained labels keep their side and focus can supersede retained ordinary labels', () => {
  const candidates=[{id:1,text:'A',x:100,y:80,radius:3,priority:0,degree:1,alpha:.66},{id:2,text:'B',x:104,y:100,radius:3,priority:0,degree:2,alpha:.66}];
  const memory=new Map<number,'above'|'below'>([[1,'above']]);
  const result=placeGraphLabels(candidates,400,300,()=>60,memory);
  assert.equal(result[0].id,1);assert.ok(result[0].top<80);
  candidates[1].priority=3;
  assert.equal(placeGraphLabels(candidates,400,300,()=>60,memory).at(-1)!.id,2, 'focus paints over ordinary labels');
});
test('cold initialization is neutral, deterministic and independent of input/component order', () => {
  const nodes=Array.from({length:1200},(_,id)=>({id,key:`note-${id}`}));
  const edges=nodes.filter(n=>n.id%12!==0).map(n=>[n.id,n.id-1] as const);
  const positions=graphSeedPositions(nodes,edges,1280,800);
  assert.equal(positions.size,1200);
  assert.deepEqual(graphSeedPositions(nodes.slice().reverse(),edges.slice().reverse(),1280,800),positions);
  assert.deepEqual(graphSeedPositions(nodes,edges,1280,800),positions);
  assert.deepEqual(graphSeedPositions([],[],1280,800),new Map());
  const isolates=graphSeedPositions(nodes,[],1280,800);
  assert.deepEqual(isolates,positions,'topology must not preassign a constellation or centre isolates by role');
  assert.ok(new Set([...isolates.values()].map(p=>p.x)).size>1190,'isolates do not retain grid columns');
});
