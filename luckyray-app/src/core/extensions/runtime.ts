import { invoke } from "@tauri-apps/api/core";
import { readActiveKnowledgeWriteSource } from "../services/knowledgeSource";
import { requireAttachmentDraftSession } from "../services/vaultAttachmentSessions";
export type PluginScope = {
  materialLibraryId?: string | null; materialIds: string[]; canvasIds: string[]; writes: boolean; exportPath?: string | null;
  knowledge: null | { allowCreate: boolean; vaultId: string; sourceEpoch: number; documents: string[]; parentRelativePath: string | null };
  theme: Record<string, string>;
};
export type PluginUi = { title: string; text?: string; fields?: { id: string; label: string; value: string }[]; actions?: { id: string; label: string }[] };
/** A host-confirmed write: the native response value of a dispatched write method, never the plugin's own claim. `call` is the dispatch sequence within the run. */
export type PluginOutcome = { call: number; method: string; value: unknown; exportPath: string | null };
/** A write whose commit status the host never reported back (transport loss, cancellation, delivery failure after commit). */
export type PluginUnconfirmedWrite = { call: number; method: string; target: string };
/**
 * A host call that did not return a committed result. `kind` is decided here with
 * the same pre-execution table that settles unconfirmed writes: `refused` means the
 * native side rejected it before any mutation; `unknown` means nothing can be
 * inferred (the matching unconfirmed record, if any, shares the `call` number).
 */
export type PluginCallFailure = { call: number; method: string; code: string; kind: "refused" | "unknown" };
/** Everything the host has established about this run so far, independent of the plugin's final UI. */
export type PluginProgress = { outcomes: PluginOutcome[]; unconfirmed: PluginUnconfirmedWrite[]; failures: PluginCallFailure[] };
export type PluginRunResult = PluginProgress & { ui: PluginUi; receipts: unknown[] };
/**
 * A failed run still carries the host-confirmed progress that happened before the
 * failure. Plugin throw, invalid UI, transport loss or cancellation never erase a
 * committed write; callers must present `outcomes`/`unconfirmed` rather than
 * treating the round as "nothing happened".
 */
export class PluginRunError extends Error {
  readonly code: string;
  readonly outcomes: PluginOutcome[];
  readonly unconfirmed: PluginUnconfirmedWrite[];
  readonly failures: PluginCallFailure[];
  constructor(error: unknown, progress: PluginProgress) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "PluginRunError";
    this.code = this.message;
    this.outcomes = [...progress.outcomes];
    this.unconfirmed = [...progress.unconfirmed];
    this.failures = [...progress.failures];
  }
}
const OUTCOME_METHODS = new Set(["data.set", "materials.tags", "knowledge.create", "knowledge.insert", "canvas.export"]);
/**
 * Native codes that are raised before any domain mutation starts (lease check,
 * authorization, parameter/limit validation, transactional conflicts). A write
 * refused with one of these definitely did not happen. Anything else — including
 * an unrecognised code or a transport failure — leaves the write status unknown.
 */
const PRE_EXECUTION_REFUSALS = new Set([
  "plugin-retired", "plugin-no-pending-call", "plugin-session-busy", "plugin-concurrency-limit", "plugin-host-work-limit", "plugin-host-lock",
  "plugin-host-veto", "plugin-permission-denied", "plugin-object-denied", "plugin-write-confirmation-required", "plugin-create-not-selected",
  "plugin-consent-required", "plugin-disabled", "plugin-incompatible", "plugin-contribution-unavailable", "plugin-scope", "plugin-scope-limit",
  "plugin-parameters", "plugin-parameter-limit", "plugin-input-limit", "plugin-method-unavailable", "plugin-handle-denied", "plugin-log-limit",
  "plugin-data-invalid", "plugin-revision-conflict", "plugin-document-limit", "plugin-canvas-limit", "plugin-canvas-format", "plugin-image-limit",
  "plugin-image-format", "plugin-image-decode", "plugin-image-unavailable", "plugin-material-unavailable", "plugin-selection-unavailable",
  "plugin-export-destination-required", "plugin-export-already-written", "plugin-storage-unavailable", "extension-storage-unavailable",
  "extension-invalid-request", "extension-consent-required", "extension-data-conflict-or-limit", "extension-revision-conflict",
  "extension-storage-busy", "extension-storage-corrupt",
  // Knowledge validates title/parent/vault and refuses a name conflict before writing anything
  // (knowledge/mod.rs: safe_markdown_name / safe_existing_directory / assert vault, all before write_document).
  "knowledge-name-conflict", "knowledge-invalid-title", "knowledge-parent-missing", "knowledge-path-outside-vault",
  "knowledge-vault-not-current",
]);
/**
 * Native domain services (knowledge, materials) serialise their errors as
 * `{"code":"…","message":"…"}`; classification and copy need the bare code.
 */
export function domainErrorCode(code: string): string {
  if (code.startsWith("{")) {
    try { const parsed = JSON.parse(code) as { code?: unknown }; if (typeof parsed.code === "string" && parsed.code) return parsed.code; } catch { /* not JSON */ }
  }
  return code;
}
export function isPreExecutionRefusal(code: string): boolean { return PRE_EXECUTION_REFUSALS.has(code) || PRE_EXECUTION_REFUSALS.has(domainErrorCode(code)); }
export function validatePluginUi(value: unknown): PluginUi {
  if (!value || typeof value !== "object" || JSON.stringify(value).length > 32000) throw Error("plugin-ui-invalid");
  const v = value as Record<string, unknown>;
  const text = (v: unknown, max: number) => { if (typeof v !== "string" || v.length > max) throw Error("plugin-ui-invalid"); return v; };
  const result: PluginUi = { title: text(v.title, 160) };
  if (v.text !== undefined) result.text = text(v.text, 16000);
  if (v.fields !== undefined) {
    if (!Array.isArray(v.fields) || v.fields.length > 8) throw Error("plugin-ui-invalid");
    result.fields = v.fields.map(f => ({ id: text(f.id, 64), label: text(f.label, 120), value: text(f.value, 1000) }));
  }
  if (v.actions !== undefined) {
    if (!Array.isArray(v.actions) || v.actions.length > 8) throw Error("plugin-ui-invalid");
    result.actions = v.actions.map(a => ({ id: text(a.id, 64), label: text(a.label, 120) }));
  }
  return result;
}
async function command<T>(request: object) { return invoke<T>("extension_runtime", { request: JSON.stringify(request) }); }
function errorCode(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** Host UI bridge only. Package JavaScript runs exclusively in the native worker. */
export async function runPlugin(id: string, scope: PluginScope, event: object, signal: AbortSignal, log: (message: string) => void, onProgress?: (progress: PluginProgress) => void): Promise<PluginRunResult> {
  const outcomes: PluginOutcome[] = [], unconfirmed: PluginUnconfirmedWrite[] = [], failures: PluginCallFailure[] = [];
  const snapshot = (): PluginProgress => ({ outcomes: [...outcomes], unconfirmed: [...unconfirmed], failures: [...failures] });
  const publish = () => onProgress?.(snapshot());
  const settle = (pending: PluginUnconfirmedWrite | null) => { if (pending) { const at = unconfirmed.indexOf(pending); if (at >= 0) unconfirmed.splice(at, 1); } };
  const classify = (code: string): PluginCallFailure["kind"] => isPreExecutionRefusal(code) ? "refused" : "unknown";
  let sequence = 0;
  const source = readActiveKnowledgeWriteSource();
  let token: string | undefined;
  const close = () => { if (token) void command({ op: "close", token }).catch(() => {}); };
  try {
    if (signal.aborted) throw Error("plugin-cancelled");
    token = (await command<{ token: string }>({ op: "start", id, scope, event })).token;
    signal.addEventListener("abort", close, { once: true });
    while (!signal.aborted) {
      const message = await command<{ kind: string; request?: { method: string; params: Record<string, unknown> }; result?: { ok: boolean; value?: unknown; error?: string }; receipts?: unknown[] }>({ op: "poll", token });
      if (signal.aborted) throw Error("plugin-cancelled");
      if (message.kind === "pending") { await new Promise(resolve => setTimeout(resolve, 20)); continue; }
      if (message.kind === "result") {
        if (!message.result?.ok) throw Error(message.result?.error || "plugin-failed");
        return { ui: validatePluginUi(message.result.value), receipts: message.receipts || [], ...snapshot() };
      }
      if (message.kind !== "call" || !message.request) throw Error("plugin-protocol");
      const call = message.request;
      let veto: string | null = null;
      let draft: ReturnType<typeof requireAttachmentDraftSession> | undefined;
      const paths = typeof call.params.path === "string" ? [call.params.path] : scope.knowledge?.documents || [];
      if (call.method.startsWith("knowledge.")) {
        if (!source || source !== readActiveKnowledgeWriteSource() || source.vaultId !== scope.knowledge?.vaultId) veto = "source-changed";
        if (["knowledge.insert", "knowledge.selection"].includes(call.method) && !veto) {
          try { draft = requireAttachmentDraftSession(scope.knowledge!.vaultId, source!); if (draft.dirty(paths)) veto = "editor-dirty"; }
          catch { veto = "editor-session-unavailable"; }
        }
      }
      if (signal.aborted) throw Error("plugin-cancelled");
      // Until native dispatch answers, a write's commit status is unknown. Keep the
      // record on transport loss or cancellation; never infer rollback from an error.
      const callIndex = ++sequence;
      const pending: PluginUnconfirmedWrite | null = OUTCOME_METHODS.has(call.method) && !veto ? {
        call: callIndex,
        method: call.method,
        target: String(call.params.path ?? call.params.id ?? call.params.title ?? (call.method === "canvas.export" ? scope.exportPath : id) ?? ""),
      } : null;
      if (pending) { unconfirmed.push(pending); publish(); }
      let response: { response: { value?: unknown; error?: string }; deliveryError?: string };
      try {
        response = await command({ op: "dispatch", token, veto });
      } catch (error) {
        // The command itself failed. A lease refusal happens before any domain work,
        // so the write did not run; any other failure leaves it unconfirmed.
        const code = errorCode(error);
        failures.push({ call: callIndex, method: call.method, code, kind: classify(code) });
        if (isPreExecutionRefusal(code)) settle(pending);
        publish();
        throw error;
      }
      if (response.response.error) {
        failures.push({ call: callIndex, method: call.method, code: response.response.error, kind: classify(response.response.error) });
        if (isPreExecutionRefusal(response.response.error)) settle(pending);
        log(response.response.error);
      } else if (OUTCOME_METHODS.has(call.method)) {
        settle(pending);
        outcomes.push({ call: callIndex, method: call.method, value: response.response.value, exportPath: call.method === "canvas.export" ? scope.exportPath ?? null : null });
      }
      publish();
      if (call.method === "log" && !signal.aborted) log(String(call.params.message || "").slice(0, 1000));
      // The native side committed the write but could not hand the reply to the
      // plugin (lease ended meanwhile). The outcome above stands; the run ends here.
      if (response.deliveryError) throw Error(response.deliveryError);
      if (signal.aborted) throw Error("plugin-cancelled");
      if (call.method === "knowledge.insert" && !response.response.error && draft && source === readActiveKnowledgeWriteSource()) {
        try { if (requireAttachmentDraftSession(scope.knowledge!.vaultId, source!) === draft) await draft.refresh(paths); }
        catch { log("笔记已写入，但界面刷新失败；请检查目标笔记，不要自动重试。"); }
      }
    }
    throw Error("plugin-cancelled");
  } catch (error) { throw error instanceof PluginRunError ? error : new PluginRunError(error, snapshot()); }
  finally { signal.removeEventListener("abort", close); close(); }
}
