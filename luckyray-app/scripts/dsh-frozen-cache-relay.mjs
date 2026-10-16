// pnpm's public fetch command hydrates its own store from our verified bytes.
// This short-lived loopback cache is NOT an upstream/feed, package resolver,
// generic proxy, or installer. Unknown URLs cannot fall back to the internet.
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { npmTarballUrl } from "./dsh-frozen-inputs.mjs";

export async function openFrozenCacheRelay(inputs, cache, releaseTimes = []) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 768) throw new Error("cache-input-count-invalid");
  const prefix = `/${randomBytes(16).toString("hex")}`;
  const entries = new Map();
  const metadata = new Map(), absentAttestations = new Set(), names = new Map();
  if (!Array.isArray(releaseTimes) || releaseTimes.length > 1024) throw new Error("cache-time-count-invalid");
  for (const pkg of releaseTimes) {
    if (pkg.url !== npmTarballUrl(pkg.name, pkg.version) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(pkg.integrity)
        || typeof pkg.publishedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(pkg.publishedAt)
        || !Number.isFinite(Date.parse(pkg.publishedAt)) || Date.parse(pkg.publishedAt) > Date.now()) throw new Error("cache-time-invalid");
    const meta = names.get(pkg.name) ?? { name: pkg.name, time: {}, versions: {} };
    if (meta.time[pkg.version]) throw new Error("cache-time-duplicate");
    meta.time[pkg.version] = pkg.publishedAt;
    meta.versions[pkg.version] = { name: pkg.name, version: pkg.version, dist: { tarball: pkg.url, integrity: pkg.integrity } };
    names.set(pkg.name, meta);
    // pnpm may try attestations before falling back to frozen publication
    // times. This cache has none; a fixed 404 does NOT assert upstream absence.
    absentAttestations.add(`${prefix}/-/npm/v1/attestations/${pkg.name}@${pkg.version}`);
  }
  for (const [name, value] of names) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 128 * 1024) throw new Error("cache-time-budget-invalid");
    for (const path of [name, name.replace("/", "%2F"), name.replace("/", "%2f")]) metadata.set(`${prefix}/${path}`, bytes);
  }
  let inputBytes = 0;
  for (const input of inputs) {
    if (input.url !== npmTarballUrl(input.name, input.version) || !/^[a-f0-9]{64}$/u.test(input.sha256)
        || !Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > 256 * 1024 * 1024) throw new Error("cache-input-invalid");
    const path = prefix + new URL(input.url).pathname;
    if (entries.has(path)) throw new Error("cache-input-duplicate");
    inputBytes += input.bytes;
    if (inputBytes > 1024 * 1024 * 1024) throw new Error("cache-input-budget-invalid");
    entries.set(path, input);
  }
  let requests = 0, rejected = 0, bytesServed = 0, tarballRequests = 0, metadataRequests = 0, uncachedAttestationRequests = 0, droppedConnections = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Connection", "close");
    const input = entries.get(request.url);
    if (++requests > (inputs.length + releaseTimes.length) * 4 || request.method !== "GET") {
      rejected++; response.writeHead(404); response.end(); return;
    }
    const metaBytes = metadata.get(request.url);
    if (metaBytes) {
      metadataRequests++;
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": metaBytes.length, "Cache-Control": "no-store" });
      response.end(metaBytes); return;
    }
    if (absentAttestations.has(request.url)) {
      uncachedAttestationRequests++; response.writeHead(404); response.end(); return;
    }
    if (!input) { rejected++; response.writeHead(404); response.end(); return; }
    // Permit one complete retry, not requestCount times the largest input.
    // Reserve before async reads so simultaneous requests share this bound.
    if (bytesServed + input.bytes > inputBytes * 2) {
      rejected++; response.writeHead(409); response.end(); return;
    }
    bytesServed += input.bytes;
    tarballRequests++;
    try {
      const path = join(cache, `${input.sha256}.tgz`);
      const meta = await lstat(path, { bigint: true });
      if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1n || meta.size !== BigInt(input.bytes)) throw new Error("cache-file-invalid");
      const bytes = await readFile(path);
      if (bytes.length !== input.bytes || createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error("cache-file-invalid");
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" });
      response.end(bytes);
    } catch { bytesServed -= input.bytes; rejected++; response.writeHead(409); response.end(); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  // pnpm's policy verifier has a separate metadata pool from tarball fetch.
  // Do not drop valid policy requests behind 32 idle keep-alive sockets. The
  // total requests, metadata bytes and fixed input bytes remain bounded.
  server.maxConnections = 256;
  server.on("drop", () => { droppedConnections++; });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    registry: `http://127.0.0.1:${server.address().port}${prefix}/`,
    statistics: () => ({ requests, rejected, bytesServed, tarballRequests, metadataRequests, uncachedAttestationRequests, droppedConnections, upstreamRequestsByRelay: 0 }),
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
