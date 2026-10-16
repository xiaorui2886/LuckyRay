export const MATERIALS_FILTER_PANEL_ID = "materials-filter-panel";
export const MATERIALS_MISSING_PANEL_ID = "materials-missing-panel";

export const MATERIALS_VIEW_ORDER = ["masonry", "grid", "list"] as const;
export type MaterialsViewMode = (typeof MATERIALS_VIEW_ORDER)[number];

export const MATERIALS_SORT_OPTIONS = [
  { key: "recent" },
  { key: "newest" },
  { key: "random" },
  { key: "name-asc" },
  { key: "size-desc" },
] as const;
export type MaterialsSortBy = (typeof MATERIALS_SORT_OPTIONS)[number]["key"];

export type MaterialsToolbarFilterState = {
  kinds: readonly string[];
  tagIds: readonly string[];
  recentOnly: boolean;
  storageMode: "all" | "linked" | "managed" | "source";
  folderId: string | null;
  color: string | null;
  dateFrom: string;
  dateTo: string;
  ratingMin: number | null;
};

export type StandardMaterialsFilterState = Omit<MaterialsToolbarFilterState, "kinds" | "tagIds"> & {
  kinds: string[];
  tagIds: string[];
};

export type MaterialsToolbarState = {
  query?: string;
  searchMode?: "materials" | "global";
  viewMode: MaterialsViewMode;
  workView: "general" | "design" | "video";
  folderName: string | null;
  sortBy: MaterialsSortBy;
  filterOpen: boolean;
  activeFilterCount: number;
  missingOpen: boolean;
  exportOpen: boolean;
  exportRunningCount: number;
  exportNeedsAttention: boolean;
};

export type MaterialsPageFilterSelectionState = MaterialsToolbarFilterState & {
  selectedFolderId: string | null;
};

export type MaterialsToolbarCommand =
  | { type: "set-query"; query: string }
  | { type: "set-search-mode"; mode: "materials" | "global" }
  | { type: "open-appearance" }
  | { type: "toggle-appearance" }
  | { type: "set-view"; viewMode: MaterialsViewMode }
  | { type: "cycle-workview" }
  | { type: "set-sort"; sortBy: MaterialsSortBy }
  | { type: "toggle-filter" }
  | { type: "clear-filters" }
  | { type: "toggle-missing" }
  | { type: "toggle-export-tasks" }
  | { type: "close-overlays" }
  | { type: "request-state" };

export const MATERIALS_TOOLBAR_STATE_EVENT = "luckyray:materials-toolbar-state";
export const MATERIALS_TOOLBAR_COMMAND_EVENT = "luckyray:materials-toolbar-command";

// A navigation intent, not another search state. The material page consumes it once.
export function openMaterialAppearanceFromNavigation(): void {
  window.location.hash = "materials?appearance=1";
}

export function countActiveMaterialsFilters(filter: MaterialsToolbarFilterState): number {
  return Number(filter.kinds.length > 0)
    + Number(filter.tagIds.length > 0)
    + Number(filter.recentOnly)
    + Number(filter.storageMode !== "all")
    + Number(Boolean(filter.folderId))
    + Number(Boolean(filter.color))
    + Number(Boolean(filter.dateFrom))
    + Number(Boolean(filter.dateTo))
    + Number(filter.ratingMin !== null);
}

export function normalizeStandardMaterialsFilters(
  filter: MaterialsToolbarFilterState,
): StandardMaterialsFilterState {
  return {
    ...filter,
    kinds: [...filter.kinds],
    tagIds: [],
    recentOnly: false,
    storageMode: "all",
    folderId: null,
    dateFrom: "",
    dateTo: "",
  };
}

export function countActiveStandardMaterialsFilters(filter: MaterialsToolbarFilterState): number {
  const standard = normalizeStandardMaterialsFilters(filter);
  return Number(standard.kinds.length > 0)
    + Number(Boolean(standard.color))
    + Number(standard.ratingMin !== null);
}

export function clearMaterialsToolbarFilters(
  state: MaterialsPageFilterSelectionState,
): MaterialsPageFilterSelectionState {
  return {
    ...state,
    kinds: [],
    tagIds: [],
    recentOnly: false,
    storageMode: "all",
    folderId: null,
    color: null,
    dateFrom: "",
    dateTo: "",
    ratingMin: null,
  };
}

export function publishMaterialsToolbarState(state: MaterialsToolbarState): void {
  window.dispatchEvent(new CustomEvent<MaterialsToolbarState>(MATERIALS_TOOLBAR_STATE_EVENT, { detail: state }));
}

export function dispatchMaterialsToolbarCommand(command: MaterialsToolbarCommand): void {
  window.dispatchEvent(new CustomEvent<MaterialsToolbarCommand>(MATERIALS_TOOLBAR_COMMAND_EVENT, { detail: command }));
}
