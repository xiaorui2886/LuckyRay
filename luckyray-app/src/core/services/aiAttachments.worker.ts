import { fileToAiAttachment } from "./aiAttachments";

type WorkerRequest = {
  id: string;
  file: File;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, file } = event.data || {};
  if (!id || !file) return;
  try {
    const attachment = await fileToAiAttachment(file);
    self.postMessage({ id, ok: true, attachment });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
