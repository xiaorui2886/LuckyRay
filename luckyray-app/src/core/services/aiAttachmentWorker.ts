import { fileToAiAttachment } from "./aiAttachments";
import type { AiAttachment } from "./aiAttachments";

type WorkerResponse = {
  id: string;
  ok: boolean;
  attachment?: AiAttachment;
  error?: string;
};

const ATTACHMENT_WORKER_TIMEOUT_MS = 20_000;

let attachmentWorker: Worker | null = null;

function getAttachmentWorker(): Worker {
  if (!attachmentWorker) {
    attachmentWorker = new Worker(new URL("./aiAttachments.worker.ts", import.meta.url), { type: "module" });
    attachmentWorker.addEventListener("error", () => {
      attachmentWorker?.terminate();
      attachmentWorker = null;
    });
  }
  return attachmentWorker;
}

function shouldUseWorker(file: File): boolean {
  if (typeof Worker === "undefined") return false;
  const lower = file.name.toLowerCase();
  if (file.type.startsWith("audio/") || file.type.startsWith("video/")) return false;
  if (/\.(mp3|wav|ogg|flac|m4a|mp4|mov|webm|mkv)$/i.test(lower)) return false;
  return true;
}

function parseFileWithWorker(file: File): Promise<AiAttachment> {
  const worker = getAttachmentWorker();
  const id = `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("attachment worker timeout"));
    }, ATTACHMENT_WORKER_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
    };
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response?.id !== id) return;
      cleanup();
      if (response.ok && response.attachment) {
        resolve(response.attachment);
      } else {
        reject(new Error(response?.error || "attachment worker failed"));
      }
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, file });
  });
}

export async function fileToAiAttachmentWithWorker(file: File): Promise<AiAttachment> {
  if (!shouldUseWorker(file)) return fileToAiAttachment(file);
  try {
    return await parseFileWithWorker(file);
  } catch {
    return fileToAiAttachment(file);
  }
}

export async function filesToAiAttachmentsWithWorker(files: FileList | File[]): Promise<AiAttachment[]> {
  const fileArray = Array.from(files);
  return Promise.all(fileArray.map(fileToAiAttachmentWithWorker));
}
