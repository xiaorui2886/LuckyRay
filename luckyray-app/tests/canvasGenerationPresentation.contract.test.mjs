import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
const css=readFileSync(new URL('../src/canvas-spike-scroll.css',import.meta.url),'utf8');
test('generation animation is clipped independently of the overflowing image stack and node controls',()=>{
  assert.match(css,/\.canvas-generator-process\s*\{[^}]*overflow:\s*hidden;[^}]*border-radius:\s*inherit;/);
  assert.doesNotMatch(css,/\.canvas-generator-output\.is-generating::(?:before|after)/);
  assert.match(css,/\.canvas-generator-process::after\s*\{[^}]*animation:\s*canvasGeneratorScan/);
  assert.match(css,/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.canvas-generator-process::after,[\s\S]*?animation: none/);
  assert.match(source,/placement="card"/);
  assert.match(source,/const selectedResultActions=selectedNode && selectedNode\.data\.kind !== "generator"/);
});
test('failed/cancelled/active task updates keep previous successful image data unchanged',()=>{
  const start=source.indexOf('function applyGenerationTaskToNodes(');
  const end=source.indexOf('\nfunction ',start+1);
  const compiled=transformSync(source.slice(start,end),{loader:'ts',format:'cjs'}).code;
  const apply=Function(compiled+';return applyGenerationTaskToNodes;')();
  const original={id:'node',data:{kind:'generator',label:'Old image',generationTask:{id:'task',status:'running'},resultMediaUrl:'/old.png',resultThumbnailUrl:'/thumb.png',resultMediaItems:[{url:'/old.png'},{url:'/second.png'}]}};
  for(const status of ['failed','cancelled','queued','running']){
    const task={id:'task',status};const [next]=apply([original],task);
    assert.equal(next.data.generationTask,task);assert.equal(next.data.resultMediaUrl,'/old.png');assert.equal(next.data.resultThumbnailUrl,'/thumb.png');assert.equal(next.data.resultMediaItems,original.data.resultMediaItems);
  }
  assert.equal(apply([original],{id:'different-task',status:'failed'})[0],original);
});
