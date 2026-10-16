import type { GraphSessionLayout } from './graphSessionStore';
export type GraphSessionRect = { left: number; top: number; width: number; height: number };
export type GraphSplitRect = GraphSessionRect & { id: string; orientation: 'row' | 'column'; bounds: GraphSessionRect; ratio: number };
export function graphSessionRects(layout: GraphSessionLayout, width: number, height: number, divider = 6) {
  const groups = new Map<string, GraphSessionRect>(), splits: GraphSplitRect[] = [];
  const visit = (node: GraphSessionLayout, rect: GraphSessionRect) => {
    if (node.kind === 'group') { groups.set(node.id, rect); return; }
    const horizontal = node.orientation === 'row';
    const total = Math.max(0, (horizontal ? rect.width : rect.height) - divider), first = total * node.ratio;
    const line = horizontal ? { left: rect.left + first, top: rect.top, width: divider, height: rect.height } : { left: rect.left, top: rect.top + first, width: rect.width, height: divider };
    splits.push({ ...line, id: node.id, orientation: node.orientation, bounds: rect, ratio: node.ratio });
    visit(node.first, horizontal ? { ...rect, width: first } : { ...rect, height: first });
    visit(node.second, horizontal ? { ...rect, left: line.left + divider, width: total - first } : { ...rect, top: line.top + divider, height: total - first });
  };
  visit(layout, { left: 0, top: 0, width: Math.max(0, width), height: Math.max(0, height) });
  return { groups, splits };
}
