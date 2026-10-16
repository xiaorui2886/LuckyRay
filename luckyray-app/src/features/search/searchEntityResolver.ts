import { focusEntity } from "../../core/services/context";
import { openCanvasById } from "../canvas/canvasNavigation";
import type { SearchResult } from "./searchCore";

// Search results remain transport-safe. This adapter is the only R1 seam that
// knows how desktop navigation maps entity references to the current UI.
export function openSearchResult(result: SearchResult) {
  switch (result.ref.kind) {
    case "material-asset":
      focusEntity("asset", result.ref.id, { action: "detail", source: "global-search" });
      window.location.hash = "#materials";
      return;
    case "db-note":
    case "real-vault-note":
      focusEntity("note", result.ref.id, { source: "global-search" });
      window.location.hash = "#notes";
      return;
    case "collection-item":
      focusEntity("collection", result.ref.id, { source: "global-search" });
      window.location.hash = "#collection";
      return;
    case "canvas":
      openCanvasById(result.ref.id);
      return;
  }
}
