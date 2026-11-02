/** Issue-status labels for attachment maintenance.
 *
 * This module deliberately has no imports: the label rule is exercised by an
 * offline node test, and importing the workflow would drag in the Tauri bridge.
 * `resolveAttachmentIssueLabel` receives the already-resolved access message so
 * the i18n lookup stays in the calling module.
 */

const importLabels: Record<string, string> = {
  missing: "找不到来源附件",
  ambiguous: "存在多个同名附件",
  "unsupported-reference-style-rewrite": "此引用格式暂不支持改写",
  "import-partial": "导入中断，可从操作记录恢复",
  "referenced-note-not-selected": "引用的笔记不在本次选择中",
  "material-source-unavailable": "素材记录存在，但来源文件不可用",
  "knowledge-attachment-read-failed": "无法读取来源附件",
  "knowledge-attachment-size-limit": "来源附件超出大小限制",
  "knowledge-path-reparse-forbidden": "来源路径不允许访问",
};

const maintenanceLabels: Record<string, string> = {
  "other-vault-pending": "其他知识库仍有引用，请分别打开处理",
  "external-attachment-not-approved": "外部文件尚未连接，请定位并确认附件",
  "material-resolvable": "可从素材库定位，尚未转换为真实文件引用",
  "attachment-index-pending": "文件已处理，附件索引仍需刷新",
  "knowledge-revision-conflict": "笔记已变化，请重新检查",
  "knowledge-export-capacity": "导出超过单次容量限制，请缩小范围",
  "knowledge-export-write-failed": "导出目标无法写入",
  "knowledge-export-verification-failed": "导出文件校验未通过，请检查目标目录",
  "knowledge-export-destination-not-empty": "导出目标不是空文件夹",
  "knowledge-export-source-overlap": "导出目标不能与原知识库重叠",
  // Introduced by the Linux port. These codes never occurred before it, so no
  // existing display changes by naming them here.
  "knowledge-linux-rollback-unprovable": "回滚未执行，现场已保留",
  "knowledge-linux-fs-unsupported": "文件系统不支持安全回滚，未做修改",
  "knowledge-exclusive-write-unsupported": "该操作在本机暂不可用，未做任何修改",
  "knowledge-operation-partial": "未全部完成，可继续或回滚",
};

/** Codes this port introduced. Only these may be read out of a `code: reason`
 * step status; every pre-existing status keeps exactly the label it had. */
export const linuxPortIssueCodes = new Set([
  "knowledge-linux-rollback-unprovable",
  "knowledge-linux-fs-unsupported",
  "knowledge-exclusive-write-unsupported",
  "knowledge-operation-partial",
]);

const UNRECOGNIZED = "此附件暂未处理，请检查文件位置后重试";

export function resolveAttachmentIssueLabel(status: string, access: string | null = null): string {
  if (access) return access;
  const exact = importLabels[status] || maintenanceLabels[status];
  if (exact) return exact;
  const code = status.split(": ")[0];
  if (code !== status && linuxPortIssueCodes.has(code)) {
    return importLabels[code] || maintenanceLabels[code] || UNRECOGNIZED;
  }
  return UNRECOGNIZED;
}
