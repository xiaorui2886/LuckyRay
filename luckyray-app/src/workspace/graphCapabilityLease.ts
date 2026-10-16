import type { GraphMainAction } from './nativeGraphMainProtocol';
export type GraphCapabilitySnapshot = { kinds: GraphMainAction['kind'][]; expiresInMs: number };
export type GraphCapabilityClock = { now: () => number; set: (callback: () => void, delay: number) => unknown; clear: (timer: unknown) => void };
const clock: GraphCapabilityClock = { now: () => performance.now(), set: (callback, delay) => { const timer = setTimeout(callback, delay); (timer as unknown as { unref?: () => void }).unref?.(); return timer; }, clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
const known = new Set(['openDocument', 'createMissing', 'openTag', 'openCatalogAsset', 'composeAi', 'fileOperation', 'screenshot']);
/** A service mount lease never changes loaded graph tickets or scene identity. */
export function createGraphCapabilityLease(read: () => Promise<GraphCapabilitySnapshot>, timers: GraphCapabilityClock = clock) {
  let active = true, sequence = 0, expires = 0, kinds = new Set<GraphMainAction['kind']>(), timer: unknown;
  let published = '';
  const listeners = new Set<() => void>();
  const current = () => active && timers.now() < expires ? kinds : new Set<GraphMainAction['kind']>();
  const emit = () => { const key = [...current()].sort().join(','); if (key === published) return; published = key; for (const listener of listeners) listener(); };
  const revoke = () => { expires = 0; kinds = new Set(); timers.clear(timer); timer = undefined; emit(); };
  return {
    has: (kind: GraphMainAction['kind']) => current().has(kind),
    current: () => [...current()],
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async refresh() {
      if (!active) throw Error('workspace-graph-capabilities-closed');
      const request = ++sequence, started = timers.now();
      try {
        const snapshot = await read();
        if (!active || request !== sequence) return;
        if (!snapshot || !Array.isArray(snapshot.kinds) || snapshot.kinds.length > known.size || new Set(snapshot.kinds).size !== snapshot.kinds.length
          || snapshot.kinds.some(kind => !known.has(kind)) || !Number.isFinite(snapshot.expiresInMs) || snapshot.expiresInMs < 0 || snapshot.expiresInMs > 30000) throw Error('workspace-graph-capabilities-invalid');
        timers.clear(timer); timer = undefined;
        // Count latency against the server TTL. Receiving an old reply cannot
        // extend the mounted Main handler beyond its verified lifetime.
        expires = started + snapshot.expiresInMs;
        kinds = new Set(snapshot.kinds);
        if (expires <= timers.now()) { revoke(); return; }
        timer = timers.set(() => { if (active) { revoke(); } }, Math.max(0, expires - timers.now()));
        emit();
      } catch (error) { if (active && request === sequence) revoke(); throw error; }
    },
    dispose() { if (!active) return; active = false; sequence++; revoke(); listeners.clear(); },
  };
}
