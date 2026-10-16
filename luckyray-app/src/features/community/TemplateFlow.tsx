import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExtensionTemplateActions,
  PreparedTemplate,
} from "../../core/extensions/templates";
import type { TemplateResource } from "../../core/extensions/packages";
import { extensionErrorCopyKey } from "./ExtensionPackagesPanel";
import type { ExtCopyKey } from "./extensionMessages";

type Translate = (key: ExtCopyKey, vars?: Record<string, string>) => string;

export type TemplateCreateOutcome = {
  /** A precise document reference when the writer returned one. */
  documentRef: unknown | null;
  title: string;
  /** True only when the writer gave no precise reference to open. */
  uncertain: boolean;
};

export type TemplateFlowProps = {
  actions: ExtensionTemplateActions;
  templateId: string;
  templateName: string;
  resource: TemplateResource;
  t: Translate;
  /** Locate the produced note by its real reference (never by guessed title). */
  onLocate?: (outcome: TemplateCreateOutcome) => void;
  onMessage?: (kind: "info" | "error", text: string) => void;
  onBusyChange?: (busy: boolean) => void;
};

type Stage =
  | { kind: "form"; mode: "create" | "insert" }
  | { kind: "preparing"; mode: "create" | "insert" }
  | { kind: "prepared"; mode: "create" | "insert"; prepared: PreparedTemplate }
  | { kind: "running"; mode: "create" | "insert"; prepared: PreparedTemplate }
  | { kind: "written-unconfirmed"; prepared: PreparedTemplate };

function initialValues(resource: TemplateResource) {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(resource.parameters)) values[key] = value;
  return values;
}

/** Pull a precise document reference out of a writer result, if it returned one. */
function documentRefOf(result: unknown): unknown | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.documentRef) return record.documentRef;
  const document = record.document as Record<string, unknown> | undefined;
  if (document && document.documentRef) return document.documentRef;
  return null;
}

/**
 * Template use flow: parameters → content preview with an explicit target →
 * create/insert → locate. Preparation failures are re-runnable; a write whose
 * refresh failed is reported without an automatic retry (never duplicate text).
 * The confirmation view renders the *prepared* content and target (R4).
 *
 * Identity binding (A): every prepared run belongs to the template it started
 * under. If the caller swaps the template (A → B) — including while A's prepare
 * is still in flight — the stale operation is discarded by generation and the
 * component resets to B's form. A run that already started its write is never
 * silently re-executed or pretended cancelled.
 */
export function TemplateFlow({
  actions, templateId, templateName, resource, t, onLocate, onMessage, onBusyChange,
}: TemplateFlowProps) {
  const [stage, setStage] = useState<Stage>({ kind: "form", mode: "create" });
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(resource));
  const [title, setTitle] = useState(templateName);
  const [target, setTarget] = useState<string | null>(null);
  const [targetNote, setTargetNote] = useState("");
  const [insertAvailable, setInsertAvailable] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const notify = useCallback((kind: "info" | "error", text: string) => {
    setNotice({ kind, text });
    onMessage?.(kind, text);
  }, [onMessage]);
  useEffect(() => { onBusyChange?.(stage.kind === "preparing" || stage.kind === "running"); }, [stage.kind, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);

  // Generation is bumped on every identity swap and every new prepare. Async
  // results are only applied when their generation is still current.
  const generation = useRef(0);
  const identity = `${templateId}::${templateName}`;
  const identityRef = useRef(identity);

  // Reset the whole flow whenever the template identity changes (A → B), so a
  // previously prepared run can never leak into the new template's confirmation.
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    generation.current += 1;
    setStage({ kind: "form", mode: "create" });
    setValues(initialValues(resource));
    setTitle(templateName);
    setNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // Unmount invalidation: the caller swaps templates with a React `key`, which
  // unmounts this instance rather than changing its props, so the identity
  // effect above never runs. Bump the generation on unmount too, so a write that
  // already started cannot deliver a late locate/success callback into the new
  // template's UI (or pull focus back to the old note). The in-flight write is
  // allowed to finish — we only stop its callback from touching the live page.
  useEffect(() => () => { generation.current += 1; }, []);

  const refreshTarget = useCallback(async () => {
    const op = generation.current;
    let probe;
    try {
      probe = await actions.probeTarget();
    } catch {
      // A failed probe means insert is not offered; never leave an unhandled
      // rejection or a stale "available" state.
      if (op === generation.current) { setInsertAvailable(false); setTargetNote(""); }
      return;
    }
    if (op !== generation.current) return;
    setTarget(probe.target?.vaultId ?? null);
    setTargetNote(probe.target?.documentRefRelativePath ?? probe.target?.vaultId ?? "");
    setInsertAvailable(probe.insertAvailable);
  }, [actions]);

  useEffect(() => { void refreshTarget(); }, [refreshTarget, identity]);

  const setValue = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const prepare = useCallback(async (mode: "create" | "insert") => {
    const op = ++generation.current;
    setNotice(null);
    setStage({ kind: "preparing", mode });
    try {
      const prepared = await actions.prepare(templateId, values, mode);
      if (op !== generation.current) return; // identity changed while preparing
      setStage({ kind: "prepared", mode, prepared });
    } catch (error) {
      if (op !== generation.current) return;
      // Preparation/validation failures are safe to retry: return to the form
      // rather than pretending content exists. A stale target is refreshed.
      if ((error as { code?: string } | null)?.code === "extension-target-stale") {
        setStage({ kind: "form", mode });
        setInsertAvailable(false);
        await refreshTarget();
        if (op === generation.current) notify("error", t("pack.template.targetStale"));
      } else {
        setStage({ kind: "form", mode });
        notify("error", t(extensionErrorCopyKey(error)));
      }
    }
  }, [actions, notify, refreshTarget, t, templateId, values]);

  const run = useCallback(async (prepared: PreparedTemplate, mode: "create" | "insert") => {
    const op = generation.current;
    setStage({ kind: "running", mode, prepared });
    try {
      const result = await prepared.execute(title);
      if (op !== generation.current) return; // the user moved on; do not touch the new flow
      const documentRef = documentRefOf(result);
      notify("info", t(mode === "create" ? "pack.template.created" : "pack.template.inserted", { name: title }));
      if (mode === "insert") {
        onLocate?.({ documentRef, title, uncertain: false });
      } else if (documentRef) {
        onLocate?.({ documentRef, title, uncertain: false });
      }
      setStage({ kind: "form", mode });
      await refreshTarget();
    } catch (error) {
      if (op !== generation.current) return;
      const code = (error as { code?: string } | null)?.code;
      if (code === "extension-target-stale" || code === "extension-editor-dirty"
        || code === "extension-cursor-required" || code === "extension-template-disabled"
        || code === "extension-template-changed" || code === "extension-vault-required") {
        // The write did not run: show the precise reason and let the user retry.
        setStage({ kind: "form", mode });
        notify("error", t(extensionErrorCopyKey(error)));
        return;
      }
      // Any other failure leaves the write outcome unknown (e.g. the commit
      // landed but the refresh failed). Do not auto-retry and do not claim a
      // specific note; offer to inspect the target repository instead.
      setStage({ kind: "written-unconfirmed", prepared });
    }
  }, [onLocate, notify, refreshTarget, t, title]);

  if (stage.kind === "written-unconfirmed") {
    return (
      <div className="ext-template-flow">
        <div className="ext-template-warn">{t("pack.template.writtenUnconfirmed")}</div>
        <div className="ext-template-actions">
          <button className="lr-cap-run" onClick={() => {
            // Only offer a repository-level check; no precise note is known.
            onLocate?.({ documentRef: null, title, uncertain: true });
            setStage({ kind: "form", mode: "create" });
          }}>{t("pack.template.inspectTarget")}</button>
          <button className="lr-cap-run secondary" onClick={() => setStage({ kind: "form", mode: "create" })}>{t("pack.template.back")}</button>
        </div>
      </div>
    );
  }

  if (stage.kind === "prepared" || stage.kind === "running") {
    const mode = stage.mode;
    const busy = stage.kind === "running";
    // R4: render the prepared content and the prepared target, not the props or
    // the stale probe. What is previewed is exactly what execute() will write.
    const preparedTargetLabel = stage.prepared.target.vaultId;
    return (
      <div className="ext-template-flow">
        <div className="ext-template-summary">
          <div className="ext-template-param"><span>{t("pack.template.titleField")}</span><code>{title}</code></div>
          <div className="ext-template-param"><span>{t("pack.template.target")}</span><code>{preparedTargetLabel || t("pack.template.targetNone")}</code></div>
        </div>
        <div className="ext-template-preview-label">{t("pack.template.preview")}</div>
        <pre className="ext-template-preview">{stage.prepared.content}</pre>
        <div className="ext-template-actions">
          <button className="lr-cap-run" disabled={busy} onClick={() => void run(stage.prepared, mode)}>
            {t(mode === "create" ? "pack.template.create" : "pack.template.insert")}
          </button>
          <button className="lr-cap-run secondary" disabled={busy} onClick={() => setStage({ kind: "form", mode })}>{t("pack.template.back")}</button>
        </div>
      </div>
    );
  }

  const preparing = stage.kind === "preparing";
  const formPreview = (() => {
    try {
      return actions.render(resource, values);
    } catch {
      return "";
    }
  })();
  return (
    <div className="ext-template-flow">
      {notice && <div className={`community-drawer-message${notice.kind === "error" ? " error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
      <div className="ext-template-params">
        {Object.keys(resource.parameters).map((key) => (
          <label className="ext-template-field" key={key}>
            <span>{key}</span>
            <input value={values[key] ?? ""} maxLength={500} disabled={preparing}
              onChange={(event) => setValue(key, event.target.value)} />
          </label>
        ))}
        <label className="ext-template-field">
          <span>{t("pack.template.titleField")}</span>
          <input value={title} disabled={preparing} onChange={(event) => setTitle(event.target.value)} />
        </label>
      </div>
      <div className="ext-template-target">
        <span>{t("pack.template.target")}</span>
        <code>{targetNote || t("pack.template.targetNone")}</code>
      </div>
      <div className="ext-template-preview-label">{t("pack.template.preview")}</div>
      <pre className="ext-template-preview">{formPreview}</pre>
      <div className="ext-template-actions">
        <button className="lr-cap-run" disabled={preparing || !target} onClick={() => void prepare("create")}>{t("pack.template.create")}</button>
        <button className="lr-cap-run secondary" disabled={preparing || !insertAvailable} title={insertAvailable ? undefined : t("pack.template.insertUnavailable")} onClick={() => void prepare("insert")}>{t("pack.template.insert")}</button>
      </div>
      {!insertAvailable && <div className="ext-template-hint">{t("pack.template.insertUnavailable")}</div>}
    </div>
  );
}
