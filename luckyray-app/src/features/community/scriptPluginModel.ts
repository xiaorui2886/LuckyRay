import { packageCompatibility, type InstalledPackage, type ScriptContribution, type ScriptResource } from "../../core/extensions/packages";
import type { PluginOutcome } from "../../core/extensions/runtime";

/** Object-selection limits mirror the host's per-run scope bounds. */
export const PICK_LIMITS = { materials: 32, notes: 32, canvases: 8 } as const;
/** How many list entries are shown before search is needed; totals are still reported honestly. */
export const LIST_SHOWN = 100;
/** The knowledge list call returns the newest N notes; search is the way to reach the rest. */
export const NOTES_LIST_CAP = 200;

export type PluginStatus = "incompatible" | "needs-consent" | "disabled" | "enabled";

export type PluginView = {
  id: string;
  name: string;
  version: string;
  minHostVersion: string;
  digest: string;
  epoch: number | null;
  enabled: boolean;
  compatible: boolean;
  required: string[];
  optional: string[];
  granted: string[];
  missingRequired: string[];
  status: PluginStatus;
  contributions: ScriptContribution[];
  dataVersion: number;
  modules: { required: string[]; optional: string[] };
};

export function describeScriptPackage(entry: InstalledPackage, hostVersion: string): PluginView {
  const manifest = entry.package.manifest;
  const resource = entry.package.resource as ScriptResource;
  const { compatible } = packageCompatibility(entry.package, hostVersion);
  const granted = entry.grants ?? [];
  const required = [...resource.requiredPermissions];
  const optional = resource.optionalPermissions.filter(permission => !required.includes(permission));
  const missingRequired = required.filter(permission => !granted.includes(permission));
  const status: PluginStatus = !compatible ? "incompatible" : entry.enabled ? "enabled" : missingRequired.length ? "needs-consent" : "disabled";
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    minHostVersion: manifest.minHostVersion,
    digest: entry.digest,
    epoch: entry.epoch ?? null,
    enabled: entry.enabled,
    compatible,
    required,
    optional,
    granted,
    missingRequired,
    status,
    contributions: resource.contributions,
    dataVersion: resource.dataVersion,
    modules: { required: manifest.requiredModules, optional: manifest.optionalModules },
  };
}

/** Grants to save: every required permission plus the optional ones the user ticked, in manifest order. */
export function nextGrants(view: Pick<PluginView, "required" | "optional">, selectedOptional: readonly string[]): string[] {
  return [...view.required, ...view.optional.filter(permission => selectedOptional.includes(permission))];
}

/** Order-insensitive equality of two permission lists. */
export function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort(), sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/** True when the installed entry no longer matches the view the user acted on. */
export function pluginChanged(view: Pick<PluginView, "digest" | "epoch">, entry: InstalledPackage | undefined): boolean {
  return !entry || entry.digest !== view.digest || (entry.epoch ?? null) !== view.epoch;
}

export type RunScope = { materialIds: readonly string[]; documents: readonly string[]; canvasIds: readonly string[]; allowCreate: boolean; writes: boolean };

/**
 * Stable identity of one run's authorized objects; a result is stale once this
 * changes. The write toggle is deliberately excluded: it does not change which
 * objects the plugin sees, and the documented flow is preview → allow writes →
 * confirm an action on the same preview.
 */
export function scopeSignature(scope: Omit<RunScope, "writes"> & { writes?: boolean }): string {
  const sorted = (values: readonly string[]) => [...values].sort();
  return JSON.stringify([sorted(scope.materialIds), sorted(scope.documents), sorted(scope.canvasIds), scope.allowCreate]);
}

export type OutcomeView =
  | { key: "noteCreated" | "noteInserted"; params: { title: string; path: string }; documentRef: { vaultId: string; relativePath: string } | null }
  | { key: "tagsAdded"; params: { name: string; count: string } }
  | { key: "exported"; params: { nodes: string; edges: string; bytes: string; path: string }; exportPath: string | null }
  | { key: "dataSaved"; params: Record<string, never> };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Turn host response values of committed writes into displayable outcomes. Plugin text is never consulted. */
export function describeOutcomes(outcomes: readonly PluginOutcome[]): OutcomeView[] {
  const views: OutcomeView[] = [];
  for (const outcome of outcomes) {
    const value = asRecord(outcome.value);
    if (outcome.method === "knowledge.create" || outcome.method === "knowledge.insert") {
      const note = outcome.method === "knowledge.insert" ? asRecord(value.document) : value;
      const ref = asRecord(note.documentRef);
      const relativePath = typeof ref.relativePath === "string" ? ref.relativePath : "";
      const vaultId = typeof ref.vaultId === "string" ? ref.vaultId : "";
      views.push({
        key: outcome.method === "knowledge.create" ? "noteCreated" : "noteInserted",
        params: { title: typeof note.title === "string" && note.title ? note.title : relativePath, path: relativePath },
        documentRef: relativePath && vaultId ? { vaultId, relativePath } : null,
      });
    } else if (outcome.method === "materials.tags") {
      const tagIds = Array.isArray(value.tagIds) ? value.tagIds : [];
      views.push({ key: "tagsAdded", params: { name: typeof value.name === "string" ? value.name : "", count: String(tagIds.length) } });
    } else if (outcome.method === "canvas.export") {
      views.push({
        key: "exported",
        params: { nodes: String(value.nodes ?? "?"), edges: String(value.edges ?? "?"), bytes: String(value.bytes ?? "?"), path: outcome.exportPath ?? "" },
        exportPath: outcome.exportPath,
      });
    } else if (outcome.method === "data.set") {
      views.push({ key: "dataSaved", params: {} });
    }
  }
  return views;
}

/**
 * Field values after a re-render: keep what the user is typing, take the plugin's
 * value for untouched fields, and drop fields the plugin no longer returns.
 */
export function mergeFieldValues(current: Record<string, string>, incoming: readonly { id: string; value: string }[] | undefined, edited: ReadonlySet<string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const field of incoming ?? []) next[field.id] = edited.has(field.id) && field.id in current ? current[field.id] : field.value;
  return next;
}

/** Case-insensitive contains filter over display names, capped for rendering. */
export function filterByQuery<T extends { name: string }>(items: readonly T[], query: string, limit: number): T[] {
  const needle = query.trim().toLowerCase();
  const matched = needle ? items.filter(item => item.name.toLowerCase().includes(needle)) : [...items];
  return matched.slice(0, limit);
}
