// Local HTTP fixtures only. No upstream request, runner, archive execution or app build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { collectSource, readPublicInputs } from "./collect-macos-source-evidence.mjs";

test("reviewed manifest retains all twelve exact recipe inputs and separate unresolved closures", async () => {
  const { inputs, unresolvedClosures, unresolvedRequirementIds } = await readPublicInputs();
  assert.equal(inputs.length, 12);
  assert.equal(inputs.filter(input => input.officialChecksum).length, 5);
  assert.equal(inputs.filter(input => input.reviewedPin).length, 12);
  assert.equal(unresolvedClosures.length, 4);
  assert.deepEqual(unresolvedRequirementIds, unresolvedClosures);
});

test("HTTP evidence keeps exact bytes, errors, interruption and official mismatch distinct", async t => {
  const bytes = Buffer.from("diff --git a/source b/source\n--- a/source\n+++ b/source\n+fixture\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const server = createServer((request, response) => {
    if (request.url === "/error") {
      response.writeHead(503).end("temporary upstream failure");
    } else if (request.url === "/interrupted") {
      response.writeHead(200, { "Content-Length": bytes.length + 20 });
      response.write(bytes);
      setImmediate(() => response.destroy());
    } else if (request.url === "/timeout") {
      response.writeHead(200);
      response.flushHeaders();
    } else if (request.url === "/oversized") {
      response.writeHead(200, { "Content-Length": bytes.length });
      response.end(bytes);
    } else {
      response.writeHead(200, { "Content-Length": bytes.length });
      response.end(bytes);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options) => fetch(`${localOrigin}${new URL(url).pathname}`, options);
  const source = (path, sha256 = digest) => ({
    id: "offline-fixture", kind: "patch", url: `https://fixture.invalid${path}`,
    officialChecksum: { sha256, sourceUrl: "https://fixture.invalid/checksum" },
  });
  const complete = await collectSource(source("/complete"), { request });
  assert.equal(complete.status, "download-complete-awaiting-source-review");
  assert.equal(complete.bytes, bytes.length);
  assert.equal(complete.sha256, digest);
  assert.equal(complete.officialChecksum.comparison, "match");
  assert.equal(complete.officialChecksum.sourceRetrievedInThisRun, false);
  assert.equal(complete.sourceQualification, "not-performed");

  const mismatch = await collectSource(source("/complete", "0".repeat(64)), { request });
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.failure, "official-sha256-mismatch");
  assert.equal(mismatch.bytes, bytes.length);
  assert.equal(mismatch.sha256, digest);
  assert.equal(mismatch.officialChecksum.comparison, "mismatch");

  const pinned = { ...source("/complete"), reviewedPin: { sha256: digest, bytes: bytes.length } };
  assert.equal((await collectSource(pinned, { request })).reviewedPin.comparison, "match");
  for (const reviewedPin of [{ sha256: digest, bytes: bytes.length + 1 }, { sha256: "0".repeat(64), bytes: bytes.length }]) {
    const changed = await collectSource({ ...pinned, reviewedPin }, { request });
    assert.equal(changed.status, "failed");
    assert.equal(changed.failure, "reviewed-source-pin-mismatch");
    assert.equal(changed.reviewedPin.comparison, "mismatch");
  }

  for (const [path, failure, options] of [
    ["/error", "http-status-not-200", {}],
    ["/interrupted", null, {}],
    ["/timeout", "timeout", { timeoutMs: 100 }],
    ["/oversized", "byte-limit-exceeded", { maxBytes: bytes.length - 1 }],
  ]) {
    const result = await collectSource(source(path), { request, ...options });
    assert.equal(result.status, "failed", path);
    if (failure) assert.equal(result.failure, failure, path);
    else assert.ok(["body-transfer-interrupted", "transport-failed"].includes(result.failure));
    assert.equal(result.bytes, null, path);
    assert.equal(result.sha256, null, path);
    assert.equal(result.officialChecksum.comparison, "not-performed", path);
  }
});
