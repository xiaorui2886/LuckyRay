import { useCallback, useEffect, useRef, useState } from "react";
import {
  executeAttachmentOperation,
  getAttachmentLinkUpdatePolicy,
  previewExternalAttachmentChanges,
  setAttachmentLinkUpdatePolicy,
  type ExternalAttachmentUpdate,
} from "../../core/services/vaultAttachments";
import { markdownContentChanges, type VaultFileChangeBatch } from "../../core/services/vaultFileChanges";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { attachmentErrorMessage } from "../../core/services/vaultAttachmentErrors";

const fingerprint = (update: ExternalAttachmentUpdate) =>
  JSON.stringify(update.plan);
export function useVaultAttachmentChanges(options: {
  vault: { id: string; rootPath: string } | null;
  batch?: VaultFileChangeBatch | null;
  saveAffected: (paths: string[]) => Promise<void>;
  isDirty: (paths: string[]) => boolean;
  refreshAffected: (paths: string[]) => Promise<void>;
  recheckAttachments?: () => void;
}) {
  const [update, setUpdate] = useState<ExternalAttachmentUpdate | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [wake, setWake] = useState(0);
  const current = useRef(options);
  current.current = options;
  const session = useRef(0),
    busy = useRef(false),
    seen = useRef(new Set<string>()),
    pending = useRef(new Map<string, string>());
  const lastGeneration = useRef("");
  const overflow = useRef(false);
  const request = useRef(0);
  const reviewedPaths = useRef(new Map<string, string>());
  const refreshPending = useRef<string[]>([]);
  const executionWarning = useRef("");
  useEffect(() => {
    session.current++;
    request.current++;
    seen.current.clear();
    pending.current.clear();
    reviewedPaths.current.clear();
    lastGeneration.current = "";
    overflow.current = false;
    refreshPending.current = [];
    executionWarning.current = "";
    setUpdate(null);
    setError("");
  }, [options.vault?.id, options.vault?.rootPath]);
  const apply = useCallback(
    async (candidate: ExternalAttachmentUpdate, always: boolean) => {
      const vault = current.current.vault;
      if (!vault || !candidate.plan || busy.current) return;
      const own = session.current,
        source = readActiveKnowledgeWriteSource();
      const isCurrent = () =>
        own === session.current &&
        current.current.vault?.id === vault.id &&
        current.current.vault?.rootPath === vault.rootPath &&
        readActiveKnowledgeWriteSource() === source;
      request.current++;
      const batchPaths = new Map(reviewedPaths.current);
      const consume = () => {
        for (const [path, generation] of batchPaths)
          if (pending.current.get(path) === generation)
            pending.current.delete(path);
      };
      busy.current = true;
      setRunning(true);
      setError("");
      try {
        if (overflow.current)
          throw new Error("文件变化超出本轮容量，请保留原文并重新检查引用。");
        const paths = candidate.plan.files.map((file) => file.relativePath);
        await current.current.saveAffected(paths);
        if (!isCurrent()) return;
        const fresh = await previewExternalAttachmentChanges(
          vault.id,
          [...batchPaths.keys()],
          false,
        );
        if (!isCurrent()) return;
        if (!fresh.plan) {
          setUpdate(null);
          consume();
          return;
        }
        if (fingerprint(fresh) !== fingerprint(candidate)) {
          setUpdate(fresh);
          setError("笔记内容已变化，请确认更新后的影响范围。");
          return;
        }
        if (
          current.current.isDirty(
            fresh.plan.files.map((file) => file.relativePath),
          )
        )
          throw new Error("笔记仍有未保存修改，请保存后重试。");
        if (always)
          await setAttachmentLinkUpdatePolicy(
            vault.id,
            fresh.sourceEpoch,
            "always",
          );
        if (!isCurrent()) return;
        const result = await executeAttachmentOperation(
          fresh.sourceEpoch,
          fresh.plan,
          crypto.randomUUID(),
        );
        if (!isCurrent()) return;
        seen.current.add(fingerprint(fresh));
        if (seen.current.size > 64)
          seen.current.delete(seen.current.values().next().value!);
        executionWarning.current =
          result.status === "complete" ||
          result.status === "complete-with-unresolved"
            ? ""
            : "部分引用未更新，请在附件操作记录中查看详情。";
        // An execution receipt must not be submitted again when only readback fails.
        consume();
        setUpdate(null);
        refreshPending.current = fresh.plan.files.map(
          (file) => file.relativePath,
        );
        await current.current.refreshAffected(refreshPending.current);
        if (!isCurrent()) return;
        refreshPending.current = [];
        current.current.recheckAttachments?.();
        setError(executionWarning.current);
        setUpdate(null);
        if (pending.current.size) setWake((value) => value + 1);
      } catch (cause) {
        if (isCurrent()) {
          setUpdate(refreshPending.current.length ? null : candidate);
          setError(attachmentErrorMessage(cause));
        }
      } finally {
        busy.current = false;
        setRunning(false);
        if (
          pending.current.size &&
          (own !== session.current ||
            [...pending.current].some(
              ([path, generation]) => batchPaths.get(path) !== generation,
            ))
        )
          setWake((value) => value + 1);
      }
    },
    [],
  );
  useEffect(() => {
    const { vault, batch } = options;
    if (
      !vault ||
      !batch ||
      batch.vaultId !== vault.id ||
      batch.rootPath !== vault.rootPath
    )
      return;
    const key = `${batch.session}:${batch.generation}`;
    if (lastGeneration.current !== key) {
      lastGeneration.current = key;
      if (markdownContentChanges(batch)) return;
      for (const observation of batch.observations)
        for (const path of observation.paths) {
          if (
            pending.current.has(path) ||
            (pending.current.size < 256 &&
              [...pending.current.keys(), path].reduce(
                (bytes, value) => bytes + value.length * 2,
                0,
              ) <=
                128 * 1024)
          )
            pending.current.set(path, key);
          else overflow.current = true;
        }
      overflow.current ||= batch.reconcileRequired;
    }
    if (!pending.current.size && !overflow.current) return;
    if (busy.current) return;
    const own = session.current;
    const source = readActiveKnowledgeWriteSource();
    const attempt = ++request.current;
    const observed = new Map(pending.current);
    const incomplete = overflow.current;
    void previewExternalAttachmentChanges(
      vault.id,
      [...observed.keys()].slice(0, 256),
      incomplete,
    )
      .then(async (next) => {
        if (
          own !== session.current ||
          attempt !== request.current ||
          readActiveKnowledgeWriteSource() !== source
        )
          return;
        if (!next.plan || seen.current.has(fingerprint(next))) {
          for (const [path, generation] of observed)
            if (pending.current.get(path) === generation)
              pending.current.delete(path);
          overflow.current = false;
          setUpdate(null);
          setWake((value) => value + 1);
          if ((incomplete || next.uncertainCount) && observed.size) {
            setUpdate(null);
            setError(
              "部分附件变化无法确认，相关引用已保留原文，请检查附件位置。",
            );
          } else setError(executionWarning.current);
          return;
        }
        reviewedPaths.current = observed;
        setUpdate(next);
        setError("");
        const policy = await getAttachmentLinkUpdatePolicy(vault.id);
        if (
          own === session.current &&
          attempt === request.current &&
          readActiveKnowledgeWriteSource() === source &&
          policy === "always" &&
          next.plan.files.length &&
          !next.plan.issues.length &&
          !next.uncertainCount
        )
          await apply(next, true);
      })
      .catch((cause) => {
        if (
          own === session.current &&
          attempt === request.current &&
          readActiveKnowledgeWriteSource() === source
        ) {
          reviewedPaths.current = observed;
          setError(attachmentErrorMessage(cause));
        }
      });
  }, [options.vault?.id, options.vault?.rootPath, options.batch, apply, wake]);
  const decline = () => {
    request.current++;
    if (!update?.plan) {
      // Dismissing a failed read is not a decision to discard a rename.
      setError("");
      return;
    }
    if (update) seen.current.add(fingerprint(update));
    if (seen.current.size > 64)
      seen.current.delete(seen.current.values().next().value!);
    for (const [path, generation] of reviewedPaths.current)
      if (pending.current.get(path) === generation)
        pending.current.delete(path);
    setUpdate(null);
    setError("");
    if (pending.current.size) setWake((value) => value + 1);
  };
  const retry = async () => {
    if (busy.current) return;
    const own = session.current;
    const source = readActiveKnowledgeWriteSource();
    const observed = new Map(pending.current);
    busy.current = true;
    setRunning(true);
    setError("");
    try {
      if (refreshPending.current.length)
        await current.current.refreshAffected(refreshPending.current);
      if (
        own !== session.current ||
        source !== readActiveKnowledgeWriteSource()
      )
        return;
      refreshPending.current = [];
      current.current.recheckAttachments?.();
      setError(executionWarning.current);
      setWake((value) => value + 1);
    } catch (cause) {
      if (
        own === session.current &&
        source === readActiveKnowledgeWriteSource()
      )
        setError(attachmentErrorMessage(cause));
    } finally {
      busy.current = false;
      setRunning(false);
      if (
        pending.current.size &&
        (own !== session.current ||
          [...pending.current].some(
            ([path, generation]) => observed.get(path) !== generation,
          ))
      )
        setWake((value) => value + 1);
    }
  };
  return {
    update,
    error,
    running,
    decline,
    retry,
    pending: pending.current.size > 0 || refreshPending.current.length > 0,
    applyOnce: () => update && apply(update, false),
    applyAlways: () => update && apply(update, true),
  };
}

export function VaultLinkUpdateDialog({
  flow,
}: {
  flow: ReturnType<typeof useVaultAttachmentChanges>;
}) {
  const plan = flow.update?.plan;
  const surface = useApplicationModalSurface<HTMLDivElement>(
    Boolean(plan),
    flow.decline,
    { closeOnBackdrop: !flow.running, closeOnEscape: !flow.running },
  );
  if (!plan) return null;
  return (
    <div
      className="modal-overlay-react vault-link-update-overlay"
      onPointerDown={surface.onBackdropPointerDown}
    >
      <div
        ref={surface.surfaceRef}
        tabIndex={-1}
        onKeyDown={surface.onSurfaceKeyDown}
        className="modal-box-react small vault-link-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-link-update-title"
      >
        <div className="modal-header-react">
          <div className="modal-title-react" id="vault-link-update-title">
            更新附件链接
          </div>
        </div>
        <div className="modal-body-react">
          {!plan && flow.running && (
            <p role="status">正在重新检查附件和笔记…</p>
          )}
          {plan && (
            <p>
              {plan.files.length ? (
                <>
                  检测到附件移动或重命名。更新 {plan.documentCount} 篇笔记中的{" "}
                  {flow.update!.referenceCount} 处引用？
                </>
              ) : (
                "检测到附件移动或重命名，但现有引用需要手动检查。"
              )}
            </p>
          )}
          {plan && plan.issues.length > 0 && (
            <p>另有 {plan.issues.length} 处引用无法确定，将保留原文。</p>
          )}
          {flow.error && <p role="alert">{flow.error}</p>}
        </div>
        <div className="notes-dialog-actions">
          <button disabled={flow.running} onClick={flow.decline}>
            {plan ? "不做更新" : "稍后处理"}
          </button>
          {!plan && flow.error && (
            <button
              className="primary"
              disabled={flow.running}
              onClick={() => void flow.retry()}
            >
              重新检查
            </button>
          )}
          {plan && (
            <>
              <button
                disabled={flow.running || !plan.files.length}
                onClick={() => void flow.applyAlways()}
              >
                本库始终更新
              </button>
              <button
                className="primary"
                disabled={flow.running || !plan.files.length}
                onClick={() => void flow.applyOnce()}
              >
                {flow.running ? "正在更新…" : "仅更新这次"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
