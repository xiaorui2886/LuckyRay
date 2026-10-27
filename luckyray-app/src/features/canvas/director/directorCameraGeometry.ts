import * as THREE from 'three';
import { aspectNumber, focalLengthToVerticalFov } from '../../../core/canvas/director/model';
import type { DirectorCamera, Vec3 } from '../../../core/canvas/director/types';

/** Editor-only camera body, lens and projection guide. Local -Z points into the shot. */
export function buildDirectorCameraHelper(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'director-camera-helper';
  const material = new THREE.LineBasicMaterial({ color: '#f4c86a', toneMapped: false });
  const bodyGeometry = new THREE.BoxGeometry(.62, .42, .42);
  const body = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeometry), material);
  bodyGeometry.dispose();
  body.position.z = .12;
  root.add(body);
  const lensGeometry = new THREE.CylinderGeometry(.13, .19, .25, 8, 1, true);
  lensGeometry.rotateX(Math.PI / 2);
  const lens = new THREE.LineSegments(new THREE.EdgesGeometry(lensGeometry), material);
  lensGeometry.dispose();
  lens.position.z = -.19;
  root.add(lens);
  // Top marker makes roll legible even when the frustum is nearly square.
  const marker = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-.15, .22, .1), new THREE.Vector3(0, .38, .1), new THREE.Vector3(.15, .22, .1),
  ]), material);
  root.add(marker);
  const frustum = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(48), 3)), material);
  frustum.name = 'director-camera-frustum';
  root.add(frustum);
  const pick = new THREE.Mesh(new THREE.BoxGeometry(.76, .66, .78), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  pick.name = 'director-camera-pick';
  root.add(pick);
  root.traverse(child => { child.userData.directorCamera = true; });
  return root;
}

export function syncDirectorCameraHelper(root: THREE.Group, camera: DirectorCamera): void {
  root.position.fromArray(camera.position);
  root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(root.position, new THREE.Vector3(...camera.target), new THREE.Vector3(...(camera.up ?? [0, 1, 0]))));
  root.scale.setScalar(1);
  const frustum = root.getObjectByName('director-camera-frustum') as THREE.LineSegments | undefined;
  if (frustum) {
    const depth = 1.2;
    const height = Math.tan(THREE.MathUtils.degToRad(focalLengthToVerticalFov(camera.focalLength, camera.aspect)) / 2) * depth;
    const width = height * aspectNumber(camera.aspect);
    const corners = [new THREE.Vector3(-width, -height, -depth), new THREE.Vector3(width, -height, -depth), new THREE.Vector3(width, height, -depth), new THREE.Vector3(-width, height, -depth)];
    const position = frustum.geometry.getAttribute('position') as THREE.BufferAttribute;
    let index = 0;
    for (let i = 0; i < 4; i++) {
      position.setXYZ(index++, 0, 0, 0);
      position.setXYZ(index++, ...corners[i].toArray());
      position.setXYZ(index++, ...corners[i].toArray());
      position.setXYZ(index++, ...corners[(i + 1) % 4].toArray());
    }
    position.needsUpdate = true;
    frustum.geometry.computeBoundingSphere();
  }
  root.updateMatrixWorld(true);
}

/** Keep focus distance fixed: translation moves both endpoints; rotation carries camera roll. */
export function cameraFromDirectorHelper(root: THREE.Object3D, source: DirectorCamera): DirectorCamera {
  root.updateWorldMatrix(true, false);
  const position = root.getWorldPosition(new THREE.Vector3());
  const quaternion = root.getWorldQuaternion(new THREE.Quaternion());
  const distance = new THREE.Vector3(...source.position).distanceTo(new THREE.Vector3(...source.target));
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
  return { ...source, position: position.toArray() as Vec3, target: position.clone().addScaledVector(direction, distance).toArray() as Vec3, up: up.toArray() as Vec3 };
}
