export type DraggedMaterialAsset = {
  id: string;
  name: string;
};

export const MATERIAL_ASSET_DRAG_TYPE = "application/x-luckyray-material-asset";

function normalizeDraggedMaterialAsset(value: unknown): DraggedMaterialAsset | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DraggedMaterialAsset>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!id || !name) return null;
  return { id, name };
}

export function setDraggedMaterialAsset(dataTransfer: DataTransfer, asset: DraggedMaterialAsset) {
  const normalized = normalizeDraggedMaterialAsset(asset);
  if (!normalized) return;
  const markdown = `![[${normalized.name}]]`;
  dataTransfer.setData(MATERIAL_ASSET_DRAG_TYPE, JSON.stringify(normalized));
  dataTransfer.setData("text/plain", markdown);
  dataTransfer.effectAllowed = "copy";
}

export function getDraggedMaterialAsset(dataTransfer: DataTransfer | null | undefined): DraggedMaterialAsset | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(MATERIAL_ASSET_DRAG_TYPE);
  if (!raw) return null;
  try {
    return normalizeDraggedMaterialAsset(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function hasDraggedMaterialAsset(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types || []).includes(MATERIAL_ASSET_DRAG_TYPE);
}
