// Maintainer-only. Never bundled into the client or the assembly worker.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, readdirSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, parse } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { validateQualifiedAssemblyDescription } from "./dsh-frozen-assembly-description.mjs";
import { validateCompatibility } from "./dsh-host-compatibility.mjs";

export const REPOSITORY = "xiaorui2886/luckyray-update-metadata";
export const ORIGIN = `https://raw.githubusercontent.com/${REPOSITORY}/main/`;
export const FEED = `${ORIGIN}catalog/preview/windows-x86_64.json`;
export const PUBLIC_README = "# LuckyRay LSH compatibility metadata\n\nThis repository contains signed compatibility metadata only. Official runtime\narchives are downloaded directly from upstream. Discovery alone never grants\ninstallation permission. Clients pin the production public key in the host.\n\nNo application source, runtime mirror, credentials or user data is published.\nExisting LuckyRay v1.9.4 installers have no configured online update source.\n\nMaintenance and withdrawal require a reviewed signed catalog.\n";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const bad = code => { throw new Error(code); };
const hex = x => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const semver = x => typeof x === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(x);
const keys = (x, names) => {
  if (!x || Array.isArray(x) || typeof x !== "object" || Object.keys(x).sort().join("|") !== names.sort().join("|")) bad("unexpected-fields");
};
const publicKeyObject = raw => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
export function rawPublicKey(key) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== "ed25519") bad("not-ed25519");
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32);
}
export function decodePublicKey(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(encoded)) bad("public-key-invalid");
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== encoded) bad("public-key-invalid");
  return raw;
}

// Path ownership is independently checked in PowerShell. No secret is passed
// to a command argument, environment variable, public plan or stdout.
export function validateSecureDirectory(path) {
  if (process.platform !== "win32") bad("windows-operator-required");
  const guard = fileURLToPath(new URL("./dsh-signing-storage.ps1", import.meta.url));
  const result = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", guard, "-Path", path, "-VerifyOnly"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.trim() !== "SIGNING_STORAGE_VERIFIED") bad("storage-not-verified");
}
function safeFile(path, max) {
  if (!isAbsolute(path)) bad("absolute-path-required");
  let current = resolve(path);
  for (;;) {
    const meta = lstatSync(current);
    if (meta.isSymbolicLink() || realpathSync.native(current).toLowerCase() !== current.toLowerCase()) bad("linked-path-rejected");
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const meta = lstatSync(path);
  if (!meta.isFile() || meta.nlink !== 1 || meta.size < 1 || meta.size > max) bad("file-shape-invalid");
  return readFileSync(path);
}
export function encryptedRoot(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 20 || passphrase.length > 1024) bad("passphrase-length");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { encrypted: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase })), publicKey: rawPublicKey(publicKey) };
}
export function restoreProof(encrypted, passphrase, publicKey) {
  if (!encrypted.toString("utf8").startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----\n")) bad("unencrypted-key-rejected");
  const restored = createPrivateKey({ key: encrypted, passphrase });
  if (!rawPublicKey(restored).equals(publicKey)) bad("restored-key-mismatch");
  const challenge = Buffer.concat([Buffer.from("luckyray-production-root-backup-restore-v1\0"), randomBytes(32)]);
  const signature = sign(null, challenge, restored);
  if (!verify(null, challenge, publicKeyObject(publicKey), signature)) bad("restore-proof-failed");
  return { challenge: challenge.toString("base64url"), challengeSha256: sha256(challenge), signature: signature.toString("base64url"), verified: true };
}
export function initializeRoot({ primary, backupOne, backupTwo, passphrase }) {
  if (![primary, backupOne, backupTwo].every(x => typeof x === "string" && isAbsolute(x))) bad("absolute-private-directories-required");
  const dirs = [primary, backupOne, backupTwo].map(x => resolve(x));
  if (new Set(dirs.map(x => x.toLowerCase())).size !== 3 || dirs.some((x, i) => dirs.some((y, j) => i !== j && x.toLowerCase().startsWith(y.toLowerCase() + "\\")))) bad("backup-not-independent");
  // At least one independently mounted volume, not three copies on one disk.
  if (new Set(dirs.map(x => parse(x).root.toLowerCase())).size < 2) bad("separate-backup-volume-required");
  for (const directory of dirs) { validateSecureDirectory(directory); if (readdirSync(directory).length) bad("storage-not-empty"); }
  const root = encryptedRoot(passphrase), keyName = "production-root.encrypted.pem";
  const stateFile = join(dirs[0], "operator-state.json");
  writeFileSync(stateFile, JSON.stringify({ schema: 1, state: "initialization-incomplete-preserve-files", activation: false }) + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(dirs[0], keyName), root.encrypted, { flag: "wx", mode: 0o600 });
  for (const backup of dirs.slice(1)) copyFileSync(join(dirs[0], keyName), join(backup, keyName), 1);
  for (const directory of dirs) {
    validateSecureDirectory(directory);
    if (!safeFile(join(directory, keyName), 16 * 1024).equals(root.encrypted)) bad("backup-bytes-mismatch");
  }
  // Restore the encrypted backup to the already protected primary directory,
  // decrypt only in memory, prove signing, then remove only this exact copy.
  const restoredPath = join(dirs[0], "backup-restore-proof.encrypted.pem");
  copyFileSync(join(dirs[2], keyName), restoredPath, 1);
  let proof;
  try { proof = restoreProof(safeFile(restoredPath, 16 * 1024), passphrase, root.publicKey); }
  finally { unlinkSync(restoredPath); }
  const receipt = { schema: 1, purpose: "luckyray-production-root", algorithm: "Ed25519", createdAt: new Date().toISOString(),
    keyId: `lsh-${sha256(root.publicKey).slice(0, 16)}`, publicKey: root.publicKey.toString("base64url"), fingerprintSha256: sha256(root.publicKey),
    encryptedKeySha256: sha256(root.encrypted), storageAclVerified: true, backupCount: 2, separateVolume: true, restoreProof: proof,
    activation: "awaiting-central-fingerprint-review" };
  for (const directory of dirs) {
    writeFileSync(join(directory, "public-root-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    writeFileSync(join(directory, "production-public-key.txt"), receipt.publicKey + "\n", { flag: "wx", mode: 0o600 });
  }
  writeFileSync(stateFile, JSON.stringify({ schema: 1, state: "root-and-backup-restore-complete-awaiting-review", fingerprintSha256: receipt.fingerprintSha256, activation: false }) + "\n", { mode: 0o600 });
  root.encrypted.fill(0);
  return receipt; // No local path or operator SID in the shareable receipt.
}

export function validateCandidate(candidate, descriptor, contract, now = Math.floor(Date.now() / 1000)) {
  keys(candidate, ["schema", "channel", "runtimePackage", "issuedAt", "expiresAt", "hostVersion", "adapterFingerprint", "platform", "fromVersions", "version", "nodeSha256", "entrySha256", "artifactUrl", "artifactSha256", "artifactBytes", "closureSha256", "closureFileCount", "dataCompatibility", "resourceGateSha256", "assembly", ...(candidate.schema === 2 ? ["compatibility"] : [])]);
  keys(contract, ["hostVersion", "adapterFingerprint", "resourceGateSha256", ...(Object.hasOwn(contract, "interfaces") ? ["interfaces"] : [])]);
  if (candidate.schema === 2) {
    if (!contract.interfaces) bad("host-interfaces-required");
    validateCompatibility(candidate.compatibility, candidate.hostVersion, contract.interfaces);
    validateCompatibility(candidate.compatibility, contract.hostVersion, contract.interfaces);
  } else if (candidate.schema !== 1 || candidate.hostVersion !== contract.hostVersion
    || candidate.adapterFingerprint !== contract.adapterFingerprint || candidate.resourceGateSha256 !== contract.resourceGateSha256) bad("legacy-host-binding-invalid");
  if (candidate.channel !== "preview" || candidate.platform !== "windows-x86_64" || candidate.runtimePackage !== "@deepseek-ai/dsh"
      || !semver(candidate.version) || !semver(candidate.hostVersion)
      || ![candidate.adapterFingerprint, candidate.resourceGateSha256, candidate.nodeSha256, candidate.entrySha256, candidate.artifactSha256, candidate.closureSha256].every(hex)
      || !Number.isSafeInteger(candidate.issuedAt) || !Number.isSafeInteger(candidate.expiresAt) || candidate.issuedAt < 0 || candidate.issuedAt > now + 300
      || candidate.expiresAt <= now || candidate.expiresAt <= candidate.issuedAt || candidate.expiresAt - candidate.issuedAt > 30 * 86400
      || !Array.isArray(candidate.fromVersions) || !candidate.fromVersions.length || candidate.fromVersions.length > 16
      || new Set(candidate.fromVersions).size !== candidate.fromVersions.length || !candidate.fromVersions.every(semver)
      || candidate.dataCompatibility !== "no-migration" || !Number.isSafeInteger(candidate.closureFileCount) || candidate.closureFileCount < 1 || candidate.closureFileCount > 30000) bad("candidate-contract-invalid");
  keys(candidate.assembly, ["schema", "kind", "toolset"]);
  if (candidate.assembly.schema !== 2 || candidate.assembly.kind !== "official-npm-qualified-win-x64-v2" || candidate.assembly.toolset !== "node22.19.0-pnpm11.7.0-policy1"
      || candidate.artifactUrl !== `${ORIGIN}descriptors/${candidate.artifactSha256}.json` || candidate.artifactBytes !== descriptor.length || sha256(descriptor) !== candidate.artifactSha256) bad("descriptor-binding-invalid");
  const description = validateQualifiedAssemblyDescription({ bytes: descriptor, expectedHash: candidate.artifactSha256, expectedBytes: candidate.artifactBytes });
  const q = JSON.parse(descriptor).qualification;
  if (q.authority.runtimePackage.version !== candidate.version || q.authority.nodeRuntime.nodeExeSha256 !== candidate.nodeSha256
      || q.dependencyAudit.entryPoint.fileSha256 !== candidate.entrySha256 || q.authority.dependencyClosure.releaseLayout.fileCount !== candidate.closureFileCount) bad("qualification-identity-mismatch");
  return description;
}
export function verifyEnvelope(envelopeBytes, encodedKey, descriptor, contract, now) {
  if (envelopeBytes.length < 1 || envelopeBytes.length > 96 * 1024) bad("envelope-size-invalid");
  const envelope = JSON.parse(envelopeBytes); keys(envelope, ["payload", "signature"]);
  const payload = Buffer.from(envelope.payload, "base64url"), signature = Buffer.from(envelope.signature, "base64url");
  if (!payload.length || payload.length > 64 * 1024 || payload.toString("base64url") !== envelope.payload || signature.length !== 64 || signature.toString("base64url") !== envelope.signature
      || !verify(null, payload, publicKeyObject(decodePublicKey(encodedKey)), signature)) bad("signature-invalid");
  const candidate = JSON.parse(payload); validateCandidate(candidate, descriptor, contract, now); return candidate;
}
export function signCandidate({ keyDirectory, passphrase, candidatePath, descriptorPath, contract, approvedPayloadSha256, output }) {
  validateSecureDirectory(keyDirectory);
  const payload = safeFile(resolve(candidatePath), 64 * 1024), descriptor = safeFile(resolve(descriptorPath), 2 * 1024 * 1024);
  if (!hex(approvedPayloadSha256) || sha256(payload) !== approvedPayloadSha256) bad("approved-payload-mismatch");
  validateCandidate(JSON.parse(payload), descriptor, contract);
  const encrypted = safeFile(join(keyDirectory, "production-root.encrypted.pem"), 16 * 1024);
  const receipt = JSON.parse(safeFile(join(keyDirectory, "public-root-receipt.json"), 8 * 1024));
  const raw = decodePublicKey(receipt.publicKey);
  if (receipt.purpose !== "luckyray-production-root" || receipt.fingerprintSha256 !== sha256(raw) || receipt.encryptedKeySha256 !== sha256(encrypted) || receipt.restoreProof?.verified !== true) bad("root-receipt-invalid");
  restoreProof(encrypted, passphrase, raw);
  const key = createPrivateKey({ key: encrypted, passphrase });
  const envelope = Buffer.from(JSON.stringify({ payload: payload.toString("base64url"), signature: sign(null, payload, key).toString("base64url") }) + "\n");
  verifyEnvelope(envelope, receipt.publicKey, descriptor, contract);
  writeFileSync(resolve(output), envelope, { flag: "wx", mode: 0o600 });
  encrypted.fill(0);
  return { outcome: "SIGNED_NOT_PUBLISHED_OR_ACTIVATED", envelopeSha256: sha256(envelope), payloadSha256: sha256(payload), fingerprintSha256: receipt.fingerprintSha256 };
}

export function publicationPlan(envelope, publicKey, descriptor, contract) {
  const candidate = verifyEnvelope(envelope, publicKey, descriptor, contract);
  // Project exact bytes, not arbitrary operator paths/extra files. The only
  // allowed public description is the already bounded qualification format.
  if (/-----BEGIN|(?:^|["\s])[A-Z]:[\\/]|Bearer\s|github_pat_|ghp_|AppData[\\/]|(?:password|apiKey|accessToken)\s*"\s*:/iu.test(descriptor.toString("utf8"))) bad("private-data-in-descriptor");
  const files = new Map([["README.md", Buffer.from(PUBLIC_README)], [`descriptors/${candidate.artifactSha256}.json`, Buffer.from(descriptor)], ["catalog/preview/windows-x86_64.json", Buffer.from(envelope)]]);
  const plan = { schema: 1, repository: REPOSITORY, feedUrl: FEED, publicKey, fingerprintSha256: sha256(decodePublicKey(publicKey)), version: candidate.version,
    hostContract: contract, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) };
  return { files, plan, planSha256: sha256(Buffer.from(JSON.stringify(plan))) };
}
export function validatePublicationBundle(bundle) {
  if (!(bundle.files instanceof Map) || bundle.files.size !== 3 || bundle.plan?.files?.length !== 3) bad("public-file-allowlist");
  for (const row of bundle.plan.files) {
    const bytes = bundle.files.get(row.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== row.bytes || sha256(bytes) !== row.sha256) bad("public-file-changed");
  }
  const descriptor = bundle.plan.files.find(row => /^descriptors\/[a-f0-9]{64}\.json$/u.test(row.path));
  if (!descriptor) bad("public-descriptor-path");
  const rebuilt = publicationPlan(bundle.files.get("catalog/preview/windows-x86_64.json"), bundle.plan.publicKey, bundle.files.get(descriptor.path), bundle.plan.hostContract);
  if (rebuilt.planSha256 !== bundle.planSha256 || JSON.stringify(rebuilt.plan) !== JSON.stringify(bundle.plan)) bad("public-plan-changed");
}
const gh = (args, body) => JSON.parse(execFileSync("gh.exe", ["api", ...args, ...(body ? ["--input", "-"] : [])], {
  encoding: "utf8", input: body ? JSON.stringify(body) : undefined, windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
}));
function existingPublicBytes(previous, api) {
  if (previous.type !== "file" || !/^[a-f0-9]{40}$/u.test(previous.sha)
      || !Number.isSafeInteger(previous.size) || previous.size < 1 || previous.size > 2 * 1024 * 1024) bad("publication-existing-shape-invalid");
  // Contents object responses deliberately omit base64 content above 1 MB.
  // Read the exact immutable Git blob, never an arbitrary download_url.
  const blob = previous.encoding === "none" ? api([`repos/${REPOSITORY}/git/blobs/${previous.sha}`]) : previous;
  if (blob.encoding !== "base64" || typeof blob.content !== "string" || blob.content.length > 3 * 1024 * 1024
      || (previous.encoding === "none" && (blob.sha !== previous.sha || blob.size !== previous.size))) bad("publication-existing-shape-invalid");
  const encoded = blob.content.replace(/\s/gu, ""), bytes = Buffer.from(encoded, "base64");
  const gitSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (bytes.length !== previous.size || bytes.toString("base64") !== encoded || gitSha !== previous.sha) bad("publication-existing-bytes-invalid");
  return bytes;
}
export function publishReviewed(bundle, approvedPlanSha256, api = gh) {
  validatePublicationBundle(bundle);
  if (bundle.planSha256 !== approvedPlanSha256 || !hex(approvedPlanSha256)) bad("reviewed-plan-mismatch");
  const repo = api([`repos/${REPOSITORY}`]);
  if (repo.full_name !== REPOSITORY || repo.private !== false || repo.default_branch !== "main") bad("publication-repository-invalid");
  let tree;
  try { tree = api([`repos/${REPOSITORY}/git/trees/main?recursive=1`]); }
  catch (error) { if (!String(error.stderr).includes("409") && !String(error.stderr).includes("404")) bad("publication-tree-read-failed"); }
  if (tree && (tree.truncated || tree.tree.length > 512 || tree.tree.some(row => row.type === "tree"
      ? !["catalog", "catalog/preview", "descriptors"].includes(row.path)
      : row.type !== "blob" || row.mode !== "100644" || !/^(?:README\.md|catalog\/preview\/windows-x86_64\.json|descriptors\/[a-f0-9]{64}\.json)$/u.test(row.path) || row.size > 2 * 1024 * 1024))) bad("unknown-repository-content");
  // Immutable descriptor first; mutable signed catalog last. Clients can
  // never see a new catalog that references an unpublished descriptor.
  const ordered = [...bundle.files].sort(([a], [b]) => Number(a.startsWith("catalog/")) - Number(b.startsWith("catalog/")));
  const results = [];
  for (const [path, bytes] of ordered) {
    let previous;
    try { previous = api([`repos/${REPOSITORY}/contents/${path}?ref=main`, "--header", "Accept: application/vnd.github.object+json"]); }
    catch (error) { if (!String(error.stderr).includes("404")) bad("publication-read-failed"); }
    if (previous) {
      const old = existingPublicBytes(previous, api);
      if (old.equals(bytes)) { results.push({ path, unchanged: true }); continue; }
      if (path.startsWith("descriptors/") || path === "README.md") bad("immutable-public-file-conflict");
      if (old.length > 96 * 1024) bad("existing-catalog-invalid");
      // Renewals/withdrawals must still use the same root. Rotating a root is
      // a separately reviewed host transition, not a publisher overwrite.
      const prior = JSON.parse(old); keys(prior, ["payload", "signature"]);
      if (!verify(null, Buffer.from(prior.payload, "base64url"), publicKeyObject(decodePublicKey(bundle.plan.publicKey)), Buffer.from(prior.signature, "base64url"))) bad("existing-catalog-root-conflict");
    }
    const response = api([`repos/${REPOSITORY}/contents/${path}`, "--method", "PUT"], { message: `Publish reviewed LSH ${bundle.plan.version} metadata`, content: bytes.toString("base64"), branch: "main", ...(previous ? { sha: previous.sha } : {}) });
    results.push({ path, commit: response.commit.sha });
  }
  return { outcome: "PUBLISHED_ANONYMOUS_READBACK_REQUIRED", planSha256: bundle.planSha256, results };
}
export async function anonymousReadback(bundle) {
  validatePublicationBundle(bundle);
  const downloaded = new Map();
  for (const [path, expected] of bundle.files) {
    const response = await fetch(`${ORIGIN}${path}`, { redirect: "error", signal: AbortSignal.timeout(15000), headers: { "cache-control": "no-cache" } });
    if (!response.ok || Number(response.headers.get("content-length") || 0) > expected.length) bad("anonymous-network-rejected");
    const reader = response.body.getReader(), chunks = []; let length = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > expected.length) { await reader.cancel(); bad("anonymous-size-rejected"); } chunks.push(value); }
    const bytes = Buffer.concat(chunks);
    if (!bytes.equals(expected)) bad("anonymous-bytes-mismatch"); downloaded.set(path, bytes);
  }
  const descriptorFile = bundle.plan.files.find(x => x.path.startsWith("descriptors/")).path;
  verifyEnvelope(downloaded.get("catalog/preview/windows-x86_64.json"), bundle.plan.publicKey, downloaded.get(descriptorFile), bundle.plan.hostContract);
  return { outcome: "ANONYMOUS_HTTPS_SIGNATURE_VERIFIED", authorizationSent: false, planSha256: bundle.planSha256,
    files: bundle.plan.files, fingerprintSha256: bundle.plan.fingerprintSha256 };
}

async function run() {
  const operation = process.argv[2];
  if (operation === "init" || operation === "sign") {
    process.stdin.setEncoding("utf8"); // preserve Unicode across pipe chunk boundaries
    let input = ""; for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) bad("interactive-input-size"); }
    let request; try { request = JSON.parse(input); } finally { input = ""; }
    try {
      if (operation === "sign") return signCandidate(request);
      if (request.initialCandidate) {
        const payload = safeFile(resolve(request.initialCandidate.candidatePath), 64 * 1024);
        if (sha256(payload) !== request.initialCandidate.approvedPayloadSha256) bad("approved-payload-mismatch");
        validateCandidate(JSON.parse(payload), safeFile(resolve(request.initialCandidate.descriptorPath), 2 * 1024 * 1024), request.initialCandidate.contract);
      }
      const receipt = initializeRoot(request);
      if (request.initialCandidate) receipt.initialCandidate = signCandidate({ ...request.initialCandidate, keyDirectory: resolve(request.primary), passphrase: request.passphrase });
      return receipt;
    } finally { request.passphrase = ""; }
  }
  const [envelopeFile, keyFile, descriptorFile, contractFile, approvedPlan] = process.argv.slice(3);
  const bundle = publicationPlan(safeFile(resolve(envelopeFile), 96 * 1024), readFileSync(keyFile, "utf8").trim(), safeFile(resolve(descriptorFile), 2 * 1024 * 1024), JSON.parse(safeFile(resolve(contractFile), 4096)));
  if (operation === "plan") return { outcome: "PUBLIC_ALLOWLIST_PLAN_NOT_PUBLISHED", ...bundle.plan, planSha256: bundle.planSha256 };
  if (operation === "publish") return publishReviewed(bundle, approvedPlan);
  if (operation === "readback") return anonymousReadback(bundle);
  bad("usage-init-sign-plan-publish-readback");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await run()) + "\n"); }
  catch { process.stderr.write("PRODUCTION_MAINTENANCE_STOPPED: check operation, reviewed inputs, storage or network; no secret diagnostics emitted.\n"); process.exitCode = 1; }
}
