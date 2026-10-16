import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { workerPaths, workerCliPaths, workerFailureShape, pnpmFailureCode, pnpmCachePolicy, readWorkerDescription } from "./dsh-frozen-assembly-worker.mjs";

test("fixed worker accepts only generated sibling work/stage and bounded native digest pointer", () => {
  const parent = resolve("test-versions");
  const workspace = join(parent, `.assembly-${"a".repeat(32)}`), stage = join(parent, `.stage-${"b".repeat(32)}`);
  assert.equal(workerPaths("plan", workspace, stage, "c".repeat(64), "523992").command, "plan");
  assert.equal(workerPaths("assemble", workspace, stage, "c".repeat(64), "523992").size, 523992);
  for (const args of [
    ["run", workspace, stage, "c".repeat(64), "523992"],
    ["assemble", "relative", stage, "c".repeat(64), "523992"],
    ["assemble", parent, stage, "c".repeat(64), "523992"],
    ["assemble", workspace, join(parent, "other", `.stage-${"b".repeat(32)}`), "c".repeat(64), "523992"],
    ["plan", workspace, stage, "../../command", "523992"],
    ["plan", workspace, stage, "c".repeat(64), "2097153"],
    ["plan", workspace, stage, "c".repeat(64), "0"],
  ]) assert.throws(() => workerPaths(...args), /arguments-invalid/u);
});

test("native worker CLI derives owned paths without expanding the atomic-spawn argument grammar", () => {
  const workspace = join(resolve("test space"), `.assembly-${"a".repeat(32)}`);
  const bundle = join(workspace, "worker"), stageName = `.stage-${"b".repeat(32)}`;
  const args = ["plan", stageName, "c".repeat(64), "523992"];
  assert(args.every((value) => /^[A-Za-z0-9._-]{1,128}$/u.test(value)));
  assert.equal(workerCliPaths(bundle, args).stage, join(dirname(workspace), stageName));
  for (const changed of ["../escape", join(dirname(workspace), stageName), "other", stageName + "/extra"])
    assert.throws(() => workerCliPaths(bundle, ["plan", changed, ...args.slice(2)]), /arguments-invalid/u);
  assert.throws(() => workerCliPaths(bundle, [...args, "extra"]), /arguments-invalid/u);
});

test("worker failure evidence cannot output raw messages, paths, commands or unknown stages", () => {
  assert.deepEqual(workerFailureShape({ message: "secret path", name: "DshSupplyChainError", code: "untrusted-code" }, "portable-seal"),
    { kind: "failure", stage: "portable-seal", category: "seal" });
  assert.deepEqual(workerFailureShape({ message: "secret path", code: "EACCES" }, "some secret path"),
    { kind: "failure", stage: "descriptor", category: "EACCES" });
  assert.equal(pnpmFailureCode("private file path ERR_PNPM_ENAMETOOLONG some private argv"), "ERR_PNPM_ENAMETOOLONG");
  assert.equal(pnpmFailureCode("private message ERR_PNPM_NOT_ON_WHITELIST"), "worker");
  assert.equal(pnpmFailureCode("private prefix EPERMSECRET"), "worker");
  assert.equal(pnpmFailureCode("ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION private data"), "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION");
});

test("offline install uses a fresh detached host, never fetch's linked virtual-store project", async () => {
  const source = await readFile(new URL("./dsh-frozen-assembly-worker.mjs", import.meta.url), "utf8");
  assert(source.includes('runPnpm(acquisition, ["fetch"'));
  assert(source.includes('runPnpm(host, ["install"'));
  assert(source.includes('const host = join(stage, "host")'));
  assert(!source.includes('runPnpm(acquisition, ["install"'));
  assert(source.indexOf('await relay.close()') < source.indexOf('runPnpm(host, ["install"'));
  assert(!source.includes('"minimumReleaseAge=0"'));
  assert(!source.includes('"lockfile-verified.jsonl"'));
});

test("offline metadata namespace reuse never grants a socket or an online fallback", () => {
  const registry = `http://127.0.0.1:43127/${"a".repeat(32)}/`;
  assert.deepEqual(pnpmCachePolicy(registry, true), { registryArg: `--registry=${registry}`, fencePort: "43127", offlineArgs: [] });
  assert.deepEqual(pnpmCachePolicy(registry, false), { registryArg: `--registry=${registry}`, fencePort: "", offlineArgs: ["--offline"] });
  for (const url of ["http://localhost:43127/", "https://registry.npmjs.org/", registry.replace("43127", "70000"), "http://127.0.0.1:43127/", registry + "package", registry + "?token=x", undefined])
    assert.throws(() => pnpmCachePolicy(url, false), /cache-invalid/u);
  assert.throws(() => pnpmCachePolicy(registry, "false"), /cache-invalid/u);
});

test("desktop-style bundle reads genuine descriptor only through the native hash/size pointer", { skip: !process.env.DSH_OFFICIAL_INPUTS_RECORD }, async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-worker-plan-"));
  const bundle = join(root, "worker"), workspace = join(root, `.assembly-${"a".repeat(32)}`);
  await mkdir(join(bundle, "host"), { recursive: true });
  await mkdir(join(bundle, "records")); await mkdir(workspace);
  for (const name of ["package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) await copyFile(resolve("dsh-host", name), join(bundle, "host", name));
  await copyFile(resolve("dsh-host/runtime-authority.json"), join(bundle, "runtime-authority.json"));
  await copyFile(resolve("dsh-host/records/dependency-audit.json"), join(bundle, "records/dependency-audit.json"));
  const bytes = await readFile(process.env.DSH_OFFICIAL_INPUTS_RECORD);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(workspace, "description.json"), bytes, { flag: "wx" });
  const result = await readWorkerDescription(bundle, workspace, hash, bytes.length);
  assert.equal(result.description.packages.length, 516);
  assert.equal(result.description.releaseTimes.length, 591);
  await assert.rejects(readWorkerDescription(bundle, workspace, "0".repeat(64), bytes.length), /description-invalid/u);
  await assert.rejects(readWorkerDescription(bundle, workspace, hash, bytes.length - 1), /description-invalid/u);
  const changed = JSON.parse(bytes); changed.command = "do not execute";
  const changedBytes = Buffer.from(JSON.stringify(changed));
  await writeFile(join(workspace, "description.json"), changedBytes);
  await assert.rejects(readWorkerDescription(bundle, workspace, createHash("sha256").update(changedBytes).digest("hex"), changedBytes.length), /description-invalid/u);
});
