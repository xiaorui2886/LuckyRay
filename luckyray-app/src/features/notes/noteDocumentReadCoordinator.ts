type Hydration = { noteId: string; settled: Promise<void>; finish(): void };

/** Owns temporary hydration and drains observed external changes without polling. */
export class NoteDocumentReadCoordinator {
  private hydration: Hydration | null = null;
  private pending: (() => Promise<void>) | null = null;
  private running: Promise<void> | null = null;

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
    this.clearHydration();
  }
}
