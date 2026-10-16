import { materialLibrarySession, type MaterialLibrarySession } from "./materialLibraryContext";
import type { MaterialAsset } from "./materialCatalog";
import { toMaterialCatalogError } from "./materialCatalog";

export const APPEARANCE_ALGORITHM = "pixel-appearance-v1";
export const APPEARANCE_MAX_CANDIDATES = 96;
export const APPEARANCE_MAX_BYTES = 12 * 1024 * 1024;
export type AppearanceQuery = { kind: "asset"; id: string } | { kind: "bytes"; bytes: number[] };
export type AppearanceResult = {
  libraryId: string; algorithm: string; requested: number; indexed: number; unindexed: number; excludedAnchor: number;
  failures: Array<{ assetId: string; message: string }>;
  hits: Array<{ assetId: string; distance: { total: number; spatial: number; color: number; structure: number; proportion: number } }>;
};
export type AppearanceProgress = {
  phase: "indexing" | "completed" | "cancelled"; total: number; completed: number; reused: number;
  failures: Array<{ assetId: string; message: string }>;
};
type Prepared = { libraryId: string; assetId: string; algorithm: string; cached: boolean; token: string | null };
export class AppearanceCancelled extends Error { constructor() { super("外观检索已取消或库范围已变化"); } }
export function appearanceCandidates(assets: readonly MaterialAsset[], selectedIds: ReadonlySet<string>): MaterialAsset[] {
  const images = assets.filter(asset => asset.kind === "image" && (selectedIds.size === 0 || selectedIds.has(asset.id)));
  if (selectedIds.size > 0 && images.length > APPEARANCE_MAX_CANDIDATES) throw new Error("一次最多索引96张选中图片，请缩小选择范围");
  return images.slice(0, APPEARANCE_MAX_CANDIDATES);
}

/** One bounded UI operation; native Catalog owns membership and file reads. No all-library scan. */
export class MaterialAppearanceSession {
  private context: ReturnType<MaterialLibrarySession["capture"]>;
  private indexSequence = 0;
  private querySequence = 0;
  private disposed = false;
  private session: MaterialLibrarySession;
  private readonly boundLibraryId?:string;
  constructor(session: MaterialLibrarySession = materialLibrarySession,boundLibraryId?:string) { this.session=session;this.boundLibraryId=boundLibraryId; this.context = boundLibraryId?{libraryId:boundLibraryId,generation:0}:session.capture(); }
  isCurrent() {
    if(this.disposed||this.context.libraryId===null)return false;
    if(this.boundLibraryId)return this.session.getSnapshot().registry?.libraries.some(library=>library.id===this.boundLibraryId&&library.state==='ready')??false;
    return this.session.isCurrent(this.context)&&this.session.getSnapshot().status==='ready';
  }
  private indexCurrent(sequence: number) { return this.isCurrent() && sequence === this.indexSequence; }
  private queryCurrent(sequence: number) { return this.isCurrent() && sequence === this.querySequence; }
  cancelIndex() { ++this.indexSequence; }
  cancelQuery() { ++this.querySequence; }
  dispose() { this.disposed = true; this.cancelIndex(); this.cancelQuery(); }
  private ids(ids: readonly string[]) {
    if (ids.length === 0 || ids.length > APPEARANCE_MAX_CANDIDATES || new Set(ids).size !== ids.length
      || ids.some(id => !id || id.length > 256 || /[\x00-\x1f]/.test(id))) throw new Error("请选择1–96项不重复的图片素材");
    return [...ids];
  }
  async index(ids: readonly string[], progress: (state: AppearanceProgress) => void): Promise<AppearanceProgress> {
    const selection = this.ids(ids); const sequence = ++this.indexSequence;
    if (!this.isCurrent()) throw new AppearanceCancelled();
    const state: AppearanceProgress = { phase:"indexing",total:selection.length,completed:0,reused:0,failures:[] };
    const publish = () => { if (this.indexCurrent(sequence)) progress({ ...state, failures:[...state.failures] }); };
    publish();
    for (const assetId of selection) {
      if (!this.indexCurrent(sequence)) return { ...state, phase:"cancelled" };
      let token: string | null = null;
      try {
        const item = await this.session.request<Prepared>({op:"appearancePrepare",id:assetId},this.context.libraryId);
        token = item.token;
        if (!this.indexCurrent(sequence)) return { ...state,phase:"cancelled" };
        if (item.libraryId !== this.context.libraryId || item.assetId !== assetId || item.algorithm !== APPEARANCE_ALGORITHM
          || (item.cached ? token !== null : !token)) throw new Error("原生特征身份不匹配");
        // Recheck generation immediately before cache submission. Native rechecks membership/source again.
        if (!item.cached) {
          await this.session.request({op:"appearanceCommit",token},this.context.libraryId);
          token = null;
        }
        if (!this.indexCurrent(sequence)) return { ...state,phase:"cancelled" };
        state.completed++; if (item.cached) state.reused++;
      } catch (error) {
        if (!this.indexCurrent(sequence)) return { ...state,phase:"cancelled" };
        state.failures.push({ assetId,message:toMaterialCatalogError(error).message });
      } finally {
        if (token) await this.session.request({op:"appearanceDiscard",token},this.context.libraryId).catch(() => {});
      }
      publish();
    }
    state.phase="completed"; publish(); return state;
  }
  async query(ids: readonly string[], query: AppearanceQuery, maximumDistance = 0.45): Promise<AppearanceResult> {
    const selection = this.ids(ids); const sequence = ++this.querySequence;
    if (!this.isCurrent()) throw new AppearanceCancelled();
    if (query.kind === "bytes" && (query.bytes.length === 0 || query.bytes.length > APPEARANCE_MAX_BYTES)) throw new Error("查询图片为空或超过12MiB");
    if (!Number.isFinite(maximumDistance) || maximumDistance < 0 || maximumDistance > 1) throw new Error("外观距离须在0–1之间");
    let result: AppearanceResult;
    try { result = await this.session.request<AppearanceResult>({op:"appearanceQuery",ids:selection,query,maximumDistance},this.context.libraryId); }
    catch (error) { if (!this.queryCurrent(sequence)) throw new AppearanceCancelled(); throw toMaterialCatalogError(error); }
    if (!this.queryCurrent(sequence)) throw new AppearanceCancelled();
    if (result.libraryId !== this.context.libraryId || result.algorithm !== APPEARANCE_ALGORITHM
      || result.hits.length > 24 || result.hits.some(hit => !selection.includes(hit.assetId)
        || !Object.values(hit.distance).every(n => Number.isFinite(n) && n >= 0 && n <= 1))) throw new Error("外观结果身份或距离无效");
    // Catalog get has a 64-ID cap. Chunk even though this version returns at most24 hits.
    const visible = new Set<string>();
    for (let offset = 0; offset < result.hits.length; offset += 64) {
      let assets: MaterialAsset[];
      try { assets=await this.session.request<MaterialAsset[]>({op:"get",ids:result.hits.slice(offset,offset+64).map(hit => hit.assetId)},this.context.libraryId); }
      catch(error) { if(!this.queryCurrent(sequence))throw new AppearanceCancelled();throw toMaterialCatalogError(error); }
      if (!this.queryCurrent(sequence)) throw new AppearanceCancelled();
      for (const asset of assets) if (asset.kind === "image") visible.add(asset.id);
    }
    const dropped=result.hits.filter(hit=>!visible.has(hit.assetId));
    return { ...result,indexed:Math.max(0,result.indexed-dropped.length),
      failures:[...result.failures,...dropped.map(hit=>({assetId:hit.assetId,message:"展示前图片已从当前库移除或类型已变化"}))],
      hits:result.hits.filter(hit => visible.has(hit.assetId)) };
  }
}

/** Preview only. Pixel reads still use the native Catalog gate, never this URL. */
export function localAppearancePreview(asset: MaterialAsset): string | null {
  for (const value of [asset.thumbnailUrl,asset.previewUrl]) {
    if(!value)continue;
    if(/^data:image\/(?:png|jpeg|bmp|webp);base64,[A-Za-z0-9+/=]+$/i.test(value))return value;
    try {
      const url=new URL(value);
      if(!url.username&&!url.password&&((url.protocol==="asset:"&&url.hostname==="localhost")
        ||((url.protocol==="http:"||url.protocol==="https:")&&url.hostname==="asset.localhost"&&!url.port)))return value;
    }catch{/* Raw/private paths and remote URLs are never loaded by this result list. */}
  }
  return null;
}
