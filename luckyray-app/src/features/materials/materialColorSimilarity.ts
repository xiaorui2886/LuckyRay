export const MATERIAL_COLOR_MATCH_THRESHOLDS = Object.freeze({
  hueDegrees: 24,
  chromaticFloor: 0.045,
  neutralChromaMax: 0.05,
  blackChromaMax: 0.09,
  blackLightnessMax: 0.28,
  whiteLightnessMin: 0.9,
});

export type MaterialNeutralFilter = "neutral:black" | "neutral:gray" | "neutral:white";
export type StandardMaterialColorFilter = `hue:${number}` | MaterialNeutralFilter;

type Oklch = {
  lightness: number;
  chroma: number;
  hue: number;
};

export type MaterialColorFilterView = {
  kind: "hue" | "black" | "gray" | "white";
  hue: number | null;
  label: string;
  sample: string;
};

const NEUTRAL_VIEWS: Record<MaterialNeutralFilter, MaterialColorFilterView> = {
  "neutral:black": { kind: "black", hue: null, label: "中性黑", sample: "#111214" },
  "neutral:gray": { kind: "gray", hue: null, label: "中性灰", sample: "#777982" },
  "neutral:white": { kind: "white", hue: null, label: "中性白", sample: "#f4f4f2" },
};

const HUE_LABELS = [
  "玫红色附近",
  "红色附近",
  "橙色附近",
  "黄色附近",
  "黄绿色附近",
  "绿色附近",
  "青绿色附近",
  "青色附近",
  "天蓝色附近",
  "蓝色附近",
  "紫色附近",
  "洋红色附近",
] as const;

export function createMaterialHueFilter(hue: number): StandardMaterialColorFilter {
  return `hue:${Math.round(normalizeHue(hue))}`;
}

export function normalizeStandardMaterialColorFilter(value: unknown): StandardMaterialColorFilter | null {
  if (value === "neutral:black" || value === "neutral:gray" || value === "neutral:white") return value;
  if (typeof value !== "string") return null;
  const hueToken = /^hue:(-?\d+(?:\.\d+)?)$/u.exec(value.trim());
  if (hueToken) return createMaterialHueFilter(Number(hueToken[1]));

  const legacy = parseMaterialPaletteHexes(value)[0];
  if (!legacy) return null;
  const color = hexToOklch(legacy);
  if (!color) return null;
  const neutral = classifyNeutral(color);
  if (neutral) return neutral;
  return createMaterialHueFilter(color.hue);
}

export function getMaterialColorFilterView(filter: StandardMaterialColorFilter | null): MaterialColorFilterView | null {
  if (!filter) return null;
  if (filter in NEUTRAL_VIEWS) return NEUTRAL_VIEWS[filter as MaterialNeutralFilter];
  const hue = hueFromFilter(filter);
  if (hue === null) return null;
  return {
    kind: "hue",
    hue,
    label: HUE_LABELS[Math.round(hue / 30) % HUE_LABELS.length],
    sample: oklchToHex({ lightness: 0.68, chroma: 0.2, hue }),
  };
}

export function materialColorFilterSample(filter: StandardMaterialColorFilter): string {
  return getMaterialColorFilterView(filter)?.sample || "#777982";
}

export function parseMaterialPaletteHexes(value: unknown, maxColors = 8): string[] {
  if (typeof value !== "string") return [];
  const matches = value.toLowerCase().match(/#[0-9a-f]{6}/gu) || [];
  const colors: string[] = [];
  for (const color of matches) {
    if (!colors.includes(color)) colors.push(color);
    if (colors.length >= maxColors) break;
  }
  return colors;
}

export function materialPaletteMatchesStandardColor(
  palette: unknown,
  filter: StandardMaterialColorFilter,
): boolean {
  const colors = parseMaterialPaletteHexes(palette);
  if (colors.length === 0) return false;
  const selectedNeutral = filter in NEUTRAL_VIEWS ? filter as MaterialNeutralFilter : null;
  const selectedHue = selectedNeutral ? null : hueFromFilter(filter);
  if (!selectedNeutral && selectedHue === null) return false;

  return colors.some((hex) => {
    const candidate = hexToOklch(hex);
    if (!candidate) return false;
    if (selectedNeutral) return classifyNeutral(candidate) === selectedNeutral;
    if (candidate.chroma < MATERIAL_COLOR_MATCH_THRESHOLDS.chromaticFloor) return false;
    return circularHueDistance(candidate.hue, selectedHue as number) <= MATERIAL_COLOR_MATCH_THRESHOLDS.hueDegrees;
  });
}

function hueFromFilter(filter: string): number | null {
  const match = /^hue:(\d{1,3})$/u.exec(filter);
  if (!match) return null;
  return normalizeHue(Number(match[1]));
}

function classifyNeutral(color: Oklch): MaterialNeutralFilter | null {
  if (
    color.lightness <= MATERIAL_COLOR_MATCH_THRESHOLDS.blackLightnessMax
    && color.chroma <= MATERIAL_COLOR_MATCH_THRESHOLDS.blackChromaMax
  ) return "neutral:black";
  if (color.chroma > MATERIAL_COLOR_MATCH_THRESHOLDS.neutralChromaMax) return null;
  return color.lightness >= MATERIAL_COLOR_MATCH_THRESHOLDS.whiteLightnessMin
    ? "neutral:white"
    : "neutral:gray";
}

function circularHueDistance(left: number, right: number): number {
  const delta = Math.abs(normalizeHue(left) - normalizeHue(right));
  return Math.min(delta, 360 - delta);
}

function normalizeHue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

function hexToOklch(hex: string): Oklch | null {
  if (!/^#[0-9a-f]{6}$/iu.test(hex)) return null;
  const red = srgbToLinear(Number.parseInt(hex.slice(1, 3), 16) / 255);
  const green = srgbToLinear(Number.parseInt(hex.slice(3, 5), 16) / 255);
  const blue = srgbToLinear(Number.parseInt(hex.slice(5, 7), 16) / 255);
  const lRoot = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const mRoot = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const sRoot = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const b = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;
  return {
    lightness,
    chroma: Math.hypot(a, b),
    hue: normalizeHue(Math.atan2(b, a) * 180 / Math.PI),
  };
}

function oklchToHex(color: Oklch): string {
  const radians = normalizeHue(color.hue) * Math.PI / 180;
  const a = color.chroma * Math.cos(radians);
  const b = color.chroma * Math.sin(radians);
  const lRoot = color.lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = color.lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = color.lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return `#${[
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.round(Math.min(1, Math.max(0, linearToSrgb(channel))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}
