import { extensionPackages, ExtensionError, packageCompatibility, type ExtensionPackageService, type TemplateResource } from "./packages";
import { ensureActiveKnowledgeUiSource, getCurrentKnowledgeContext, sourceBoundKnowledgeWrites } from "../services/knowledge";
import { requireAttachmentDraftSession } from "../services/vaultAttachmentSessions";
import { readActiveKnowledgeWriteSource } from "../services/knowledgeSource";

const defaults = { ensureActive: ensureActiveKnowledgeUiSource, context: getCurrentKnowledgeContext, writes: sourceBoundKnowledgeWrites, source: readActiveKnowledgeWriteSource, draft: requireAttachmentDraftSession };

type TemplateDependencies = typeof defaults;

/** Read-only picture of the current template target, for gating UI affordances. */
export type TemplateTargetProbe = {
  target: { vaultId: string; documentRefRelativePath: string | null } | null;
  insertAvailable: boolean;
};

/** A prepared template run: rendered content plus the exact captured target. */
export type PreparedTemplate = {
  content: string;
  target: { vaultId: string; documentRef: unknown; revision: string | null };
  execute(title: string, parentRelativePath?: string): Promise<unknown>;
};

export type ExtensionTemplateActions = {
  displayName(id: string): string | null;
  templateResource(id: string): TemplateResource | null;
  probeTarget(): Promise<TemplateTargetProbe>;
  render(resource: TemplateResource, values: Record<string, string>): string;
  prepare(id: string, values: Record<string, string>, mode: "create" | "insert"): Promise<PreparedTemplate>;
};

/**
 * Read-only snapshot used to decide whether "insert into current note" may be
 * offered. It reuses the same authorities as prepare() and never writes. The
 * probe honours the live editor session's dirty state and re-checks the source
 * identity after the async context read, so a session that switched mid-await —
 * or a note with unsaved edits — never advertises a doomed insert.
 */
export async function probeTemplateTarget(deps: TemplateDependencies = defaults): Promise<TemplateTargetProbe> {
  const source = deps.source();
  if (!source?.vaultId) return { target: null, insertAvailable: false };
  let context;
  try {
    context = await deps.context();
  } catch {
    // A failing context read means there is no usable insert target; never
    // reject the probe (callers would otherwise see an unhandled promise).
    return { target: null, insertAvailable: false };
  }
  // The source (active knowledge write target) may have changed while waiting.
  if (deps.source() !== source) return { target: null, insertAvailable: false };
  let editorMounted = false;
  if (context && context.documentRef?.vaultId === source.vaultId && context.cursorOffset != null) {
    try {
      const draft = deps.draft(source.vaultId, source);
      // A note with in-flight/unsaved edits cannot accept an insert; the same
      // dirty veto prepare() applies at write time.
      const paths = [context.documentRef.relativePath];
      editorMounted = !draft.dirty(paths);
    } catch {
      editorMounted = false;
    }
  }
  // Re-check identity once more after the draft lookup (still no await inside,
  // but keeps the invariant explicit if the authority ever becomes async).
  if (deps.source() !== source) return { target: null, insertAvailable: false };
  return {
    target: {
      vaultId: source.vaultId,
      documentRefRelativePath: editorMounted ? context!.documentRef.relativePath ?? null : null,
    },
    insertAvailable: editorMounted,
  };
}

export function renderPackageTemplate(resource: TemplateResource, values: Record<string, string>) {
  for (const key of Object.keys(values)) if (!Object.prototype.hasOwnProperty.call(resource.parameters, key)) throw new ExtensionError("extension-unknown-parameter");
  return resource.markdown.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, key: string) => {
    const value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : resource.parameters[key];
    if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f]/.test(value)) throw new ExtensionError("extension-invalid-parameter");
    // Parameters are text, never another expansion pass or markdown resource.
    return value.replace(/[\\`*_{}\[\]()<>#!|~]/g, "\\$&");
  });
}
export function createExtensionTemplateActions(packages: ExtensionPackageService = extensionPackages, deps = defaults): ExtensionTemplateActions {
  return {
    displayName(id: string) {
      const installed = packages.snapshot().packages.find((p) => p.package.manifest.id === id && p.package.manifest.type === "template");
      return installed?.package.manifest.name ?? null;
    },
    templateResource(id: string) {
      const installed = packages.snapshot().packages.find((p) => p.package.manifest.id === id && p.package.manifest.type === "template" && p.enabled);
      return installed ? structuredClone(installed.package.resource as TemplateResource) : null;
    },
    probeTarget() {
      return probeTemplateTarget(deps);
    },
    render: renderPackageTemplate,
    async prepare(id: string, values: Record<string, string>, mode: "create" | "insert") {
      const source = deps.source();
      if (!source?.vaultId) throw new ExtensionError("extension-vault-required");
      const vaultId = source.vaultId;
      const active = await deps.ensureActive();
      if (source !== deps.source() || active.vaultId !== source.vaultId) throw new ExtensionError("extension-target-stale");
      const state = await packages.refresh();
      const installed = state.packages.find(p => p.package.manifest.id === id && p.enabled && p.package.manifest.type === "template");
      if (!installed) throw new ExtensionError("extension-template-disabled");
      if (!packageCompatibility(installed.package, state.hostVersion).compatible) throw new ExtensionError("extension-incompatible");
      const content = renderPackageTemplate(installed.package.resource as TemplateResource, values);
      const context = mode === "insert" ? await deps.context() : null;
      if (source !== deps.source() || (mode === "insert" && (!context || context.documentRef.vaultId !== source.vaultId))) throw new ExtensionError("extension-target-stale");
      let consumed = false;
      return {
        content,
        target: { vaultId: source.vaultId, documentRef: context ? structuredClone(context.documentRef) : null, revision: context?.expectedRevision ?? null },
        async execute(title: string, parentRelativePath?: string) {
          if (consumed) throw new ExtensionError("extension-operation-consumed");
          consumed = true; // Unknown write outcomes must not be silently retried.
          const latest = await packages.refresh();
          if (!latest.packages.some(p => p.enabled && p.digest === installed.digest && p.package.manifest.id === id)) throw new ExtensionError("extension-template-changed");
          if (context) {
            const now = await deps.context();
            if (!now || JSON.stringify(now.documentRef) !== JSON.stringify(context.documentRef) || now.expectedRevision !== context.expectedRevision || now.cursorOffset !== context.cursorOffset) throw new ExtensionError("extension-target-stale");
          }
          if (source !== deps.source()) throw new ExtensionError("extension-target-stale");
          // Explicit captured epoch/ref/revision. Never resolve "current" again after an await.
          if (context) {
            if (context.cursorOffset == null) throw new ExtensionError("extension-cursor-required");
            // Reuse the NotesPage live draft/in-flight-save authority. Without
            // that editor session, insertion is unavailable (never assume clean).
            const draft = deps.draft(vaultId, source);
            const paths = [context.documentRef.relativePath];
            if (draft.dirty(paths)) throw new ExtensionError("extension-editor-dirty");
            const result = await deps.writes.insertDocument(context.documentRef, context.cursorOffset, content, context.expectedRevision, active.sourceEpoch);
            // The existing refresh detects edits made while the write was in flight
            // and preserves them as a conflict instead of replacing the editor.
            if (source === deps.source() && deps.draft(vaultId, source) === draft) await draft.refresh(paths);
            return result;
          }
          return deps.writes.createDocument({ title, content, parentRelativePath }, active.sourceEpoch);
        },
      };
    },
  };
}
export const extensionTemplates = createExtensionTemplateActions();
