// Watch resource lifecycle only. Catalog remains the sole import/save authority.
export type RootEvent = { paths: string[]; rescan?: boolean; detectedAt?: number; error?: string };
type Subscription = { root: string; stop?: () => Promise<void>; alive: boolean };
export type RootWatchAdapter = (id: string, root: string, receive: (event: RootEvent) => void) => Promise<() => Promise<void>>;
export class MaterialRootEvents {
  private subscriptions = new Map<string, Subscription>();
  constructor(private watch: RootWatchAdapter,
    private receive: (id: string, event: RootEvent) => void,
    private failure: (id: string, error: unknown) => void) {}
  sync(roots: { id: string; root: string }[]) {
    const desired = new Map(roots.map(item => [item.id, item.root]));
    for (const [id, subscription] of this.subscriptions) {
      if (desired.get(id) !== subscription.root) {
        subscription.alive = false; this.subscriptions.delete(id);
        void subscription.stop?.().catch(error => this.failure(id, error));
      }
    }
    for (const { id, root } of roots) {
      if (this.subscriptions.has(id)) continue;
      const subscription: Subscription = { root, alive: true };
      this.subscriptions.set(id, subscription);
      void this.watch(id, root, event => {
        if (subscription.alive && this.subscriptions.get(id) === subscription) this.receive(id, event);
      }).then(stop => {
        subscription.stop = stop;
        if (!subscription.alive) void stop().catch(error => this.failure(id, error));
        else this.receive(id, { paths: [], rescan: true }); // Attach before initial reconciliation.
      }).catch(error => {
        // Keep the failed entry until config changes; do not create a retry storm.
        if (subscription.alive) this.failure(id, error);
      });
    }
  }
  stop() { this.sync([]); }
}

export class RootEventBatch {
  private pending = new Map<string, Set<string> | null>();
  add(id: string, paths: string[] | null) {
    if (paths === null) this.pending.set(id, null);
    else if (this.pending.get(id) !== null) {
      const entries = this.pending.get(id) || new Set<string>();
      for (const path of paths) entries.add(path);
      // Bounded memory: overflow becomes one low-level reconciliation, not dropped work.
      this.pending.set(id, entries.size > 4096 ? null : entries);
    }
  }
  remove(id: string) { this.pending.delete(id); }
  clear() { this.pending.clear(); }
  drain() { const result = this.pending; this.pending = new Map(); return result; }
}
