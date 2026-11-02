import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, chmod, link, symlink, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { APP, TAURI } from "../scripts/macos-build-common.mjs";
import { NODE_INPUT } from "../scripts/prepare-macos-node-input.mjs";
import { runtimeSeal, sealRows } from "../scripts/macos-lsh-seal.mjs";
import { readProbePatch } from "../src-tauri/macos-lsh/host-support.mjs";
const sha = data => createHash("sha256").update(data).digest("hex");
const root = { kind: "directory", path: "" };
const file = { kind: "file", path: "a", size: 1, executable: false, sha256: sha("x") };

test("canonical tree commits to names, bytes, execute bits and empty directories", () => {
  const expected = sha(`luckyray-macos-lsh-tree-v1\x00D\x00\nF\x00a\x001\x000\x00${sha("x")}\n`);
  assert.equal(sealRows([file, root]).sha256, expected);
  assert.equal(sealRows([root, file]).sha256, expected);
  for (const rows of [[root, { ...file, executable: true }], [root, { ...file, sha256: sha("y") }],
    [root, { ...file, path: "b" }], [root, file, { kind: "directory", path: "extra" }]])
    assert.notEqual(sealRows(rows).sha256, expected);
});
test("malformed, duplicate and escaping inventory entries fail", () => {
  for (const path of ["/escape", "../escape", "a/../b", "a//b", "a/./b", "a\\b", "a\0b", "a\nb"])
    assert.throws(() => sealRows([root, { ...file, path }]));
  assert.throws(() => sealRows([root, file, file]));
  assert.throws(() => sealRows([root, { ...file, size: 512 * 1024 * 1024 + 1 }]));
  assert.throws(() => sealRows([root, { ...file, sha256: "f" }]));
});
async function fixture(operation) {
  await mkdir(join(TAURI, "target"), { recursive: true });
  const path = await mkdtemp(join(TAURI, "target/macos-lsh-seal-test-"));
  await chmod(path, 0o700);
  try { await writeFile(join(path, "a"), "x", { mode: 0o600, flag: "wx" }); await operation(path); }
  finally { await rm(path, { recursive: true, force: true }); }
}
test("actual data inventory refuses links and unsafe writes", () => fixture(async path => {
  const first = await runtimeSeal(path);
  await symlink(join(path, "a"), join(path, "alias"));
  await assert.rejects(runtimeSeal(path), /linked-entry/); await unlink(join(path, "alias"));
  await link(join(path, "a"), join(path, "alias"));
  await assert.rejects(runtimeSeal(path), /file-invalid/); await unlink(join(path, "alias"));
  await chmod(join(path, "a"), 0o666);
  await assert.rejects(runtimeSeal(path), /file-invalid/); await chmod(join(path, "a"), 0o600);
  assert.equal((await runtimeSeal(path)).closure.sha256, first.closure.sha256);
}));
test("only the root non-code receipt has a separate compilation-time pin", () => fixture(async path => {
  const first = await runtimeSeal(path);
  await writeFile(join(path, "macos-build.json"), "non-authoritative receipt bytes", { flag: "wx", mode: 0o600 });
  assert.equal((await runtimeSeal(path)).closure.sha256, first.closure.sha256);
  await mkdir(join(path, "nested"), { mode: 0o700 });
  await writeFile(join(path, "nested/macos-build.json"), "extra", { flag: "wx", mode: 0o600 });
  assert.notEqual((await runtimeSeal(path)).closure.sha256, first.closure.sha256);
}));
test("compiled authority, frozen inputs and product material index stay bound", async () => {
  const bytes = await readFile(join(TAURI, "macos-lsh-authority.json"));
  const authority = JSON.parse(bytes);
  const source = await readFile(join(TAURI, "src/dsh_runtime_seal/macos_runtime.rs"), "utf8");
  assert(source.includes(`const AUTHORITY_SHA: &str = "${sha(bytes)}"`));
  assert.deepEqual(authority.nodeInput, NODE_INPUT);
  const upstream = JSON.parse(await readFile(join(APP, "dsh-host/runtime-authority.json")));
  assert.deepEqual(authority.runtimePackage, upstream.runtimePackage);
  assert.equal(authority.lockfileSha256, sha(await readFile(join(APP, "dsh-host/pnpm-lock.yaml"))));
  assert.equal(authority.sourceMaterialIndexSha256, sha(await readFile(join(APP, "third-party-notices/macos-dsh/INDEX.json"))));
  assert.equal(authority.criticalFiles[0].sha256, "0d005c18e095027ca8f9fe1cc1126f767ee4ad7b004f4d6fb781ec4228a7c5d1");
  assert.deepEqual(authority.nodeCodeDirectoryHashes, ["348bf6d84161a4342654c4cbbe669e0d927806d5"]);
  const host = await readFile(join(TAURI, "src/dsh_host.rs"), "utf8");
  const helper = await readFile(join(TAURI, "macos-lsh/host-support.mjs"));
  assert(host.includes(`const MACOS_HOST_SUPPORT_SHA256: &str = "${sha(helper)}"`));
  const config = JSON.parse(await readFile(join(TAURI, "tauri.macos.conf.json")));
  assert.equal(config.bundle.resources["macos-lsh/host-support.mjs"], "lr-lsh/199-1/dsh-host/luckyray-dsh-macos.mjs");
  const wrapper = await readFile(join(TAURI, "dsh-host/luckyray-dsh-host.mjs"), "utf8");
  const patch = JSON.parse(wrapper.match(/const DSH_NATIVE_PROBE_PATCH = ("[^\n]+")/)[1]);
  assert.equal(patch, "- id: session-title-llm\n  disabled: true\n");
});
test("managed probe input is read no-follow without replacing conflicts", () => fixture(async path => {
  await readProbePatch(join(path, "a"), "x");
  await symlink(join(path, "a"), join(path, "alias"));
  await assert.rejects(readProbePatch(join(path, "alias"), "x"));
  await unlink(join(path, "alias"));
  await assert.rejects(readProbePatch(join(path, "a"), "conflicting bytes"));
  assert.equal(await readFile(join(path, "a"), "utf8"), "x");
}));
