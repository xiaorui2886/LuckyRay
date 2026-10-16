// Maintainer-only data preparation. No signer, trust-root initialization or
// runtime policy override. Input must be a previously frozen official record.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { qualifiedHostFiles, validateQualifiedAssemblyDescription } from "./dsh-frozen-assembly-description.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export async function qualifyFrozenDescription(root, originalBytes) {
  const [authority, lockfile, dependencyAudit] = await Promise.all([
    readFile(join(root, "runtime-authority.json"), "utf8").then(JSON.parse),
    readFile(join(root, "pnpm-lock.yaml"), "utf8"),
    readFile(join(root, "records/dependency-audit.json"), "utf8").then(JSON.parse),
  ]);
  const record = JSON.parse(originalBytes);
  const hostFiles = qualifiedHostFiles(authority, lockfile);
  const result = { ...record, schema: 2, kind: "official-npm-qualified-win-x64-v2",
    packages: record.packages.map(({ name, version, bytes, sha256 }) => ({ name, version, bytes, sha256 })),
    releaseTimes: record.releaseTimes.map(({ name, version, publishedAt }) => ({ name, version, publishedAt })),
    hostFiles: Object.entries(hostFiles).map(([path, bytes]) => ({ path, sha256: hash(bytes), bytes: bytes.length })),
    qualification: { authority, lockfile, dependencyAudit } };
  const bytes = Buffer.from(JSON.stringify(result) + "\n");
  validateQualifiedAssemblyDescription({ bytes, expectedHash: hash(bytes), expectedBytes: bytes.length });
  return bytes;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, record, output] = process.argv.slice(2);
  if (!output) throw new Error("usage: frozen-dsh-host-root acquired-input-record new-description-path");
  const bytes = await qualifyFrozenDescription(resolve(root), await readFile(resolve(record)));
  await writeFile(resolve(output), bytes, { flag: "wx" });
  process.stdout.write(JSON.stringify({ outcome: "QUALIFIED_DATA_NOT_INSTALL_AUTHORITY", bytes: bytes.length, sha256: hash(bytes) }) + "\n");
}
