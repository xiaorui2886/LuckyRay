// Maintainer evidence only. pnpm's retained minimumReleaseAge policy needs
// publication times for ALL locked versions, including pruned platform entries.
// This output is unsigned; a later catalog must bind its exact bytes.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { frozenLockedInputs } from "./dsh-frozen-inputs.mjs";

const [repoArg, originalArg, newRecordArg] = process.argv.slice(2);
if (!newRecordArg) throw new Error("usage: repo original-input-record new-record-file");
const repo = resolve(repoArg), output = resolve(newRecordArg);
const record = JSON.parse(await readFile(resolve(originalArg), "utf8"));
const lock = await readFile(join(repo, "dsh-host/pnpm-lock.yaml"));
if (createHash("sha256").update(lock).digest("hex") !== record.lockSha256 || record.releaseTimes) throw new Error("input-record-lock-invalid");
const locked = frozenLockedInputs(lock.toString("utf8"));
const names = [...new Set(locked.map((pkg) => pkg.name))], times = new Map();
let index = 0, metadataBytes = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (index < names.length) {
    const name = names[index++], url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`release-time-http-${response.status}:${name}`);
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length; metadataBytes += chunk.length;
      if (size > 32 * 1024 * 1024 || metadataBytes > 512 * 1024 * 1024) throw new Error("release-time-metadata-budget");
      chunks.push(chunk);
    }
    const meta = JSON.parse(Buffer.concat(chunks));
    if (meta.name !== name || !meta.time || !meta.versions) throw new Error("release-time-identity-invalid");
    for (const pkg of locked.filter((pkg) => pkg.name === name)) {
      const publishedAt = meta.time[pkg.version], manifest = meta.versions[pkg.version];
      if (typeof publishedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(publishedAt)
          || !Number.isFinite(Date.parse(publishedAt)) || Date.parse(publishedAt) > Date.now()
          || manifest?.name !== name || manifest.version !== pkg.version || manifest.dist?.integrity !== pkg.integrity) throw new Error(`release-time-version-invalid:${name}`);
      times.set(`${name}@${pkg.version}`, { ...pkg, publishedAt });
    }
    if (times.size % 25 === 0) process.stdout.write(`publication-times ${times.size}/${locked.length}\n`);
  }
}));
record.releaseTimes = locked.map((pkg) => times.get(`${pkg.name}@${pkg.version}`));
record.releaseTimePolicy = { minimumAgeMinutes: 1440, strict: true, ignoreMissingTime: false,
  lockedVersionCount: locked.length, source: "https://registry.npmjs.org/", acquiredAt: new Date().toISOString() };
const bytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
await writeFile(output, bytes, { flag: "wx" });
process.stdout.write(JSON.stringify({ outcome: "EXACT_OFFICIAL_RELEASE_TIMES", lockedVersions: locked.length,
  metadataRequests: names.length, metadataBytes, recordBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), signed: false }) + "\n");
