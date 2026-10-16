/**
 * Canvas-owned portable export serializer.
 *
 * Pure functions only: no Tauri, DOM, bridge, Provider, filesystem, Material
 * Library or Agent API access. The durable canvas document already carries
 * `generationHistory`; the portable export keeps it instead of silently
 * dropping part of the visible Canvas state.
 */

export const CANVAS_PORTABLE_EXPORT_SCHEMA_VERSION = 1 as const;

export type CanvasPortableExportSource = {
  canvasId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: unknown;
  edges: unknown;
  viewport: { x: number; y: number; zoom: number };
  generationHistory?: unknown;
};

export type CanvasPortableExport = {
  schemaVersion: number;
  canvasId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: unknown;
  edges: unknown;
  viewport: { x: number; y: number; zoom: number };
  generationHistory: unknown[];
};

/**
 * Serialize a loaded canvas document into the portable export object.
 *
 * The exporter deliberately picks explicit fields only: backend-only
 * concurrency / Agent authority metadata (`revision`, `contentDigest`,
 * `agentReceipts`) and any secret-bearing settings never reach the output,
 * even when present on a wider input object. Node/edge/history payloads are
 * passed through unchanged (JSON-safe nested fields included); missing or
 * legacy generation history becomes `[]`.
 *
 * Portable export version authority is fixed at
 * `CANVAS_PORTABLE_EXPORT_SCHEMA_VERSION`; any schema version carried by a
 * wider runtime input (e.g. the durable document's `schemaVersion`) is
 * deliberately ignored so the portable export stays decoupled from
 * durable-storage schema truth.
 */
export function serializeCanvasPortableExport(input: CanvasPortableExportSource): CanvasPortableExport {
  return {
    schemaVersion: CANVAS_PORTABLE_EXPORT_SCHEMA_VERSION,
    canvasId: input.canvasId,
    name: input.name,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    nodes: input.nodes,
    edges: input.edges,
    viewport: input.viewport,
    generationHistory: Array.isArray(input.generationHistory) ? input.generationHistory : [],
  };
}
