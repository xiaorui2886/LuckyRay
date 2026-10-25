/** Exact, half-open pixel regions. No resampling and no AI requests. */
export type GridSpec = { x: number[]; y: number[] };
export type GridCell = {
  index: number;
  row: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export const GRID_LIMITS = {
  axis: 6,
  cells: 36,
  pixels: 64_000_000,
  bytes: 64 * 1024 * 1024,
};
export function equalGrid(rows: number, columns: number): GridSpec {
  if (
    ![rows, columns].every(
      (n) => Number.isInteger(n) && n >= 1 && n <= GRID_LIMITS.axis,
    ) ||
    rows * columns < 2
  )
    throw Error("invalid-grid");
  return {
    x: Array.from({ length: columns + 1 }, (_, i) => i / columns),
    y: Array.from({ length: rows + 1 }, (_, i) => i / rows),
  };
}
export function gridCells(
  width: number,
  height: number,
  spec: GridSpec,
): GridCell[] {
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    width * height > GRID_LIMITS.pixels
  )
    throw Error("image-too-large");
  const axis = (cuts: number[], size: number) => {
    if (
      cuts.length < 2 ||
      cuts.length > 7 ||
      cuts[0] !== 0 ||
      cuts[cuts.length - 1] !== 1 ||
      cuts.some(
        (v, i) =>
          !Number.isFinite(v) || v < 0 || v > 1 || (i > 0 && v <= cuts[i - 1]),
      )
    )
      throw Error("invalid-grid");
    const px = cuts.map((v) => Math.round(v * size));
    if (px.some((v, i) => i > 0 && v <= px[i - 1]))
      throw Error("cell-too-small");
    return px;
  };
  const xs = axis(spec.x, width),
    ys = axis(spec.y, height),
    columns = xs.length - 1;
  if (columns * (ys.length - 1) < 2) throw Error("invalid-grid");
  return ys.slice(0, -1).flatMap((y, row) =>
    xs.slice(0, -1).map((x, column) => ({
      index: row * columns + column,
      row,
      column,
      x,
      y,
      width: xs[column + 1] - x,
      height: ys[row + 1] - y,
    })),
  );
}
export function moveGridLine(
  spec: GridSpec,
  axis: "x" | "y",
  index: number,
  value: number,
  pixels: number,
): GridSpec {
  if (
    index <= 0 ||
    index >= spec[axis].length - 1 ||
    !Number.isFinite(value) ||
    pixels < 1
  )
    return spec;
  const cuts = [...spec[axis]],
    gap = 1 / pixels;
  cuts[index] = Math.max(
    cuts[index - 1] + gap,
    Math.min(cuts[index + 1] - gap, value),
  );
  return { ...spec, [axis]: cuts };
}
export function splitImageSource(data: Record<string, unknown>): string | null {
  if (
    data._emptyMedia ||
    ["queued", "running"].includes(
      (data.generationTask as { status?: string })?.status || "",
    )
  )
    return null;
  if (data.kind === "image")
    return typeof data.refMediaUrl === "string" && data.refMediaUrl.trim()
      ? data.refMediaUrl
      : null;
  if (
    (data.kind === "generator" && data.generationKind === "image") ||
    (data.kind === "aiResult" && data.resultKind === "image")
  ) {
    const items = data.resultMediaItems as Array<{ url?: string }> | undefined;
    return (
      items?.[0]?.url ||
      (typeof data.resultMediaUrl === "string" ? data.resultMediaUrl : null)
    );
  }
  return null;
}
export function renderGridCell(
  source: CanvasImageSource,
  cell: GridCell,
  makeCanvas = (w: number, h: number) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  },
) {
  const canvas = makeCanvas(cell.width, cell.height),
    ctx = canvas.getContext("2d");
  if (!ctx) throw Error("canvas-unavailable");
  ctx.drawImage(
    source,
    cell.x,
    cell.y,
    cell.width,
    cell.height,
    0,
    0,
    cell.width,
    cell.height,
  );
  return canvas;
}
export type GridOutput = { cell: GridCell; png: string };
/** Files are staged first. Never publish a half-batch into a canvas. */
export async function stageGridOutputs(
  outputs: readonly GridOutput[],
  store: (png: string) => Promise<string>,
  valid: () => boolean,
): Promise<Array<GridOutput & { path: string }>> {
  if (
    !outputs.length ||
    outputs.length > GRID_LIMITS.cells ||
    new Set(outputs.map((o) => o.cell.index)).size !== outputs.length
  )
    throw Error("invalid-selection");
  let bytes = 0;
  for (const output of outputs) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(output.png))
      throw Error("invalid-png");
    bytes += output.png.length * 0.75;
  }
  if (bytes > GRID_LIMITS.bytes) throw Error("output-too-large");
  const staged = [];
  for (const output of outputs) {
    if (!valid()) throw Error("canvas-changed");
    const path = await store(output.png);
    if (!path || /^(data|blob|https?):/i.test(path))
      throw Error("image-not-persisted");
    staged.push({ ...output, path });
  }
  if (!valid()) throw Error("canvas-changed");
  return staged;
}
export type GridBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export function placeGridGroup(
  source: GridBounds,
  occupied: readonly GridBounds[],
  width: number,
  height: number,
): { x: number; y: number } {
  const x = source.x + source.width + 80;
  let y = source.y;
  // Move down past collisions. Each iteration eliminates at least one obstacle.
  for (let i = 0; i <= occupied.length; i++) {
    const hits = occupied.filter(
      (b) =>
        x < b.x + b.width + 24 &&
        x + width + 24 > b.x &&
        y < b.y + b.height + 24 &&
        y + height + 24 > b.y,
    );
    if (!hits.length) return { x, y };
    y = Math.max(...hits.map((b) => b.y + b.height + 40));
  }
  throw Error("layout-unavailable");
}

/** Repair saved slices that used a missing generator handle and a parent clamp. */
export function restoreGridSliceInteraction<T extends {
  data: { gridSlice?: { version?: number } };
  dragHandle?: string;
  extent?: unknown;
}>(node: T): T {
  if (node.data.gridSlice?.version !== 1 || (!node.dragHandle && !node.extent)) return node;
  return { ...node, dragHandle: undefined, extent: undefined };
}

/** Create a normal group with independent image cards. No AI job/history is inherited. */
export function planGridNodes(input: {
  sourceId: string;
  label: string;
  source: GridBounds;
  occupied: GridBounds[];
  staged: Array<GridOutput & { path: string }>;
  spec: GridSpec;
  id: () => string;
  english?: boolean;
}) {
  const { sourceId, label, source, occupied, staged, spec, id, english } =
    input;
  if (
    !staged.length ||
    staged.length > GRID_LIMITS.cells ||
    !staged.every((o) => o.path)
  )
    throw Error("invalid-selection");
  const columns = spec.x.length - 1,
    rows = spec.y.length - 1,
    cellWidth = 300;
  // Size the card to its actual pixels. Row spacing belongs to layout, not the image.
  const sizes = staged.map(({cell}) => {
    const scale = Math.min(cellWidth / cell.width, 600 / cell.height);
    return {width: cell.width * scale, height: cell.height * scale};
  });
  const heights = Array.from({length: rows}, (_, row) => Math.max(0,
    ...staged.map((o, i) => o.cell.row === row ? sizes[i].height : 0)));
  const width = columns * (cellWidth + 24) + 40,
    height = heights.reduce((n, h) => n + h + 48, 0) + 72;
  const position = placeGridGroup(source, occupied, width, height),
    groupId = "grid-" + id();
  const group = {
    id: groupId,
    type: "group",
    position,
    style: { width, height },
    dragHandle: ".canvas-group-drag-handle",
    selected: true,
    data: {
      kind: "group" as const,
      label: english
        ? `${label} · ${staged.length} slices`
        : `${label} · ${staged.length} 张切片`,
      groupMemberCount: staged.length,
    },
  };
  const children = staged.map(({ cell, path }, index) => ({
    id: id(),
    type: "spike",
    parentId: groupId,
    position: {
      x: 32 + cell.column * (cellWidth + 24),
      y: 56 + heights.slice(0, cell.row).reduce((n, h) => n + h + 48, 0),
    },
    style: sizes[index],
    data: {
      kind: "image" as const,
      label: `${label} · ${cell.row + 1}-${cell.column + 1}`,
      refKind: "image",
      refMediaUrl: path,
      refThumbnailUrl: path,
      _emptyMedia: false,
      _manualSize: true,
      derivedFromNodeId: sourceId,
      gridSlice: {
        version: 1 as const,
        batchId: groupId,
        sourceNodeId: sourceId,
        cell,
      },
    },
  }));
  // Provenance lines are visual relations; only the slice itself is an input when
  // connected to a generator. Never feed the original grid into it a second time.
  const edges = children.map(child => ({
    id: `grid-edge-${id()}`, source: sourceId, target: child.id,
    sourceHandle: "s-right", targetHandle: "t-left", animated: false,
    data: {role: "generic" as const, relation: "derivation" as const, semanticsVersion: 1, order: 0},
  }));
  return { group, children, edges };
}
