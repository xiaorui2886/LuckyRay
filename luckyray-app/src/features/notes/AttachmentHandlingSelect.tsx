import { attachmentErrorMessage } from "../../core/services/vaultAttachmentErrors";
import { useEffect, useState } from "react";
import { ensureActiveKnowledgeUiSource } from "../../core/services/knowledge";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import {
  getAttachmentHandlingPolicy,
  setAttachmentHandlingPolicy,
  type AttachmentHandlingPolicy,
} from "../../core/services/vaultAttachments";

/** The same persisted Vault preference is used by import, insertion and settings. */
export function AttachmentHandlingSelect({
  vaultId,
  disabled = false,
  onReady,
}: {
  vaultId: string;
  disabled?: boolean;
  onReady?: (ready: boolean) => void;
}) {
  const [policy, setPolicy] = useState<AttachmentHandlingPolicy | null>(null);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    onReady?.(policy !== null && !saving && !error);
  }, [policy, saving, error, onReady]);
  useEffect(() => {
    let active = true;
    setPolicy(null);
    setError("");
    void getAttachmentHandlingPolicy(vaultId)
      .then((value) => {
        if (active) setPolicy(value);
      })
      .catch((cause) => {
        if (active) setError(attachmentErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [vaultId, reload]);
  const change = async (next: AttachmentHandlingPolicy) => {
    const source = readActiveKnowledgeWriteSource();
    setSaving(true);
    setError("");
    try {
      const context = await ensureActiveKnowledgeUiSource();
      if (
        context.vaultId !== vaultId ||
        source !== readActiveKnowledgeWriteSource()
      )
        throw new Error("知识库已切换，请重新打开");
      const saved = await setAttachmentHandlingPolicy(
        vaultId,
        context.sourceEpoch,
        next,
      );
      if (source === readActiveKnowledgeWriteSource()) setPolicy(saved);
    } catch (cause) {
      setError(attachmentErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="attachment-handling-control">
      <label className="vault-attachment-rule">
        <span>外部文件插入方式</span>
        <select
          aria-label="外部文件插入方式"
          value={policy || "reference"}
          disabled={disabled || saving || policy === null}
          onChange={(event) =>
            void change(event.target.value as AttachmentHandlingPolicy)
          }
        >
          <option value="reference">沿用原位置</option>
          <option value="copy">复制到知识库</option>
        </select>
      </label>
      <p>
        {policy === "copy"
          ? "附件随知识库一起携带。已有笔记的引用保持原样。"
          : "引用原文件，节省副本；移动知识库时可导出为独立知识库。"}{" "}
        截图会自动保存。
      </p>
      {error && (
        <div role="alert">
          <p className="vault-attachment-error">{error}</p>
          <button
            type="button"
            disabled={saving}
            onClick={() => setReload((value) => value + 1)}
          >
            重试读取设置
          </button>
        </div>
      )}
    </div>
  );
}
