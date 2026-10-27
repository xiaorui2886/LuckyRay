/**
 * Stable, JSON-friendly canvas edge semantics contract.
 *
 * Keep this module free of React, DOM, Tauri and persistence dependencies so
 * desktop, CLI and MCP adapters resolve generation inputs the same way.
 */

import {
  getCanvasNodeCapabilities,
  type CanvasContentKind,
  type CanvasNodeCapabilityData,
} from "./nodeCapabilities";

export const CANVAS_EDGE_SEMANTICS_VERSION = 1 as const;

export const CANVAS_EDGE_ROLES = [
  "generic",
  "reference",
  "promptContext",
  "firstFrame",
  "lastFrame",
  "videoReference",
] as const;

export type CanvasEdgeRole = (typeof CANVAS_EDGE_ROLES)[number];

export type CanvasEdgeSemanticData = {
  /** A visual provenance link, never a model input. */
  relation?: "derivation";
  /** Exact source image selected by a focus token; validated against live source media. */
  referenceMediaUrl?: string;
  role?: CanvasEdgeRole;
  semanticsVersion?: number;
  order?: number;
};

export type CanvasSemanticEdge = {
  source: string;
  target: string;
  data?: CanvasEdgeSemanticData | null;
};

export type CanvasSemanticNode = {
  id: string;
  data: CanvasNodeCapabilityData;
};

export function isCanvasEdgeRole(value: unknown): value is CanvasEdgeRole {
  return typeof value === "string" && (CANVAS_EDGE_ROLES as readonly string[]).includes(value);
}

function nextInputOrder(targetId: string, incomingEdges: readonly CanvasSemanticEdge[]): number {
  return incomingEdges.filter((edge) => edge.target === targetId).length;
}

function inferGeneratorInputRole(
  sourceContent: CanvasContentKind,
  target: CanvasNodeCapabilityData,
  incomingEdges: readonly CanvasSemanticEdge[],
): CanvasEdgeRole {
  if (sourceContent === "text" || sourceContent === "note") return "promptContext";
  if (target.generationKind !== "video") return "reference";
  if (sourceContent === "video") return "videoReference";

  const occupiedRoles = new Set(
    incomingEdges
      .map((edge) => edge.data?.role)
      .filter(isCanvasEdgeRole),
  );
  if (!occupiedRoles.has("firstFrame")) return "firstFrame";
  if (!occupiedRoles.has("lastFrame")) return "lastFrame";
  return "reference";
}

export function inferCanvasEdgeRole(
  source: CanvasNodeCapabilityData,
  target: CanvasNodeCapabilityData,
  incomingEdges: readonly CanvasSemanticEdge[] = [],
): CanvasEdgeRole {
  const sourceCapabilities = getCanvasNodeCapabilities(source);
  const targetCapabilities = getCanvasNodeCapabilities(target);

  if (targetCapabilities.role === "generator") {
    return inferGeneratorInputRole(sourceCapabilities.contentKind, target, incomingEdges);
  }
  if (sourceCapabilities.contentKind === "text" || sourceCapabilities.contentKind === "note") {
    return "promptContext";
  }
  if (sourceCapabilities.contentKind === "video") return "videoReference";
  if (sourceCapabilities.contentKind === "image") return "reference";
  return "generic";
}

export function resolveCanvasEdgeSemanticData(
  source: CanvasNodeCapabilityData,
  target: CanvasNodeCapabilityData,
  targetId: string,
  incomingEdges: readonly CanvasSemanticEdge[] = [],
  current?: CanvasEdgeSemanticData | null,
): Required<Pick<CanvasEdgeSemanticData, "role" | "semanticsVersion" | "order">> {
  const inputs = incomingEdges.filter(edge => edge.target === targetId && edge.data?.relation !== "derivation");
  return {
    role: isCanvasEdgeRole(current?.role)
      ? current.role
      : inferCanvasEdgeRole(source, target, inputs),
    semanticsVersion: typeof current?.semanticsVersion === "number" && current.semanticsVersion > 0
      ? current.semanticsVersion
      : CANVAS_EDGE_SEMANTICS_VERSION,
    order: typeof current?.order === "number" && current.order >= 0
      ? current.order
      : nextInputOrder(targetId, inputs),
  };
}

export function normalizeCanvasEdgeSemantics<
  TNode extends CanvasSemanticNode,
  TEdge extends CanvasSemanticEdge,
>(nodes: readonly TNode[], edges: readonly TEdge[]): Array<TEdge & { data: CanvasEdgeSemanticData }> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const normalized: Array<TEdge & { data: CanvasEdgeSemanticData }> = [];

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      normalized.push({
        ...edge,
        data: {
          ...edge.data,
          role: isCanvasEdgeRole(edge.data?.role) ? edge.data.role : "generic",
          semanticsVersion: typeof edge.data?.semanticsVersion === "number" && edge.data.semanticsVersion > 0
            ? edge.data.semanticsVersion
            : CANVAS_EDGE_SEMANTICS_VERSION,
          order: typeof edge.data?.order === "number" && edge.data.order >= 0 ? edge.data.order : 0,
        },
      });
      continue;
    }

    normalized.push({
      ...edge,
      data: {
        ...edge.data,
        ...resolveCanvasEdgeSemanticData(
          source.data,
          target.data,
          edge.target,
          normalized.filter((candidate) => candidate.target === edge.target),
          edge.data,
        ),
      },
    });
  }

  return normalized;
}
