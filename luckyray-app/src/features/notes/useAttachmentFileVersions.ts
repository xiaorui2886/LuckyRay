import { useEffect, useRef } from "react";
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
  visible = true,
) {
  const source = readActiveKnowledgeWriteSource();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const resumeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!vaultId || !source || source.vaultId !== vaultId) return;
    let stopped = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => !stopped && visibleRef.current && document.visibilityState !== "hidden";
    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
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
      if (!active() || polling) return;
      polling = true;
      clearTimer();
      try {
        await poller.poll();
      } catch {
        /* Keep the last successful versions; retry a temporary read failure. */
      } finally {
        polling = false;
      }
      if (active()) timer = setTimeout(() => void tick(), 7500);
    };
    const resume = () => {
      clearTimer();
      if (active()) void tick();
    };
    resumeRef.current = resume;
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      stopped = true;
      poller.dispose();
      clearTimer();
      resumeRef.current = null;
      document.removeEventListener("visibilitychange", resume);
    };
  }, [vaultId, source, recheck]);
  // Keep the poller's baseline across route changes so changes made while
  // notes were hidden are still noticed on the first check after returning.
  useEffect(() => { resumeRef.current?.(); }, [visible]);
}
