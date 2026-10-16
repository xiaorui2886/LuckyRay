import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { ORIGIN, FEED, REPOSITORY, sha256, encryptedRoot, restoreProof, rawPublicKey, decodePublicKey, verifyEnvelope, publicationPlan, validatePublicationBundle, validateCandidate, publishReviewed, anonymousReadback } from "./dsh-production-maintenance.mjs";

// Explicit engineering keys exist only in memory. No init command, production
// storage/root receipt, publication or runtime installation occurs in tests.
const passphrase = "unit-test-only-ephemeral-strong-passphrase";
test("encrypted PKCS8 Ed25519 requires the secret and proves restored backup signing", () => {
  const root = encryptedRoot(passphrase);
  assert.match(root.encrypted.toString(), /^-----BEGIN ENCRYPTED PRIVATE KEY-----/u);
  assert.throws(() => createPrivateKey(root.encrypted));
  assert.throws(() => restoreProof(root.encrypted, "wrong passphrase", root.publicKey));
  const proof = restoreProof(root.encrypted, passphrase, root.publicKey);
  assert.equal(proof.verified, true); assert.equal(sha256(Buffer.from(proof.challenge, "base64url")), proof.challengeSha256);
  const restored = createPrivateKey({ key: root.encrypted, passphrase });
  assert.equal(rawPublicKey(createPublicKey(restored)).toString("hex"), root.publicKey.toString("hex"));
  assert.throws(() => restoreProof(Buffer.from(restored.export({ type: "pkcs8", format: "pem" })), passphrase, root.publicKey));
});
test("root length and canonical public encoding reject malformed input", () => {
  assert.throws(() => encryptedRoot("short"));
  assert.throws(() => decodePublicKey("a"));
  assert.throws(() => decodePublicKey("A".repeat(42) + "B"));
});

const descriptionPath = process.env.DSH_QUALIFIED_NEW_DESCRIPTION;
const contract = { hostVersion: "1.9.4", adapterFingerprint: "f4472926e623bbb75f5813bb2e7d741e5cae2f6328d7be4626b12168fbacf4c9", resourceGateSha256: "caa8cc5c07680c2b4f985aa4f82d5a48d4ed37cfec7ee9936d450872e2a7d913" };
function fixture() {
  const descriptor = readFileSync(descriptionPath), q = JSON.parse(descriptor).qualification;
  const candidate = { schema: 1, channel: "preview", runtimePackage: "@deepseek-ai/dsh", issuedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: Math.floor(Date.now() / 1000) + 86400,
    ...contract, platform: "windows-x86_64", fromVersions: ["0.1.5-rc.2"], version: q.authority.runtimePackage.version,
    nodeSha256: q.authority.nodeRuntime.nodeExeSha256, entrySha256: q.dependencyAudit.entryPoint.fileSha256,
    artifactUrl: `${ORIGIN}descriptors/${sha256(descriptor)}.json`, artifactSha256: sha256(descriptor), artifactBytes: descriptor.length,
    closureSha256: "a".repeat(64), closureFileCount: q.authority.dependencyClosure.releaseLayout.fileCount, dataCompatibility: "no-migration",
    assembly: { schema: 2, kind: "official-npm-qualified-win-x64-v2", toolset: "node22.19.0-pnpm11.7.0-policy1" } };
  const pair = generateKeyPairSync("ed25519"), key = rawPublicKey(pair.publicKey).toString("base64url");
  const envelopeFor = value => { const payload = Buffer.from(JSON.stringify(value)); return Buffer.from(JSON.stringify({ payload: payload.toString("base64url"), signature: sign(null, payload, pair.privateKey).toString("base64url") })); };
  return { descriptor, candidate, key, envelopeFor, envelope: envelopeFor(candidate) };
}
const genuine = { skip: !descriptionPath };
test("signed catalog binds genuine qualification but upstream latest gives no permission", genuine, () => {
  const f = fixture(); assert.equal(verifyEnvelope(f.envelope, f.key, f.descriptor, contract).version, "0.1.7-rc.2");
  const wrongKey = rawPublicKey(generateKeyPairSync("ed25519").publicKey).toString("base64url");
  assert.throws(() => verifyEnvelope(f.envelope, wrongKey, f.descriptor, contract), /signature-invalid/u);
  const envelope = JSON.parse(f.envelope); envelope.payload = Buffer.from("{}").toString("base64url");
  assert.throws(() => verifyEnvelope(Buffer.from(JSON.stringify(envelope)), f.key, f.descriptor, contract));
});
test("expired/future/host/adapter/data/tool/hash/size and cross-repository targets fail", genuine, () => {
  const f = fixture();
  for (const change of [c => c.expiresAt = c.issuedAt, c => c.issuedAt = c.expiresAt - 100,
    c => c.hostVersion = "1.9.5", c => c.adapterFingerprint = "b".repeat(64), c => c.resourceGateSha256 = "b".repeat(64),
    c => c.version = "0.9.9", c => c.dataCompatibility = "migration", c => c.assembly.toolset = "unknown",
    c => c.artifactBytes++, c => c.artifactSha256 = "b".repeat(64), c => c.artifactUrl = `https://raw.githubusercontent.com/other/repo/main/a.json`,
    c => c.artifactUrl += "?token=secret", c => c.artifactUrl = c.artifactUrl.replace("https:", "http:"), c => c.extra = "run-code"]) {
    const candidate = structuredClone(f.candidate); change(candidate);
    assert.throws(() => verifyEnvelope(f.envelopeFor(candidate), f.key, f.descriptor, contract));
  }
  assert.throws(() => validateCandidate(f.candidate, Buffer.from("{}"), contract));
});
test("public allowlist contains exactly README/signed catalog/content-addressed descriptor", genuine, () => {
  const f = fixture(), bundle = publicationPlan(f.envelope, f.key, f.descriptor, contract);
  assert.equal(bundle.plan.repository, REPOSITORY); assert.equal(bundle.plan.feedUrl, FEED);
  assert.deepEqual([...bundle.files.keys()], ["README.md", `descriptors/${sha256(f.descriptor)}.json`, "catalog/preview/windows-x86_64.json"]);
  validatePublicationBundle(bundle);
  bundle.files.set("secret.pem", Buffer.from("secret")); assert.throws(() => validatePublicationBundle(bundle));
  bundle.files.delete("secret.pem"); bundle.files.get("README.md")[0] ^= 1;
  assert.throws(() => publishReviewed(bundle, bundle.planSha256)); // fails BEFORE GitHub writes
});
test("readback sends no authorization, rejects redirects and checks exact signed bytes (mock, not online proof)", genuine, async t => {
  const f = fixture(), bundle = publicationPlan(f.envelope, f.key, f.descriptor, contract);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, undefined);
    assert.ok(url.startsWith(ORIGIN)); const bytes = bundle.files.get(url.slice(ORIGIN.length));
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  });
  assert.equal((await anonymousReadback(bundle)).outcome, "ANONYMOUS_HTTPS_SIGNATURE_VERIFIED");
});
test("readback network error, declared oversize and changed bytes are failures (mock)", genuine, async t => {
  const f = fixture(), bundle = publicationPlan(f.envelope, f.key, f.descriptor, contract);
  t.mock.method(globalThis, "fetch", async () => new Response("offline", { status: 503 }));
  await assert.rejects(() => anonymousReadback(bundle), /anonymous-network-rejected/u);
  globalThis.fetch = async () => new Response("x", { status: 200, headers: { "content-length": "999999999" } });
  await assert.rejects(() => anonymousReadback(bundle), /anonymous-network-rejected/u);
  globalThis.fetch = async () => new Response("changed", { status: 200 });
  await assert.rejects(() => anonymousReadback(bundle), /anonymous-bytes-mismatch/u);
});
function fakeGithub(overrides = {}) {
  const writes = [], previous = overrides.previous ?? new Map();
  const gitSha = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const api = (args, body) => {
    if (args[0] === `repos/${REPOSITORY}`) return { full_name: REPOSITORY, private: false, default_branch: "main", ...overrides.repo };
    if (args[0].includes("/git/trees/")) return { truncated: false, tree: overrides.tree ?? [] };
    if (args[0].includes("/git/blobs/")) {
      const wanted = args[0].split("/git/blobs/")[1], bytes = [...previous.values()].find(x => gitSha(x) === wanted);
      assert.ok(bytes); return { sha: wanted, size: bytes.length, encoding: "base64", content: bytes.toString("base64"), ...overrides.blob };
    }
    const path = args[0].split("/contents/")[1].split("?")[0];
    if (body) { writes.push({ path, body }); return { commit: { sha: "a".repeat(40) } }; }
    if (previous.has(path)) {
      const bytes = previous.get(path), large = bytes.length > 1024 * 1024;
      return { type: "file", encoding: large ? "none" : "base64", content: large ? "" : bytes.toString("base64"), size: bytes.length, sha: gitSha(bytes) };
    }
    const error = new Error("not found"); error.stderr = "404"; throw error;
  };
  return { api, writes };
}
test("publisher is conditional, descriptor-before-catalog, immutable and rejects unknown content (mock only)", genuine, () => {
  const f = fixture(), bundle = publicationPlan(f.envelope, f.key, f.descriptor, contract), github = fakeGithub();
  assert.throws(() => publishReviewed(bundle, "0".repeat(64), github.api), /reviewed-plan-mismatch/u); assert.equal(github.writes.length, 0);
  publishReviewed(bundle, bundle.planSha256, github.api);
  assert.equal(github.writes.at(-1).path, "catalog/preview/windows-x86_64.json");
  assert.equal(github.writes.find(x => x.path.startsWith("descriptors/")).body.content, f.descriptor.toString("base64"));
  for (const overrides of [{ repo: { private: true } }, { tree: [{ type: "blob", mode: "100644", path: "source.rs", size: 1 }] },
    { tree: [{ type: "blob", mode: "120000", path: "README.md", size: 1 }] },
    { previous: new Map([["catalog/preview/windows-x86_64.json", fixture().envelope]]) },
    { previous: new Map([[`descriptors/${sha256(f.descriptor)}.json`, Buffer.from("conflicting immutable bytes")]]) }]) {
    const badGithub = fakeGithub(overrides); assert.throws(() => publishReviewed(bundle, bundle.planSha256, badGithub.api));
    assert.ok(!badGithub.writes.some(x => x.path.startsWith("catalog/")));
  }
});

test("existing large immutable descriptor uses its exact Git blob, not an empty Contents body (mock)", genuine, () => {
  const f = fixture(), bundle = publicationPlan(f.envelope, f.key, f.descriptor, contract);
  assert.ok(f.descriptor.length > 1024 * 1024);
  const previous = new Map([...bundle.files]), github = fakeGithub({ previous });
  const receipt = publishReviewed(bundle, bundle.planSha256, github.api);
  assert.equal(github.writes.length, 0); assert.ok(receipt.results.every(x => x.unchanged));
  const bad = fakeGithub({ previous, blob: { sha: "0".repeat(40) } });
  assert.throws(() => publishReviewed(bundle, bundle.planSha256, bad.api), /publication-existing-shape-invalid/u);
  assert.equal(bad.writes.length, 0);
});
