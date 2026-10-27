import { DIRECTOR_LIMITS, sanitizeDirectorDocument } from './model';
import type { DirectorDocument, DirectorShot } from './types';

/** Renderer exports are local PNGs, never remote URLs or provider requests. */
export function assertDirectorCapture(png: string): void {
  if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,iVBORw0KGgo') || png.length > 24 * 1024 * 1024) throw new Error('invalid-director-capture');
}
export function directorSessionMatches(owner: {canvasId: string; epoch: number}, current: {canvasId: string | null; epoch: number}): boolean {
  return owner.canvasId === current.canvasId && owner.epoch === current.epoch;
}
export function directorShotDescription(shot: DirectorShot): string {
  const { camera, lighting } = shot.scene;
  return [shot.notes, `${camera.focalLength} mm · ${camera.aspect}`, `Camera (${camera.position.join(', ')}) → (${camera.target.join(', ')})`, `Light: ${lighting.preset}`].filter(Boolean).join('\n');
}

/** Preserve the current draft while retaining the exact scene that produced an exported frame. */
export function retainDirectorExport(document: unknown, shot: DirectorShot): DirectorDocument {
  const clean = sanitizeDirectorDocument(document);
  if (!clean) throw new Error('invalid-director-document');
  const normalizedShot = sanitizeDirectorDocument({ version: 1, scene: shot.scene, shots: [shot] })?.shots[0];
  if (!normalizedShot) throw new Error('invalid-director-shot');
  const existing = clean.shots.find(item => item.id === normalizedShot.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(normalizedShot)) throw new Error('director-shot-identity-conflict');
  if (!existing && clean.shots.length >= DIRECTOR_LIMITS.shots) throw new Error('too-many-director-shots');
  const next = sanitizeDirectorDocument({ ...clean, shots: existing ? clean.shots : [...clean.shots, normalizedShot] });
  if (!next) throw new Error('invalid-director-document');
  return next;
}

export type DirectorShotSource = { version: 1; shotId: string; shot: DirectorShot };
/** Never hand the editor an aliased node snapshot. Validate and reconstruct JSON data. */
export function readDirectorShotSource(value: unknown): DirectorShot | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<DirectorShotSource>;
  if (source.version !== 1 || !source.shot || source.shotId !== source.shot.id) return null;
  return sanitizeDirectorDocument({ version: 1, scene: source.shot.scene, shots: [source.shot] })?.shots[0] ?? null;
}
/** Opening a captured frame is a temporary draft, not an implicit edit to the persisted stage. */
export function directorFrameDraft(document: DirectorDocument, source: unknown): DirectorDocument {
  const shot = readDirectorShotSource(source);
  const clean = sanitizeDirectorDocument(document);
  if (!clean) throw new Error('invalid-director-document');
  return shot ? { ...clean, scene: shot.scene, activeShotId: undefined } : clean;
}
