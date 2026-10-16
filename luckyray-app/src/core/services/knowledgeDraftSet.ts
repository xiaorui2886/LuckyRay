import { invoke, isTauri } from "@tauri-apps/api/core";
import { parseKnowledgeDocumentNoteId, ensureActiveKnowledgeUiSource } from "./knowledge";
import { readActiveKnowledgeWriteSource } from "./knowledgeSource";

let generation = 0;

/** Same draft membership used by NotesPage; notify only clean/dirty transitions,
 * never each keystroke. Native generations discard reordered IPC responses. */
export class KnowledgeDraftSet extends Set<string> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private report() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!isTauri()) return;
    const source = readActiveKnowledgeWriteSource();
    if (!source) return;
    const paths = Array.from(this, parseKnowledgeDocumentNoteId)
      .filter(ref => ref?.vaultId === source.vaultId).map(ref => ref!.relativePath);
    const currentGeneration = ++generation;
    void ensureActiveKnowledgeUiSource().then(activation => {
      if (readActiveKnowledgeWriteSource() !== source) return;
      return invoke("knowledge_companion_desktop_drafts", { sourceEpoch: activation.sourceEpoch, generation: currentGeneration, paths });
    }).catch(() => {
      // The existing editor keeps the draft and expectedRevision after IPC
      // failures; this notification never acknowledges or clears editor data.
      // Retry the current membership so a lost clean transition cannot leave
      // DESKTOP_DRAFT_BUSY stuck until somebody types in another note.
      if (currentGeneration !== generation || readActiveKnowledgeWriteSource() !== source) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (currentGeneration === generation && readActiveKnowledgeWriteSource() === source) this.report();
      }, 2000);
    });
  }
  add(id: string): this { const changed = !this.has(id); super.add(id); if (changed) this.report(); return this; }
  delete(id: string): boolean { const changed = super.delete(id); if (changed) this.report(); return changed; }
  clear(): void { const changed = this.size > 0; super.clear(); if (changed) this.report(); }
}
