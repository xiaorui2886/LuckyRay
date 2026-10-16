import { useState } from "react";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { AttachmentHandlingSelect } from "./AttachmentHandlingSelect";
import "./vaultAttachments.css";

export function AttachmentImportDialog({
  vaultId,
  onCancel,
  onImport,
}: {
  vaultId: string;
  onCancel: () => void;
  onImport: (folder: boolean) => void;
}) {
  const modal = useApplicationModalSurface<HTMLDivElement>(true, onCancel);
  const [ready, setReady] = useState(false);
  return (
    <div
      className="editorial-dialog-backdrop notes-vault-modal-overlay experience-dialog-backdrop"
      onPointerDown={modal.onBackdropPointerDown}
    >
      <div
        ref={modal.surfaceRef}
        className="editorial-dialog experience-dialog notes-vault-dialog attachment-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导入笔记"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={modal.onSurfaceKeyDown}
      >
        <div className="editorial-dialog-head">
          <div className="editorial-dialog-header-row">
            <div className="editorial-dialog-heading">
              <h2>导入笔记</h2>
            </div>
            <button
              type="button"
              className="editorial-dialog-close"
              aria-label="关闭导入"
              onClick={onCancel}
            >
              <span
                className="editorial-dialog-close-icon"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
        <div className="editorial-dialog-body vault-attachment-settings">
          <AttachmentHandlingSelect vaultId={vaultId} onReady={setReady} />
          <p>
            复制笔记文本，自动连接可以确定的本地附件。此选择与知识库设置共用。
          </p>
        </div>
        <div className="editorial-dialog-footer vault-attachment-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => onImport(true)}
          >
            选择文件夹
          </button>
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => onImport(false)}
          >
            选择笔记
          </button>
        </div>
      </div>
    </div>
  );
}
