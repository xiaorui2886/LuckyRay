import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFrozenCacheRelay } from "./dsh-frozen-cache-relay.mjs";

const bytes = Buffer.from("authenticated-tarball-test-bytes");
const input = { name: "@deepseek-ai/test", version: "0.1.7-rc.2", bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  url: "https://registry.npmjs.org/@deepseek-ai/test/-/test-0.1.7-rc.2.tgz" };
async function scratch(fn) {
  const root = await mkdtemp(join(tmpdir(), "luckyray-frozen-cache-test-"));
  try { return await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); } // Only this newly generated test directory.
}
const ownUrl = (relay) => relay.registry + "@deepseek-ai/test/-/test-0.1.7-rc.2.tgz";
test("cache serves only fixed verified bytes; closing it ends access", async () => scratch(async (root) => {
  await writeFile(join(root, input.sha256 + ".tgz"), bytes);
  const relay = await openFrozenCacheRelay([input], root);
  try {
    const response = await fetch(ownUrl(relay));
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.deepEqual(relay.statistics(), { requests: 1, rejected: 0, bytesServed: bytes.length,
      tarballRequests: 1, metadataRequests: 0, uncachedAttestationRequests: 0, droppedConnections: 0, upstreamRequestsByRelay: 0 });
  } finally { await relay.close(); }
  await assert.rejects(fetch(ownUrl(relay)));
}));
test("unknown endpoints, metadata and methods cannot resolve or proxy", async () => scratch(async (root) => {
  const relay = await openFrozenCacheRelay([input], root);
  try {
    for (const suffix of ["@deepseek-ai/test", "other/-/other-1.0.0.tgz"]) assert.equal((await fetch(relay.registry + suffix)).status, 404);
    assert.equal((await fetch(ownUrl(relay), { method: "POST" })).status, 404);
    assert.equal((await fetch(relay.registry + "unknown")).status, 404);
    assert.equal((await fetch(ownUrl(relay))).status, 404); // Fixed total request budget exhausted.
    assert.equal(relay.statistics().upstreamRequestsByRelay, 0);
  } finally { await relay.close(); }
}));
test("concurrent tarball retries cannot exceed twice the fixed input byte budget", async () => scratch(async (root) => {
  await writeFile(join(root, input.sha256 + ".tgz"), bytes);
  const relay = await openFrozenCacheRelay([input], root);
  try {
    const responses = await Promise.all([1, 2, 3].map(() => fetch(ownUrl(relay))));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 409]);
    assert.equal(relay.statistics().bytesServed, bytes.length * 2);
    assert.equal(relay.statistics().rejected, 1);
  } finally { await relay.close(); }
}));
test("missing, same-length tampered, and hardlinked input is rejected", async () => scratch(async (root) => {
  const path = join(root, input.sha256 + ".tgz"), relay = await openFrozenCacheRelay([input], root);
  try {
    assert.equal((await fetch(ownUrl(relay))).status, 409);
    await writeFile(path, Buffer.alloc(bytes.length));
    assert.equal((await fetch(ownUrl(relay))).status, 409);
    await writeFile(path, bytes); await link(path, join(root, "alias.tgz"));
    assert.equal((await fetch(ownUrl(relay))).status, 409);
    assert.equal(relay.statistics().bytesServed, 0);
  } finally { await relay.close(); }
}));
test("unsupported host/name/version, duplicate inputs and budgets are rejected before bind", async () => {
  for (const changed of [{ url: input.url.replace("registry.npmjs.org", "example.com") }, { name: "../escape" },
    { version: "latest" }, { sha256: "../escape" }, { bytes: 0 }, { bytes: 256 * 1024 * 1024 + 1 }]) {
    await assert.rejects(openFrozenCacheRelay([{ ...input, ...changed }], "unused"));
  }
  await assert.rejects(openFrozenCacheRelay([], "unused"));
  await assert.rejects(openFrozenCacheRelay([input, input], "unused"));
  for (const publishedAt of ["missing", "2099-01-01T00:00:00.000Z", "2026-09-01", "2026-19-01T00:00:00.000Z"]) {
    await assert.rejects(openFrozenCacheRelay([input], "unused", [{ ...input, integrity: "sha512-YQ==", publishedAt }]));
  }
  const time = { ...input, integrity: "sha512-YQ==", publishedAt: "2026-09-01T00:00:00.000Z" };
  await assert.rejects(openFrozenCacheRelay([input], "unused", [time, time]));
});
test("frozen publication-time subset does not serve latest or unbound versions", async () => scratch(async (root) => {
  const publishedAt = "2026-09-01T00:00:00.000Z";
  const relay = await openFrozenCacheRelay([input], root, [{ ...input, integrity: "sha512-YQ==", publishedAt }]);
  try {
    const response = await fetch(relay.registry + "@deepseek-ai%2Ftest");
    const meta = await response.json();
    assert.equal(meta.time[input.version], publishedAt);
    assert.deepEqual(Object.keys(meta.versions), [input.version]);
    assert.equal(meta["dist-tags"], undefined); assert.equal(meta.modified, undefined);
    assert.equal((await fetch(relay.registry + "-/npm/v1/attestations/@deepseek-ai/test@0.1.7-rc.2")).status, 404);
    assert.equal(relay.statistics().uncachedAttestationRequests, 1);
    assert.equal(relay.statistics().rejected, 0);
    assert.equal((await fetch(relay.registry + "@deepseek-ai/test/latest")).status, 404);
  } finally { await relay.close(); }
}));
