import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as supply from "../scripts/dsh-supply-chain.mjs";

async function fixture(t, version = "2.6.9") {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-distribution-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeModulesRoot = join(root, "node_modules");
  const pkg = join(nodeModulesRoot, "compression", "node_modules", "debug");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(nodeModulesRoot, "compression", "package.json"), JSON.stringify({ name: "compression", version: "1.8.0" }));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "debug", version }));
  await writeFile(join(pkg, "index.js"), "module.exports = 'synthetic runtime';\n");
  return { root, pkg, nodeModulesRoot };
}

test("distribution projection is present and an already-projected tree is idempotent", async (t) => {
  const { pkg, nodeModulesRoot } = await fixture(t);
  assert.equal(typeof supply.projectDshDistributionMetadata, "function");
  assert.deepEqual(await supply.projectDshDistributionMetadata({ nodeModulesRoot }), { schemaVersion: 1, removed: [] });
  assert.deepEqual(await supply.projectDshDistributionMetadata({ nodeModulesRoot }), { schemaVersion: 1, removed: [] });
  assert.equal(await readFile(join(pkg, "index.js"), "utf8"), "module.exports = 'synthetic runtime';\n");
});

test("unexpected development metadata bytes fail closed without deleting any file", async (t) => {
  const { pkg, nodeModulesRoot } = await fixture(t);
  const marker = "synthetic-nonsecret-metadata\n";
  await writeFile(join(pkg, ".coveralls.yml"), marker);
  await assert.rejects(() => supply.projectDshDistributionMetadata({ nodeModulesRoot }), { code: "dsh-distribution-metadata-hash-invalid" });
  assert.equal(await readFile(join(pkg, ".coveralls.yml"), "utf8"), marker);
  assert.equal(await readFile(join(pkg, "index.js"), "utf8"), "module.exports = 'synthetic runtime';\n");
});

test("projection does not remove a different package version or other metadata", async (t) => {
  const { pkg, nodeModulesRoot } = await fixture(t, "4.4.0");
  await writeFile(join(pkg, ".coveralls.yml"), "synthetic-other-version\n");
  await writeFile(join(pkg, "NOTICE"), "synthetic notice\n");
  assert.deepEqual(await supply.projectDshDistributionMetadata({ nodeModulesRoot }), { schemaVersion: 1, removed: [] });
  assert.equal(await readFile(join(pkg, ".coveralls.yml"), "utf8"), "synthetic-other-version\n");
  assert.equal(await readFile(join(pkg, "NOTICE"), "utf8"), "synthetic notice\n");
});
