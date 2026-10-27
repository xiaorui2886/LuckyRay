import test from 'node:test';
import assert from 'node:assert/strict';
import { materialDragPreview } from '../src/features/materials/materialDragPreview.ts';
test('drag reuses a decoded cover in a bounded bitmap and preserves native fallback', () => {
 let img: any = {complete:true,naturalWidth:3840,naturalHeight:2160};
 const draw: unknown[][]=[];let encoded='data:image/png;base64,AAAA';let fail=false;
 const canvas={width:0,height:0,getContext:()=>({drawImage:(...args:unknown[])=>{if(fail)throw Error('tainted');draw.push(args);}}),toDataURL:()=>encoded};
 const savedDocument=Object.getOwnPropertyDescriptor(globalThis,'document');const savedCSS=Object.getOwnPropertyDescriptor(globalThis,'CSS');
 try {
  Object.defineProperty(globalThis,'CSS',{configurable:true,value:{escape:(v:string)=>v}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>({querySelector:()=>img}),createElement:()=>canvas}});
  assert.equal(materialDragPreview('a'),encoded);assert.equal(canvas.width,192);assert.equal(canvas.height,108);assert.equal(draw.length,1);
  img={complete:true,naturalWidth:20,naturalHeight:40};materialDragPreview('a');assert.equal(canvas.width,20);assert.equal(canvas.height,40);
  img.complete=false;assert.equal(materialDragPreview('a'),undefined);
  img.complete=true;fail=true;assert.equal(materialDragPreview('a'),undefined);
  fail=false;encoded='x'.repeat(350001);assert.equal(materialDragPreview('a'),undefined);
  img=null;assert.equal(materialDragPreview('a'),undefined);
  Reflect.deleteProperty(globalThis,'CSS');assert.equal(materialDragPreview('a'),undefined);
 } finally {
  if(savedDocument)Object.defineProperty(globalThis,'document',savedDocument);else Reflect.deleteProperty(globalThis,'document');
  if(savedCSS)Object.defineProperty(globalThis,'CSS',savedCSS);else Reflect.deleteProperty(globalThis,'CSS');
 }
});
