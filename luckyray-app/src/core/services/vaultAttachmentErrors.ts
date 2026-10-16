import { normalizeLocale, translate, type Locale } from "../i18n/index";
import { normalizeKnowledgeError } from "./knowledge";

export function attachmentAccessMessage(status: string | undefined, locale?: Locale): string | null {
  if (status !== "external-unregistered" && status !== "external-attachment-not-approved") return null;
  return translate(locale || normalizeLocale(typeof document === "undefined" ? null : document.documentElement.lang), "editor.notes.attachment.externalUnregistered");
}

export function attachmentErrorMessage(cause: unknown, locale?: Locale) {
  let structured = cause;
  if (typeof cause === "string") { try { structured = JSON.parse(cause); } catch { /* Plain errors retain the existing normalization. */ } }
  const rawCode = structured && typeof structured === "object" && "code" in structured && typeof structured.code === "string" ? structured.code : undefined;
  const error = normalizeKnowledgeError(cause);
  const accessMessage = attachmentAccessMessage(rawCode || error.code, locale);
  if (accessMessage) return accessMessage;
  const messages: Record<string, string> = {
    "knowledge-export-destination-not-empty": "请选择空文件夹，导出不会覆盖现有文件。",
    "knowledge-export-source-overlap": "请选择原知识库之外的独立文件夹。",
    "knowledge-export-capacity": "当前知识库超过单次导出容量，请缩小范围后再导出。",
    "knowledge-export-invalid-destination": "导出目录不可用，请重新选择可访问的文件夹。",
    "knowledge-export-write-failed": "无法写入导出目录，请检查目录可用空间和写入权限。",
    "material-in-use-by-notes": "文件仍被已登记笔记引用，请先检查引用范围。",
  };
  if (messages[error.code]) return messages[error.code];
  if (
    error.code === "knowledge-vault-unavailable" ||
    error.code === "knowledge-attachment-parent-unavailable"
  )
    return "暂时无法访问知识库目录。请确认目录可访问后重新检查；待处理的附件变化已保留。";
  if (error.code === "knowledge-revision-conflict")
    return "笔记已发生变化，请重新检查影响范围后再更新。";
  if (error.code === "knowledge-attachment-witness-expired")
    return "附件身份记录已失效，未自动修改引用。请重新检查附件位置。";
  if (
    error.code === "knowledge-source-inactive" ||
    error.code === "knowledge-target-not-current"
  )
    return "知识库会话已变化，请在当前知识库重新检查。";
  if (
    /[\u4e00-\u9fff]/.test(error.message) &&
    !error.message.trim().startsWith("{")
  )
    return error.message;
  return "附件操作未完成。待处理变化已保留，请重新检查后再试。";
}
