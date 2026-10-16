import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createNativeSurfaceOwner, createPluginCompatService } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fetchLocal(url, cookie, method = "GET") {
  return new Promise((done, reject) => {
    const target = new URL(url);
    assert.equal(target.hostname, "127.0.0.1");
    const req = request(target, { method, headers: { connection: "close", ...(cookie ? { cookie } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("synthetic carrier request timeout")));
    req.end();
  });
}

async function sessionHashes(root) {
  const result = {};
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".jsonl.zstd")) result[path] = hash(await readFile(path));
    }
  }
  await visit(root);
  return result;
}

// Test-only authenticated route adapter to the actual running official services.
// No fake persistence/settings, external providers or model turns are involved.
function fixtureModule(runtimeRoot) {
  const schemaUrl = pathToFileURL(createRequire(join(runtimeRoot,"host/package.json")).resolve("@deepseek-ai/schemastery")).href;
  return `import z from ${JSON.stringify(schemaUrl)};
import { join } from 'node:path';
export const Config = z.object({ marker: z.string().default('original').volatile() });
export function apply(ctx) {
  const settings = ctx.get('settings');
  const persistence = ctx.get('sessionPersistence');
  const registry = ctx.get('workspaceRegistry');
  const credentials = ctx.get('credentials');
  async function create(id, marker, archived) {
    const cwd = join(process.env.DSH_HOME, 'workspace');
    const handle = await persistence.create({ version: 4, id, cwd, createdAt: 1000, isSeeded: false });
    try {
      await handle.append([{ type: 'user/message', seq: 0, time: 1000, surfaceOp: 'append',
        data: { id: id + '-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: marker }] } }]);
      await handle.flush();
    } finally { await handle.close(); }
    const workspace = await registry.create(cwd, 'Continuity fixture');
    await workspace.attachSession(id);
    if (archived) await registry.archiveSession(id);
  }
  async function snapshot() {
    const sessions = [];
    for (const row of await persistence.list()) {
      const id = row.header.id;
      const handle = await persistence.open(id, 'read');
      try { sessions.push({ id, events: (await handle.read()).events }); }
      finally { await handle.close(); }
    }
    return { home: process.env.DSH_HOME, cwd: process.cwd(),
      marker: settings.describe().find(row => row.ns === 'continuity-fixture')?.value?.marker,
      provider: settings.describe().find(row => row.ns === 'llm-pi-ai')?.value?.providers?.['continuity-fixture'],
      credentialConfigured: (await credentials.resolve('CONTINUITY_TEST_KEY'))?.value === 'synthetic-local-only',
      workspaces: registry.list().map(w => ({ id:w.id, path:w.path, sessionIds:[...w.sessionIds] })),
      archived: [...registry.archivedSessionIds], sessions: sessions.sort((a,b)=>a.id.localeCompare(b.id)) };
  }
  ctx.get('webServer').register({ kind:'exact', path:'/_luckyray/continuity-fixture', async handler(req,res) {
    try {
      if (req.method === 'POST') {
        await create('session-continuity-new', 'created-during-compatibility', false);
        await settings.update('continuity-fixture', {marker:'changed-during-compatibility'});
      } else if (req.method === 'PUT') {
        await create('session-continuity-old', 'original-conversation', false);
        await create('session-continuity-archived', 'original-archive', true);
      }
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(await snapshot()));
    } catch (error) { res.statusCode=500; res.end(JSON.stringify({fixtureError:String(error)})); }
  } });
}`;
}

test("real official surface retains existing and compatibility-created data through failure, restart and normal mode", {
  timeout: 180_000,
}, async (t) => {
  assert.ok(process.env.DSH_M1_RUNTIME_ROOT, "DSH_M1_RUNTIME_ROOT is required for compatibility admission");
  const runtimeRoot = resolve(process.env.DSH_M1_RUNTIME_ROOT);
  const expectedVersion = process.env.DSH_M1_EXPECTED_RUNTIME_VERSION ?? "0.1.7-rc.2";
  assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  assert.equal(JSON.parse(await readFile(join(runtimeRoot, "host/node_modules/@deepseek-ai/dsh/package.json"), "utf8")).version, expectedVersion);
  // Always own a fresh temporary root. Never accept DSH_M1_STATE_ROOT or any user profile.
  const root = await mkdtemp(join(tmpdir(), "luckyray-compat-continuity-"));
  const stateRoot = join(root, "native-state/rc8-v1");
  const home = join(root, "native-state/rc8-native-surface-v1");
  const profile = join(home, "profiles/web");
  const bad = join(profile, "node_modules/continuity-bad-plugin");
  const patch = join(home, "luckyray-dsh-native-surface.generated.patch.yml");
  let owner;
  let fixtureStderr = "";
  let verified = false;
  try {
    await mkdir(stateRoot, { recursive: true });
    await mkdir(join(home, "workspace"), { recursive: true });
    await mkdir(bad, { recursive: true });
    for (const name of ["dsh-authenticated-webserver", "dsh-resource-tools", "dsh-native-surface-state", "dsh-lightseek-ui"]) {
      await cp(join(appRoot, "src-tauri/dsh-host", `luckyray-${name}`), join(home, "profiles/node_modules/@luckyray", name), { recursive: true });
    }
    const probe = join(profile, "node_modules/@luckyray/continuity-fixture");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "package.json"), JSON.stringify({ name: "@luckyray/continuity-fixture", version: "1.0.0", type: "module", main: "index.mjs", dsh: { bundle: { patch: "cordis.patch.yml" } } }));
    await writeFile(join(probe, "index.mjs"), fixtureModule(runtimeRoot));
    await writeFile(join(probe, "cordis.patch.yml"),
      "- insert:\n    - id: continuity-fixture\n      name: '@luckyray/continuity-fixture'\n      inject: [webServer, settings, credentials, sessionPersistence, workspaceRegistry]\n");
    await writeFile(join(bad, "package.json"), JSON.stringify({ name: "continuity-bad-plugin", version: "1.0.0", type: "module", main: "index.mjs", dsh: { bundle: { patch: "cordis.patch.yml" } } }));
    await writeFile(join(bad, "index.mjs"), "export function apply() {}\n");
    await writeFile(join(bad, "cordis.patch.yml"), "- insert:\n    - id: continuity-bad-plugin\n      name: continuity-bad-plugin\n");
    await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-web", private: true, dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@luckyray/continuity-fixture", "continuity-bad-plugin"] } } }));
    await writeFile(patch, await readFile(join(appRoot, "src-tauri/dsh-host/luckyray-dsh-native-surface.patch.yml"), "utf8"));
    await writeFile(join(home, "settings.yaml"), `continuity-fixture:\n  marker: original\nllm-pi-ai:\n  providers:\n    continuity-fixture:\n      displayName: Continuity fixture\n      apiKeyEnv: CONTINUITY_TEST_KEY\n      api: openai-completions\n      baseURL: http://127.0.0.1:1/v1\n      models:\n        - id: continuity-model\n          name: Continuity model\n          contextWindow: 4096\n          maxTokens: 256\n          input: [text]\n          reasoningEfforts: false\n`);
    await writeFile(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  CONTINUITY_TEST_KEY: synthetic-local-only\n");
    const { parseCredentialsDocument } = await import(pathToFileURL(join(runtimeRoot,"host/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js")));
    const initialCredentialDocument = await readFile(join(home,".credentials.yaml"),"utf8");
    assert.ok(parseCredentialsDocument(initialCredentialDocument,"synthetic-fixture").refs.get("CONTINUITY_TEST_KEY") === "synthetic-local-only",
      "the input fixture contains the expected credential before official normalization");
    await mkdir(join(home, "attachments"));
    await writeFile(join(home, "attachments/fixture.txt"), "original-attachment");
    await mkdir(join(home, "storages"), { recursive: true });
    await writeFile(join(home, "storages/continuity-bad-plugin.json"), JSON.stringify({ retained: "plugin-owned-data" }));
    const protectedPaths = [".credentials.yaml", "attachments/fixture.txt", "storages/continuity-bad-plugin.json"];
    const newOwner = (onFailure = null) => createNativeSurfaceOwner({ runtimeRoot, stateRoot, surfaceHome: home, surfacePatch: patch,
      clientReadyTimeoutMs: onFailure ? 5_000 : 120_000,
      onUnexpectedExit: () => onFailure?.("unexpected-exit"), onSurfaceLost: reason => onFailure?.(reason),
      onChildStarted(child) { child.stderr.on("data", bytes => {
        fixtureStderr = (fixtureStderr + bytes).slice(-8000);
      }); } });
    async function open(reuse = false) {
      if (!reuse) owner = newOwner();
      const ready = await owner.open();
      assert.equal(ready.stage, "surface-ready", JSON.stringify(ready) + fixtureStderr);
      const base = `http://127.0.0.1:${ready.port}`;
      const bootstrap = await fetchLocal(`${base}${ready.bootstrapPath}?ref=${ready.bootstrapRef}`);
      assert.equal(bootstrap.status,302);
      const cookie = bootstrap.headers["set-cookie"][0].split(";",1)[0];
      const exchange = await fetchLocal(new URL(bootstrap.headers.location,base),cookie);
      assert.equal(exchange.status,303);
      const cookies = `${cookie}; ${exchange.headers["set-cookie"][0].split(";",1)[0]}`;
      const index = await fetchLocal(base,cookies);
      assert.equal(index.status,200);
      assert.match(index.text,/__DSH_BOOT__/u);
      return async (method="GET") => {
        const response = await fetchLocal(`${base}/_luckyray/continuity-fixture`,cookies,method);
        assert.equal(response.status,200,response.text);
        return JSON.parse(response.text);
      };
    }
    const close = async () => { await owner?.shutdown(); owner = undefined; };
    const initial = await (await open())("PUT");
    assert.equal(initial.sessions.length,2);
    assert.equal(initial.credentialConfigured,true);
    assert.deepEqual({ displayName:initial.provider?.displayName, apiKeyEnv:initial.provider?.apiKeyEnv,
      api:initial.provider?.api, baseURL:initial.provider?.baseURL,
      models:initial.provider?.models?.map(({id,name,contextWindow,maxTokens,input,reasoningEfforts}) =>
        ({id,name,contextWindow,maxTokens,input,reasoningEfforts})) },
      { displayName:"Continuity fixture", apiKeyEnv:"CONTINUITY_TEST_KEY",
        api:"openai-completions", baseURL:"http://127.0.0.1:1/v1", models:[{id:"continuity-model",name:"Continuity model",contextWindow:4096,maxTokens:256,input:["text"],reasoningEfforts:false}] },
      "first normal boot preserves the original provider/model settings and credential reference");
    assert.equal(initial.marker,"original");
    assert.equal(initial.home,home);
    assert.equal(initial.cwd,home);
    assert.deepEqual(initial.archived,["session-continuity-archived"]);
    await owner.close();
    assert.deepEqual(await (await open(true))(),initial,
      "healthy leave/reenter rotates binding and reads data without compatibility apply");
    await close();
    // Official first boot may normalize the synthetic v1 credential document.
    // Its reference was verified through the live provider before this baseline.
    const protectedBytes = await Promise.all(protectedPaths.map(async p => hash(await readFile(join(home,p)))));
    t.diagnostic(`first normal boot credential serialization changed: ${protectedBytes[0] !== hash(initialCredentialDocument)}; input and live credential semantics verified`);
    const originalLogs = await sessionHashes(join(home,"sessions"));
    const settingsBefore = hash(await readFile(join(home,"settings.yaml.imported")));
    // A concrete load failure, then an ordinary retry, neither may reset user data.
    await writeFile(join(bad,"index.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('fixture-load-failed', 'SYNTHETIC_PLUGIN_INCOMPATIBLE'); throw new Error('SYNTHETIC_PLUGIN_INCOMPATIBLE'); export function apply() {}\n");
    for (let attempt=0;attempt<2;attempt++) {
      fixtureStderr="";
      let exited;
      const exit = new Promise(resolveExit => { exited=resolveExit; });
      owner=newOwner(exited);
      const failed=await owner.open();
      if (failed.stage==="surface-ready") {
        let timeout;
        try {
          const reason=await Promise.race([exit,new Promise((_,reject)=>{ timeout=setTimeout(()=>reject(new Error("synthetic plugin failure was not reclaimed")),45_000); })]);
          assert.equal(reason,"surface-client-stuck","only confirmed watchdog tree reclamation admits a new owner in this fixture");
          t.diagnostic(`fault ${attempt+1}: ${reason}`);
        } finally { clearTimeout(timeout); }
      } else {
        assert.equal(failed.stage,"surface-failed");
        assert.equal(failed.reclaim?.confirmed,true,"an unconfirmed tree cannot be bypassed by constructing another owner");
      }
      assert.equal(await readFile(join(home,"fixture-load-failed"),"utf8"),"SYNTHETIC_PLUGIN_INCOMPATIBLE");
      await rm(join(home,"fixture-load-failed"));
      await close();
      assert.deepEqual(await sessionHashes(join(home,"sessions")),originalLogs);
      assert.equal(hash(await readFile(join(home,"settings.yaml.imported"))),settingsBefore);
    }
    assert.match(fixtureStderr,/continuity-bad-plugin \(continuity-bad-plugin\): failed to import/u,
      "the official loader identifies the failing plugin before isolation");
    let compat=createPluginCompatService({runtimeRoot,stateRoot,surfaceHome:home});
    const detection=await compat.check({baseline:false});
    assert.equal(detection.checked,true);
    assert.notEqual(detection.plugins.find(p=>p.entryId==="continuity-bad-plugin")?.outcome,"unchecked",
      "the static checker records the current plugin bytes before targeted isolation");
    t.diagnostic(`static verdict for deliberately throwing plugin: ${detection.plugins.find(p=>p.entryId==="continuity-bad-plugin")?.outcome}; actual startup failure and reclamation asserted above`);
    for (let attempt=0;attempt<2;attempt++) {
      const applied=await compat.apply({kind:"auto",entryId:"continuity-bad-plugin"});
      assert.equal(applied.applied,true,JSON.stringify(applied));
      assert.deepEqual(applied.quarantineSet,["continuity-bad-plugin"]);
    }
    let call=await open();
    assert.deepEqual(await call(),initial,"direct compatibility reads original data through live official services");
    const changed=await call("POST");
    assert.equal(changed.marker,"changed-during-compatibility");
    assert.equal(changed.sessions.length,3);
    assert.equal(changed.workspaces.length,initial.workspaces.length);
    for (const original of initial.workspaces) {
      const current=changed.workspaces.find(w=>w.id===original.id);
      assert.ok(current,"workspace identity is retained");
      assert.equal(current.path,original.path);
      assert.deepEqual([...current.sessionIds].sort(),[...original.sessionIds,"session-continuity-new"].sort());
    }
    assert.deepEqual(changed.archived,initial.archived);
    assert.deepEqual(changed.sessions.filter(s=>s.id!=="session-continuity-new"),initial.sessions);
    await close();
    compat=createPluginCompatService({runtimeRoot,stateRoot,surfaceHome:home});
    assert.equal((await compat.status()).plugins.find(p=>p.entryId==="continuity-bad-plugin").quarantined,true);
    // Persisted isolation is sufficient: no second compatibility apply/confirmation.
    call=await open();
    assert.deepEqual(await call(),changed,"compatibility-created records and settings survive restart");
    await close();
    // Model a plugin fix, then use the existing restore action, not a new profile.
    await writeFile(join(bad,"index.mjs"), "export function apply() {}\n");
    assert.equal((await compat.apply({kind:"restore",entryId:"continuity-bad-plugin"})).applied,true);
    assert.deepEqual((await compat.apply({kind:"normal"})).quarantineSet,[]);
    call=await open();
    assert.deepEqual(await call(),changed,"returning to normal retains both old and compatibility-created data");
    await close();
    const afterLogs=await sessionHashes(join(home,"sessions"));
    for (const [path,bytes] of Object.entries(originalLogs)) assert.equal(afterLogs[path],bytes);
    assert.deepEqual(await Promise.all(protectedPaths.map(async p=>hash(await readFile(join(home,p))))),protectedBytes);
    verified = true;
    t.diagnostic("real rc.2: original conversation/archive/config/credential reference, repeated failure/direct compat, compat-created conversation+setting, restart, restore/normal, old log/attachment/plugin data hashes preserved; no model calls");
  } catch (error) {
    t.diagnostic(fixtureStderr);
    throw error;
  } finally {
    await owner?.shutdown();
    assert.equal(dirname(root),tmpdir());
    if (verified) await rm(root,{recursive:true,force:true});
    else t.diagnostic(`failed synthetic fixture retained for diagnosis: ${root}`);
  }
});
