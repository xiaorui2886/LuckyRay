import { cloneRigPose, normalizeRigPose } from './rig';
import type { DirectorRigPose, DirectorSavedPose, DirectorCamera, DirectorDocument, DirectorLighting, DirectorObject, DirectorObjectKind, DirectorScene, DirectorShot, Vec3 } from './types';

/** Portable, bounded scene data only. Angles are degrees; dimensions are metres. */
export const DIRECTOR_LIMITS = Object.freeze({ objects: 100, shots: 40, savedPoses: 24, jsonBytes: 2_000_000, name: 120, notes: 8_000 });
const kinds: readonly DirectorObjectKind[] = ['actor', 'box', 'sphere', 'cylinder', 'wall', 'platform'];
const aspects: readonly DirectorCamera['aspect'][] = ['16:9', '9:16', '4:3', '1:1', '2.39:1'];
const presets: readonly DirectorLighting['preset'][] = ['studio', 'day', 'night'];
const poses = ['stand', 'sit', 'walk'] as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const text = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(v);
const color = (v: unknown): v is string => typeof v === 'string' && /^#[a-fA-F0-9]{6}$/.test(v);
function vec(v: unknown, min: number, max: number): Vec3 | null { return Array.isArray(v) && v.length === 3 && v.every(n => number(n, min, max)) ? [v[0], v[1], v[2]] : null; }
function uid(prefix: string) { return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`; }

export function aspectNumber(aspect: DirectorCamera['aspect']): number {
  return ({ '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '1:1': 1, '2.39:1': 2.39 } as const)[aspect] ?? 16 / 9;
}
/** Matches a 36 mm full-frame camera's vertical field of view (Three.js filmGauge model). */
export function focalLengthToVerticalFov(focalLength: number, aspect: DirectorCamera['aspect']): number {
  const filmHeight = 36 / Math.max(aspectNumber(aspect), 1);
  return 2 * Math.atan(filmHeight / (2 * focalLength)) * 180 / Math.PI;
}
export function cameraPreset(name: 'wide' | 'medium' | 'close' | 'overhead' = 'wide'): DirectorCamera {
  const cameras: Record<string, DirectorCamera> = {
    wide: { position: [6, 3.2, 8], target: [0, 1, 0], focalLength: 35, aspect: '16:9' },
    medium: { position: [0, 1.7, 4.8], target: [0, 1.1, 0], focalLength: 50, aspect: '16:9' },
    close: { position: [0, 1.65, 2.8], target: [0, 1.5, 0], focalLength: 85, aspect: '16:9' },
    overhead: { position: [0, 10, 0.01], target: [0, 0, 0], focalLength: 35, aspect: '16:9' },
  };
  const camera = cameras[name] ?? cameras.wide;
  return { ...camera, position: [...camera.position], target: [...camera.target] };
}
export function lightingPreset(name: DirectorLighting['preset'] = 'studio'): DirectorLighting {
  const lights: Record<DirectorLighting['preset'], DirectorLighting> = {
    studio: { preset: 'studio', intensity: 3, azimuth: -35, elevation: 50, color: '#fff1dd', ambient: 0.7, background: '#252b35', ground: '#555d6b' },
    day: { preset: 'day', intensity: 3.5, azimuth: 40, elevation: 60, color: '#fff6e8', ambient: 1, background: '#b9d4e8', ground: '#a5aaa4' },
    night: { preset: 'night', intensity: 2, azimuth: -70, elevation: 25, color: '#adc7ff', ambient: 0.25, background: '#111725', ground: '#30394a' },
  };
  return { ...(lights[name] ?? lights.studio) };
}
export function createDirectorObject(kind: DirectorObjectKind, id = uid('object')): DirectorObject {
  const validKind = kinds.includes(kind) ? kind : 'box';
  const names: Record<DirectorObjectKind, string> = { actor: '角色', box: '方块', sphere: '球体', cylinder: '圆柱', wall: '墙面', platform: '台面' };
  return { id, name: names[validKind], kind: validKind, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: validKind === 'actor' ? '#d8a579' : '#8bafc6', visible: true, locked: false, ...(validKind === 'actor' ? { pose: 'stand' as const } : {}) };
}
export function createDirectorDocument(): DirectorDocument {
  const actor = createDirectorObject('actor');
  actor.name = '角色 A'; actor.position = [-0.8, 0, 0]; actor.rotation = [0, 25, 0];
  const partner = createDirectorObject('actor');
  partner.name = '角色 B'; partner.position = [0.8, 0, -0.4]; partner.rotation = [0, -35, 0]; partner.color = '#8bafc6';
  return { version: 1, scene: { objects: [actor, partner], camera: cameraPreset(), lighting: lightingPreset() }, shots: [] };
}
export function cloneScene(scene: DirectorScene): DirectorScene {
  return { objects: scene.objects.map(o => ({ ...o, position: [...o.position], rotation: [...o.rotation], scale: [...o.scale], ...(o.rig ? { rig: cloneRigPose(o.rig) } : {}) })), camera: { ...scene.camera, position: [...scene.camera.position], target: [...scene.camera.target], ...(scene.camera.up ? { up: [...scene.camera.up] as Vec3 } : {}) }, lighting: { ...scene.lighting }, ...(scene.presentation ? { presentation: { ...scene.presentation } } : {}) };
}
function sanitizeObject(input: unknown): DirectorObject | null {
  if (!record(input) || !identifier(input.id) || !text(input.name, DIRECTOR_LIMITS.name) || !kinds.includes(input.kind as DirectorObjectKind) || !color(input.color) || typeof input.visible !== 'boolean' || typeof input.locked !== 'boolean') return null;
  const position = vec(input.position, -1000, 1000), rotation = vec(input.rotation, -3600, 3600), scale = vec(input.scale, 0.05, 100);
  if (!position || !rotation || !scale || (input.pose !== undefined && !poses.includes(input.pose as typeof poses[number]))) return null;
  const rig = input.rig === undefined ? undefined : normalizeRigPose(input.rig);
  if (input.rig !== undefined && (!rig || input.kind !== 'actor')) return null;
  return { id: input.id, name: input.name, kind: input.kind as DirectorObjectKind, position, rotation, scale, color: input.color, visible: input.visible, locked: input.locked, ...(rig ? { rig } : {}), ...(input.kind === 'actor' && input.pose !== undefined ? { pose: input.pose as DirectorObject['pose'] } : {}) };
}
export function sanitizeDirectorScene(input: unknown): DirectorScene | null {
  if (!record(input) || !Array.isArray(input.objects) || input.objects.length > DIRECTOR_LIMITS.objects || !record(input.camera) || !record(input.lighting)) return null;
  const objects: DirectorObject[] = []; const ids = new Set<string>();
  for (const value of input.objects) { const object = sanitizeObject(value); if (!object || ids.has(object.id)) return null; ids.add(object.id); objects.push(object); }
  const c = input.camera, l = input.lighting;
  const position = vec(c.position, -1000, 1000), target = vec(c.target, -1000, 1000);
  if (!position || !target || Math.hypot(...position.map((n, i) => n - target[i])) < 0.001 || !number(c.focalLength, 12, 200) || !aspects.includes(c.aspect as DirectorCamera['aspect'])) return null;
  const up = c.up === undefined ? undefined : vec(c.up, -1000, 1000);
  if (c.up !== undefined) {
    if (!up) return null;
    const direction = target.map((n, i) => n - position[i]);
    const upLength = Math.hypot(...up), distance = Math.hypot(...direction);
    const cross = [direction[1] * up[2] - direction[2] * up[1], direction[2] * up[0] - direction[0] * up[2], direction[0] * up[1] - direction[1] * up[0]];
    if (upLength < 1e-8 || Math.hypot(...cross) / (distance * upLength) < 1e-6) return null;
  }
  if (!presets.includes(l.preset as DirectorLighting['preset']) || !number(l.intensity, 0, 10) || !number(l.azimuth, -360, 360) || !number(l.elevation, 1, 89) || !number(l.ambient, 0, 3) || !color(l.color) || !color(l.background) || !color(l.ground)) return null;
  const presentation = input.presentation;
  if (presentation !== undefined && (!record(presentation) || !['original', 'clay'].includes(presentation.mode as string) || !color(presentation.clayColor))) return null;
  return { objects, ...(presentation ? { presentation: { mode: (presentation as { mode: 'original' | 'clay' }).mode, clayColor: (presentation as { clayColor: string }).clayColor } } : {}), camera: { position, target, ...(up ? { up } : {}), focalLength: c.focalLength, aspect: c.aspect as DirectorCamera['aspect'] }, lighting: { preset: l.preset as DirectorLighting['preset'], intensity: l.intensity, azimuth: l.azimuth, elevation: l.elevation, ambient: l.ambient, color: l.color, background: l.background, ground: l.ground } };
}
/** Reject malformed or oversized imports rather than partially dropping a user's work. */
export function sanitizeDirectorDocument(input: unknown): DirectorDocument | null {
  try {
    if (!record(input) || input.version !== 1 || !Array.isArray(input.shots) || input.shots.length > DIRECTOR_LIMITS.shots) return null;
    const serialized = JSON.stringify(input);
    if (serialized.length > DIRECTOR_LIMITS.jsonBytes || new TextEncoder().encode(serialized).byteLength > DIRECTOR_LIMITS.jsonBytes) return null;
    const scene = sanitizeDirectorScene(input.scene); if (!scene) return null;
    const shots: DirectorShot[] = []; const ids = new Set<string>();
    for (const value of input.shots) {
      if (!record(value) || !identifier(value.id) || ids.has(value.id) || !text(value.name, DIRECTOR_LIMITS.name) || !text(value.notes, DIRECTOR_LIMITS.notes) || !number(value.duration, 0.1, 3600)) return null;
      const shotScene = sanitizeDirectorScene(value.scene); if (!shotScene) return null;
      ids.add(value.id); shots.push({ id: value.id, name: value.name, notes: value.notes, duration: value.duration, scene: shotScene });
    }
    if (input.activeShotId !== undefined && (!identifier(input.activeShotId) || !ids.has(input.activeShotId))) return null;
    let poseLibrary: DirectorSavedPose[] | undefined;
    if (input.poseLibrary !== undefined) {
      if (!Array.isArray(input.poseLibrary) || input.poseLibrary.length > DIRECTOR_LIMITS.savedPoses) return null;
      poseLibrary = []; const poseIds = new Set<string>();
      for (const item of input.poseLibrary) {
        if (!record(item) || !identifier(item.id) || poseIds.has(item.id) || !text(item.name, DIRECTOR_LIMITS.name) || !item.name.trim()) return null;
        const rig = normalizeRigPose(item.rig); if (!rig) return null;
        poseIds.add(item.id); poseLibrary.push({ id: item.id, name: item.name, rig });
      }
    }
    return { version: 1, scene, shots, ...(poseLibrary ? { poseLibrary } : {}), ...(input.activeShotId !== undefined ? { activeShotId: input.activeShotId as string } : {}) };
  } catch { return null; }
}
export function addShot(document: DirectorDocument, name?: string): DirectorDocument {
  if (document.shots.length >= DIRECTOR_LIMITS.shots) return document;
  const shot: DirectorShot = { id: uid('shot'), name: (name?.trim() || `镜头 ${document.shots.length + 1}`).slice(0, DIRECTOR_LIMITS.name), duration: 5, notes: '', scene: cloneScene(document.scene) };
  return { ...document, shots: [...document.shots, shot], activeShotId: shot.id };
}
export function restoreShot(document: DirectorDocument, id: string): DirectorDocument {
  const shot = document.shots.find(s => s.id === id);
  return shot ? { ...document, scene: cloneScene(shot.scene), activeShotId: id } : document;
}
/** Explicit overwrite of a selected shot; editing the stage never silently changes snapshots. */
export function updateShot(document: DirectorDocument, id: string): DirectorDocument {
  if (!document.shots.some(s => s.id === id)) return document;
  return { ...document, shots: document.shots.map(s => s.id === id ? { ...s, scene: cloneScene(document.scene) } : s) };
}
export function removeShot(document: DirectorDocument, id: string): DirectorDocument {
  if (!document.shots.some(s => s.id === id)) return document;
  const next: DirectorDocument = { ...document, shots: document.shots.filter(s => s.id !== id) };
  if (next.activeShotId === id) delete next.activeShotId;
  return next;
}
export function reorderShot(document: DirectorDocument, id: string, targetIndex: number): DirectorDocument {
  const index = document.shots.findIndex(s => s.id === id);
  if (index < 0 || !Number.isFinite(targetIndex)) return document;
  const destination = Math.max(0, Math.min(document.shots.length - 1, Math.trunc(targetIndex)));
  if (index === destination) return document;
  const shots = [...document.shots]; const [shot] = shots.splice(index, 1); shots.splice(destination, 0, shot);
  return { ...document, shots };
}
export function directorDocumentJson(document: DirectorDocument): string {
  const valid = sanitizeDirectorDocument(document);
  if (!valid) throw new Error('invalid-director-document');
  return JSON.stringify(valid);
}
export function parseDirectorDocument(source: string): DirectorDocument | null {
  if (source.length > DIRECTOR_LIMITS.jsonBytes) return null;
  try { return sanitizeDirectorDocument(JSON.parse(source)); } catch { return null; }
}

export function saveRigPose(document: DirectorDocument, name: string, pose: DirectorRigPose): DirectorDocument {
  const rig = normalizeRigPose(pose), title = name.trim().slice(0, DIRECTOR_LIMITS.name);
  if (!rig || !title || !text(title, DIRECTOR_LIMITS.name) || (document.poseLibrary?.length ?? 0) >= DIRECTOR_LIMITS.savedPoses) return document;
  return sanitizeDirectorDocument({ ...document, poseLibrary: [...(document.poseLibrary ?? []), { id: uid('pose'), name: title, rig }] }) ?? document;
}
export function removeSavedRigPose(document: DirectorDocument, id: string): DirectorDocument {
  return document.poseLibrary?.some(p => p.id === id) ? { ...document, poseLibrary: document.poseLibrary.filter(p => p.id !== id) } : document;
}
export const STAGE_PRESETS = [{ id: 'studio', label: '摄影棚', labelEn: 'Studio' }, { id: 'interview', label: '双人访谈', labelEn: 'Interview' }, { id: 'room', label: '室内转角', labelEn: 'Room corner' }, { id: 'steps', label: '阶梯舞台', labelEn: 'Stepped stage' }] as const;
export function appendStagePreset(document: DirectorDocument, preset: typeof STAGE_PRESETS[number]['id']): DirectorDocument {
  type Part = [DirectorObjectKind, string, Vec3, Vec3];
  const parts: Record<typeof preset, Part[]> = {
    studio: [['wall', '背景墙', [0, 0, -2], [5, 3, .12]], ['platform', '展示台', [0, 0, 0], [3, .18, 2]]],
    interview: [['box', '左座椅', [-.85, 0, 0], [.65, .45, .65]], ['wall', '左椅背', [-.85, .45, -.28], [.65, .65, .12]], ['box', '右座椅', [.85, 0, 0], [.65, .45, .65]], ['wall', '右椅背', [.85, .45, -.28], [.65, .65, .12]], ['cylinder', '圆桌', [0, 0, .5], [.5, .5, .5]]],
    room: [['wall', '后墙', [0, 0, -2], [4, 2.8, .12]], ['box', '侧墙', [-2, 0, 0], [.12, 2.8, 4]], ['box', '陈列台', [.8, 0, -.8], [.8, .7, .8]]],
    steps: [['platform', '一级台阶', [0, 0, 0], [3, .2, 1.5]], ['platform', '二级台阶', [0, .2, -.5], [3, .2, 1]], ['platform', '三级台阶', [0, .4, -.75], [3, .2, .5]]],
  };
  const selected = parts[preset]; if (!selected || document.scene.objects.length + selected.length > DIRECTOR_LIMITS.objects) return document;
  const offset = document.scene.objects.length ? Math.max(...document.scene.objects.map(o => o.position[0] + Math.max(...o.scale) * 1.5)) + 3 : 0;
  // Preset dimensions are metres; primitive base meshes are not all unit cubes.
  const objects = selected.map(([kind, name, position, dimensions]) => {
    const base: Vec3 = kind === 'wall' ? [3, 2.6, .16] : kind === 'platform' ? [2.4, .25, 1.8] : kind === 'cylinder' ? [.9, 1, .9] : [1, 1, 1];
    return { ...createDirectorObject(kind), name, position: [position[0] + offset, position[1], position[2]] as Vec3, scale: dimensions.map((value, index) => value / base[index]) as Vec3, color: '#d9d9d4' };
  });
  return sanitizeDirectorDocument({ ...document, scene: { ...document.scene, objects: [...document.scene.objects, ...objects] } }) ?? document;
}
