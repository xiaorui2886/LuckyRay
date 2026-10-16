import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const sdk = fileURLToPath(new URL("../plugin-sdk/", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const npmCli = process.env.LR_SDK_NPM_CLI || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const tsc = process.env.LR_SDK_TSC;
const worker = process.env.LR_SDK_WORKER;
const workerSha = process.env.LR_SDK_WORKER_SHA256;
const templates = ["palette", "outline", "canvas-export", "material-manifest", "page-desk", "material-reader"];
let scratch, exported, consumer, installed, cli, tarball;
const results = { evidence: "local npm tarball consumer; actual QuickJS with controlled RPC adapter (not native Broker/domain/GUI)", gui: "NOT_RUN", nativeBroker: "NOT_RUN", cases: [] };

function run(args, cwd = scratch, expected = 0) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(result.status, expected, `${args[0]} ${args.slice(1).join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function json(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value)); }
async function create(name, template) {
  const project = path.join(consumer, name);
  run([cli, "create", project, ...(template ? ["--template", template] : [])]);
  return project;
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "luckyray-sdk-consumer-"));
  exported = path.join(scratch, "public SDK 中文");
  run([path.join(sdk, "export-sdk.mjs"), exported]);
  const packed = JSON.parse(run([npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", scratch], exported).stdout)[0];
  tarball = path.join(scratch, packed.filename);
  consumer = path.join(scratch, "independent-consumer"); await fs.mkdir(consumer);
  await writeJson(path.join(consumer, "package.json"), { name: "standalone-sdk-verification", private: true, version: "1.0.0" });
  run([npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-dev", tarball], consumer);
  installed = path.join(consumer, "node_modules/@luckyray/plugin-sdk");
  cli = path.join(installed, "cli.mjs");
  results.tarballSha256 = sha(await fs.readFile(tarball));
  results.manifest = await json(path.join(installed, "MANIFEST.json"));
  if (worker) {
    assert.match(workerSha || "", /^[a-f0-9]{64}$/i, "An approved worker hash is mandatory; never fall through into an app/profile");
    assert.equal(sha(await fs.readFile(worker)), workerSha.toLowerCase());
    results.worker = { sha256: workerSha.toLowerCase(), flag: "--extension-worker", sourceCommit: "807c783951b506bf0e44e79c4977332fbfde9c39" };
  }
});

after(async () => {
  const output = process.env.LR_SDK_EVIDENCE_DIR;
  if (output && scratch) {
    await fs.mkdir(output, { recursive: true });
    await fs.copyFile(tarball, path.join(output, path.basename(tarball)));
    await fs.copyFile(path.join(installed, "MANIFEST.json"), path.join(output, "MANIFEST.json"));
    await fs.writeFile(path.join(output, "consumer-results.json"), JSON.stringify(results, null, 2) + "\n");
  }
  if (scratch) {
    const safeRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(path.resolve(scratch)), safeRoot);
    assert(path.basename(scratch).startsWith("luckyray-sdk-consumer-"));
    await fs.rm(scratch, { recursive: true, force: true }); // Only this run's uniquely owned temp directory.
  }
});

test("local tarball contains verified public docs/types/tools and all six example sources, no host or stale packs", async () => {
  const metadata = await json(path.join(installed, "package.json"));
  assert.equal(metadata.version, "1.0.1"); assert.equal(metadata.types, "index.d.ts");
  const manifest = results.manifest;
  assert.equal(manifest.scriptApiVersion, 1);
  for (const [relative, fact] of Object.entries(manifest.files)) {
    const bytes = await fs.readFile(path.join(installed, relative));
    assert.equal(sha(bytes), fact.sha256, relative); assert.equal(bytes.length, fact.bytes);
    assert(!/[A-Z]:[\\/]codex|C:[\\/]Users[\\/]/.test(bytes.toString()), `${relative} exposes an engineering path`);
  }
  for (const name of templates) {
    await fs.access(path.join(installed, "examples", name, "main.js"));
    await assert.rejects(fs.access(path.join(installed, "examples", name, `example.${name}.lrpack.json`)));
  }
  for (const file of ["README.zh-CN.md", "DELIVERY.md", "COMPATIBILITY.md", "export-sdk.mjs"]) await fs.access(path.join(installed, file));
  assert.equal(sha((await fs.readFile(path.join(installed, "material-library-consumer.js"), "utf8")).replace(/\r\n/g, "\n")), "f404a55011dd6cab5979c2591e12b316868f1466126008866c65a247e82a4bee");
  const reexport = path.join(scratch, "second export");
  run([path.join(installed, "export-sdk.mjs"), reexport]);
  assert.deepEqual(await json(path.join(reexport, "MANIFEST.json")), manifest);
  run([path.join(installed, "export-sdk.mjs"), reexport], scratch, 1);
  await fs.appendFile(path.join(reexport, "README.md"), "\nchanged\n");
  run([path.join(reexport, "export-sdk.mjs"), path.join(scratch, "tampered")], scratch, 1);
  results.cases.push("package allowlist/hashes/re-export tamper refusal PASS");
});

test("installed CLI scaffolds, builds and packages hello plus every template with strict types", async () => {
  assert(tsc, "Set LR_SDK_TSC to an installed TypeScript5.8 compiler for delivery verification");
  for (const name of ["hello", ...templates]) {
    const project = await create(name, name === "hello" ? undefined : name);
    run([cli, "check", project]);
    run([tsc, "-p", path.join(project, "jsconfig.json")]);
    run([cli, "pack", project]);
    const config = await json(path.join(project, "plugin.json"));
    const pkg = await json(path.join(project, `${config.id}.lrpack.json`));
    assert.equal(pkg.manifest.apiVersion, 1); assert.equal(pkg.manifest.schemaVersion, 1);
    assert(!pkg.resource.code.includes("../../index.d.ts"));
    assert(!pkg.resource.code.includes(sdk));
    assert.deepEqual(pkg.resource.contributions, config.contributions);
  }
  results.cases.push("hello+six templates standalone check/strict build/pack PASS");
});

test("installed CLI matches native authoring negatives without executing source, grants or compatibility inference", async () => {
  const project = await create("negative");
  const base = await json(path.join(project, "plugin.json"));
  for (const [change, error] of [
    [{ version: "01.0.0" }, "invalid-manifest"], [{ minHostVersion: "1.0.000" }, "invalid-manifest"],
    [{ name: "\u0000name" }, "invalid-manifest"], [{ name: "中".repeat(54) }, "invalid-manifest"],
    [{ requiredModules: "materials" }, "invalid-modules"], [{ requiredModules: ["Materials"] }, "invalid-modules"],
    [{ requiredPermissions: ["materials.read"] }, "permission-module-required"], [{ requiredPermissions: ["materials.import"] }, "unsupported-permission"],
    [{ schemaVersion: 1 }, "invalid-manifest-fields"], [{ dataVersion: 4294967296 }, "invalid-script"],
    [{ contributions: [{ id: "x", label: "x", kind: "html" }] }, "invalid-contribution"],
    [{ contributions: [{ id: "x", label: "x", kind: "panel", html: "x" }] }, "invalid-contribution"],
    [{ contributions: [{ id: "x", label: "x", kind: "panel" }, { id: "x", label: "x", kind: "page" }] }, "invalid-contribution"],
  ]) {
    await writeJson(path.join(project, "plugin.json"), { ...base, ...change });
    assert(run([cli, "check", project], scratch, 1).stderr.includes(error));
  }
  await writeJson(path.join(project, "plugin.json"), { ...base, requiredModules: ["future-module"] });
  run([cli, "check", project]); // Syntactically valid; only native compatibility can declare availability.
  const marker = path.join(project, "source-executed");
  await fs.writeFile(path.join(project, "main.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");`);
  run([cli, "check", project]); await assert.rejects(fs.access(marker));
  run([cli, "create", project], scratch, 1);
  run([cli, "create", path.join(consumer, "traversal"), "--template", "../private"], scratch, 1);
  results.cases.push("authoring negative inputs/new-directory/no-execution PASS");
});

test("installed types enforce required inputs, empty params, exact library scope and unavailable API", async () => {
  const project = path.join(consumer, "hello");
  const negativeTypes = '/// <reference path="./sdk.d.ts" />\nLuckyRay.call("data.get");\nLuckyRay.call("materials.library.read", {libraryId:"A",requestId:"read-1",id:"selected"});\n// @ts-expect-error required input\nLuckyRay.call("materials.read");\n// @ts-expect-error missing explicit library\nLuckyRay.call("materials.library.list", {requestId:"x"});\n// @ts-expect-error empty-input cannot carry identity\nLuckyRay.call("data.get", {pluginId:"other"});\n// @ts-expect-error unsupported public import API\nLuckyRay.call("materials.import", {});\n// @ts-expect-error extra authority cannot be supplied\nLuckyRay.call("knowledge.create", {title:"x",content:"x",scope:"other"});\n';
  await fs.writeFile(path.join(project, "consumer-types.ts"), negativeTypes);
  run([tsc, "--strict", "--noEmit", "--target", "ES2020", "--lib", "ES2020", path.join(project, "consumer-types.ts")]);
  results.cases.push("public ambient types positive+negative compile PASS");
});

test("final encoded package budget includes newline and rejects oversized output before replacing a package", async () => {
  const project = await create("budget");
  run([cli, "pack", project]);
  const config = await json(path.join(project, "plugin.json"));
  const output = path.join(project, `${config.id}.lrpack.json`);
  const pkg = await json(output);
  // Valid JS comment; each newline costs two bytes in JSON but one in source.
  const base = "/*\n*/\nLuckyRay.register(()=>({title:'budget'}));";
  pkg.resource.code = base;
  const padding = 131072 - Buffer.byteLength(JSON.stringify(pkg)) - 1;
  const source = "/*" + "\n".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2) + base.slice(2);
  await fs.writeFile(path.join(project, "main.js"), source);
  run([cli, "pack", project]);
  const final = await fs.readFile(output);
  assert.equal(final.length, 131072);
  await fs.writeFile(path.join(project, "main.js"), source.replace("/*", "/*x"));
  assert(run([cli, "pack", project], scratch, 1).stderr.includes("extension-package-too-large"));
  assert.deepEqual(await fs.readFile(output), final, "rejected build must not replace the last valid pack");
  results.cases.push("final 128KiB package boundary incl newline PASS");
});

const material = { id: "selected", name: "Public fixture asset", kind: "image", mimeType: "image/png", revision: "r1", storageMode: "managed", tagIds: [] };
function event(action = "run", connected = false) {
  return { input: { contribution: "read", action, fields: { title: "Fixture title" } }, capabilities: ["materials.read", ...(connected ? ["knowledge.create"] : [])], objects: { materials: ["selected"], knowledge: connected ? { vaultId: "fixture-vault", documents: [] } : null, canvases: [] }, theme: {} };
}
async function invoke(source, input, respond) {
  const calls = [];
  return await new Promise((resolve, reject) => {
    const child = spawn(worker, ["--extension-worker"], { cwd: scratch, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let result, failure, stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(Error("bounded actual worker deadline exceeded")); }, 6000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stderr.on("data", bytes => { stderr += bytes.toString(); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.kind === "call") { calls.push(message.request); child.stdin.write(JSON.stringify(respond(message.request, calls)) + "\n"); }
        else if (message.kind === "result") result = message.result;
        else throw Error("Unexpected worker message");
      } catch (error) { failure = error; child.kill(); }
    });
    child.on("close", code => {
      clearTimeout(timer); lines.close();
      if (failure || code !== 0 || !result) reject(failure || Error(`worker exit ${code}: ${stderr}`));
      else resolve({ result, calls });
    });
    child.stdin.write(JSON.stringify({ source, event: input }) + "\n");
  });
}

test("actual QuickJS runs installed consumer; controlled read refusal and unknown write never fallback/retry", { skip: !worker }, async () => {
  const source = await fs.readFile(path.join(consumer, "material-reader/main.js"), "utf8");
  const success = await invoke(source, event(), () => ({ value: [material] }));
  assert.equal(success.result.ok, true); assert(success.result.value.text.includes(material.name));
  assert.deepEqual(success.calls.map(call => call.method), ["materials.list"]);
  const denied = await invoke(source, event(), () => ({ error: "plugin-permission-denied" }));
  assert.equal(denied.result.value.title, "Materials unavailable"); assert.equal(denied.calls.length, 1);
  const absent = await invoke(source, event("note"), () => ({ value: [material] }));
  assert.equal(absent.result.value.title, "Connection required"); assert.equal(absent.calls.length, 1);
  const unknown = await invoke(source, event("note", true), call => call.method === "materials.list" ? { value: [material] } : { error: "capture-commit-uncertain" });
  assert.equal(unknown.result.value.title, "Write not confirmed");
  assert.deepEqual(unknown.calls.map(call => call.method), ["materials.list", "knowledge.create"]);
  const unavailable = await invoke('LuckyRay.register(async()=>{try{await LuckyRay.call("materials.library.list",{libraryId:"fixture",requestId:"id"});}catch(error){return {title:"Unavailable",text:error.message};}});', event(), () => ({ error: "plugin-method-unavailable" }));
  assert.equal(unavailable.result.value.text, "plugin-method-unavailable"); assert.equal(unavailable.calls.length, 1);
  const capabilities = await invoke('LuckyRay.register(()=>({title:"Boundary",text:[typeof process,typeof require,typeof fetch,typeof document].join(",")}));', event(), () => ({ error: "unused" }));
  assert.equal(capabilities.result.value.text, "undefined,undefined,undefined,undefined");
  results.cases.push("actual QuickJS: selected read/refusal/explicit optional connection/unknown once/API unavailable/no ambient authority PASS; RPC adapter controlled");
});

test("actual QuickJS page template echoes saved note/count for null and primitive owned JSON; manifest unknown wording is conservative", { skip: !worker }, async () => {
  const source = await fs.readFile(path.join(consumer, "page-desk/main.js"), "utf8");
  for (const settings of [null, "primitive", [], { views: 3, note: "old" }]) {
    const input = { ...event("save"), input: { contribution: "board", action: "save", fields: { note: "new note" } } };
    const reply = await invoke(source, input, call => ({ value: call.method === "data.get" ? { schemaVersion: 1, revision: 1, settings, cache: null } : call.params }));
    assert.equal(reply.result.ok, true); assert.equal(reply.result.value.fields[0].value, "new note");
    assert(reply.result.value.text.includes(`已保存次数：${settings?.views === 3 ? 4 : 1}`));
    assert.deepEqual(reply.calls.map(call => call.method), ["data.get", "data.set"]);
  }
  const manifest = await fs.readFile(path.join(consumer, "material-manifest/main.js"), "utf8");
  const input = { ...event("note", true), input: { contribution: "run", action: "note", fields: {} } };
  const reply = await invoke(manifest, input, call => call.method === "data.get" ? { value: { schemaVersion: 1, revision: 0, settings: null, cache: "primitive" } } : call.method === "materials.list" ? { value: [material] } : { error: "plugin-worker-ended" });
  assert(reply.result.value.text.includes("结果未核实"));
  assert.equal(reply.calls.filter(call => call.method === "knowledge.create").length, 1);
  results.cases.push("actual QuickJS: page saved echo/owned JSON guards/manifest unknown once PASS; RPC adapter controlled");
});
