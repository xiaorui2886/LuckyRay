import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DirectorPerformance } from '../src/features/canvas/director/directorPerformance.ts';
test('diagnostics remain bounded and copied; CPU metrics are not FPS/GPU evidence', () => {
 const stats = new DirectorPerformance();
 for (let i=0;i<1000;i++) stats.record(i, 2, i===0);
 const report=stats.snapshot();
 assert.equal(report.samples.length,120); assert.equal(report.samples[0].queueMs,880);
 assert.equal(report.counts.renders,1000); assert.equal(report.counts.shadowUpdates,1);
 report.samples[0].queueMs=0; report.counts.renders=0;
 assert.equal(stats.snapshot().samples[0].queueMs,880); assert.equal(stats.snapshot().counts.renders,1000);
 assert.match(report.measurement,/not GPU time, FPS/);
});
test('interaction contract keeps input direct and invalidates shadow cache on object edits', () => {
 const source=fs.readFileSync(new URL('../src/features/canvas/director/DirectorViewport.tsx',import.meta.url),'utf8');
 assert.match(source,/control.enableDamping = false/);
 assert.match(source,/shadowMap.autoUpdate = false/);
 assert.match(source,/controls.addEventListener\('objectChange', onObjectChange\)/);
 assert.match(source,/controls.removeEventListener\('objectChange', onObjectChange\)/);
 assert.match(source,/nextWidth !== renderWidth \|\| nextHeight !== renderHeight/);
 assert.match(source,/previousObjects !== p.scene.objects/);
 assert.match(source,/previousLighting !== p.scene.lighting/);
 assert.match(source,/renderWidth = 0; renderHeight = 0; resize\(\)/);
 assert.match(source,/const onOrbitChange = \(\) => invalidate\(\)/);
 assert.doesNotMatch(source,/rotateSpeed\s*=/);
});
test('portal respects canvas route visibility and short-window overflow fallback', () => {
 const canvas=fs.readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 assert.match(canvas,/directorDocument \? \(visible \? <DirectorWorkspace/);
 const css=fs.readFileSync(new URL('../src/features/canvas/director/directorWorkspace.css',import.meta.url),'utf8');
 assert.match(css,/\.director-backdrop\{[^}]*box-sizing:border-box;position:fixed/);
 assert.doesNotMatch(css,/backdrop-filter:blur/);
 assert.match(css,/@media\(min-width:781px\) and \(max-height:780px\)/);
});
