/** Bounded local CPU timings; never GPU/display latency or FPS. */
export class DirectorPerformance {
  private samples: { queueMs: number; renderSubmitMs: number; shadowUpdated: boolean }[] = [];
  readonly counts = { renders: 0, resizes: 0, sceneSyncs: 0, shadowUpdates: 0 };
  record(queueMs: number, renderSubmitMs: number, shadowUpdated: boolean) {
    this.counts.renders++; if (shadowUpdated) this.counts.shadowUpdates++;
    this.samples.push({ queueMs: Math.max(0, queueMs), renderSubmitMs: Math.max(0, renderSubmitMs), shadowUpdated });
    if (this.samples.length > 120) this.samples.shift();
  }
  snapshot() { return { counts: { ...this.counts }, samples: this.samples.map(sample => ({ ...sample })), limit: 120, measurement: 'CPU render submission and invalidation-to-rAF only; not GPU time, FPS, or input-to-display latency' }; }
}
