import * as THREE from 'three';
export type SelectionOperation = 'replace' | 'add' | 'subtract';
export function mergeDirectorSelection(current: readonly string[], hits: readonly string[], operation: SelectionOperation): string[] {
  if (operation === 'subtract') return current.filter(id => !hits.includes(id));
  return [...new Set(operation === 'add' ? [...current, ...hits] : hits)];
}
/** Intersect the world AABB with the rectangle's clipped camera frustum.
 * Crop in homogeneous clip space so near-plane intersections are not discarded.
 */
export function directorBoundsInRectangle(box: THREE.Box3, camera: THREE.Camera, rect: { left: number; top: number; right: number; bottom: number }): boolean {
  if (box.isEmpty() || rect.right <= rect.left || rect.top <= rect.bottom) return false;
  const sx = 2 / (rect.right - rect.left), sy = 2 / (rect.top - rect.bottom);
  const crop = new THREE.Matrix4().set(sx, 0, 0, -(rect.right + rect.left) / (rect.right - rect.left), 0, sy, 0, -(rect.top + rect.bottom) / (rect.top - rect.bottom), 0, 0, 1, 0, 0, 0, 0, 1);
  const projection = crop.multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
  return new THREE.Frustum().setFromProjectionMatrix(projection).intersectsBox(box);
}
