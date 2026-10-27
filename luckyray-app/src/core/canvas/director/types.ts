export type Vec3 = [number, number, number];
export type DirectorObjectKind = 'actor' | 'box' | 'sphere' | 'cylinder' | 'wall' | 'platform';
export type DirectorObject = { id: string; name: string; kind: DirectorObjectKind; position: Vec3; rotation: Vec3; scale: Vec3; color: string; visible: boolean; locked: boolean; pose?: 'stand' | 'sit' | 'walk'; rig?: DirectorRigPose };
export type DirectorCamera = { position: Vec3; target: Vec3; up?: Vec3; focalLength: number; aspect: '16:9' | '9:16' | '4:3' | '1:1' | '2.39:1' };
export type DirectorLighting = { preset: 'studio' | 'day' | 'night'; intensity: number; azimuth: number; elevation: number; color: string; ambient: number; background: string; ground: string };
export type DirectorScene = { objects: DirectorObject[]; camera: DirectorCamera; lighting: DirectorLighting; presentation?: { mode: 'original' | 'clay'; clayColor: string } };
export type DirectorShot = { id: string; name: string; duration: number; notes: string; scene: DirectorScene };
export type DirectorDocument = { version: 1; scene: DirectorScene; shots: DirectorShot[]; activeShotId?: string; poseLibrary?: DirectorSavedPose[] };
export type DirectorViewportHandle = { capture: () => Promise<string>; frameSelection: () => void; resetOrbit: () => void; alignCameraToOrbit: () => void };
export type DirectorViewportProps = { scene: DirectorScene; selectedId: string | null; selectedIds?: string[]; onSelectionChange?: (ids: string[]) => void; onTransforms?: (patches: Array<{ id: string; patch: Partial<DirectorObject> }>) => void | boolean; mode: 'orbit' | 'camera' | 'top'; transform: 'translate' | 'rotate' | 'scale'; guides: boolean; onSelect: (id: string | null) => void; onTransform: (id: string, patch: Partial<DirectorObject>) => void | boolean; cameraSelected?: boolean; onCameraSelect?: () => void; onCameraChange?: (camera: DirectorCamera) => void | boolean; onError?: (message: string) => void; english?: boolean; poseEditing?: boolean; selectedJoint?: DirectorJointId | null; poseTool?: 'rotate' | 'ik'; onJointSelect?: (joint: DirectorJointId | null) => void };

export type DirectorJointId = 'pelvis' | 'spine' | 'chest' | 'neck' | 'head' | 'leftShoulder' | 'leftUpperArm' | 'leftForearm' | 'leftHand' | 'rightShoulder' | 'rightUpperArm' | 'rightForearm' | 'rightHand' | 'leftThigh' | 'leftShin' | 'leftFoot' | 'rightThigh' | 'rightShin' | 'rightFoot';
export type DirectorLimb = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';
export type DirectorRigPose = { version: 1; joints: Partial<Record<DirectorJointId, Vec3>>; rootOffset: Vec3 };
export type DirectorSavedPose = { id: string; name: string; rig: DirectorRigPose };
