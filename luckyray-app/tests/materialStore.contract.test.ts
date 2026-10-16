import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function freshMaterialStore(name: string, bridge?: object) {
  const windowTarget = Object.assign(new EventTarget(), { __LUCKYRAY__: bridge });
  Object.assign(globalThis, { window: windowTarget });
  const moduleUrl = new URL(`../src/core/services/materialStore.ts?case=${name}`, import.meta.url);
  return (await import(moduleUrl.href)).materialStore;
}

test("a database-ready marker published before retain recovers the cold materials route", async () => {
  const store = await freshMaterialStore("ready-before-listener");
  await store.ensureSnapshot({ reason: "cold-materials-route" });
  assert.equal(store.getSnapshot().status, "error");

  let folderCalls = 0;
  const windowWithBridge = globalThis.window as unknown as {
    __LUCKYRAY__?: object;
    __LUCKYRAY_BRIDGE_READINESS__?: { generation: number; bridgeInstalled: boolean; databaseReady: boolean };
  };
  windowWithBridge.__LUCKYRAY__ = {
    listAssets: async () => [{ id: "cold-asset", name: "Cold asset" }],
    listAssetsFiltered: async () => [],
    listFolders: async () => {
      folderCalls += 1;
      return [{ id: "cold-folder", name: "Cold folder", parentId: null, open: true, children: [] }];
    },
    getMaterialChangeState: async () => ({
      version: 1,
      reason: "database-ready",
      affectedIds: [],
      foldersChanged: true,
      occurredAt: "2026-07-14T00:00:00Z",
    }),
  };
  windowWithBridge.__LUCKYRAY_BRIDGE_READINESS__ = {
    generation: 1,
    bridgeInstalled: true,
    databaseReady: true,
  };
  (globalThis.window as unknown as EventTarget).dispatchEvent(new Event("luckyray:bridge-ready"));

  const release = store.retainChangeProtocol();
  await waitFor(() => store.getSnapshot().status === "ready", "level-triggered readiness did not recover the cold route");
  assert.equal(store.getSnapshot().folders[0]?.id, "cold-folder");
  assert.equal(folderCalls, 1);
  (globalThis.window as unknown as EventTarget).dispatchEvent(new Event("luckyray:bridge-ready"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(folderCalls, 1);
  release();
});

test("browser preview loads folders without a Tauri database readiness marker", async () => {
  let folderCalls = 0;
  const store = await freshMaterialStore("browser-preview", {
    listAssets: async () => [],
    listAssetsFiltered: async () => [],
    listFolders: async () => {
      folderCalls += 1;
      return [{ id: "preview-folder", name: "Preview", parentId: null, open: true, children: [] }];
    },
    getMaterialChangeState: async () => null,
  });
  const release = store.retainChangeProtocol();
  await store.ensureSnapshot({ reason: "browser-preview-route" });
  assert.equal(store.getSnapshot().status, "ready");
  assert.equal(store.getSnapshot().folders[0]?.id, "preview-folder");
  assert.equal(folderCalls, 1);
  release();
});

test("a cold materials snapshot recovers exactly once when the bridge becomes ready", async () => {
  const store = await freshMaterialStore("cold-bridge-ready");
  const releaseFirst = store.retainChangeProtocol();
  const releaseStrictModeReplay = store.retainChangeProtocol();

  await store.ensureSnapshot({ reason: "cold-materials-route" });
  assert.equal(store.getSnapshot().loaded, false);
  assert.equal(store.getSnapshot().status, "error");

  let listAssetsCalls = 0;
  let listFoldersCalls = 0;
  let folders = [{ id: "cold-folder", name: "Cold folder", parentId: null, open: true, children: [] }];
  (globalThis.window as unknown as { __LUCKYRAY__?: object }).__LUCKYRAY__ = {
    listAssets: async () => {
      listAssetsCalls += 1;
      return [{ id: "cold-asset", name: "Cold asset" }];
    },
    listAssetsFiltered: async () => [],
    listFolders: async () => {
      listFoldersCalls += 1;
      return folders;
    },
    getMaterialChangeState: async () => ({
      version: 4,
      reason: "bridge-ready",
      affectedIds: [],
      foldersChanged: true,
      occurredAt: "2026-07-14T00:00:00Z",
    }),
  };
  (globalThis.window as unknown as {
    __LUCKYRAY_BRIDGE_READINESS__?: { generation: number; bridgeInstalled: boolean; databaseReady: boolean };
  }).__LUCKYRAY_BRIDGE_READINESS__ = { generation: 1, bridgeInstalled: true, databaseReady: true };
  (globalThis.window as unknown as EventTarget).dispatchEvent(new Event("luckyray:bridge-ready"));
  (globalThis.window as unknown as EventTarget).dispatchEvent(new Event("luckyray:bridge-ready"));

  await waitFor(() => store.getSnapshot().status === "ready", "bridge-ready did not recover the cold snapshot");
  assert.equal(listAssetsCalls, 1);
  assert.equal(listFoldersCalls, 1);
  assert.equal(store.getSnapshot().folders[0]?.id, "cold-folder");

  folders = [{ id: "switched-folder", name: "Switched folder", parentId: null, open: true, children: [] }];
  (globalThis.window as unknown as {
    __LUCKYRAY_BRIDGE_READINESS__?: { generation: number; bridgeInstalled: boolean; databaseReady: boolean };
  }).__LUCKYRAY_BRIDGE_READINESS__ = { generation: 2, bridgeInstalled: true, databaseReady: true };
  (globalThis.window as unknown as EventTarget).dispatchEvent(new Event("luckyray:bridge-ready"));
  await waitFor(() => store.getSnapshot().folders[0]?.id === "switched-folder", "bridge replacement did not refresh folders");
  assert.equal(listAssetsCalls, 2);
  assert.equal(listFoldersCalls, 2);
  assert.equal(store.getSnapshot().allAssets[0]?.id, "cold-asset");
  await store.ensureSnapshot({ reason: "warm-cache-reenter" });
  assert.equal(listAssetsCalls, 2);
  assert.equal(listFoldersCalls, 2);
  assert.equal(store.getSnapshot().folders[0]?.id, "switched-folder");

  releaseFirst();
  releaseStrictModeReplay();
});

test("an unmounted materials consumer is not notified by a late bridge-ready response", async () => {
  const store = await freshMaterialStore("bridge-ready-unmount");
  const releaseProtocol = store.retainChangeProtocol();
  await store.ensureSnapshot({ reason: "cold-route" });

  const assets = deferred<Array<{ id: string; name: string }>>();
  (globalThis.window as unknown as { __LUCKYRAY__?: object }).__LUCKYRAY__ = {
    listAssets: async () => assets.promise,
    listAssetsFiltered: async () => [],
    listFolders: async () => [{ id: "late-folder", name: "Late", parentId: null, open: true, children: [] }],
    getMaterialChangeState: async () => ({
      version: 1,
      reason: "late-ready",
      affectedIds: [],
      foldersChanged: true,
      occurredAt: "2026-07-14T00:00:00Z",
    }),
  };
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  (globalThis.window as unknown as EventTarget).dispatchEvent(new Event("luckyray:bridge-ready"));
  await waitFor(() => store.getSnapshot().status === "loading", "late bridge request did not start");
  unsubscribe();
  releaseProtocol();
  const notificationsAtUnmount = notifications;
  assets.resolve([{ id: "late-asset", name: "Late asset" }]);
  await waitFor(() => store.getSnapshot().status === "ready", "shared snapshot did not settle after unmount");

  assert.equal(notifications, notificationsAtUnmount);
  assert.equal(store.getSnapshot().folders[0]?.id, "late-folder");
});

test("an invalidation received during revalidation is drained before callers resume", async () => {
  const firstRefresh = deferred<Array<{ id: string; name: string }>>();
  let listAssetsCalls = 0;
  const store = await freshMaterialStore("drain", {
    listAssets: async () => {
      listAssetsCalls += 1;
      if (listAssetsCalls === 1) return [{ id: "initial", name: "Initial" }];
      if (listAssetsCalls === 2) return firstRefresh.promise;
      return [{ id: "after-second", name: "After second" }];
    },
    listAssetsFiltered: async () => [],
    listFolders: async () => [],
    getMaterialChangeState: async () => ({
      version: listAssetsCalls,
      reason: "test",
      affectedIds: [],
      foldersChanged: false,
      occurredAt: "2026-07-13T00:00:00Z",
    }),
  });

  await store.ensureSnapshot({ reason: "initial" });
  const firstInvalidation = store.invalidate({ reason: "first" });
  await waitFor(() => listAssetsCalls === 2, "first revalidation did not start");
  const secondInvalidation = store.invalidate({ reason: "second" });
  firstRefresh.resolve([{ id: "after-first", name: "After first" }]);

  const [firstResult, secondResult] = await Promise.all([firstInvalidation, secondInvalidation]);
  assert.equal(listAssetsCalls, 3);
  assert.equal(firstResult.allAssets[0]?.id, "after-second");
  assert.equal(secondResult.allAssets[0]?.id, "after-second");
  assert.equal(store.getSnapshot().lastReason, "second");
});

test("a failed material change can be retried with the same source version", async () => {
  let sourceVersion = 0;
  let listAssetsCalls = 0;
  let failNextRefresh = false;
  const store = await freshMaterialStore("source-version-retry", {
    listAssets: async () => {
      listAssetsCalls += 1;
      if (failNextRefresh) {
        failNextRefresh = false;
        throw new Error("temporary material read failure");
      }
      return [{ id: `asset-v${sourceVersion}`, name: `Asset v${sourceVersion}` }];
    },
    listAssetsFiltered: async () => [],
    listFolders: async () => [],
    getMaterialChangeState: async () => ({
      version: sourceVersion,
      reason: "test-change",
      affectedIds: [],
      foldersChanged: false,
      occurredAt: "2026-07-13T00:00:00Z",
    }),
  });
  const releaseProtocol = store.retainChangeProtocol();

  try {
    await store.ensureSnapshot({ reason: "initial" });
    sourceVersion = 7;
    failNextRefresh = true;
    const change = {
      version: sourceVersion,
      reason: "desktop-import",
      affectedIds: ["asset-v7"],
      foldersChanged: false,
      occurredAt: "2026-07-13T00:00:00Z",
    };
    const dispatchChange = () => {
      const event = new Event("luckyray:material-change-local");
      Object.defineProperty(event, "detail", { value: change });
      (globalThis.window as unknown as EventTarget).dispatchEvent(event);
    };

    dispatchChange();
    await waitFor(() => store.getSnapshot().status === "error", "failed refresh was not observable");
    dispatchChange();
    await waitFor(
      () => store.getSnapshot().status === "ready" && store.getSnapshot().sourceVersion === sourceVersion,
      "same source version did not recover the store",
    );

    assert.equal(listAssetsCalls, 3);
    assert.equal(store.getSnapshot().allAssets[0]?.id, "asset-v7");
    assert.equal(store.getSnapshot().error, null);
  } finally {
    releaseProtocol();
  }
});

test("an HTTP catalog import becomes visible after one material-change without a route switch", async () => {
  let sourceVersion = 0;
  let assets: Array<{ id: string; name: string; folderId: string | null }> = [];
  let listAssetsCalls = 0;
  const store = await freshMaterialStore("http-import-refresh", {
    listAssets: async () => {
      listAssetsCalls += 1;
      return assets;
    },
    listAssetsFiltered: async () => assets,
    listFolders: async () => [{ id: "folder-web", name: "Web", parentId: null, open: true, children: [] }],
    getMaterialChangeState: async () => ({
      version: sourceVersion,
      reason: "browser-extension-import",
      affectedIds: assets.map((asset) => asset.id),
      foldersChanged: false,
      occurredAt: "2026-07-14T00:00:00Z",
    }),
  });
  const releaseProtocol = store.retainChangeProtocol();
  try {
    await store.ensureSnapshot({ reason: "materials-route", query: { key: "materials:root" } });
    assets = [{ id: "canonical-web-asset", name: "hovered.png", folderId: "folder-web" }];
    sourceVersion = 1;
    const change = {
      version: sourceVersion,
      reason: "browser-extension-import",
      affectedIds: [assets[0].id],
      foldersChanged: false,
      occurredAt: "2026-07-14T00:00:00Z",
    };
    const event = new Event("luckyray:material-change-local");
    Object.defineProperty(event, "detail", { value: change });
    (globalThis.window as unknown as EventTarget).dispatchEvent(event);
    await waitFor(() => store.getSnapshot().allAssets[0]?.id === assets[0].id, "imported asset did not reach the page snapshot");
    const callsAfterImport = listAssetsCalls;

    const duplicateEvent = new Event("luckyray:material-change-local");
    Object.defineProperty(duplicateEvent, "detail", { value: change });
    (globalThis.window as unknown as EventTarget).dispatchEvent(duplicateEvent);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(store.getSnapshot().allAssets.length, 1);
    assert.equal(store.getSnapshot().allAssets[0]?.folderId, "folder-web");
    assert.equal(listAssetsCalls, callsAfterImport);
    assert.equal(store.getSnapshot().queryKey, "materials:root");
  } finally {
    releaseProtocol();
  }
});

test("unscoped search and graph consumers do not replace the materials page query", async () => {
  const allAssets = [
    { id: "image", name: "Image", kind: "image" },
    { id: "video", name: "Video", kind: "video" },
  ];
  const store = await freshMaterialStore("query-isolation", {
    listAssets: async () => allAssets,
    listAssetsFiltered: async () => [allAssets[0]],
    listFolders: async () => [],
    getMaterialChangeState: async () => ({
      version: 1,
      reason: "test",
      affectedIds: [],
      foldersChanged: false,
      occurredAt: "2026-07-13T00:00:00Z",
    }),
  });
  const materialsQuery = { key: "materials:image", filters: { kinds: ["image"] } };

  await store.ensureSnapshot({ reason: "materials-page", query: materialsQuery });
  const searchSnapshot = await store.ensureSnapshot({ reason: "global-search" });
  const graphSnapshot = await store.ensureSnapshot({ reason: "graph" });
  await store.invalidate({ reason: "material-change" });

  assert.deepEqual(searchSnapshot.allAssets.map((asset) => asset.id), ["image", "video"]);
  assert.deepEqual(graphSnapshot.allAssets.map((asset) => asset.id), ["image", "video"]);
  assert.equal(store.getSnapshot().queryKey, materialsQuery.key);
  assert.deepEqual(store.getSnapshot().assets.map((asset) => asset.id), ["image"]);
});

test("an Agent tag change while the materials route is detached preserves recent order on remount", async () => {
  let sourceVersion = 0;
  let listAssetsCalls = 0;
  let listFoldersCalls = 0;
  let exactAssetCalls = 0;
  let catalogAssets = [
    { id: "asset-a", name: "A", kind: "image", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "asset-b", name: "B", kind: "video", updatedAt: "2026-01-02T00:00:00Z" },
  ];
  const store = await freshMaterialStore("agent-tag-targeted-reconcile", {
    listAssets: async () => {
      listAssetsCalls += 1;
      return catalogAssets;
    },
    getAssetsByIds: async (ids: string[]) => {
      exactAssetCalls += 1;
      return catalogAssets.filter((asset) => ids.includes(asset.id));
    },
    listAssetsFiltered: async () => catalogAssets,
    listFolders: async () => {
      listFoldersCalls += 1;
      return [];
    },
    getMaterialChangeState: async () => ({
      version: sourceVersion,
      reason: "agent-material-tags",
      affectedIds: ["asset-a"],
      foldersChanged: false,
      occurredAt: "2026-08-06T00:00:00Z",
    }),
  });
  let releaseProtocol = () => {};
  try {
    await store.ensureSnapshot({ reason: "materials-route" });
    const originalOrder = store.getSnapshot().allAssets.map((asset) => asset.id);
    catalogAssets = [
      { ...catalogAssets[0]!, updatedAt: "2026-08-06T00:00:00Z" },
      catalogAssets[1]!,
    ];
    sourceVersion = 1;
    releaseProtocol = store.retainChangeProtocol();

    await waitFor(
      () => store.getSnapshot().sourceVersion === sourceVersion,
      "remount did not reconcile the detached Agent tag change",
    );
    assert.equal(exactAssetCalls, 1);
    assert.equal(listAssetsCalls, 1);
    assert.equal(listFoldersCalls, 1);
    assert.equal(store.getSnapshot().status, "ready");
    assert.deepEqual(store.getSnapshot().allAssets.map((asset) => asset.id), originalOrder);
    assert.equal(store.getSnapshot().allAssets[0]?.updatedAt, "2026-08-06T00:00:00Z");
    assert.deepEqual(
      store.getSnapshot().recentOrder,
      ["asset-b", "asset-a"],
      "tag-only updatedAt must not move the affected asset to the front of 最近使用",
    );
    const pageSource = readFileSync(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
    assert.match(pageSource, /materialSnapshot\.recentOrder/);
  } finally {
    releaseProtocol();
  }
});

test("an Agent tag timestamp cannot make an old asset look newly imported after app restart", async () => {
  const catalogAssets = [
    {
      id: "asset-old",
      name: "Old import with a new tag",
      kind: "image",
      importedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-08-06T00:00:00Z",
    },
    {
      id: "asset-new",
      name: "New import",
      kind: "video",
      importedAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
    },
  ];
  const bridge = {
    listAssets: async () => catalogAssets,
    listAssetsFiltered: async () => catalogAssets,
    listFolders: async () => [],
    getMaterialChangeState: async () => ({
      version: 1,
      reason: "agent-material-tags",
      affectedIds: ["asset-old"],
      foldersChanged: false,
      occurredAt: "2026-08-06T00:00:00Z",
    }),
  };

  const firstLaunch = await freshMaterialStore("agent-tag-restart-first", bridge);
  await firstLaunch.ensureSnapshot({ reason: "app-start" });
  const restarted = await freshMaterialStore("agent-tag-restart-second", bridge);
  await restarted.ensureSnapshot({ reason: "app-restart" });

  assert.deepEqual(firstLaunch.getSnapshot().recentOrder, ["asset-new", "asset-old"]);
  assert.deepEqual(
    restarted.getSnapshot().recentOrder,
    ["asset-new", "asset-old"],
    "durable import chronology, not tag-mutated updatedAt, must reconstruct recent order after restart",
  );
});
