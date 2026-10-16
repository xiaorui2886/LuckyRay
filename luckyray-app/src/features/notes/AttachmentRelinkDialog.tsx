import { attachmentErrorMessage } from "../../core/services/vaultAttachmentErrors";
import { useEffect, useMemo, useState } from "react";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { ensureActiveKnowledgeUiSource } from "../../core/services/knowledge";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import {
  executeAttachmentOperation,
  previewAttachmentRelink,
  previewMaterialFileMove,
  type AttachmentOperationPlan,
  type AttachmentOperationResult,
} from "../../core/services/vaultAttachments";
import {
  createAttachmentRelinkController,
  requestAttachmentRelink,
  type AttachmentRelinkRequest,
} from "../../core/services/vaultAttachmentSessions";
import { attachmentIssueLabel } from "../../core/services/vaultAttachmentWorkflow";
import "./vaultAttachments.css";
export function AttachmentRelinkDialog({
  request,
}: {
  request: AttachmentRelinkRequest;
}) {
  const [plan, setPlan] = useState<AttachmentOperationPlan | null>(null);
  const [result, setResult] = useState<AttachmentOperationResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const controller = useMemo(
    () =>
      createAttachmentRelinkController(request, {
        current: readActiveKnowledgeWriteSource,
        capture: async () => {
          const active = await ensureActiveKnowledgeUiSource();
          if (active.vaultId !== request.vaultId)
            throw new Error("知识库已切换");
          return active.sourceEpoch;
        },
        preview: () =>
          (request.kind === "move"
            ? previewMaterialFileMove
            : previewAttachmentRelink)(
            request.vaultId,
            request.assetId,
            request.newPath,
          ),
        execute: (epoch, prepared) =>
          executeAttachmentOperation(epoch, prepared, crypto.randomUUID()),
      }),
    [request],
  );
  const close = () => {
    if (controller.phase === "running") return;
    controller.cancel();
    requestAttachmentRelink(null);
  };
  const modal = useApplicationModalSurface<HTMLDivElement>(true, close);
  useEffect(() => {
    let active = true;
    let started = false;
    queueMicrotask(() => {
      if (!active) return;
      started = true;
      void controller
        .prepare()
        .then((value) => {
          if (active) setPlan(value);
        })
        .catch((cause) => {
          if (active) setError(attachmentErrorMessage(cause));
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    });
    return () => {
      active = false;
      if (started) controller.cancel();
    };
  }, [controller]);
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await controller.confirm());
    } catch (cause) {
      setError(attachmentErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const issues = result?.issues || plan?.issues || [];
  return (
    <div
      className="editorial-dialog-backdrop experience-dialog-backdrop notes-vault-modal-overlay"
      onPointerDown={modal.onBackdropPointerDown}
    >
      <div
        ref={modal.surfaceRef}
        className="editorial-dialog experience-dialog notes-vault-dialog attachment-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={
          request.kind === "move" ? "移动或重命名文件" : "恢复附件位置"
        }
        tabIndex={-1}
        onKeyDown={modal.onSurfaceKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="editorial-dialog-head">
          <h2>
            {request.kind === "move" ? "移动或重命名文件" : "恢复附件位置"}
          </h2>
        </div>
        <div className="editorial-dialog-body vault-attachment-settings">
          <p className="attachment-export-path">新位置：{request.newPath}</p>
          {busy && (
            <p role="status">
              {plan ? "正在更新引用…" : "正在保存草稿并检查引用…"}
            </p>
          )}
          {plan && !result && (
            <p>
              当前知识库涉及 {plan.documentCount} 项笔记变更。
              {request.kind === "move"
                ? "确认后移动真实文件并更新可安全处理的引用。"
                : "确认后更新真实引用，原文件保留。"}
            </p>
          )}
          {request.otherVaultCount > 0 && (
            <p>
              另外 {request.otherVaultCount}{" "}
              个知识库仍需分别打开处理，本次不会声称已更新它们。
            </p>
          )}
          {result && (
            <p role="status">
              {result.status === "complete"
                ? "当前知识库引用已更新"
                : "已处理可确定项，仍有引用待处理"}{" "}
              · {result.completedFiles} / {result.totalFiles} 项
            </p>
          )}
          {issues.length > 0 && (
            <details>
              <summary>查看 {issues.length} 项待处理原因</summary>
              <ul className="vault-attachment-issues">
                {issues.map((issue, i) => (
                  <li key={i}>
                    <strong>{attachmentIssueLabel(issue.status)}</strong>
                    <span>
                      {issue.document} · {issue.target}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {error && (
            <p role="alert" className="vault-attachment-error">
              {error}
            </p>
          )}
          <div className="vault-attachment-actions">
            <button disabled={controller.phase === "running"} onClick={close}>
              {result ? "完成" : "取消"}
            </button>
            {plan && !result && (
              <button
                className="primary"
                disabled={busy || !!error || !plan.files.length}
                onClick={() => void confirm()}
              >
                {request.kind === "move"
                  ? "确认移动并更新引用"
                  : "确认更新引用"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
