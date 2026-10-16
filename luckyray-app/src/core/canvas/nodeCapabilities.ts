/**
 * Stable, JSON-friendly canvas node capability contract.
 *
 * Keep this module free of React, DOM, Tauri and persistence dependencies so the
 * desktop canvas, future CLI commands and MCP adapters can share one interface.
 */

export const CANVAS_NODE_CAPABILITIES_VERSION = 2 as const;

export const CANVAS_NODE_ROLES = ["resource", "editable", "generator", "result", "container"] as const;
export type CanvasNodeRole = (typeof CANVAS_NODE_ROLES)[number];

export type CanvasNodeKind = "text" | "image" | "video" | "noteRef" | "aiPrompt" | "aiResult" | "generator" | "group";
export type CanvasResultKind = "text" | "image" | "video";
export type CanvasContentKind = CanvasResultKind | "note";
export type CanvasComposerMode = "none" | "contextual" | "embedded";
export type CanvasContentAction = "edit" | "replace" | "clear" | "derive";

export type CanvasNodeCapabilityData = {
  kind: CanvasNodeKind;
  role?: CanvasNodeRole;
  capabilitiesVersion?: number;
  _emptyMedia?: boolean;
  resultKind?: CanvasResultKind;
  generationKind?: "image" | "video";
};

export type CanvasNodeCapabilities = {
  version: typeof CANVAS_NODE_CAPABILITIES_VERSION;
  role: CanvasNodeRole;
  contentKind: CanvasContentKind;
  canReceive: boolean;
  canOutput: boolean;
  composerMode: CanvasComposerMode;
  acceptedInputs: CanvasContentKind[];
  contentActions: CanvasContentAction[];
};

const ALL_CONTENT_KINDS: CanvasContentKind[] = ["text", "image", "video", "note"];

export function isCanvasNodeRole(value: unknown): value is CanvasNodeRole {
  return typeof value === "string" && (CANVAS_NODE_ROLES as readonly string[]).includes(value);
}

export function inferCanvasNodeRole(data: CanvasNodeCapabilityData): CanvasNodeRole {
  if (data.kind === "group") return "container";
  if (data.kind === "generator") return "generator";
  if (data.kind === "aiResult") return "result";
  if (data.kind === "noteRef") return "resource";
  if (data.kind === "image" || data.kind === "video") {
    return data._emptyMedia === true ? "editable" : "resource";
  }
  if (isCanvasNodeRole(data.role)) return data.role;
  return "editable";
}

export function getCanvasNodeContentKind(data: CanvasNodeCapabilityData): CanvasContentKind {
  if (data.kind === "group") return "text";
  if (data.kind === "image" || data.kind === "video") return data.kind;
  if (data.kind === "noteRef") return "note";
  if (data.kind === "aiResult") return data.resultKind || "text";
  if (data.kind === "generator") return data.generationKind || "image";
  return "text";
}

function acceptedInputsFor(role: CanvasNodeRole): CanvasContentKind[] {
  if (role === "resource" || role === "result" || role === "container") return [];
  return [...ALL_CONTENT_KINDS];
}

function contentActionsFor(data: CanvasNodeCapabilityData, role: CanvasNodeRole): CanvasContentAction[] {
  if (data.kind === "group" || role === "container") return [];
  if (data.kind === "aiResult") return ["derive"];
  if (data.kind === "noteRef") return ["derive"];
  if (data.kind === "image" || data.kind === "video") {
    return data._emptyMedia === true
      ? ["replace"]
      : ["replace", "clear", "derive"];
  }
  if (role === "generator") return ["edit"];
  return ["edit", "derive"];
}

export function getCanvasNodeCapabilities(data: CanvasNodeCapabilityData): CanvasNodeCapabilities {
  const role = inferCanvasNodeRole(data);
  return {
    version: CANVAS_NODE_CAPABILITIES_VERSION,
    role,
    contentKind: getCanvasNodeContentKind(data),
    canReceive: role === "editable" || role === "generator",
    canOutput: role !== "container",
    composerMode: role === "generator" || role === "editable" ? "contextual"
        : "none",
    acceptedInputs: acceptedInputsFor(role),
    contentActions: contentActionsFor(data, role),
  };
}
export function canConnectCanvasNodes(
  source: CanvasNodeCapabilityData,
  target: CanvasNodeCapabilityData,
): boolean {
  const sourceCapabilities = getCanvasNodeCapabilities(source);
  const targetCapabilities = getCanvasNodeCapabilities(target);
  return sourceCapabilities.canOutput
    && targetCapabilities.canReceive
    && targetCapabilities.acceptedInputs.includes(sourceCapabilities.contentKind);
}

export function normalizeCanvasNodeCapabilityData<T extends CanvasNodeCapabilityData>(data: T): T & {
  role: CanvasNodeRole;
  capabilitiesVersion: number;
} {
  return {
    ...data,
    role: inferCanvasNodeRole(data),
    capabilitiesVersion: CANVAS_NODE_CAPABILITIES_VERSION,
  };
}
