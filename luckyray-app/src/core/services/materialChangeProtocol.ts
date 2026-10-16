export const MATERIAL_CHANGE_EVENT = "luckyray:material-change";
export const MATERIAL_CHANGE_LOCAL_EVENT = "luckyray:material-change-local";

export type MaterialChange = {
  version: number;
  reason: string;
  affectedIds: string[];
  foldersChanged: boolean;
  occurredAt: string;
};

export function isMaterialChange(value: unknown): value is MaterialChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Partial<MaterialChange>;
  return Number.isFinite(change.version)
    && typeof change.reason === "string"
    && Array.isArray(change.affectedIds)
    && typeof change.foldersChanged === "boolean"
    && typeof change.occurredAt === "string";
}
