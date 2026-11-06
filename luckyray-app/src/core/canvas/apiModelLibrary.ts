import type { CanvasMediaProfile } from "../services/canvasMediaProfiles";

export type CanvasApiModelKind = "text" | "image" | "video";
export type CanvasApiModelChoice = { model: string; profileId?: string; profileName: string };

export function canvasProfileModelIds(profile: CanvasMediaProfile | null | undefined, kind: CanvasApiModelKind): string[] {
  if (!profile || profile.id === "doubao-default" || profile.imageProtocol === "doubao-image" || profile.videoProtocol === "doubao-video") return [];
  const protocol = kind === "text" ? profile.textProtocol ?? "legacy" : kind === "image" ? profile.imageProtocol : profile.videoProtocol;
  if (protocol === "disabled" || protocol === "legacy") return [];
  const model = kind === "text" ? profile.textModel : kind === "image" ? profile.imageModel : profile.videoModel;
  const models = kind === "text" ? profile.textModels : kind === "image" ? profile.imageModels : profile.videoModels;
  return Array.from(new Set([model, ...(models ?? [])].filter((id): id is string => !!id?.trim())));
}

/** A card owns its connection selection; choosing a model never changes the global default. */
export function canvasGenerationProfile(profiles: readonly CanvasMediaProfile[] | undefined, active: CanvasMediaProfile | null, profileId?: string): CanvasMediaProfile | null {
  if (!profileId) return active;
  return profiles ? profiles.find(profile => profile.id === profileId) ?? null : active?.id === profileId ? active : null;
}

export function canvasApiModelChoices(
  profiles: readonly CanvasMediaProfile[] | undefined,
  kind: CanvasApiModelKind,
  active: CanvasMediaProfile | null,
  fallbackModels: readonly string[],
  legacyText?: { models: readonly string[]; providerLabel: string },
): CanvasApiModelChoice[] {
  if (!profiles) return fallbackModels.map(model => ({ model, profileId: active?.id, profileName: active?.name ?? legacyText?.providerLabel ?? "" }));
  const legacyProfile = active && (active.textProtocol ?? "legacy") === "legacy" ? active : profiles.find(profile => (profile.textProtocol ?? "legacy") === "legacy" && profile.id !== "doubao-default" && profile.imageProtocol !== "doubao-image" && profile.videoProtocol !== "doubao-video");
  return profiles.flatMap(profile => {
    if (profile.id === "doubao-default" || profile.imageProtocol === "doubao-image" || profile.videoProtocol === "doubao-video") return [];
    if (kind === "text" && (profile.textProtocol ?? "legacy") === "legacy") {
      // Legacy connections all share app settings; show that route once.
      return profile.id === legacyProfile?.id ? (legacyText?.models ?? []).map(model => ({ model, profileId: profile.id, profileName: legacyText?.providerLabel || profile.name })) : [];
    }
    return canvasProfileModelIds(profile, kind).map(model => ({ model, profileId: profile.id, profileName: profile.name }));
  });
}
