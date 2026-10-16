import type { DeliveryItem } from "./mediaDelivery";
/** Explicit projection: originals only, no thumbnail fallback or secret-bearing state. */
export function selectedCanvasMedia(
  nodes: readonly {
    id: string;
    parentId?: string;
    data: Record<string, unknown>;
  }[],
  selected: readonly string[],
  resolve: (source: string) => string,
): DeliveryItem[] {
  const ids = new Set(selected),
    result: DeliveryItem[] = [];
  for (let added = true; added; ) {
    added = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        added = true;
      }
    }
  }
  for (const node of nodes) {
    if (!ids.has(node.id)) continue;
    const d = node.data,
      label = typeof d.label === "string" ? d.label : "result";
    if (
      (d.kind === "image" || d.kind === "video") &&
      typeof d.refMediaUrl === "string" &&
      d.refMediaUrl
    ) {
      result.push({
        id: node.id,
        nodeId: node.id,
        label,
        kind: d.kind,
        source: resolve(d.refMediaUrl),
      });
      continue;
    }
    const kind = d.generationKind || d.resultKind;
    if (kind !== "image" && kind !== "video") continue;
    const outputs =
      kind === "image" && Array.isArray(d.resultMediaItems)
        ? d.resultMediaItems.filter(
            (v) => v && typeof v.url === "string" && v.url,
          )
        : [];
    if (outputs.length) {
      outputs.forEach((item, index) =>
        result.push({
          id: `${node.id}:${index}`,
          nodeId: node.id,
          label: `${label} ${index + 1}`,
          kind,
          source: resolve(item.url),
        }),
      );
    } else if (typeof d.resultMediaUrl === "string" && d.resultMediaUrl)
      result.push({
        id: node.id,
        nodeId: node.id,
        label,
        kind,
        source: resolve(d.resultMediaUrl),
      });
  }
  return result;
}
