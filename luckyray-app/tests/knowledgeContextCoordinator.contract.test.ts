import assert from "node:assert/strict";
import test from "node:test";

import { createLatestDrainCoordinator } from "../src/core/services/knowledgeContextCoordinator.ts";

type Deferred = { value: string | null; resolve(): void; reject(error: Error): void };

function deferredRun() {
  const calls: Deferred[] = [];
  let active = 0;
  let maxActive = 0;
  return {
    calls,
    get maxActive() { return maxActive; },
    run(value: string | null) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<void>((resolve, reject) => {
        calls.push({
          value,
          resolve: () => { active -= 1; resolve(); },
          reject: (error) => { active -= 1; reject(error); },
        });
      });
    },
  };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("an in-flight context write drains only the latest set or clear", async () => {
  const runner = deferredRun();
  const coordinator = createLatestDrainCoordinator<string | null>(runner.run);
  const source = coordinator.createSource();

  const first = source.submit("A");
  const superseded = source.submit("B");
  const latest = source.submit(null);
  assert.deepEqual(runner.calls.map((call) => call.value), ["A"]);

  runner.calls[0].resolve();
  await tick();
  assert.deepEqual(runner.calls.map((call) => call.value), ["A", null]);
  runner.calls[1].resolve();
  await Promise.all([first, superseded, latest]);
  assert.equal(runner.maxActive, 1);
});

test("dispose drops queued work and suppresses stale settlement callbacks", async () => {
  const runner = deferredRun();
  const errors: string[] = [];
  const coordinator = createLatestDrainCoordinator<string | null>(runner.run, {
    onError: (error) => errors.push(String(error)),
  });
  const source = coordinator.createSource();

  const first = source.submit("A");
  const queued = source.submit("B");
  source.dispose();
  runner.calls[0].reject(new Error("stale failure"));
  await Promise.all([first, queued]);
  await tick();

  assert.deepEqual(runner.calls.map((call) => call.value), ["A"]);
  assert.deepEqual(errors, []);
  await source.submit("ignored");
  assert.deepEqual(runner.calls.map((call) => call.value), ["A"]);
});

test("a StrictMode replacement source always writes after the retired source", async () => {
  const runner = deferredRun();
  const coordinator = createLatestDrainCoordinator<string | null>(runner.run);
  const oldSource = coordinator.createSource();
  const first = oldSource.submit("old");

  oldSource.dispose(null);
  const currentSource = coordinator.createSource();
  const current = currentSource.submit("current");
  runner.calls[0].resolve();
  await tick();
  assert.deepEqual(runner.calls.map((call) => call.value), ["old", "current"]);
  runner.calls[1].resolve();
  await Promise.all([first, current]);
  assert.equal(runner.maxActive, 1);
});

test("arg-less dispose retires the subscription without clearing Backend context", async () => {
  const runner = deferredRun();
  const coordinator = createLatestDrainCoordinator<string | null>(runner.run);
  const source = coordinator.createSource();

  const pending = source.submit("note-bound");
  runner.calls[0].resolve();
  await tick();
  assert.deepEqual(runner.calls.map((call) => call.value), ["note-bound"]);

  // NotesPage Activity hidden calls dispose() with no final value: the
  // explicitly opened note identity must survive across Notes→AI navigation.
  source.dispose();
  await source.submit("ignored-after-dispose");
  assert.deepEqual(runner.calls.map((call) => call.value), ["note-bound"]);
  assert.deepEqual(
    runner.calls.map((call) => call.value).filter((value) => value === null),
    [],
    "arg-less dispose must not enqueue a clear",
  );

  // Only an explicit clear (close/delete/Vault switch) submits null.
  const explicitClear = coordinator.createSource();
  explicitClear.submit(null);
  await tick();
  assert.deepEqual(runner.calls.map((call) => call.value), ["note-bound", null]);
});

test("flush waits through an in-flight write and the latest trailing context", async () => {
  const runner = deferredRun();
  const coordinator = createLatestDrainCoordinator<string>(runner.run);
  const source = coordinator.createSource();
  void source.submit("note-a");
  void source.submit("note-b");
  const flushed = coordinator.flush();

  runner.calls[0].resolve();
  await tick();
  assert.deepEqual(runner.calls.map((call) => call.value), ["note-a", "note-b"]);
  runner.calls[1].resolve();
  await flushed;
  assert.equal(runner.maxActive, 1);
});
