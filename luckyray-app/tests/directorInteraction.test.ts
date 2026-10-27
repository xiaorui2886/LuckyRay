import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { navigateDirectorCamera } from '../src/features/canvas/director/directorCameraNavigation';
import { directorBoundsInRectangle, mergeDirectorSelection } from '../src/features/canvas/director/directorSelection';
import type { DirectorCamera } from '../src/core/canvas/director/types';
const camera: DirectorCamera = { position: [2, 5, 7], target: [-600, -200, -700], up: [.3, .9, .1], focalLength: 35, aspect: '16:9' };
const v = (a: number[]) => new THREE.Vector3(...a);
test('distant-target look is in-place, focus/roll remain finite, source stays immutable', () => {
  const original = structuredClone(camera), result = navigateDirectorCamera(camera, 'look', 4, 3);
  assert.deepEqual(result.position, camera.position);
  assert.ok(Math.abs(v(result.position).distanceTo(v(result.target)) - v(camera.position).distanceTo(v(camera.target))) < 1e-8);
  assert.ok([...result.target, ...result.up!].every(Number.isFinite)); assert.deepEqual(camera, original);
});
test('pan and dolly use bounded local metres, never focus-distance acceleration', () => {
  for (const motion of ['pan', 'dolly'] as const) {
    const result = navigateDirectorCamera(camera, motion, 10, 10), fine = navigateDirectorCamera(camera, motion, 10, 10, true);
    assert.ok(v(result.target).sub(v(result.position)).distanceTo(v(camera.target).sub(v(camera.position))) < 1e-9);
    assert.ok(v(result.position).distanceTo(v(camera.position)) < .15);
    assert.ok(Math.abs(v(result.position).distanceTo(v(camera.position)) / v(fine.position).distanceTo(v(camera.position)) - 10) < 1e-8);
  }
  assert.equal(navigateDirectorCamera(camera, 'pan', NaN, 0), camera);
});
test('rotation fine mode reduces angle tenfold and translations stop at shared bounds', () => {
  const straight = { ...camera, target: [2, 5, -3] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
  const normal = navigateDirectorCamera(straight, 'look', 10, 0), fine = navigateDirectorCamera(straight, 'look', 10, 0, true);
  const forward = v(straight.target).sub(v(straight.position));
  assert.ok(Math.abs(forward.angleTo(v(normal.target).sub(v(normal.position))) / forward.angleTo(v(fine.target).sub(v(fine.position))) - 10) < 1e-7);
  const boundary = { ...straight, position: [999.99, 5, 7] as [number, number, number], target: [999.99, 5, -3] as [number, number, number] };
  const moved = navigateDirectorCamera(boundary, 'pan', -100, 0);
  assert.equal(moved.position[0], 1000); assert.equal(moved.target[0], 1000);
  assert.deepEqual(moved.target.map((n,i)=>n-moved.position[i]), boundary.target.map((n,i)=>n-boundary.position[i]));
});
test('replace, shift add and ctrl subtract preserve ordered independent selection', () => {
  const source = ['a','b'];
  assert.deepEqual(mergeDirectorSelection(source,['b','c'],'replace'), ['b','c']);
  assert.deepEqual(mergeDirectorSelection(source,['b','c'],'add'), ['a','b','c']);
  assert.deepEqual(mergeDirectorSelection(source,['a'],'subtract'), ['b']);
  assert.deepEqual(mergeDirectorSelection(source,[],'replace'), []);
  assert.deepEqual(mergeDirectorSelection(source,[],'add'), source); assert.deepEqual(source,['a','b']);
});
test('box projection handles drag directions, rejects behind-camera and outside rectangles', () => {
  const c = new THREE.PerspectiveCamera(45,1,.1,100); c.position.set(0,0,5); c.lookAt(0,0,0); c.updateMatrixWorld();
  const front = new THREE.Box3(new THREE.Vector3(-.5,-.5,-.5),new THREE.Vector3(.5,.5,.5));
  assert.equal(directorBoundsInRectangle(front,c,{left:-.5,right:.5,top:.5,bottom:-.5}),true);
  assert.equal(directorBoundsInRectangle(front,c,{left:.8,right:1,top:1,bottom:.8}),false);
  assert.equal(directorBoundsInRectangle(front.clone().translate(new THREE.Vector3(0,0,10)),c,{left:-1,right:1,top:1,bottom:-1}),false);
});
test('near-plane clipped visible surface remains selectable without selecting behind-camera boxes', () => {
  const c = new THREE.PerspectiveCamera(60, 1, .1, 100); c.updateMatrixWorld();
  const box = new THREE.Box3(new THREE.Vector3(.4, -.1, -1), new THREE.Vector3(.5, .1, -.01));
  const rect = { left: .95, right: 1, top: .05, bottom: -.05 };
  assert.equal(directorBoundsInRectangle(box,c,rect),true);
  assert.equal(directorBoundsInRectangle(box.clone().translate(new THREE.Vector3(0,0,2)),c,rect),false);
  assert.equal(directorBoundsInRectangle(box,c,{left:-1,right:-.95,top:.05,bottom:-.05}),false);
  const tinyInsideNear = new THREE.Box3(new THREE.Vector3(-.01,-.01,-.01), new THREE.Vector3(.01,.01,.01));
  assert.equal(directorBoundsInRectangle(tinyInsideNear,c,{left:-1,right:1,top:1,bottom:-1}),false);
});
