import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createNativeSurfaceOwner, runNativeDshProbe } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

const fromRoot = process.env.DSH_UPGRADE_FROM_RUNTIME_ROOT;
const toRoot = process.env.DSH_UPGRADE_TO_RUNTIME_ROOT;
if (!fromRoot || !toRoot) throw new Error("both sealed upgrade runtime roots are required");

function fetchLocal(url, cookie, method = "GET") {
  return new Promise((done, reject) => {
    const target = new URL(url);
    assert.equal(target.hostname, "127.0.0.1");
    const req = request(target, { method, headers: { connection: "close", ...(cookie ? { cookie } : {}) } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("synthetic settings request timeout")));
    req.end();
  });
}

async function waitForSettings(read, expected) {
  const until = Date.now() + 15_000;
  let actual;
  do {
    actual = await read();
    if (Object.entries(expected).every(([key,value]) => actual[key] === value)) return actual;
    await new Promise(done => setTimeout(done, 100));
  } while (Date.now() < until);
  assert.deepEqual(actual, expected, "official live settings did not reach the expected values");
}

const evidencePlugin = `export function apply(ctx) {
  const settings = ctx.get('settings');
  const value = ns => settings.describe
    ? settings.describe().find(row => row.ns === ns)?.value
    : settings.get(ns);
  ctx.get('webServer').register({ kind:'exact', path:'/_luckyray/settings-evidence', async handler(req,res) {
    try {
      if (req.method === 'POST') {
        await settings.update('ui-theme', { preference:'light' });
        await settings.update('locale', { preference:'en' });
        const providers = value('llm-pi-ai').providers;
        await settings.update('llm-pi-ai', { providers: {
          ...providers, 'upgrade-fixture': { ...providers['upgrade-fixture'], displayName:'Edited provider' }
        } });
      }
      const theme = value('ui-theme');
      const locale = value('locale');
      const provider = value('llm-pi-ai')?.providers?.['upgrade-fixture'];
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({ theme:theme?.preference, locale:locale?.preference,
        providerName:provider?.displayName, providerKey:provider?.apiKeyEnv,
        model:provider?.models?.[0]?.id }));
    } catch(error) { res.statusCode=500; res.end(JSON.stringify({fixtureError:String(error)})); }
  }});
}`;

test("official Web profile imports effective old settings and keeps edits after restart", { timeout: 180_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-web-upgrade-"));
  const home = join(root, "surface-home");
  const stateRoot = join(root, "host-state");
  const profile = join(home, "profiles/web");
  const overlay = join(home, "luckyray-dsh-native-surface.generated.patch.yml");
  let owner;
  let stderr = "";
  let verified = false;
  let launchLines = 0;
  const launchTokens = new Set();
  async function open(runtimeRoot) {
    owner = createNativeSurfaceOwner({ runtimeRoot, stateRoot, surfaceHome:home, surfacePatch:overlay,
      clientReadyTimeoutMs: 120_000,
      onChildStarted(child) {
        child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-8000); });
        let stdout = "";
        child.stdout.on("data", bytes => {
          stdout = (stdout + bytes).slice(-8000);
          for (;;) {
            const at = stdout.indexOf("\n");
            if (at < 0) break;
            const line = stdout.slice(0, at); stdout = stdout.slice(at + 1);
            const match = /^dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/u.exec(line);
            if (match) { launchLines++; launchTokens.add(match[1]); }
          }
        });
      } });
    const ready = await owner.open();
    assert.equal(ready.stage, "surface-ready", JSON.stringify(ready) + stderr);
    const base = `http://127.0.0.1:${ready.port}`;
    const bootstrap = await fetchLocal(`${base}${ready.bootstrapPath}?ref=${ready.bootstrapRef}`);
    assert.equal(bootstrap.status, 302);
    const cookie = bootstrap.headers["set-cookie"][0].split(";",1)[0];
    assert.equal(new URL(bootstrap.headers.location,base).searchParams.getAll("token").length,1,
      "carrier-ready must wait for the official authenticated launch URL, never redirect to bare root");
    const exchange = await fetchLocal(new URL(bootstrap.headers.location, base), cookie);
    if (exchange.status !== 303) t.diagnostic(JSON.stringify({kind:"bootstrap-exchange-failure",
      runtimeVersion:JSON.parse(await readFile(join(runtimeRoot,"host/node_modules/@deepseek-ai/dsh/package.json"))).version,
      status:exchange.status, launchLines, distinctLaunchTokens:launchTokens.size,
      bootstrapCookieCount:bootstrap.headers["set-cookie"].length,
      tokenCount:new URL(bootstrap.headers.location,base).searchParams.getAll("token").length}));
    assert.equal(exchange.status, 303, exchange.text + stderr);
    const cookies = `${cookie}; ${exchange.headers["set-cookie"][0].split(";",1)[0]}`;
    const index = await fetchLocal(base, cookies);
    assert.equal(index.status, 200);
    return async (method = "GET") => {
      const response = await fetchLocal(`${base}/_luckyray/settings-evidence`, cookies, method);
      assert.equal(response.status, 200, response.text);
      return JSON.parse(response.text);
    };
  }
  async function close() { await owner?.shutdown(); owner = undefined; }
  try {
    await mkdir(profile, { recursive:true });
    await mkdir(stateRoot, { recursive:true });
    await mkdir(join(home,"workspace"), { recursive:true });
    for (const name of ["dsh-authenticated-webserver", "dsh-resource-tools", "dsh-native-surface-state", "dsh-lightseek-ui"]) {
      await cp(new URL(`../src-tauri/dsh-host/luckyray-${name}`, import.meta.url),
        join(home,"profiles/node_modules/@luckyray",name), { recursive:true });
    }
    const probe = join(home,"profiles/node_modules/@luckyray/settings-evidence");
    await mkdir(probe, { recursive:true });
    await writeFile(join(probe,"package.json"), JSON.stringify({ name:"@luckyray/settings-evidence", version:"1.0.0", type:"module", main:"index.mjs" }));
    await writeFile(join(probe,"index.mjs"), evidencePlugin);
    await writeFile(join(profile,"package.json"), JSON.stringify({ name:"dsh-profile-web", private:true,
      dsh:{profile:{bundles:["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}} }));
    await writeFile(overlay, await readFile(new URL("../src-tauri/dsh-host/luckyray-dsh-native-surface.patch.yml", import.meta.url),"utf8") +
      "\n    - id: settings-evidence\n      name: '@luckyray/settings-evidence'\n      inject: [webServer, settings]\n");
    const settingsSource = `ui-theme:\n  preference: dark\nlocale:\n  preference: zh\nllm-pi-ai:\n  providers:\n    upgrade-fixture:\n      displayName: Original provider\n      apiKeyEnv: UPGRADE_TEST_KEY\n      api: openai-completions\n      baseURL: http://127.0.0.1:1/v1\n      models:\n        - id: upgrade-model\n          name: Upgrade model\n          contextWindow: 4096\n          maxTokens: 256\n          input: [text]\n          reasoningEfforts: false\n`;
    await writeFile(join(home,"settings.yaml"), settingsSource);
    await writeFile(join(home,".credentials.yaml"), "version: 1\nrefs:\n  UPGRADE_TEST_KEY: synthetic-local-only\n");
    const oldRead = await open(fromRoot);
    assert.deepEqual(await waitForSettings(oldRead, {theme:"dark",locale:"zh",providerName:"Original provider",
      providerKey:"UPGRADE_TEST_KEY",model:"upgrade-model"}), {theme:"dark",locale:"zh",providerName:"Original provider",
      providerKey:"UPGRADE_TEST_KEY",model:"upgrade-model"}, "old official Web profile must actively consume the old settings");
    await close();
    await runNativeDshProbe({runtimeRoot:fromRoot,stateRoot:home});
    const load = name => import(pathToFileURL(join(toRoot,"host/node_modules",name,"lib/index.js")));
    const { Context } = await load("@deepseek-ai/cordis");
    const persistenceModule = await load("@deepseek-ai/dsh-session-persistence-jsonl");
    const persistenceContext = new Context();
    await persistenceContext.plugin(persistenceModule.default ?? persistenceModule, {root:join(home,"sessions")});
    t.after(() => persistenceContext.fiber.dispose());
    const storage = () => persistenceContext.sessionPersistence;
    const beforeSessions = await storage().list();
    assert.equal(beforeSessions.length,1);
    const oldId = beforeSessions[0].header.id;
    const oldHandle = await storage().open(oldId,"read");
    const oldTurn = await oldHandle.read();
    await oldHandle.close();
    assert.ok(oldTurn.events.length>0);
    const newRead = await open(toRoot);
    assert.deepEqual(await waitForSettings(newRead, {theme:"dark",locale:"zh",providerName:"Original provider",
      providerKey:"UPGRADE_TEST_KEY",model:"upgrade-model"}), {theme:"dark",locale:"zh",providerName:"Original provider",
      providerKey:"UPGRADE_TEST_KEY",model:"upgrade-model"}, "new official Web profile must apply imported values");
    assert.equal(await readFile(join(home,"settings.yaml.imported"),"utf8"),settingsSource);
    assert.deepEqual(await newRead("POST"), {theme:"light",locale:"en",providerName:"Edited provider",
      providerKey:"UPGRADE_TEST_KEY",model:"upgrade-model"});
    await close();
    await runNativeDshProbe({runtimeRoot:toRoot,stateRoot:home});
    const afterSessions = await storage().list();
    assert.equal(afterSessions.length,2,"new conversation joins the old identity");
    assert.ok(afterSessions.some(row=>row.header.id===oldId));
    const oldAgain = await storage().open(oldId,"read");
    assert.deepEqual(await oldAgain.read(),oldTurn,"old conversation remains readable after Web migration and a new turn");
    await oldAgain.close();
    const newId = afterSessions.find(row=>row.header.id!==oldId).header.id;
    const newHandle = await storage().open(newId,"read");
    const newTurn = await newHandle.read();
    await newHandle.close();
    assert.ok(newTurn.events.length>0);
    const restarted = await open(toRoot);
    assert.deepEqual(await restarted(), {theme:"light",locale:"en",providerName:"Edited provider",
      providerKey:"UPGRADE_TEST_KEY",model:"upgrade-model"}, "active edits survive official Web restart");
    await close();
    const newAgain = await storage().open(newId,"read");
    assert.deepEqual(await newAgain.read(),newTurn,"new conversation survives a second Web restart");
    await newAgain.close();
    verified = true;
    t.diagnostic("old/new official Web settings are active; new edits and conversations survive restart on one synthetic identity");
  } catch (error) { t.diagnostic(stderr); throw error; }
  finally {
    await close();
    assert.equal(dirname(root),tmpdir());
    if (verified) await rm(root,{recursive:true,force:true});
    else t.diagnostic(`failed synthetic fixture retained for diagnosis: ${root}`);
  }
});
