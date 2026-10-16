import { attachmentErrorMessage } from "../../core/services/vaultAttachmentErrors";
import { useRef, useState } from "react";
import { ensureActiveKnowledgeUiSource } from "../../core/services/knowledge";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import {
  auditAttachmentPortability,
  exportStandaloneVault,
  type AttachmentAudit,
  type AttachmentExportResult,
} from "../../core/services/vaultAttachments";
import { attachmentIssueLabel } from "../../core/services/vaultAttachmentWorkflow";

export function AttachmentPortabilitySection({
  vaultId,
  notePaths,
  saveAffected,
  chooseDirectory,
}: {
  vaultId: string;
  notePaths: string[];
  saveAffected: (paths: string[]) => Promise<void>;
  chooseDirectory: () => Promise<string | null>;
}) {
  const [audit, setAudit] = useState<AttachmentAudit | null>(null);
  const [result, setResult] = useState<AttachmentExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const run = async (exporting: boolean) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const source = readActiveKnowledgeWriteSource();
    const requireCurrent = () => {
      if (
        !source ||
        source.vaultId !== vaultId ||
        source !== readActiveKnowledgeWriteSource()
      )
        throw new Error("知识库已切换，请重新打开设置");
    };
    try {
      requireCurrent();
      if (!exporting) {
        const report = await auditAttachmentPortability(vaultId);
        requireCurrent();
        setAudit(report);
      } else {
        const target = await chooseDirectory();
        requireCurrent();
        if (!target) return;
        await saveAffected(notePaths);
        requireCurrent();
        const active = await ensureActiveKnowledgeUiSource();
        requireCurrent();
        if (active.vaultId !== vaultId)
          throw new Error("知识库已切换，请重新打开设置");
        const exported = await exportStandaloneVault(
          vaultId,
          target,
          active.sourceEpoch,
        );
        requireCurrent();
        setResult(exported);
      }
    } catch (cause) {
      setError(attachmentErrorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const unresolved =
    audit?.entries.filter(
      (entry) =>
        !["resolved", "remote-or-absolute", "self-reference"].includes(
          entry.status,
        ),
    ) || [];
  return (
    <details className="vault-attachment-maintenance attachment-portability">
      <summary>
        盘点与独立导出<span>不修改原知识库</span>
      </summary>
      <p>
        盘点只读取磁盘引用；导出会保存当前草稿，将笔记与原图复制到单独的空文件夹。
      </p>
      <div className="vault-attachment-actions">
        <button disabled={busy} onClick={() => void run(false)}>
          只读盘点附件
        </button>
        <button disabled={busy} onClick={() => void run(true)}>
          导出为独立知识库
        </button>
      </div>
      {busy && <p role="status">正在检查并处理，请稍候…</p>}
      {error && (
        <p className="vault-attachment-error" role="alert">
          {error}
        </p>
      )}
      {audit && (
        <div className="vault-attachment-state">
          <strong>
            已盘点 {audit.documentCount} 篇笔记 · {audit.entries.length} 条引用
          </strong>
          <p>
            库外附件{" "}
            {audit.entries.filter((entry) => entry.scope === "external").length}{" "}
            条 · 待连接 {unresolved.length} 条。可收集{" "}
            {audit.migrationFileCount} 个文件，约{" "}
            {(audit.migrationCopyBytes / 1048576).toFixed(2)} MB。
          </p>
          <p>
            需要迁移旧素材时，请在“附件维护”中选择范围并预览后收集；本次盘点未改写笔记。
          </p>
          {unresolved.length > 0 && (
            <details>
              <summary>查看待连接引用</summary>
              <ul className="vault-attachment-issues">
                {unresolved.map((entry, index) => (
                  <li key={index}>
                    <strong>{attachmentIssueLabel(entry.status)}</strong>
                    <span>
                      {entry.document}:{entry.line} · {entry.target}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {result && (
        <div className="vault-attachment-state" role="status">
          <strong>
            {result.status === "complete"
              ? "独立知识库已导出"
              : "已导出可处理项，部分引用未连接"}
          </strong>
          <p>
            {result.documentCount} 篇笔记 · {result.attachmentCount} 个附件
          </p>
          <p className="attachment-export-path">{result.destination}</p>
          {result.issues.length > 0 && (
            <details>
              <summary>查看 {result.issues.length} 项未完成原因</summary>
              <ul className="vault-attachment-issues">
                {result.issues.map((issue, index) => (
                  <li key={index}>
                    <strong>{attachmentIssueLabel(issue.status)}</strong>
                    <span>
                      {issue.document} · {issue.target}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </details>
  );
}
