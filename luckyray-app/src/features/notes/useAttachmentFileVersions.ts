import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { materialStore } from "../../core/services/materialStore";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import {
  createAttachmentVersionPoller,
  type AttachmentFileVersion,
} from "../../core/services/vaultAttachmentVersions";
export function useAttachmentFileVersions(
  vaultId: string | undefined,
  recheck: () => void,
) {
  const source = readActiveKnowledgeWriteSource();
  useEffect(() => {
    if (!vaultId || !source || source.vaultId !== vaultId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poller = createAttachmentVersionPoller({
      source,
      current: readActiveKnowledgeWriteSource,
      read: () =>
        invoke<{ versions: AttachmentFileVersion[] }>(
          "knowledge_attachment_versions",
          { vaultId },
        ),
      changed: () => {
        recheck();
        void materialStore.invalidate({
          reason: "registered-attachment-version-change",
        });
      },
    });
    const tick = async () => {
      try {
        await poller.poll();
      } catch {
        /* Keep the last successful versions; retry a temporary read failure. */
      }
      if (!stopped) timer = setTimeout(() => void tick(), 7500);
    };
    void tick();
    return () => {
      stopped = true;
      poller.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [vaultId, source, recheck]);
}
