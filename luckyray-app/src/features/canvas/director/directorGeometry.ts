import * as THREE from 'three';
import { buildDirectorMannequin } from './directorRigGeometry';
import type { DirectorCamera, DirectorObject, Vec3 } from '../../../core/canvas/director/types';

export function directorAspect(value: DirectorCamera['aspect']): number {
  const ratios = { '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '1:1': 1, '2.39:1': 2.39 };
  return ratios[value] || 16 / 9;
}
export function directorCaptureSize(aspect: number, longest = 1920) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const bound = Math.max(64, Math.min(1920, Math.round(longest)));
  return a >= 1 ? { width: bound, height: Math.max(1, Math.round(bound / a)) } : { width: Math.max(1, Math.round(bound * a)), height: bound };
}
export function directorViewportSize(width: number, height: number, aspect?: number) {
  const w = Math.max(1, width), h = Math.max(1, height);
  if (!aspect) return { width: w, height: h };
  return w / h > aspect ? { width: h * aspect, height: h } : { width: w, height: w / aspect };
}
/** Match document constraints before committing interactive camera movement. */
export function boundedDirectorCamera(source: DirectorCamera, position: Vec3, target: Vec3): DirectorCamera {
  const bound = (values: Vec3, fallback: Vec3): Vec3 => values.map((v, i) => Math.max(-1000, Math.min(1000, Number.isFinite(v) ? v : fallback[i]))) as Vec3;
  const p = bound(position, source.position), t = bound(target, source.target);
  if (new THREE.Vector3(...p).distanceToSquared(new THREE.Vector3(...t)) < 0.0001) {
    p[2] = t[2] >= 999 ? t[2] - 1 : t[2] + 1;
  }
  return { ...source, position: p, target: t };
}
export function applyDirectorCamera(camera: THREE.PerspectiveCamera, source: DirectorCamera) {
  camera.aspect = directorAspect(source.aspect);
  camera.filmGauge = 36;
  camera.setFocalLength(source.focalLength);
  camera.position.fromArray(source.position);
  const target = new THREE.Vector3(...source.target);
  if (camera.position.distanceToSquared(target) < 0.0001) target.z -= 1;
  camera.up.fromArray(source.up ?? [0, 1, 0]).normalize();
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
export function disposeDirectorObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => materials.add(material));
  });
  geometries.forEach(g => g.dispose());
  materials.forEach(m => m.dispose());
  object.removeFromParent();
}
export function applyDirectorTransform(root: THREE.Object3D, object: DirectorObject) {
  root.position.fromArray(object.position);
  root.rotation.set(...object.rotation.map(THREE.MathUtils.degToRad) as Vec3);
  root.scale.fromArray(object.scale);
  root.visible = object.visible;
  root.userData.directorId = object.id;
  root.updateMatrixWorld(true);
}
export function directorTransformPatch(root: THREE.Object3D): Pick<DirectorObject, 'position' | 'rotation' | 'scale'> {
  const sane = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
  return {
    position: root.position.toArray().map(v => sane(v, -1000, 1000)) as Vec3,
    rotation: [root.rotation.x, root.rotation.y, root.rotation.z].map(v => sane(THREE.MathUtils.radToDeg(v), -3600, 3600)) as Vec3,
    scale: root.scale.toArray().map(v => sane(v, 0.05, 100)) as Vec3,
  };
}
/** Procedural assets only: no network requests, texture downloads or third-party models. */
export function buildDirectorObject(object: DirectorObject, clayColor?: string): THREE.Group {
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: clayColor ?? object.color, roughness: clayColor ? .86 : .76, metalness: clayColor ? 0 : .02 });
  const mesh = (geometry: THREE.BufferGeometry, position: Vec3, scale?: Vec3) => {
    const part = new THREE.Mesh(geometry, material);
    part.position.fromArray(position);
    if (scale) part.scale.fromArray(scale);
    part.castShadow = true; part.receiveShadow = true;
    root.add(part); return part;
  };
  if (object.kind === 'actor') {
    buildDirectorMannequin(root, object, material);
  } else if (object.kind === 'sphere') mesh(new THREE.SphereGeometry(0.5, 24, 16), [0, 0.5, 0]);
  else if (object.kind === 'cylinder') mesh(new THREE.CylinderGeometry(0.45, 0.45, 1, 24), [0, 0.5, 0]);
  else if (object.kind === 'wall') mesh(new THREE.BoxGeometry(3, 2.6, 0.16), [0, 1.3, 0]);
  else if (object.kind === 'platform') mesh(new THREE.BoxGeometry(2.4, 0.25, 1.8), [0, 0.125, 0]);
  else mesh(new THREE.BoxGeometry(1, 1, 1), [0, 0.5, 0]);
  applyDirectorTransform(root, object);
  return root;
}
