// One-shot seed for the existing lazy global search overlay, not a second search service.
let pendingQuery: string | undefined;
let returnToMaterials = false;
export function openGlobalSearchWithQuery(query: string, fromMaterials = false) {
  pendingQuery = query;
  returnToMaterials = fromMaterials;
  window.dispatchEvent(new CustomEvent("luckyray:search-open"));
}
export function consumeMaterialSearchReturn() {
  const value = returnToMaterials; returnToMaterials = false; return value;
}
export function consumeGlobalSearchQuery() {
  const query = pendingQuery; pendingQuery = undefined; return query;
}
