import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaGenerationReadiness as readiness} from '../src/core/canvas/mediaGenerationReadiness.ts';
import type {CanvasMediaProfile} from '../src/core/services/canvasMediaProfiles.ts';
const profile:CanvasMediaProfile={id:'doubao-default',name:'Saved connection',baseUrl:'https://www.doubao.com',revision:1,apiKeyConfigured:false,imageProtocol:'doubao-image',videoProtocol:'doubao-video',imageModel:'Saved image',videoModel:'Saved video'};
test('retired identity or protocol is explicitly unavailable regardless of stored model or key',()=>{
 for(const kind of ['image','video'] as const){
  for(const value of [profile,{...profile,id:'other'},{...profile,imageProtocol:'ark-image',videoProtocol:'ark-video',apiKeyConfigured:true}] as CanvasMediaProfile[]){
   const result=readiness(kind,value,'Saved model');assert.equal(result.ready,false);assert.match(result.message,/豆包连接器已移除/);assert.match(result.message,/不会改发/);
  }
  assert.match(readiness(kind,profile,'Saved',true).message,/connector has been removed/);
 }
});
test('Ark and other API connections still require model, key and enabled protocol',()=>{
 const api={...profile,id:'ark',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',imageProtocol:'ark-image' as const,videoProtocol:'ark-video' as const};
 for(const kind of ['image','video'] as const){
  assert.equal(readiness(kind,api,'Saved').ready,false);
  assert.equal(readiness(kind,{...api,apiKeyConfigured:true},'Saved').ready,true);
  assert.equal(readiness(kind,{...api,apiKeyConfigured:true},' ').ready,false);
 }
 assert.equal(readiness('image',{...api,apiKeyConfigured:true,imageProtocol:'disabled'},'Saved').ready,false);
});
