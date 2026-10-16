import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDshNativeSurfaceVisibility, resetDshNativeSurfaceInitialOpenSingleFlight,
  runDshNativeSurfaceInitialOpenSingleFlight,
} from "../src/core/services/dshNativeSurface.ts";

test("late hide settlement during cold open cannot report a false startup failure", async () => {
  resetDshNativeSurfaceInitialOpenSingleFlight();
  let finishHide!: () => void;
  let finishOpen!: () => void;
  const hiding = new Promise<void>(resolve => { finishHide = resolve; });
  const opening = new Promise<void>(resolve => { finishOpen = resolve; });
  let opened = false;
  let opens = 0;
  let visible = false;
  const client = {
    async show() {
      if (!opened) throw new Error("dsh-native-surface-not-open");
      visible = true;
    },
    async hide() { await hiding; visible = false; },
  };
  const beforeModal = claimDshNativeSurfaceVisibility();
  const oldHide = beforeModal.hide(Promise.resolve(client));
  await Promise.resolve();
  const afterModal = claimDshNativeSurfaceVisibility();
  await assert.rejects(() => afterModal.show(client, { x: 236, y: 60, width: 820, height: 640 }), /not-open/u);
  const coldOpen = runDshNativeSurfaceInitialOpenSingleFlight(async () => {
    opens += 1;
    await opening;
    opened = true;
    visible = true;
  });
  // Observe the rejection immediately: current page catches it as startup failure.
  const hideSettlement = oldHide.then(value => ({ value }), error => ({ error }));
  finishHide();
  await new Promise(resolve => setImmediate(resolve));
  finishOpen();
  await coldOpen;
  assert.equal(await afterModal.reconcileAfterOneShotOpen(), true);
  assert.deepEqual(await hideSettlement, { value: false });
  assert.equal(opens, 1);
  assert.equal(visible, true);
});

test("a real cold-open failure still rejects and never creates an automatic replacement", async () => {
  resetDshNativeSurfaceInitialOpenSingleFlight();
  let finishHide!: () => void;
  let failOpen!: (error: Error) => void;
  const hiding = new Promise<void>(resolve => { finishHide = resolve; });
  const opening = new Promise<void>((_, reject) => { failOpen = reject; });
  let opens = 0;
  const client = {
    async show() { throw new Error("dsh-native-surface-not-open"); },
    async hide() { await hiding; },
  };
  const old = claimDshNativeSurfaceVisibility();
  const hide = old.hide(Promise.resolve(client));
  await Promise.resolve();
  const latest = claimDshNativeSurfaceVisibility();
  await assert.rejects(() => latest.show(client, { x: 236, y: 60, width: 820, height: 640 }), /not-open/u);
  const cold = runDshNativeSurfaceInitialOpenSingleFlight(() => { opens += 1; return opening; });
  const failedCold = assert.rejects(cold, /dsh-surface-failed/u);
  const failedHide = assert.rejects(hide, /dsh-surface-failed/u);
  finishHide();
  await new Promise(resolve => setImmediate(resolve));
  failOpen(new Error("dsh-surface-failed:surface-ready-timeout"));
  await Promise.all([failedCold, failedHide]);
  await assert.rejects(runDshNativeSurfaceInitialOpenSingleFlight(async () => { opens += 1; }), /dsh-surface-failed/u);
  assert.equal(opens, 1);
  resetDshNativeSurfaceInitialOpenSingleFlight();
  await runDshNativeSurfaceInitialOpenSingleFlight(async () => { opens += 1; });
  assert.equal(opens, 2, "only the explicit Retry reset permits another cold open");
});

test("joining cold open honors a newer final hidden intent and never reports visible", async () => {
  resetDshNativeSurfaceInitialOpenSingleFlight();
  let finishHide!: () => void;
  let finishOpen!: () => void;
  const hiding = new Promise<void>(resolve => { finishHide = resolve; });
  const opening = new Promise<void>(resolve => { finishOpen = resolve; });
  let opened = false;
  let visible = false;
  const client = {
    async show() { if (!opened) throw new Error("dsh-native-surface-not-open"); visible = true; },
    async hide() { await hiding; visible = false; },
  };
  const first = claimDshNativeSurfaceVisibility();
  const lateHide = first.hide(Promise.resolve(client));
  await Promise.resolve();
  const latest = claimDshNativeSurfaceVisibility();
  await assert.rejects(() => latest.show(client, { x: 236, y: 60, width: 820, height: 640 }), /not-open/u);
  const cold = runDshNativeSurfaceInitialOpenSingleFlight(async () => { await opening; opened = true; visible = true; });
  finishHide();
  await new Promise(resolve => setImmediate(resolve));
  // User closes/navigates away while the reconciliation waits on the same open.
  await latest.hide(Promise.resolve(client));
  finishOpen();
  await cold;
  assert.equal(await latest.reconcileAfterOneShotOpen(), false);
  assert.equal(await lateHide, false);
  assert.equal(visible, false);
});

test("real visual validation errors are not interpreted as a pending cold open", async () => {
  resetDshNativeSurfaceInitialOpenSingleFlight();
  const visible = claimDshNativeSurfaceVisibility();
  await assert.rejects(() => visible.show({
    async show() { throw new Error("dsh-native-surface-bounds-invalid"); },
    async hide() {},
  }, { x: 0, y: 0, width: 200, height: 200 }), /bounds-invalid/u);
});
