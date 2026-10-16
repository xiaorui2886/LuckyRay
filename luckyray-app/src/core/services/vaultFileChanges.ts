/** File-system notifications are observations, never permission to rewrite links. */
export type VaultFileObservation = { paths: string[]; type: unknown };
export type VaultFileChangeBatch = {
  vaultId: string;
  rootPath: string;
  session: number;
  generation: number;
  observations: VaultFileObservation[];
  reconcileRequired: boolean;
};

/** Content-only Markdown observations cannot be an attachment move. Unknown,
 * overflow, create/remove/rename and directory events must still reconcile. */
export function markdownContentChanges(batch: VaultFileChangeBatch): string[] | null {
  if (batch.reconcileRequired || !batch.observations.length) return null;
  const paths = new Set<string>();
  for (const observation of batch.observations) {
    const type = observation.type as { modify?: { kind?: string } } | null;
    if (!type?.modify || !["any", "data", "metadata"].includes(type.modify.kind || "")) return null;
    if (!observation.paths.length) return null;
    for (const path of observation.paths) {
      if (!/\.md$/i.test(path)) return null;
      paths.add(path);
    }
  }
  return [...paths];
}

export const VAULT_WATCH_MAX_WAIT_MS = 2000;
const MAX_EVENTS = 256;
const MAX_BYTES = 128 * 1024;

/** Overflow is explicit: consumers must reconcile, never infer a rename from a partial batch. */
export class VaultFileChangeQueue {
  private observations: VaultFileObservation[] = [];
  private bytes = 0;
  private reconcileRequired = false;
  private firstAt: number | null = null;

  add(event: VaultFileObservation | null, now: number) {
    this.firstAt ??= now;
    if (!event) { this.reconcileRequired = true; return; }
    // Copy only bounded, serializable event data; provider-owned arrays must not mutate a batch.
    let type: unknown;
    let encoded: string;
    try { encoded = JSON.stringify(event.type) || 'null'; type = JSON.parse(encoded); }
    catch { this.reconcileRequired = true; return; }
    const bytes = encoded.length * 2 + event.paths.reduce((sum, path) => sum + path.length * 2, 0);
    if (this.observations.length >= MAX_EVENTS || this.bytes + bytes > MAX_BYTES) {
      this.reconcileRequired = true;
      return;
    }
    this.bytes += bytes;
    this.observations.push({ paths: [...event.paths], type });
  }

  delay(now: number, quietMs = 720) {
    return Math.max(0, Math.min(quietMs, VAULT_WATCH_MAX_WAIT_MS - (now - (this.firstAt ?? now))));
  }

  drain(): Pick<VaultFileChangeBatch, 'observations' | 'reconcileRequired'> {
    const result = { observations: this.observations, reconcileRequired: this.reconcileRequired };
    this.observations = [];
    this.bytes = 0;
    this.firstAt = null;
    this.reconcileRequired = false;
    return result;
  }
}
