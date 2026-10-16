import assert from "node:assert/strict";
import test from "node:test";

import { createFolderReloadCoordinator } from "../src/features/folders/folderReloadCoordinator.ts";

type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  open: boolean;
  children: Folder[];
};

test("a folder consumer mounted before the bridge loads when database readiness arrives", async () => {
  const events = new EventTarget();
  let bridge: { listFolders(scope: "materials" | "notes"): Promise<Folder[]> } | null = null;
  let readiness: { generation: number; bridgeInstalled: boolean; databaseReady: boolean } | null = null;
  const snapshots: Folder[][] = [];

  const coordinator = createFolderReloadCoordinator<Folder>({
    scope: "materials",
    events,
    getBridge: () => bridge,
    getReadiness: () => readiness,
    onResult: (folders) => snapshots.push(folders),
  });

  coordinator.start();
  await coordinator.whenIdle();
  assert.deepEqual(snapshots, []);

  bridge = {
    listFolders: async () => [{ id: "cold-folder", name: "Cold", parentId: null, open: true, children: [] }],
  };
  readiness = { generation: 1, bridgeInstalled: true, databaseReady: true };
  events.dispatchEvent(new Event("luckyray:bridge-ready"));
  await coordinator.whenIdle();

  assert.equal(snapshots.at(-1)?.[0]?.id, "cold-folder");
  coordinator.dispose();
});

test("the same persisted readiness generation does not reload a warm folder tree twice", async () => {
  const events = new EventTarget();
  let calls = 0;
  const readiness = { generation: 3, bridgeInstalled: true, databaseReady: true };
  const bridge = {
    listFolders: async () => {
      calls += 1;
      return [{ id: "warm", name: "Warm", parentId: null, open: true, children: [] }];
    },
  };
  const coordinator = createFolderReloadCoordinator<Folder>({
    scope: "materials",
    events,
    getBridge: () => bridge,
    getReadiness: () => readiness,
    onResult: () => {},
  });

  coordinator.start();
  await coordinator.whenIdle();
  events.dispatchEvent(new Event("luckyray:bridge-ready"));
  events.dispatchEvent(new Event("luckyray:bridge-ready"));
  await coordinator.whenIdle();

  assert.equal(calls, 1);
  coordinator.dispose();
});

test("folder changes during an in-flight load drain once without concurrent requests", async () => {
  const events = new EventTarget();
  let resolveFirst!: (folders: Folder[]) => void;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const snapshots: Folder[][] = [];
  const bridge = {
    listFolders: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) return await new Promise<Folder[]>((resolve) => { resolveFirst = resolve; });
        return [{ id: "latest", name: "Latest", parentId: null, open: true, children: [] }];
      } finally {
        active -= 1;
      }
    },
  };
  const coordinator = createFolderReloadCoordinator<Folder>({
    scope: "materials",
    events,
    getBridge: () => bridge,
    getReadiness: () => ({ generation: 1, bridgeInstalled: true, databaseReady: true }),
    onResult: (folders) => snapshots.push(folders),
  });

  coordinator.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  events.dispatchEvent(new CustomEvent("luckyray:folders-changed", { detail: { scope: "materials" } }));
  resolveFirst([{ id: "stale", name: "Stale", parentId: null, open: true, children: [] }]);
  await coordinator.whenIdle();

  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.equal(snapshots.at(-1)?.[0]?.id, "latest");
  coordinator.dispose();
});

test("a database-not-ready failure retries when the same generation becomes ready", async () => {
  const events = new EventTarget();
  let calls = 0;
  let readiness = { generation: 4, bridgeInstalled: true, databaseReady: false };
  const snapshots: Folder[][] = [];
  const bridge = {
    listFolders: async () => {
      calls += 1;
      if (calls === 1) throw new Error("database not ready");
      return [{ id: "recovered", name: "Recovered", parentId: null, open: true, children: [] }];
    },
  };
  const coordinator = createFolderReloadCoordinator<Folder>({
    scope: "materials",
    events,
    getBridge: () => bridge,
    getReadiness: () => readiness,
    onResult: (folders) => snapshots.push(folders),
  });

  coordinator.start();
  await coordinator.whenIdle();
  readiness = { ...readiness, databaseReady: true };
  events.dispatchEvent(new Event("luckyray:bridge-ready"));
  await coordinator.whenIdle();

  assert.equal(calls, 2);
  assert.equal(snapshots.at(-1)?.[0]?.id, "recovered");
  coordinator.dispose();
});

test("disposing a folder consumer ignores a late response", async () => {
  const events = new EventTarget();
  let resolveLoad!: (folders: Folder[]) => void;
  const snapshots: Folder[][] = [];
  const coordinator = createFolderReloadCoordinator<Folder>({
    scope: "materials",
    events,
    getBridge: () => ({
      listFolders: () => new Promise<Folder[]>((resolve) => { resolveLoad = resolve; }),
    }),
    getReadiness: () => null,
    onResult: (folders) => snapshots.push(folders),
  });

  coordinator.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const idle = coordinator.whenIdle();
  coordinator.dispose();
  resolveLoad([{ id: "late", name: "Late", parentId: null, open: true, children: [] }]);
  await idle;

  assert.deepEqual(snapshots, []);
});

test("a browser-preview bridge already present when the materials scope mounts loads immediately", async () => {
  const events = new EventTarget();
  const snapshots: Folder[][] = [];
  const bridge = {
    listFolders: async () => [{ id: "preview", name: "Preview", parentId: null, open: true, children: [] }],
  };
  const coordinator = createFolderReloadCoordinator<Folder>({
    scope: "materials",
    events,
    getBridge: () => bridge,
    getReadiness: () => null,
    onResult: (folders) => snapshots.push(folders),
  });

  coordinator.start();
  await coordinator.whenIdle();

  assert.equal(snapshots.at(-1)?.[0]?.id, "preview");
  coordinator.dispose();
});

test("an older bridge without a readiness marker can retry the same bridge after an initial failure", async () => {
  const events = new EventTarget();
  let calls = 0;
  const snapshots: Folder[][] = [];
  const bridge = {
    listFolders: async () => {
      calls += 1;
      if (calls === 1) throw new Error("preview bridge warming up");
      return [{ id: "legacy-ready", name: "Legacy", parentId: null, open: true, children: [] }];
    },
  };
  const coordinator = createFolderReloadCoordinator<Folder>({
    scope: "materials",
    events,
    getBridge: () => bridge,
    getReadiness: () => null,
    onResult: (folders) => snapshots.push(folders),
  });

  coordinator.start();
  await coordinator.whenIdle();
  events.dispatchEvent(new Event("luckyray:bridge-ready"));
  await coordinator.whenIdle();

  assert.equal(calls, 2);
  assert.equal(snapshots.at(-1)?.[0]?.id, "legacy-ready");
  coordinator.dispose();
});

test("StrictMode effect replay shares one bridge request and only the live consumer applies it", async () => {
  const events = new EventTarget();
  let calls = 0;
  let resolveLoad!: (folders: Folder[]) => void;
  const bridge = {
    listFolders: () => {
      calls += 1;
      return new Promise<Folder[]>((resolve) => { resolveLoad = resolve; });
    },
  };
  const firstSnapshots: Folder[][] = [];
  const secondSnapshots: Folder[][] = [];
  const makeCoordinator = (onResult: (folders: Folder[]) => void) => createFolderReloadCoordinator<Folder>({
    scope: "materials",
    events,
    getBridge: () => bridge,
    getReadiness: () => ({ generation: 1, bridgeInstalled: true, databaseReady: true }),
    onResult,
  });

  const first = makeCoordinator((folders) => firstSnapshots.push(folders));
  first.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  first.dispose();
  const second = makeCoordinator((folders) => secondSnapshots.push(folders));
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 1);
  resolveLoad([{ id: "strict", name: "Strict", parentId: null, open: true, children: [] }]);
  await second.whenIdle();
  assert.deepEqual(firstSnapshots, []);
  assert.equal(secondSnapshots.at(-1)?.[0]?.id, "strict");
  second.dispose();
});
