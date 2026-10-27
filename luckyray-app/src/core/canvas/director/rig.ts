import type { DirectorJointId, DirectorLimb, DirectorObject, DirectorRigPose, Vec3 } from './types';
export type RigQuaternion = [
    number,
    number,
    number,
    number
];
export type RigJointDefinition = {
    id: DirectorJointId;
    parent: DirectorJointId | null;
    offset: Vec3;
    label: string;
    labelEn: string;
};
const joint = (id: DirectorJointId, parent: DirectorJointId | null, offset: Vec3, label: string): RigJointDefinition => ({ id, parent, offset, label, labelEn: id.replace(/([A-Z])/g, ' $1') });
export const RIG_JOINTS: readonly RigJointDefinition[] = [joint('pelvis', null, [0, .94, 0], '骨盆'), joint('spine', 'pelvis', [0, .16, 0], '腰部'), joint('chest', 'spine', [0, .23, 0], '胸部'), joint('neck', 'chest', [0, .15, 0], '颈部'), joint('head', 'neck', [0, .13, 0], '头部'), ...(['left', 'right'] as const).flatMap(side => { const sign = side === 'left' ? 1 : -1; const label = side === 'left' ? '左' : '右'; return [joint(`${side}Shoulder`, 'chest', [sign * .19, .08, 0], label + '肩'), joint(`${side}UpperArm`, `${side}Shoulder`, [sign * .10, 0, 0], label + '上臂'), joint(`${side}Forearm`, `${side}UpperArm`, [0, -.29, 0], label + '前臂'), joint(`${side}Hand`, `${side}Forearm`, [0, -.25, 0], label + '手'), joint(`${side}Thigh`, 'pelvis', [sign * .11, -.03, 0], label + '大腿'), joint(`${side}Shin`, `${side}Thigh`, [0, -.43, 0], label + '小腿'), joint(`${side}Foot`, `${side}Shin`, [0, -.43, 0], label + '脚')]; })];
const limit = (min: Vec3, max: Vec3) => ({ min, max });
export const RIG_LIMITS = Object.fromEntries(RIG_JOINTS.map(j => [j.id, j.id === 'pelvis' ? limit([-45, -90, -40], [45, 90, 40]) : j.id === 'spine' ? limit([-35, -40, -30], [45, 40, 30]) : j.id === 'chest' ? limit([-35, -45, -30], [45, 45, 30]) : j.id === 'neck' ? limit([-35, -65, -35], [45, 65, 35]) : j.id === 'head' ? limit([-35, -55, -35], [40, 55, 35]) : j.id.endsWith('Shoulder') ? limit([-45, -45, -40], [45, 45, 40]) : j.id.endsWith('UpperArm') ? limit([-175, -150, -175], [175, 150, 175]) : j.id.endsWith('Forearm') ? limit([-155, -10, -10], [5, 10, 10]) : j.id.endsWith('Hand') ? limit([-75, -80, -40], [75, 80, 40]) : j.id.endsWith('Thigh') ? limit([-130, -70, -75], [60, 70, 75]) : j.id.endsWith('Shin') ? limit([0, -8, -8], [155, 8, 8]) : limit([-50, -35, -25], [60, 35, 25])])) as Record<DirectorJointId, {
    min: Vec3;
    max: Vec3;
}>;
export const RIG_PRESETS = [{ id: 'stand', label: '站立', labelEn: 'Stand' }, { id: 'sit', label: '坐姿', labelEn: 'Sit' }, { id: 'walk', label: '迈步', labelEn: 'Stride' }, { id: 'kneel', label: '单膝跪地', labelEn: 'Kneel' }, { id: 'reach', label: '向前伸手', labelEn: 'Reach' }, { id: 'wave', label: '挥手', labelEn: 'Wave' }, { id: 'crouch', label: '蹲姿', labelEn: 'Crouch' }] as const;
export type DirectorRigPreset = typeof RIG_PRESETS[number]['id'];
export function cloneRigPose(p: DirectorRigPose): DirectorRigPose { return { version: 1, rootOffset: [...p.rootOffset], joints: Object.fromEntries(Object.entries(p.joints).map(([k, v]) => [k, [...v!]])) }; }
export function normalizeRigPose(input: unknown): DirectorRigPose | null { if (!input || typeof input !== 'object')
    return null; const p = input as DirectorRigPose; if (p.version !== 1 || !Array.isArray(p.rootOffset) || p.rootOffset.length !== 3 || !p.rootOffset.every(x => Number.isFinite(x) && Math.abs(x) <= 10) || !p.joints || typeof p.joints !== 'object' || Array.isArray(p.joints))
    return null; for (const [key, v] of Object.entries(p.joints)) {
    if (!Object.prototype.hasOwnProperty.call(RIG_LIMITS, key)) return null;
    const l = RIG_LIMITS[key as DirectorJointId];
    if (!l || !Array.isArray(v) || v.length !== 3 || !v.every((x, i) => Number.isFinite(x) && x >= l.min[i] && x <= l.max[i]))
        return null;
} return cloneRigPose(p); }
export function setJointRotation(p: DirectorRigPose, id: DirectorJointId, v: Vec3): DirectorRigPose { const n = cloneRigPose(p), l = RIG_LIMITS[id]; n.joints[id] = v.map((x, i) => Number.isFinite(x) ? Math.max(l.min[i], Math.min(l.max[i], x)) : (p.joints[id]?.[i] ?? 0)) as Vec3; return n; }
export function createRigPose(preset: DirectorRigPreset = 'stand'): DirectorRigPose {
    const p: DirectorRigPose = { version: 1, rootOffset: [0, 0, 0], joints: { leftUpperArm: [0, 0, 7], rightUpperArm: [0, 0, -7], leftForearm: [-8, 0, 0], rightForearm: [-8, 0, 0] } };
    const j = p.joints;
    if (preset === 'sit') {
        p.rootOffset[1] = -.43;
        j.leftThigh = j.rightThigh = [-90, 0, 0];
        j.leftShin = j.rightShin = [90, 0, 0];
        j.leftUpperArm = [-12, 0, 6];
        j.rightUpperArm = [-12, 0, -6];
        j.leftForearm = j.rightForearm = [-75, 0, 0];
    }
    if (preset === 'walk') {
        p.rootOffset[1] = -.0734585087583;
        j.leftThigh = [-28, 0, 0];
        j.leftShin = [12, 0, 0];
        j.rightThigh = [22, 0, 0];
        j.rightShin = [32, 0, 0];
        j.leftUpperArm = [22, 0, 7];
        j.rightUpperArm = [-28, 0, -7];
        j.rightForearm = [-25, 0, 0];
    }
    if (preset === 'kneel') {
        p.rootOffset[1] = -.39213;
        j.leftThigh = [-85, 0, 0];
        j.leftShin = [85, 0, 0];
        j.rightThigh = [0, 0, 0];
        j.rightShin = [100, 0, 0];
        j.rightFoot = [60, 0, 0];
    }
    if (preset === 'reach') {
        j.spine = [-8, 0, 0];
        j.leftUpperArm = [-78, 0, 7];
        j.rightUpperArm = [-70, 0, -7];
        j.leftForearm = [-15, 0, 0];
        j.rightForearm = [-20, 0, 0];
    }
    if (preset === 'wave') {
        j.rightUpperArm = [-20, 0, -115];
        j.rightForearm = [-95, 0, 0];
        j.rightHand = [0, 0, -15];
        j.head = [0, -12, 0];
    }
    if (preset === 'crouch') {
        p.rootOffset[1] = -.4812753;
        j.leftThigh = j.rightThigh = [-80, 0, 0];
        j.leftShin = j.rightShin = [125, 0, 0];
        j.leftFoot = j.rightFoot = [-45, 0, 0];
        j.leftUpperArm = [-55, 0, 7];
        j.rightUpperArm = [-55, 0, -7];
        j.leftForearm = j.rightForearm = [-35, 0, 0];
        j.spine = [-15, 0, 0];
    }
    return cloneRigPose(p);
}
export function getObjectRigPose(o: DirectorObject): DirectorRigPose { return o.rig ? cloneRigPose(o.rig) : createRigPose(o.pose ?? 'stand'); }
export function mirrorRigPose(p: DirectorRigPose): DirectorRigPose { const n: DirectorRigPose = { version: 1, rootOffset: [-p.rootOffset[0], p.rootOffset[1], p.rootOffset[2]], joints: {} }; for (const [id, v] of Object.entries(p.joints)) {
    const key = (id.startsWith('left') ? id.replace('left', 'right') : id.startsWith('right') ? id.replace('right', 'left') : id) as DirectorJointId;
    n.joints[key] = [v![0], -v![1], -v![2]];
} return n; }
const add = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v + b[i]) as Vec3, sub = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v - b[i]) as Vec3, scale = (a: Vec3, n: number): Vec3 => a.map(v => v * n) as Vec3;
const dot = (a: Vec3, b: Vec3) => a.reduce((s, v, i) => s + v * b[i], 0), cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm = (v: Vec3): Vec3 => scale(v, 1 / (Math.hypot(...v) || 1));
const mul = (a: RigQuaternion, b: RigQuaternion): RigQuaternion => [a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1], a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2], a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const inv = (q: RigQuaternion): RigQuaternion => [-q[0], -q[1], -q[2], q[3]];
const rotate = (v: Vec3, q: RigQuaternion): Vec3 => mul(mul(q, [...v, 0]), inv(q)).slice(0, 3) as Vec3;
function quat(v: Vec3): RigQuaternion { const [x, y, z] = v.map(a => a * Math.PI / 360), c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z); return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]; }
function euler(q: RigQuaternion): Vec3 { const [x, y, z, w] = q; const m13 = 2 * (x * z + y * w), m23 = 2 * (y * z - x * w), m33 = 1 - 2 * (x * x + y * y), m12 = 2 * (x * y - z * w), m11 = 1 - 2 * (y * y + z * z); return [Math.abs(m13) < .9999999 ? Math.atan2(-m23, m33) : Math.atan2(2 * (x * w + y * z), 1 - 2 * (x * x + z * z)), Math.asin(Math.max(-1, Math.min(1, m13))), Math.abs(m13) < .9999999 ? Math.atan2(-m12, m11) : 0].map(v => v * 180 / Math.PI) as Vec3; }
export function rigJointWorldTransforms(p: DirectorRigPose): Record<DirectorJointId, {
    position: Vec3;
    quaternion: RigQuaternion;
}> { const out = {} as Record<DirectorJointId, {
    position: Vec3;
    quaternion: RigQuaternion;
}>; for (const j of RIG_JOINTS) {
    const parent = j.parent ? out[j.parent] : null;
    out[j.id] = { position: parent ? add(parent.position, rotate(j.offset, parent.quaternion)) : add(j.offset, p.rootOffset), quaternion: parent ? mul(parent.quaternion, quat(p.joints[j.id] ?? [0, 0, 0])) : quat(p.joints[j.id] ?? [0, 0, 0]) };
} return out; }
export const RIG_LIMBS: Record<DirectorLimb, {
    upper: DirectorJointId;
    lower: DirectorJointId;
    end: DirectorJointId;
    parent: DirectorJointId;
}> = { leftArm: { upper: 'leftUpperArm', lower: 'leftForearm', end: 'leftHand', parent: 'leftShoulder' }, rightArm: { upper: 'rightUpperArm', lower: 'rightForearm', end: 'rightHand', parent: 'rightShoulder' }, leftLeg: { upper: 'leftThigh', lower: 'leftShin', end: 'leftFoot', parent: 'pelvis' }, rightLeg: { upper: 'rightThigh', lower: 'rightShin', end: 'rightFoot', parent: 'pelvis' } };
// Rotation from orthonormal matrix columns. Never infer angles in world space.
function basisQ(x: Vec3, y: Vec3, z: Vec3): RigQuaternion { const m11 = x[0], m22 = y[1], m33 = z[2], t = m11 + m22 + m33; let q: RigQuaternion; if (t > 0) {
    const s = .5 / Math.sqrt(t + 1);
    q = [(y[2] - z[1]) * s, (z[0] - x[2]) * s, (x[1] - y[0]) * s, .25 / s];
}
else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q = [.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
}
else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q = [(y[0] + x[1]) / s, .25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
}
else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, .25 * s, (x[1] - y[0]) / s];
} return q; }
/** Two-bone IK in actor-local coordinates. Anatomical limits override unreachable targets. */
export function solveLimbIK(p: DirectorRigPose, limb: DirectorLimb, target: Vec3, pole?: Vec3): DirectorRigPose { if (!RIG_LIMBS[limb] || !target.every(Number.isFinite) || (pole && !pole.every(Number.isFinite)))
    return cloneRigPose(p); const l = RIG_LIMBS[limb], w = rigJointWorldTransforms(p), start = w[l.upper].position, parentQ = w[l.parent].quaternion, arm = limb.endsWith('Arm'), a = arm ? .29 : .43, b = arm ? .25 : .43; let delta = sub(target, start), dist = Math.hypot(...delta); if (dist < 1e-8) {
    delta = sub(w[l.end].position, start);
    dist = Math.hypot(...delta);
} const dir = norm(delta), d = Math.max(Math.abs(a - b) + 1e-5, Math.min(a + b - 1e-5, dist)); let bend = pole ? sub(pole, start) : rotate(arm ? [0, -1, 0] : [0, 0, 1], parentQ); bend = sub(bend, scale(dir, dot(bend, dir))); if (Math.hypot(...bend) < 1e-7) {
    bend = sub(w[l.lower].position, start);
    bend = sub(bend, scale(dir, dot(bend, dir)));
} if (Math.hypot(...bend) < 1e-7) {
    bend = cross(dir, Math.abs(dir[0]) < .8 ? [1, 0, 0] : [0, 0, 1]);
} bend = norm(bend); const c = (a * a + d * d - b * b) / (2 * a * d), s = Math.sqrt(Math.max(0, 1 - c * c)), u = add(scale(dir, c), scale(bend, s)), v = norm(sub(scale(dir, d), scale(u, a))), theta = Math.acos(Math.max(-1, Math.min(1, dot(u, v)))), sign = arm ? -1 : 1; const y = scale(u, -1); let z = scale(sub(v, scale(u, Math.cos(theta))), -sign); z = norm(z); const x = norm(cross(y, z)); z = norm(cross(x, y)); let n = setJointRotation(p, l.upper, euler(mul(inv(parentQ), basisQ(x, y, z)))); n = setJointRotation(n, l.lower, [sign * theta * 180 / Math.PI, 0, 0]); return n; }
