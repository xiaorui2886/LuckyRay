import { readMaterialLibraryPreference, writeMaterialLibraryPreference } from "../../core/services/materialLibraryContext";
import type { MaterialsViewMode } from "./materialsToolbarProtocol";

/**
 * Work view presets (MATERIAL-VIEW-COMPARE-R1): presentation preferences over
 * the SAME material library. A preset is a bounded {viewMode, zoom} snapshot —
 * it never touches folders, filters, sort, selection, or any data.
 *
 * Lifecycle rules:
 * - The FIRST time the user leaves 通用, the CURRENT presentation is
 *   snapshotted into general.saved — so switching back restores the exact
 *   pre-preset habit ("返回通用恢复原习惯").
 * - Before that first switch, 通用 resolves to null = "keep whatever the
 *   page uses now" — the initial upgrade never overwrites an existing habit.
 * - Manual view/zoom changes while a preset is active are recorded into THAT
 *   preset's saved snapshot.
 */
export type MaterialWorkViewPresetId = "general" | "design" | "video";

export type MaterialWorkViewSnapshot = {
  viewMode: MaterialsViewMode;
  zoom: number;
};

export type MaterialWorkViewPreferences = {
  active: MaterialWorkViewPresetId;
  /** Per-preset saved user adjustments; null/absent = preset defaults apply. */
  saved: Partial<Record<MaterialWorkViewPresetId, MaterialWorkViewSnapshot>>;
};

export const MATERIAL_WORK_VIEW_ORDER: readonly MaterialWorkViewPresetId[] = ["general", "design", "video"];

export const MATERIAL_WORK_VIEW_DEFAULTS: Record<MaterialWorkViewPresetId, MaterialWorkViewSnapshot> = {
  general: { viewMode: "masonry", zoom: 180 },
  design: { viewMode: "grid", zoom: 180 },
  video: { viewMode: "masonry", zoom: 260 },
};

export const MATERIAL_WORK_VIEW_STORAGE_KEY = "luckyray-materials-workview-v1";

export const MATERIALS_ZOOM_MIN = 60;
export const MATERIALS_ZOOM_MAX = 300;

function clampZoom(value: unknown): number | null {
  const zoom = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(zoom)) return null;
  return Math.min(MATERIALS_ZOOM_MAX, Math.max(MATERIALS_ZOOM_MIN, Math.round(zoom)));
}

function isViewMode(value: unknown): value is MaterialsViewMode {
  return value === "masonry" || value === "grid" || value === "list";
}

/**
 * Resolve the effective snapshot for a preset: the user's saved adjustment
 * wins; otherwise the preset default. 通用 with NO saved adjustment returns
 * null — "keep the current presentation" — until the first snapshot is taken.
 */
export function resolveMaterialWorkViewSnapshot(
  preferences: MaterialWorkViewPreferences | null,
  preset: MaterialWorkViewPresetId,
): MaterialWorkViewSnapshot | null {
  const saved = preferences?.saved?.[preset];
  if (saved && isViewMode(saved.viewMode)) {
    const zoom = clampZoom(saved.zoom);
    if (zoom !== null) return { viewMode: saved.viewMode, zoom };
  }
  if (preset === "general") return null;
  return { ...MATERIAL_WORK_VIEW_DEFAULTS[preset] };
}

export function sanitizeMaterialWorkViewPreferences(value: unknown): MaterialWorkViewPreferences | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const active = row.active;
  if (active !== "general" && active !== "design" && active !== "video") return null;
  const saved: MaterialWorkViewPreferences["saved"] = {};
  const savedRow = row.saved;
  if (typeof savedRow === "object" && savedRow !== null) {
    for (const preset of MATERIAL_WORK_VIEW_ORDER) {
      const entry = (savedRow as Record<string, unknown>)[preset];
      if (typeof entry !== "object" || entry === null) continue;
      const entryRow = entry as Record<string, unknown>;
      const viewMode = entryRow.viewMode;
      const zoom = clampZoom(entryRow.zoom);
      if (isViewMode(viewMode) && zoom !== null) {
        saved[preset] = { viewMode, zoom };
      }
    }
  }
  return { active, saved };
}

export function loadMaterialWorkViewPreferences(libraryId?: string | null): MaterialWorkViewPreferences | null {
  try {
    const raw = readMaterialLibraryPreference(MATERIAL_WORK_VIEW_STORAGE_KEY, libraryId);
    if (!raw) return null;
    return sanitizeMaterialWorkViewPreferences(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveMaterialWorkViewPreferences(preferences: MaterialWorkViewPreferences, libraryId?: string | null): void {
  try {
    writeMaterialLibraryPreference(MATERIAL_WORK_VIEW_STORAGE_KEY, JSON.stringify(preferences), libraryId);
  } catch {
    // Best-effort; presentation still applies for this session and a
    // corrupted store recovers to defaults on next load.
  }
}

/** Record a manual presentation change into the ACTIVE preset. */
export function recordMaterialWorkViewAdjustment(
  preferences: MaterialWorkViewPreferences | null,
  preset: MaterialWorkViewPresetId,
  snapshot: MaterialWorkViewSnapshot,
): MaterialWorkViewPreferences {
  const zoom = clampZoom(snapshot.zoom) ?? MATERIAL_WORK_VIEW_DEFAULTS[preset].zoom;
  const viewMode = isViewMode(snapshot.viewMode) ? snapshot.viewMode : MATERIAL_WORK_VIEW_DEFAULTS[preset].viewMode;
  const base = preferences ?? { active: preset, saved: {} };
  return {
    active: base.active,
    saved: { ...base.saved, [preset]: { viewMode, zoom } },
  };
}

/**
 * Switch presets honestly:
 * - Leaving 通用 for the first time (no general.saved yet) snapshots the
 *   CURRENT presentation into general.saved so 通用 can restore it later.
 * - The target snapshot resolves from the NEW preferences (saved > default).
 */
export function switchMaterialWorkViewPreset(
  preferences: MaterialWorkViewPreferences | null,
  next: MaterialWorkViewPresetId,
  currentPresentation: MaterialWorkViewSnapshot,
): { preferences: MaterialWorkViewPreferences; target: MaterialWorkViewSnapshot | null } {
  const base = preferences ?? { active: "general" as const, saved: {} };
  if (base.active === next) {
    return { preferences: base, target: resolveMaterialWorkViewSnapshot(base, next) };
  }
  const saved = { ...base.saved };
  if (base.active === "general" && !saved.general) {
    // First departure from 通用: capture the user's habit exactly.
    saved.general = {
      viewMode: isViewMode(currentPresentation.viewMode)
        ? currentPresentation.viewMode
        : MATERIAL_WORK_VIEW_DEFAULTS.general.viewMode,
      zoom: clampZoom(currentPresentation.zoom) ?? MATERIAL_WORK_VIEW_DEFAULTS.general.zoom,
    };
  }
  const preferences2: MaterialWorkViewPreferences = { active: next, saved };
  return { preferences: preferences2, target: resolveMaterialWorkViewSnapshot(preferences2, next) };
}
