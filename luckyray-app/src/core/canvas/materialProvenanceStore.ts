import { materialProvenanceKey, normalizeMaterialGenerationProvenance, type MaterialGenerationProvenance, type ProvenanceAssetIdentity } from './materialProvenance';

export type MaterialProvenanceStorage = { read(key:string):Promise<string|null>; write(key:string,value:string):Promise<void> };
/** A separate record per identity prevents concurrent unrelated saves overwriting one another. */
export function createMaterialProvenanceStore(storage: MaterialProvenanceStorage, libraryId: string) {
  const cache = new Map<string, Promise<MaterialGenerationProvenance | undefined>>();
  return {
    async read(asset: ProvenanceAssetIdentity) {
      const key = materialProvenanceKey(libraryId,asset);
      let pending = cache.get(key);
      if (!pending) {
        pending = storage.read(key).then(raw => {
          if (!raw) return undefined;
          try { return normalizeMaterialGenerationProvenance(JSON.parse(raw)); } catch { return undefined; }
        }).catch(error => { cache.delete(key); throw error; });
        cache.set(key, pending);
      }
      const value = await pending;
      return value ? structuredClone(value) : undefined;
    },
    async write(asset: ProvenanceAssetIdentity, value: MaterialGenerationProvenance) {
      const normalized = normalizeMaterialGenerationProvenance(value);
      if (!normalized) throw Error('invalid-material-generation-provenance');
      const key = materialProvenanceKey(libraryId,asset);
      await storage.write(key,JSON.stringify(normalized));
      cache.set(key,Promise.resolve(normalized));
    },
  };
}
