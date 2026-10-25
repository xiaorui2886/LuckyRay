type Hydration = { noteId: string; settled: Promise<void>; finish(): void };

/** Owns temporary hydration and drains observed external changes without polling. */
export class NoteDocumentReadCoordinator {
  private hydration: Hydration | null = null;
  private pending: (() => Promise<void>) | null = null;
  private running: Promise<void> | null = null;
  private composingNoteId: string | null = null;
  private deferredCompositionRead = false;
  private focusedNoteId: string | null = null;
  private deferredFocusRead = false;

  setFocused(noteId: string, focused: boolean) {
    if (focused) {
      if (this.focusedNoteId !== noteId) this.deferredFocusRead = false;
      this.focusedNoteId = noteId;
    } else if (this.focusedNoteId === noteId) {
      this.focusedNoteId = null;
      const deferred = this.deferredFocusRead;
      this.deferredFocusRead = false;
      return deferred;
    }
    return false;
  }

  deferIfFocused(noteId: string) {
    if (this.focusedNoteId !== noteId) return false;
    this.deferredFocusRead = true;
    return true;
  }

  setComposing(noteId: string, composing: boolean) {
    if (composing) {
      if (this.composingNoteId !== noteId) this.deferredCompositionRead = false;
      this.composingNoteId = noteId;
    } else if (this.composingNoteId === noteId) {
      this.composingNoteId = null;
      const deferred = this.deferredCompositionRead;
      this.deferredCompositionRead = false;
      return deferred;
    }
    return false;
  }

  deferIfComposing(noteId: string) {
    if (this.composingNoteId !== noteId) return false;
    this.deferredCompositionRead = true;
    return true;
  }

  isHydrating(noteId: string | null) {
    return noteId !== null && this.hydration?.noteId === noteId;
  }

  beginHydration(noteId: string) {
    this.clearHydration();
    let resolve!: () => void;
    const hydration: Hydration = {
      noteId,
      settled: new Promise<void>((done) => { resolve = done; }),
      finish: () => {
        // A superseded read or delayed animation frame cannot release a newer read.
        if (this.hydration === hydration) this.hydration = null;
        resolve();
      },
    };
    this.hydration = hydration;
    return hydration.finish;
  }

  clearHydration() {
    this.hydration?.finish();
  }

  requestExternalCheck(check: () => Promise<void>) {
    this.pending = check;
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        try {
          while (this.pending) {
            // Hydration releases on success, failure, cancellation, or navigation.
            // A later notification replaces only queued work, never the active read.
            while (this.hydration) await this.hydration.settled;
            const next = this.pending;
            this.pending = null;
            if (next) await next();
          }
        } finally {
          this.running = null;
        }
      });
    }
    return this.running;
  }

  cancelPending() {
    this.pending = null;
    this.composingNoteId = null;
    this.deferredCompositionRead = false;
    this.focusedNoteId = null;
    this.deferredFocusRead = false;
    this.clearHydration();
  }
}
