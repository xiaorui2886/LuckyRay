import { useEffect, useRef } from "react";
import "../../components/experienceLayer.css";
import "./importResultNotice.css";
import type { ImportReceipt } from "../../core/services/vaultAttachmentWorkflow";
import { normalizeKnowledgeError } from "../../core/services/knowledge";

export function importIssueMessage(issue: ImportReceipt["errors"][number]) {
  const cause = normalizeKnowledgeError(issue.message);
  const code = issue.code === "import-incomplete" ? cause.code : issue.code;
  const known: Record<string, string> = {
    "source-inventory-incomplete":
      "来源目录无法完整检查，不能确认同名附件唯一；该引用已保留原文。",
    "knowledge-path-reparse-forbidden":
      "引用经过链接目录，无法安全读取；来源文件未修改。",
    "knowledge-import-source-missing": "找不到来源目录，请确认文件仍在原位置。",
    "knowledge-source-inactive": "知识库已切换，本次导入未继续。",
    missing: "找不到引用的附件，该引用已保留原文。",
    ambiguous: "存在多个同名附件，未猜选文件；该引用已保留原文。",
    "outside-vault": "附件路径超出本次来源范围，该引用已保留原文。",
    "referenced-note-not-selected":
      "引用的另一篇笔记不在本次选择中，已保留原引用。",
    "unsupported-reference-style-rewrite":
      "该引用格式暂不支持改写，已保留原文。",
    "import-partial": "导入中途未完成，已写入的部分保留，可从操作记录恢复。",
    "import-readback-failed": "导入后的笔记尚未读取成功，未计入成功数量。",
    "import-readback-changed": "导入后的笔记内容发生变化，未计入成功数量。",
  };
  if (known[code]) return known[code];
  if (
    /[\u4e00-\u9fff]/.test(cause.message) &&
    !cause.message.trim().startsWith("{")
  )
    return cause.message;
  return "这项导入未完成，来源文件保留。";
}

export function summarizeImport(receipt: ImportReceipt) {
  const groups = new Map<string, { message: string; names: Set<string> }>();
  const images = new Set<string>();
  for (const issue of receipt.errors) {
    const message = importIssueMessage(issue);
    const target = issue.sourcePath.split(/[?#]/)[0];
    const name = issue.sourcePath.split(/[\\/]/).pop() || "来源项目";
    if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(target))
      images.add(target);
    const group = groups.get(message) || { message, names: new Set<string>() };
    group.names.add(name);
    groups.set(message, group);
  }
  let summary =
    receipt.copiedCount === 1
      ? "笔记已导入"
      : `已导入 ${receipt.copiedCount} 篇笔记`;
  if (!receipt.copiedCount) summary = "笔记未导入";
  if (images.size) summary += `，${images.size} 张图片未导入`;
  else if (receipt.errors.length) summary += "，部分项目需要处理";
  if (receipt.failedCount) summary += `，${receipt.failedCount} 篇未完成`;
  if (receipt.skippedCount) summary += `，跳过 ${receipt.skippedCount} 篇`;
  return { summary, groups: [...groups.values()] };
}

export function ImportResultNotice({
  receipt,
  onClose,
}: {
  receipt: ImportReceipt;
  onClose: () => void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (receipt.errors.length || receipt.failedCount || receipt.skippedCount)
      return;
    const timer = window.setTimeout(() => close.current(), 4000);
    return () => window.clearTimeout(timer);
  }, [receipt]);
  const { summary, groups } = summarizeImport(receipt);
  return (
    <div
      className={`experience-toast notes-import-toast${groups.length || receipt.failedCount || receipt.skippedCount ? "" : " experience-toast--success"}`}
      role="status"
      aria-live="polite"
    >
      <div className="notes-import-toast-content">
        <div className="notes-import-toast-heading">
          <span>{summary}</span>
          <button type="button" onClick={onClose} aria-label="关闭导入提示">
            ×
          </button>
        </div>
        {receipt.conflictRenamedCount > 0 && (
          <small>同名笔记已另存，原文件保留。</small>
        )}
        {groups.length > 0 && (
          <details>
            <summary>查看详情</summary>
            <div className="notes-import-toast-details">
              {groups.map((group) => (
                <div key={group.message}>
                  <p>{group.message}</p>
                  <ul>
                    {[...group.names].map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
