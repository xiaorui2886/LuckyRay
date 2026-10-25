/** Portable creative directions, interpreted by the model; never physical camera metadata. */
export const CINEMATOGRAPHY_OPTIONS = {
  camera: [
    ['auto', '自动', 'Auto'], ['sony-venice', 'Sony Venice', 'Sony Venice'],
    ['arri-alexa-35', 'ARRI Alexa 35', 'ARRI Alexa 35'], ['arri-alexa-65', 'ARRI Alexa 65', 'ARRI Alexa 65'],
    ['red-v-raptor', 'RED V-Raptor', 'RED V-Raptor'], ['panavision-dxl2', 'Panavision DXL2', 'Panavision DXL2'],
    ['arricam-lt', 'ARRICAM LT', 'ARRICAM LT'], ['arriflex-435', 'ARRIFLEX 435', 'ARRIFLEX 435'], ['imax', 'IMAX', 'IMAX'],
  ],
  lens: [
    ['auto', '自动', 'Auto'], ['zeiss-ultra-prime', 'Zeiss Ultra Prime', 'Zeiss Ultra Prime'],
    ['cooke-sf-1.8x', 'Cooke SF 1.8x', 'Cooke SF 1.8x anamorphic'], ['canon-k35', 'Canon K35', 'Canon K35'],
    ['cooke-s4', 'Cooke S4', 'Cooke S4'], ['cooke-panchro', 'Cooke Panchro', 'Cooke Panchro'],
    ['arri-signature', 'ARRI Signature', 'ARRI Signature'], ['helios', 'Helios', 'Helios'],
    ['panavision', 'Panavision', 'Panavision'], ['hawk', 'Hawk', 'Hawk anamorphic'],
  ],
  focalLength: [['auto', '自动', 'Auto'], ['8', '8 mm', '8 mm'], ['14', '14 mm', '14 mm'], ['24', '24 mm', '24 mm'], ['35', '35 mm', '35 mm'], ['50', '50 mm', '50 mm'], ['75', '75 mm', '75 mm'], ['125', '125 mm', '125 mm']],
  aperture: [['auto', '自动', 'Auto'], ['1.4', 'f/1.4 · 浅景深', 'f/1.4 · Shallow depth'], ['4', 'f/4 · 中等景深', 'f/4 · Moderate depth'], ['11', 'f/11 · 深景深', 'f/11 · Deep focus']],
  framing: [['auto', '自动', 'Auto'], ['extreme-wide', '大远景', 'Extreme wide shot'], ['wide', '远景', 'Wide shot'], ['full', '全景', 'Full shot'], ['medium', '中景', 'Medium shot'], ['close-up', '近景', 'Close-up'], ['extreme-close-up', '特写', 'Extreme close-up']],
  angle: [['auto', '自动', 'Auto'], ['eye-level', '平视', 'Eye-level'], ['low', '仰拍', 'Low angle'], ['high', '俯拍', 'High angle'], ['overhead', '顶视', 'Overhead'], ['dutch', '倾斜视角', 'Dutch angle']],
  movement: [['auto', '自动', 'Auto'], ['static', '固定镜头', 'Static camera'], ['pan', '横摇', 'Pan'], ['tilt', '纵摇', 'Tilt'], ['dolly-in', '推近', 'Dolly in'], ['dolly-out', '拉远', 'Dolly out'], ['tracking', '跟拍', 'Tracking shot'], ['orbit', '环绕', 'Orbit'], ['handheld', '手持', 'Handheld']],
} as const;
export type CinematographyField = keyof typeof CINEMATOGRAPHY_OPTIONS;
type OptionValue<K extends CinematographyField> = (typeof CINEMATOGRAPHY_OPTIONS)[K][number][0];
export type CinematographySettings = { version: 1; enabled: boolean } & { [K in CinematographyField]: OptionValue<K> };
export type CinematographyKind = 'text' | 'image' | 'video';
const FIELDS = Object.keys(CINEMATOGRAPHY_OPTIONS) as CinematographyField[];
export function createDefaultCinematographySettings(): CinematographySettings {
  return { version: 1, enabled: false, camera: 'auto', lens: 'auto', focalLength: 'auto', aperture: 'auto', framing: 'auto', angle: 'auto', movement: 'auto' };
}
/** Reject unknown versions and strip unknown fields; malformed values cannot become prompt text. */
export function normalizeCinematographySettings(value: unknown): CinematographySettings {
  const result = createDefaultCinematographySettings();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return result;
  result.enabled = input.enabled === true;
  for (const key of FIELDS) {
    const candidate = input[key];
    if (typeof candidate === 'string' && CINEMATOGRAPHY_OPTIONS[key].some(option => option[0] === candidate)) {
      // Each candidate has been checked against the allowlist for its own field.
      (result as Record<CinematographyField, string>)[key] = candidate;
    }
  }
  return result;
}
export function cinematographyHasDirections(value: unknown, kind: CinematographyKind): boolean {
  const settings = normalizeCinematographySettings(value);
  return kind !== 'text' && settings.enabled && FIELDS.some(key => (kind === 'video' || key !== 'movement') && settings[key] !== 'auto');
}
function optionLabel(field: CinematographyField, value: string): string {
  return CINEMATOGRAPHY_OPTIONS[field].find(option => option[0] === value)?.[2] ?? '';
}
/** Compile once from the original editor prompt. Repeated identical compilation is idempotent. */
export function compileCinematographyPrompt(prompt: string, value: unknown, kind: CinematographyKind): string {
  const settings = normalizeCinematographySettings(value);
  if (!cinematographyHasDirections(settings, kind)) return prompt;
  const directions: string[] = [];
  if (settings.camera !== 'auto') directions.push(`Camera look inspired by ${optionLabel('camera', settings.camera)}`);
  if (settings.lens !== 'auto') directions.push(`Lens rendering inspired by ${optionLabel('lens', settings.lens)}`);
  if (settings.focalLength !== 'auto') directions.push(`${settings.focalLength} mm focal-length perspective`);
  if (settings.aperture !== 'auto') directions.push(`f/${settings.aperture} aperture look (${settings.aperture === '1.4' ? 'shallow depth of field' : settings.aperture === '4' ? 'moderate depth of field' : 'deep focus'})`);
  if (settings.framing !== 'auto') directions.push(optionLabel('framing', settings.framing));
  if (settings.angle !== 'auto') directions.push(`${optionLabel('angle', settings.angle)} viewpoint`);
  if (kind === 'video' && settings.movement !== 'auto') directions.push(`Camera movement: ${optionLabel('movement', settings.movement)}`);
  const suffix = `\n\n[Camera direction]\n${directions.join('; ')}.\nCreative visual guidance interpreted by the model.`;
  // Never search/replace arbitrary user text or remove older directions from the prompt.
  return prompt.endsWith(suffix) ? prompt : prompt + suffix;
}
