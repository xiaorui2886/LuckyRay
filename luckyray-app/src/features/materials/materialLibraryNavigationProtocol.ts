import type { MaterialLibraryRegistry } from "../../core/services/materialLibraryContext";

export const MATERIAL_LIBRARY_NAVIGATION_EVENT = "luckyray:material-library-navigation";
export const MATERIAL_LIBRARY_NAVIGATION_BUSY_EVENT = "luckyray:material-library-navigation-busy";
export type MaterialLibraryNavigationAction = "create" | "reopen" | "manage" | "export" | "restore" | "tasks" | "copyLibrary" | "moveLibrary" | "mergeLibrary" | "view" | "copyId" | "rename" | "reveal" | "relocate" | "hide" | "show";
export type MaterialLibraryNavigationIntent = { action: MaterialLibraryNavigationAction; libraryId: string | null; name: string; fromManagement?: boolean };
export function materialLibraryDisplayName(libraryId: string | null, registry: MaterialLibraryRegistry | null) {
  if (!libraryId || !registry) return "正在读取素材库…";
  return registry.libraries.find(library => library.id === libraryId)?.name ?? "素材库";
}
/** The shell requests an existing mounted dialog host; it never owns a task. */
export function requestMaterialLibraryNavigation(intent: MaterialLibraryNavigationIntent) {
  window.dispatchEvent(new CustomEvent(MATERIAL_LIBRARY_NAVIGATION_EVENT, { detail: { ...intent } }));
}
export function publishMaterialLibraryNavigationBusy(host: "manager" | "transfer", busy: boolean) {
  window.dispatchEvent(new CustomEvent(MATERIAL_LIBRARY_NAVIGATION_BUSY_EVENT, { detail: { host, busy } }));
}
