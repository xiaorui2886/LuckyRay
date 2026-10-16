// Isolated maintainer fixture for #189. Never use its ephemeral key as a
// production update authority. The release build rejects every DEV trust var.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || args.has(key)) throw Error("dev-feed-arguments-invalid");
  args.set(key, value);
}
const mode = args.get("--mode");
const directory = resolve(args.get("--directory") ?? "");
const port = Number(args.get("--port"));
if (!["prepare", "refresh", "serve"].includes(mode) || !Number.isInteger(port) || port < 1024 || port > 65535
  || !directory || !lstatSync(directory).isDirectory()) throw Error("dev-feed-arguments-invalid");
const artifact = join(directory, "dsh-0.1.7-rc.2-win-x64.zip");
const feed = join(directory, "feed.json");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

if (mode === "prepare") {
  const root = resolve(args.get("--runtime-root") ?? "");
  const from = args.get("--from-version"), hostVersion = args.get("--host-version");
  const adapter = args.get("--adapter-fingerprint"), resourceGate = args.get("--resource-gate");
  if (!root || !lstatSync(root).isDirectory() || from !== "0.1.5-rc.2"
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(hostVersion ?? "")
    || !hex64(adapter) || !hex64(resourceGate) || existsSync(feed)) {
    throw Error("dev-feed-preparation-invalid");
  }
  const packageInfo = JSON.parse(readFileSync(join(root, "host/node_modules/@deepseek-ai/dsh/package.json"), "utf8"));
  if (packageInfo.name !== "@deepseek-ai/dsh" || packageInfo.version !== "0.1.7-rc.2") {
    throw Error("dev-feed-frozen-version-mismatch");
  }
  const files = [];
  function walk(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(root, child);
      const meta = lstatSync(full);
      if (meta.isSymbolicLink() || meta.isBlockDevice() || meta.isCharacterDevice()) throw Error("dev-feed-linked-entry");
      if (meta.isDirectory()) walk(child);
      else if (meta.isFile()) {
        const bytes = readFileSync(full);
        files.push([child.replaceAll("\\", "/"), bytes.byteLength, sha(bytes)]);
      } else throw Error("dev-feed-nonregular-entry");
    }
  }
  walk("host"); walk("node");
  files.sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])));
  const closure = sha(Buffer.from(files.map(([name, size, digest]) => `${name}\0${size}\0${digest}\n`).join("")));
  if (!existsSync(artifact)) {
    const tar = spawnSync("tar.exe", ["-a", "-cf", artifact, "-C", root, "host", "node"],
      { windowsHide: true, encoding: "utf8", timeout: 600_000 });
    if (tar.error || tar.status !== 0) throw Error(`dev-feed-zip-failed: ${tar.stderr?.trim() ?? ""}`);
  }
  const archive = readFileSync(artifact);
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const candidate = {
    schema: 1, channel: "preview", runtimePackage: "@deepseek-ai/dsh",
    issuedAt, expiresAt: issuedAt + 7 * 86400,
    hostVersion, adapterFingerprint: adapter, platform: "windows-x86_64",
    fromVersions: [from], version: packageInfo.version,
    nodeSha256: sha(readFileSync(join(root, "node/node.exe"))),
    entrySha256: sha(readFileSync(join(root, "host/node_modules/@deepseek-ai/dsh/lib/bin.js"))),
    artifactUrl: `https://127.0.0.1:${port}/${basename(artifact)}`,
    artifactSha256: sha(archive), artifactBytes: archive.byteLength,
    closureSha256: closure, closureFileCount: files.length,
    dataCompatibility: "no-migration", resourceGateSha256: resourceGate,
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const payload = Buffer.from(JSON.stringify(candidate));
  const envelope = { payload: b64url(payload), signature: b64url(sign(null, payload, privateKey)) };
  writeFileSync(join(directory, "dev-signing-key.pem"), privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, "dev-public-key.txt"), `${b64url(rawKey)}\n`, { flag: "wx" });
  writeFileSync(feed, JSON.stringify(envelope), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ outcome: "ISOLATED_DEVELOPMENT_CANDIDATE", from, to: candidate.version,
    files: files.length, artifactBytes: archive.byteLength, artifactSha256: candidate.artifactSha256,
    closureSha256: closure, feedUrl: `https://127.0.0.1:${port}/feed.json`, publicKey: b64url(rawKey) })}\n`);
} else if (mode === "refresh") {
  // Dev-only requalification when the same frozen bytes are tested against a
  // changed host contract. Keep the previous signed receipt recoverable.
  const adapter = args.get("--adapter-fingerprint"), resourceGate = args.get("--resource-gate");
  const secret = join(directory, "dev-signing-key.pem");
  const publicFile = join(directory, "dev-public-key.txt");
  if (!hex64(adapter) || !hex64(resourceGate) || !existsSync(feed)
    || !existsSync(artifact) || !existsSync(secret) || !existsSync(publicFile)
  ) throw Error("dev-feed-refresh-invalid");
  const previous = join(directory, `feed.before-refresh-${sha(readFileSync(feed))}.json`);
  if (existsSync(previous)) throw Error("dev-feed-refresh-already-recorded");
  const old = JSON.parse(readFileSync(feed, "utf8"));
  const candidate = JSON.parse(Buffer.from(old.payload, "base64url").toString("utf8"));
  if (candidate.schema !== 1 || candidate.channel !== "preview"
    || candidate.version !== "0.1.7-rc.2" || candidate.hostVersion !== "1.9.3"
    || candidate.artifactUrl !== `https://127.0.0.1:${port}/${basename(artifact)}`
    || candidate.artifactSha256 !== sha(readFileSync(artifact))
    || candidate.artifactBytes !== lstatSync(artifact).size) throw Error("dev-feed-refresh-artifact-changed");
  const privateKey = createPrivateKey(readFileSync(secret));
  const rawKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  if (b64url(rawKey) !== readFileSync(publicFile, "utf8").trim()) {
    throw Error("dev-feed-refresh-key-mismatch");
  }
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  candidate.issuedAt = issuedAt;
  candidate.expiresAt = issuedAt + 7 * 86400;
  candidate.adapterFingerprint = adapter;
  candidate.resourceGateSha256 = resourceGate;
  const payload = Buffer.from(JSON.stringify(candidate));
  copyFileSync(feed, previous);
  writeFileSync(feed, JSON.stringify({ payload: b64url(payload), signature: b64url(sign(null, payload, privateKey)) }));
  process.stdout.write(`${JSON.stringify({ outcome: "ISOLATED_DEVELOPMENT_CANDIDATE_REFRESHED",
    version: candidate.version, artifactSha256: candidate.artifactSha256,
    adapterFingerprint: adapter, resourceGateSha256: resourceGate })}\n`);
} else {
  const cert = resolve(args.get("--cert") ?? ""), key = resolve(args.get("--tls-key") ?? "");
  if (!existsSync(feed) || !existsSync(artifact) || !existsSync(cert) || !existsSync(key)) {
    throw Error("dev-feed-serve-input-missing");
  }
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (request, response) => {
    const file = request.method === "GET" && request.url === "/feed.json" ? feed
      : request.method === "GET" && request.url === `/${basename(artifact)}` ? artifact : null;
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": file === feed ? "application/json" : "application/zip",
      "content-length": lstatSync(file).size, "cache-control": "no-store" });
    createReadStream(file).pipe(response);
  });
  server.listen(port, "127.0.0.1", () => process.stdout.write("ISOLATED_DSH_DEV_FEED_LISTENING\n"));
}
