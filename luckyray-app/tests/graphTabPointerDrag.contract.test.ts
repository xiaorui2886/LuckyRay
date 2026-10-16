import assert from 'node:assert/strict';
import test from 'node:test';
import { beginGraphTabPointerDrag } from '../src/features/graph/graphTabPointerDrag.ts';
import { graphSessionStore } from '../src/features/graph/graphSessionStore.ts';

/** A minimal DOM event boundary, not a substitute for the browser fixture. */
test('held Escape cancellation suppresses only that graph-tab pointer activation until release', async () => {
  const old = new Map(['window', 'document', 'HTMLElement', 'Element', 'Node'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class FakeElement extends EventTarget {
    style = {}; className = ''; textContent = ''; captures = new Set<number>();
    closest() { return null; }
    contains(node: unknown) { return node === this; }
    setPointerCapture(id: number) { this.captures.add(id); }
    hasPointerCapture(id: number) { return this.captures.has(id); }
    releasePointerCapture(id: number) { this.captures.delete(id); }
    remove() {}
  }
  class BrowserEventTarget extends EventTarget {
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
      super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options);
    }
  }
  const windowTarget = Object.assign(new BrowserEventTarget(), { setTimeout, clearTimeout });
  const classes = new Set<string>();
  const fakeDocument = { elementFromPoint: () => null, createElement: () => new FakeElement(), body: { append() {} }, documentElement: { classList: { add: (key: string) => classes.add(key), remove: (key: string) => classes.delete(key) } } };
  const replace = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, value });
  replace('window', windowTarget); replace('document', fakeDocument);
  for (const key of ['HTMLElement', 'Element', 'Node']) replace(key, FakeElement);
  const emit = (type: string, values: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
    windowTarget.dispatchEvent(event); return event;
  };
  const restore = graphSessionStore.checkpoint();
  try {
    const second = graphSessionStore.add();
    const source = new FakeElement();
    const before = graphSessionStore.getSnapshot();
    beginGraphTabPointerDrag({ button: 0, pointerId: 7, clientX: 10, clientY: 10, currentTarget: source, target: source, preventDefault() {}, stopPropagation() {} }, { tabId: 'graph-1', title: 'Graph' });
    emit('pointermove', { pointerId: 7, clientX: 120, clientY: 90 });
    assert.equal(classes.has('graph-tab-dragging'), true);
    emit('keydown', { key: 'Escape' });
    assert.equal(classes.has('graph-tab-dragging'), false);
    await new Promise(resolve => setTimeout(resolve, 15)); // pointer deliberately still down
    emit('pointerup', { pointerId: 7, clientX: 10, clientY: 10 });
    const cancelledClick = emit('click', { detail: 1, target: source });
    assert.equal(cancelledClick.defaultPrevented, true);
    assert.equal(graphSessionStore.getSnapshot(), before);
    assert.equal(graphSessionStore.getSnapshot().activeTabId, second);
    await new Promise(resolve => setTimeout(resolve, 1));
    emit('pointerdown', { pointerId: 8 });
    assert.equal(emit('click', { detail: 1, target: source }).defaultPrevented, false, 'fresh physical click remains usable');
    assert.equal(emit('click', { detail: 0, target: source }).defaultPrevented, false, 'keyboard activation remains usable');
  } finally {
    await restore();
    for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  }
});
