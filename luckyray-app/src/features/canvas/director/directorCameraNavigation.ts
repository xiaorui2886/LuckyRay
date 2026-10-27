import * as THREE from 'three';
import type { DirectorCamera, Vec3 } from '../../../core/canvas/director/types';

export type CameraMotion = 'look' | 'pan' | 'dolly';
/** Camera-local, pixel-based navigation. Never orbit a remote focus point. */
export function navigateDirectorCamera(source: DirectorCamera, motion: CameraMotion, dx: number, dy: number, fine = false): DirectorCamera {
  if (![dx, dy].every(Number.isFinite)) return source;
  const p = new THREE.Vector3(...source.position), target = new THREE.Vector3(...source.target);
  const distance = Math.max(.01, p.distanceTo(target));
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(p, target, new THREE.Vector3(...(source.up ?? [0, 1, 0]))));
  const rate = fine ? .1 : 1;
  if (motion === 'look') {
    // Local yaw and pitch preserve the optical centre and roll, including poles.
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * .002 * rate));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * .002 * rate));
    target.copy(p).add(new THREE.Vector3(0, 0, -distance).applyQuaternion(q));
  } else {
    const delta = (motion === 'pan' ? new THREE.Vector3(-dx, dy, 0).multiplyScalar(.01 * rate) : new THREE.Vector3(0, 0, dy * .002 * rate)).applyQuaternion(q);
    // Limit the shared translation, not each endpoint independently.
    for (const axis of ['x', 'y', 'z'] as const) delta[axis] = Math.max(-1000 - Math.min(p[axis], target[axis]), Math.min(1000 - Math.max(p[axis], target[axis]), delta[axis]));
    p.add(delta); target.add(delta);
  }
  if ([...target.toArray(), ...p.toArray()].some(v => Math.abs(v) > 1000 || !Number.isFinite(v))) return source;
  return { ...source, position: p.toArray() as Vec3, target: target.toArray() as Vec3, up: new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize().toArray() as Vec3 };
}
