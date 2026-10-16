import { fileToAiAttachmentWithWorker } from "./aiAttachmentWorker";
import type { AiAttachment } from "./aiAttachments";

const AI_ATTACHMENT_QUEUE_KEY = "luckyray-ai-attachment-queue-v1";
const MAX_PERSISTED_ATTACHMENTS = 8;
const MAX_PERSISTED_DATA_URL_LENGTH = 200_000;
const MAX_PERSISTED_PREVIEW_LENGTH = 6_000;

function storageAvailable() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function sanitizeAttachment(input: AiAttachment): AiAttachment {
  return {
    id: input.id,
    name: input.name,
    type: input.type || "file",
    size: Number.isFinite(input.size) ? input.size : 0,
    previewText: input.previewText ? input.previewText.slice(0, MAX_PERSISTED_PREVIEW_LENGTH) : undefined,
    dataUrl: input.dataUrl && input.dataUrl.length <= MAX_PERSISTED_DATA_URL_LENGTH ? input.dataUrl : undefined,
    parseKind: input.parseKind,
    parseStatus: input.parseStatus || "parsed",
    parseError: input.parseError,
    queuedAt: input.queuedAt || Date.now(),
  };
}

function restoreAttachment(input: AiAttachment): AiAttachment {
  const safe = sanitizeAttachment(input);
  if (safe.parseStatus !== "pending") return safe;
  return {
    ...safe,
    parseStatus: "error",
    parseError: "刷新后无法继续读取原始文件，请重新添加该附件",
  };
}

export function readAiAttachmentQueue(): AiAttachment[] {
  if (!storageAvailable()) return [];
  try {
    const raw = window.localStorage.getItem(AI_ATTACHMENT_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is AiAttachment => Boolean(item?.id && item?.name))
      .map(restoreAttachment)
      .slice(0, MAX_PERSISTED_ATTACHMENTS);
  } catch {
    return [];
  }
}

export function writeAiAttachmentQueue(items: AiAttachment[]) {
  if (!storageAvailable()) return;
  try {
    const safe = items.map(sanitizeAttachment).slice(0, MAX_PERSISTED_ATTACHMENTS);
    if (!safe.length) window.localStorage.removeItem(AI_ATTACHMENT_QUEUE_KEY);
    else window.localStorage.setItem(AI_ATTACHMENT_QUEUE_KEY, JSON.stringify(safe));
  } catch {}
}

export function createPendingAiAttachment(file: File): AiAttachment {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    type: file.type || "file",
    size: file.size,
    parseKind: "metadata",
    parseStatus: "pending",
    queuedAt: Date.now(),
  };
}

export async function parsePendingAiAttachment(file: File, pending: AiAttachment): Promise<AiAttachment> {
  try {
    const parsed = await fileToAiAttachmentWithWorker(file);
    return {
      ...parsed,
      id: pending.id,
      parseStatus: "parsed",
      queuedAt: pending.queuedAt,
    };
  } catch (error) {
    return markAiAttachmentError(pending, error);
  }
}

export function markAiAttachmentError(pending: AiAttachment, error: unknown): AiAttachment {
  return {
    ...pending,
    parseStatus: "error",
    parseKind: "metadata",
    parseError: error instanceof Error ? error.message : String(error || "附件解析失败"),
  };
}
