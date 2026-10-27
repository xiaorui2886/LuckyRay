import {normalizeCinematographySettings, type CinematographySettings} from './cinematography';
import {normalizeCreativeRecipe, type ImageCreativeRecipe} from './imageCreativeActions';

/** The editable input, separate from the provider's compiled prompt. No profile or credentials. */
export type CanvasGenerationEditorSnapshot = {
  version: 1;
  prompt: string;
  /** In the same order as request.references; preserves inline mention/focus identity. */
  referenceKeys: string[];
  cinematography?: CinematographySettings;
  creativeRecipe?: ImageCreativeRecipe;
};
export function normalizeGenerationEditorSnapshot(value: unknown, referenceCount?: number): CanvasGenerationEditorSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input=value as Record<string,unknown>;
  if(input.version!==1 || typeof input.prompt!=='string' || input.prompt.length>64000 || !Array.isArray(input.referenceKeys)
    || input.referenceKeys.length>64 || (referenceCount!==undefined && input.referenceKeys.length!==referenceCount)
    || input.referenceKeys.some(key=>typeof key!=='string'||!key||key.length>2048)
    || new Set(input.referenceKeys).size!==input.referenceKeys.length) return;
  const recipe=input.creativeRecipe===undefined?undefined:normalizeCreativeRecipe(input.creativeRecipe);
  if(input.creativeRecipe!==undefined&&!recipe)return;
  return {version:1,prompt:input.prompt,referenceKeys:[...input.referenceKeys] as string[],
    ...(input.cinematography!==undefined?{cinematography:normalizeCinematographySettings(input.cinematography)}:{}),
    ...(recipe?{creativeRecipe:{...recipe,options:{...recipe.options}}}:{})};
}
export function captureGenerationEditorSnapshot(prompt: string, referenceKeys: readonly string[], cinematography?: unknown, creativeRecipe?: unknown): CanvasGenerationEditorSnapshot | undefined {
  return normalizeGenerationEditorSnapshot({version:1,prompt,referenceKeys:[...referenceKeys],cinematography,creativeRecipe},referenceKeys.length);
}
