import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeStore } from '../src/core/services/knowledgeStore.ts';

test('fallback focus and periodic reconciliation do not invent attachment changes', async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const events = new Map<string, () => void>();
  let tick: () => void = () => {};
  const calls: string[] = [];
  let store: KnowledgeStore | undefined;
  try {
    const eventTarget = {
      addEventListener: (name: string, callback: () => void) => events.set(name, callback),
      removeEventListener: () => {},
    };
    Object.assign(globalThis, {
      window: { ...eventTarget, __TAURI_INTERNALS__: { invoke: async () => undefined } },
      document: { ...eventTarget, hidden: false },
      setInterval: (callback: () => void) => { tick = callback; return 1; },
      clearInterval: () => {},
    });
    store = new KnowledgeStore();
    // Exercise the actual fallback scheduler without waiting 30 seconds.
    const internal = store as any;
    internal.snapshot = { ...store.getSnapshot(), vault: { id: 'fixture-vault' } };
    internal.invalidate = async ({ reason }: { reason: string }) => {
      calls.push(reason);
      return store!.getSnapshot();
    };
    internal.startWatchFallback();
    tick();
    events.get('focus')!();
    events.get('visibilitychange')!();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(internal.fileChanges.drain(), {
      observations: [],
      reconcileRequired: false,
    }, 'a timer/focus is not evidence that every attachment changed');
    assert.equal(calls.length, 3);
  } finally {
    (store as any)?.stopVaultWatch();
    Object.assign(globalThis, previous);
  }
});
