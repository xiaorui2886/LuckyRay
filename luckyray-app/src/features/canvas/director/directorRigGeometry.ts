import * as THREE from 'three';
import type { DirectorJointId, DirectorLimb, DirectorObject, DirectorRigPose, Vec3 } from '../../../core/canvas/director/types';
import { getObjectRigPose, RIG_JOINTS } from '../../../core/canvas/director/rig';

type RigRuntime = { bones: Map<DirectorJointId, THREE.Bone>; markers: THREE.Mesh[] };
const rigs = new WeakMap<THREE.Object3D, RigRuntime>();
export const getDirectorRig = (root: THREE.Object3D) => rigs.get(root);
/** Original procedural articulated mannequin. Meshes follow real bones without pretending to be skinned assets. */
export function buildDirectorMannequin(root: THREE.Group, object: DirectorObject, material: THREE.Material) {
  const bones = new Map<DirectorJointId, THREE.Bone>(), markers: THREE.Mesh[] = [];
  for (const joint of RIG_JOINTS) {
    const bone = new THREE.Bone(); bone.name = joint.id; bone.userData.directorJoint = joint.id;
    bone.position.fromArray(joint.offset); (joint.parent ? bones.get(joint.parent)! : root).add(bone); bones.set(joint.id, bone);
  }
  const oval = (id: DirectorJointId, scale: Vec3, position: Vec3 = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), material);
    mesh.scale.fromArray(scale); mesh.position.fromArray(position); mesh.castShadow = mesh.receiveShadow = true; bones.get(id)!.add(mesh); return mesh;
  };
  const segment = (id: DirectorJointId, end: Vec3, radius: number) => {
    const delta = new THREE.Vector3(...end), length = delta.length();
    const profile = Array.from({ length: 21 }, (_, i) => {
      const t = i / 20;
      // Clamp the cap angle BEFORE sine: unbounded sine collapses the middle of the limb.
      const cap = Math.sin(Math.min(1, Math.min(t, 1 - t) / .18) * Math.PI / 2);
      return new THREE.Vector2(radius * (.98 - .22 * t + .05 * Math.sin(t * Math.PI)) * cap, t * length);
    });
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile, 20), material);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    mesh.castShadow = mesh.receiveShadow = true; bones.get(id)!.add(mesh);
  };
  oval('pelvis', [.175, .145, .115], [0, .015, 0]); oval('spine', [.145, .18, .105], [0, .08, 0]); oval('chest', [.205, .145, .12], [0, .02, 0]);
  segment('neck', [0, .13, 0], .052); oval('head', [.098, .125, .1], [0, .075, .008]); oval('head', [.018, .025, .024], [0, .045, .101]);
  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? 1 : -1;
    segment(`${side}Shoulder`, [sign * .10, 0, 0], .067);
    oval(`${side}UpperArm`, [.067, .067, .067]); segment(`${side}UpperArm`, [0, -.29, 0], .065);
    oval(`${side}Forearm`, [.048, .048, .048]); segment(`${side}Forearm`, [0, -.25, 0], .049);
    oval(`${side}Hand`, [.045, .075, .025], [0, -.04, .005]); oval(`${side}Hand`, [.023, .043, .024], [-sign * .04, -.025, .015]);
    oval(`${side}Thigh`, [.084, .084, .084]); segment(`${side}Thigh`, [0, -.43, 0], .094);
    oval(`${side}Shin`, [.062, .062, .062]); segment(`${side}Shin`, [0, -.43, 0], .067);
    oval(`${side}Foot`, [.072, .055, .145], [0, .005, .065]);
  }
  const markerGeometry = new THREE.SphereGeometry(.025, 12, 8);
  for (const [id, bone] of bones) {
    const marker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: '#9bbcff', depthTest: false, depthWrite: false }));
    marker.userData.directorPoseHandle = true; marker.userData.directorJoint = id; marker.renderOrder = 1000; marker.visible = false; bone.add(marker); markers.push(marker);
  }
  rigs.set(root, { bones, markers }); applyDirectorRigPose(root, getObjectRigPose(object));
}
export function applyDirectorRigPose(root: THREE.Object3D, pose: DirectorRigPose) {
  const rig = rigs.get(root); if (!rig) return;
  for (const joint of RIG_JOINTS) {
    const bone = rig.bones.get(joint.id)!; bone.position.fromArray(joint.offset);
    if (!joint.parent) bone.position.add(new THREE.Vector3(...pose.rootOffset));
    bone.rotation.set(...(pose.joints[joint.id] ?? [0, 0, 0]).map(THREE.MathUtils.degToRad) as Vec3);
  }
  root.updateMatrixWorld(true);
}
export function setDirectorRigHelpers(root: THREE.Object3D, visible: boolean, selected?: DirectorJointId | null) {
  rigs.get(root)?.markers.forEach(marker => {
    marker.visible = visible;
    (marker.material as THREE.MeshBasicMaterial).color.set(marker.userData.directorJoint === selected ? '#ffca82' : '#9bbcff');
  });
}
export function directorBoneRotation(root: THREE.Object3D, id: DirectorJointId): Vec3 {
  const b = rigs.get(root)!.bones.get(id)!; return [b.rotation.x, b.rotation.y, b.rotation.z].map(THREE.MathUtils.radToDeg) as Vec3;
}
export function directorJointWorldPosition(root: THREE.Object3D, id: DirectorJointId) { return rigs.get(root)!.bones.get(id)!.getWorldPosition(new THREE.Vector3()); }
export function directorIKLimb(id?: DirectorJointId | null): DirectorLimb | undefined {
  return ({ leftHand: 'leftArm', rightHand: 'rightArm', leftFoot: 'leftLeg', rightFoot: 'rightLeg' } as Partial<Record<DirectorJointId, DirectorLimb>>)[id!];
}
export function updateDirectorRigMarkerScale(root: THREE.Object3D, camera: THREE.Camera, height: number, selected?: DirectorJointId | null) {
  rigs.get(root)?.markers.forEach(marker => {
    if (!marker.visible) return;
    const position = marker.getWorldPosition(new THREE.Vector3());
    const units = camera instanceof THREE.PerspectiveCamera ? 2 * position.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / Math.max(1, height) : camera instanceof THREE.OrthographicCamera ? (camera.top - camera.bottom) / camera.zoom / Math.max(1, height) : .001;
    const scale = marker.parent!.getWorldScale(new THREE.Vector3()), radius = marker.userData.directorJoint === selected ? 6 : 4.5;
    marker.scale.set(units * radius / .025 / Math.max(.001, Math.abs(scale.x)), units * radius / .025 / Math.max(.001, Math.abs(scale.y)), units * radius / .025 / Math.max(.001, Math.abs(scale.z)));
  });
}
export function directorRenderableBounds(root: THREE.Object3D) {
  root.updateMatrixWorld(true); const box = new THREE.Box3();
  root.traverse(child => { const mesh = child as THREE.Mesh; if (!mesh.geometry || mesh.userData.directorPoseHandle) return; mesh.geometry.computeBoundingBox(); box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)); });
  return box;
}
