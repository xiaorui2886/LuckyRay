import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodePlacement,recoverPlacement,type WorkArea,type WindowPlacement} from '../src/workspace/windowPlacement.ts';
const monitor:WorkArea={name:'primary',x:0,y:0,width:1920,height:1040,scale:1};
const saved:WindowPlacement={x:2200,y:180,width:960,height:720,scale:1,monitor:'unplugged',maximized:false};
test('unplugged display brings the entire window into current work area',()=>{
 const result=recoverPlacement(saved,[monitor])!;assert.ok(result.x>=0&&result.y>=0);assert.ok(result.x+result.width<=1920&&result.y+result.height<=1040);assert.equal(result.monitor,'primary');
});
test('DPI change preserves logical size and clamps physical coordinates',()=>{
 const result=recoverPlacement({...saved,monitor:'primary',x:1800,y:900},[{...monitor,width:3840,height:2080,scale:2}])!;
 assert.equal(result.width,960);assert.equal(result.scale,2);assert.ok(result.x+result.width*2<=3840);assert.ok(result.y+result.height*2<=2080);
});
test('negative monitor coordinates and small work area are legitimate',()=>{
 const left={...monitor,name:'left',x:-1280,width:1280,height:680,scale:1.5};const result=recoverPlacement({...saved,x:-1200,y:40,monitor:'left'},[monitor,left])!;
 assert.ok(result.x>=-1280&&result.x+result.width*1.5<=0);assert.ok(result.height*1.5<=680);
});
test('invalid persistence and unavailable monitor list are safe no-ops',()=>{
 for(const value of [null,{}, {...saved,width:Infinity},{...saved,scale:0},{...saved,x:NaN},{...saved,monitor:{}}])assert.equal(decodePlacement(value),null);
 assert.deepEqual(decodePlacement(saved),saved);assert.equal(recoverPlacement(saved,[]),null);
});
