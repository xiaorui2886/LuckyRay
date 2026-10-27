import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const adapter = process.env.DSH_UPGRADE_HOST_ADAPTER;
if (!adapter) throw new Error("DSH_UPGRADE_HOST_ADAPTER is required");
const { runNativeDshProbe } = await import(pathToFileURL(adapter));

async function openWorkspaceServices(runtimeRoot, home) {
  const load = (name) => import(pathToFileURL(join(runtimeRoot, "host/node_modules", name, "lib/index.js")));
  const { Context } = await load("@deepseek-ai/cordis");
  const ctx = new Context();
  try {
    await ctx.plugin((await load("@deepseek-ai/dsh-storage")).default);
    await ctx.plugin(await load("@deepseek-ai/dsh-storage-json"), { root: join(home, "storages") });
    await ctx.plugin(await load("@deepseek-ai/dsh-storage-domain"), { backend: "json" });
    const persistenceModule = await load("@deepseek-ai/dsh-session-persistence-jsonl");
    const Persistence = persistenceModule.default ?? persistenceModule;
    if (Persistence.inject?.includes("sessions")) {
      await ctx.plugin((await load("@deepseek-ai/dsh-session")).default);
    }
    await ctx.plugin(Persistence, { root: join(home, "sessions") });
    await ctx.plugin((await load("@deepseek-ai/dsh-workspace")).default);
    return { ctx, close: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

function workspaceSnapshot(registry) {
  return {
    workspaces: registry.list().map(workspace => ({
      id: workspace.id, path: workspace.path, title: workspace.title,
      sessionIds: [...workspace.sessionIds],
    })),
    archivedSessionIds: [...registry.archivedSessionIds],
  };
}

// Release qualification: use independently verified old and new runtimes.
// The probe talks only to its own deterministic loopback provider, never user APIs.
test("an in-place upgrade retains old turns, legacy settings backup and credentials across a second restart", {
  timeout: 120_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "luckyray-dsh-upgrade-"));
  try {
    const oldRoot = process.env.DSH_UPGRADE_FROM_RUNTIME_ROOT;
    const newRoot = process.env.DSH_UPGRADE_TO_RUNTIME_ROOT;
    const load = (name) => import(pathToFileURL(join(newRoot, "host/node_modules", name, "lib/index.js")));
    const { Context } = await load("@deepseek-ai/cordis");
    const persistenceModule = await load("@deepseek-ai/dsh-session-persistence-jsonl");
    const { parseCredentialsDocument } = await load("@deepseek-ai/dsh-credentials-local");
    const { default: yaml } = await import(pathToFileURL(join(newRoot, "host/node_modules/yaml/dist/index.js")));

    await runNativeDshProbe({ runtimeRoot: oldRoot, stateRoot: home });
    const persistenceContext = new Context();
    await persistenceContext.plugin(persistenceModule.default ?? persistenceModule, { root: join(home, "sessions") });
    t.after(() => persistenceContext.fiber.dispose());
    const storage = () => persistenceContext.sessionPersistence;
    const firstStore = storage();
    const oldSessions = await firstStore.list();
    assert.equal(oldSessions.length, 1);
    const id = oldSessions[0].header.id;
    const reader = await firstStore.open(id, "read");
    const oldTurn = await reader.read();
    await reader.close();
    assert.ok(oldTurn.events.length > 0);
    async function originals(dir) {
      const found = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...await originals(path));
        else if (/^session\.v[34]\.jsonl\.zstd$/u.test(entry.name)) {
          found.push([path, createHash("sha256").update(await readFile(path)).digest("hex")]);
        }
      }
      return found.sort(([a], [b]) => a.localeCompare(b));
    }
    const originalBytes = await originals(join(home, "sessions"));
    assert.equal(originalBytes.length, 1, "the old runtime must produce a real saved session generation");
    const settings = {
      "ui-theme": { preference: "dark" },
      locale: { preference: "zh-CN" },
      "llm-pi-ai": { providers: { "continuity-fixture": {
        displayName: "Continuity fixture", apiKeyEnv: "CONTINUITY_TEST_KEY",
        api: "openai-completions", baseURL: "http://127.0.0.1:1/v1", models: [],
      } } },
    };
    const credentials = { version: 1, refs: { CONTINUITY_TEST_KEY: "synthetic-local-test-only" } };
    const settingsSource = yaml.stringify(settings);
    await writeFile(join(home, "settings.yaml"), settingsSource);
    await writeFile(join(home, ".credentials.yaml"), yaml.stringify(credentials));
    await mkdir(join(home, "storages"), { recursive: true });
    // This is the official persisted workspace shape; keep it byte-for-byte.
    const workspace = JSON.stringify({ unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: ["continuity"], archivedSessionIds: [] },
      tables: { workspaces: { continuity: { path: join(home, "workspace"), title: "Upgrade",
        sessionIds: [id], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } } } });
    await writeFile(join(home, "storages/workspace.json"), workspace);

    await runNativeDshProbe({ runtimeRoot: newRoot, stateRoot: home });
    const afterUpgrade = (await storage().list()).map(item => item.header.id).sort();
    assert.equal(afterUpgrade.length, 2);
    assert.ok(afterUpgrade.includes(id));
    await runNativeDshProbe({ runtimeRoot: newRoot, stateRoot: home });
    const afterRestart = (await storage().list()).map(item => item.header.id).sort();
    assert.equal(afterRestart.length, 3);
    assert.ok(afterUpgrade.every(session => afterRestart.includes(session)));
    const reopened = await storage().open(id, "read");
    assert.deepEqual(await reopened.read(), oldTurn);
    await reopened.close();
    for (const [path, originalHash] of originalBytes) {
      assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), originalHash,
        "every original session artifact keeps its exact bytes after upgrade and restart");
    }
    // 0.1.7 imports legacy settings into profile entries and keeps the source as
    // .imported. This headless probe proves byte preservation, not that every
    // setting was accepted by the desktop profile.
    const importedSettings = await readFile(join(home, "settings.yaml.imported"), "utf8");
    assert.equal(importedSettings, settingsSource);
    assert.deepEqual(yaml.parse(importedSettings), settings);
    const parsed = parseCredentialsDocument(await readFile(join(home, ".credentials.yaml"), "utf8"), "fixture");
    assert.equal(parsed.refs.get("CONTINUITY_TEST_KEY"), "synthetic-local-test-only");
    assert.equal(await readFile(join(home, "storages/workspace.json"), "utf8"), workspace);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("official workspace services preserve IDs, project paths and ownership across upgrade and later project activity", {
  timeout: 120_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "luckyray-dsh-workspaces-"));
  let services;
  try {
    const oldRoot = process.env.DSH_UPGRADE_FROM_RUNTIME_ROOT;
    const newRoot = process.env.DSH_UPGRADE_TO_RUNTIME_ROOT;
    await runNativeDshProbe({ runtimeRoot: oldRoot, stateRoot: home });
    const otherProject = join(home, "other-project");
    await mkdir(otherProject);
    services = await openWorkspaceServices(oldRoot, home);
    let { sessionPersistence: persistence, workspaceRegistry: registry } = services.ctx;
    const [{ header }] = await persistence.list();
    const first = await registry.create(header.cwd, "Same name");
    await first.setTitle("Same name");
    await first.attachSession(header.id);
    const second = await registry.create(otherProject, "Same name");
    const secondSessionId = "session-upgrade-second-project";
    const secondHandle = await persistence.create({ ...header, id: secondSessionId, cwd: otherProject });
    // Create its own user event through the official API. A completed source
    // turn contains delivery markers bound to the original Session identity.
    await secondHandle.append([{ type: "user/message", seq: 0, time: 1000, surfaceOp: "append",
      data: { id: `${secondSessionId}-message`, role: "user", source: { kind: "user" },
        content: [{ type: "text", text: "Synthetic second project" }] } }]);
    await secondHandle.close();
    await second.attachSession(secondSessionId);
    await registry.archiveSession(secondSessionId);
    const before = workspaceSnapshot(registry);
    assert.equal(before.workspaces.length, 2);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.path, second.path);
    await services.close();

    // Run the target's real storage and workspace plugins. A JSON byte check
    // alone would miss boot-time regrouping or regeneration of workspace IDs.
    services = await openWorkspaceServices(newRoot, home);
    ({ sessionPersistence: persistence, workspaceRegistry: registry } = services.ctx);
    assert.deepEqual(workspaceSnapshot(registry), before);
    let handle;
    for (const id of [header.id, secondSessionId]) {
      handle = await persistence.open(id, "write");
      await handle.flush();
      await handle.close();
    }
    assert.equal((await registry.create(first.path, "Do not rename")).id, first.id);
    assert.equal(registry.get(first.id).title, "Same name");
    const newSessionId = "session-upgrade-new-in-second-project";
    const upgradedHeader = (await persistence.list()).find(item => item.header.id === header.id).header;
    handle = await persistence.create({ ...upgradedHeader, id: newSessionId, cwd: otherProject });
    await handle.flush();
    await handle.close();
    await registry.get(second.id).attachSession(newSessionId);
    await assert.rejects(registry.get(first.id).attachSession(newSessionId), /cannot attach session/u);
    const afterNewActivity = workspaceSnapshot(registry);
    assert.deepEqual(registry.get(first.id).sessionIds, [header.id]);
    assert.deepEqual(registry.get(second.id).sessionIds, [newSessionId, secondSessionId]);
    await services.close();

    services = await openWorkspaceServices(newRoot, home);
    ({ sessionPersistence: persistence, workspaceRegistry: registry } = services.ctx);
    assert.deepEqual(workspaceSnapshot(registry), afterNewActivity);
    for (const original of before.workspaces) {
      const current = registry.get(original.id);
      assert.ok(current, "an existing workspace ID must survive upgrade and restart");
      assert.equal(current.path, original.path);
      assert.ok(original.sessionIds.every(id => current.sessionIds.includes(id)));
    }
    assert.deepEqual((await persistence.list()).map(item => item.header.id).sort(),
      [header.id, secondSessionId, newSessionId].sort());
    assert.deepEqual(registry.archivedSessionIds, [secondSessionId]);
  } finally {
    await services?.close();
    await rm(home, { recursive: true, force: true });
  }
});
