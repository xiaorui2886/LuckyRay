import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeStore } from "../src/core/services/knowledgeStore.ts";
import { materialLibrarySession } from "../src/core/services/materialLibraryContext.ts";

test("workspace-consumed stores stay callable when React detaches subscribe/getSnapshot", () => {
  for (const store of [knowledgeStore, materialLibrarySession]) {
    // useSyncExternalStore receives the methods as bare references, so they must
    // not depend on a `this` receiver still being attached at call time.
    const subscribe = store.subscribe;
    const getSnapshot = store.getSnapshot;
    const snapshot = getSnapshot();
    const unsubscribe = subscribe(() => {});
    assert.equal(typeof unsubscribe, "function");
    assert.ok(typeof snapshot === "object" && snapshot !== null);
    unsubscribe();
  }
});
