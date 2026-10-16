import type { MaterialAsset } from "../../core/services/materialCatalog";

/** Smart queries also match kind; reject a conversion that can broaden an ordinary query. */
export function materialSmartQueryMatchesKind(
  query: string,
  supportedKinds: readonly string[],
  loadedAssets: readonly Pick<MaterialAsset, "kind">[],
) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return false;
  return supportedKinds.some(kind => kind.toLocaleLowerCase().includes(normalized))
    || loadedAssets.some(asset => asset.kind.toLocaleLowerCase().includes(normalized));
}

export function sortMaterialMetadata(assets: readonly MaterialAsset[], sort: "name-asc" | "size-desc") {
  return [...assets].sort((a,b)=>{
    if(sort==="name-asc")return a.name.localeCompare(b.name,"zh-CN");
    const left=Number.isFinite(a.sizeBytes)&&a.sizeBytes!==null&&a.sizeBytes>=0?a.sizeBytes:null;
    const right=Number.isFinite(b.sizeBytes)&&b.sizeBytes!==null&&b.sizeBytes>=0?b.sizeBytes:null;
    return left===null?(right===null?a.id.localeCompare(b.id):1):right===null?-1:right-left||a.id.localeCompare(b.id);
  });
}
