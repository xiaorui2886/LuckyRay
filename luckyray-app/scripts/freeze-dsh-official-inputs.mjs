// Maintainer-only acquisition: records exact official tarball bytes for a
// future signed catalog. This does not create a trust root or an installer.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateDshRuntimeAuthority, validateQualifiedDshRuntimeAuthority, validateDshFrozenClosure } from "./dsh-supply-chain.mjs";
import { frozenPackageInputs } from "./dsh-frozen-inputs.mjs";

const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
async function exactTarball(input, cache) {
  // Every URL is derived from a validated fixed npm name/version, never latest
  // or metadata-controlled URLs. No redirects, cookies, tokens or hook code.
  const response = await fetch(input.url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`input-download-http-${response.status}:${input.name}`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 256 * 1024 * 1024) throw new Error("input-download-budget");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const integrity = `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
  if (integrity !== input.integrity) throw new Error(`input-integrity-invalid:${input.name}`);
  const sha256 = hash(buffer);
  await writeFile(join(cache, `${sha256}.tgz`), buffer, { flag: "wx" });
  return { ...input, bytes, sha256 };
}

async function main() {
  const [repoArg, outputArg] = process.argv.slice(2);
  if (!repoArg || !outputArg) throw new Error("usage: repo new-output-directory");
  const repo = resolve(repoArg), output = resolve(outputArg);
  const authority = (process.argv[4] === "--qualification-data" ? validateQualifiedDshRuntimeAuthority : validateDshRuntimeAuthority)(JSON.parse(await readFile(join(repo, "dsh-host/runtime-authority.json"), "utf8")));
  const [lockfile, manifest, npmrc, workspacePolicy, audit] = await Promise.all([
    readFile(join(repo, "dsh-host/pnpm-lock.yaml")), readFile(join(repo, "dsh-host/package.json")),
    readFile(join(repo, "dsh-host/.npmrc")), readFile(join(repo, "dsh-host/pnpm-workspace.yaml")),
    readFile(join(repo, "dsh-host/records/dependency-audit.json"), "utf8").then(JSON.parse),
  ]);
  validateDshFrozenClosure({ authority, hostPackage: JSON.parse(manifest), lockfile, npmrc: npmrc.toString("utf8"), workspacePolicy });
  const packages = frozenPackageInputs(lockfile.toString("utf8"), audit);
  await mkdir(output);
  const cache = join(output, "tarballs");
  await mkdir(cache);
  const acquired = new Array(packages.length);
  let index = 0, total = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < packages.length) {
      const own = index++;
      acquired[own] = await exactTarball(packages[own], cache);
      total += acquired[own].bytes;
      if (total > 1024 * 1024 * 1024) throw new Error("input-total-budget");
      if ((own + 1) % 25 === 0) process.stdout.write(`verified ${own + 1}/${packages.length}\n`);
    }
  }));
  const description = {
    schema: 1, kind: "official-npm-frozen-win-x64-v1", runtimePackage: authority.runtimePackage,
    node: { ...authority.nodeRuntime, archiveBytes: 35424607 },
    packageManager: { ...authority.packageManager, archiveBytes: 4590455 },
    lockSha256: authority.dependencyClosure.sha256,
    hostFiles: ["package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"].map((path, i) => ({
      path, sha256: hash([manifest, npmrc, lockfile, workspacePolicy][i]),
      bytes: [manifest, npmrc, lockfile, workspacePolicy][i].length,
    })),
    packageCount: acquired.length, packageBytes: total, packages: acquired,
    finalLayout: authority.dependencyClosure.releaseLayout,
    authorization: "UNSIGNED_MAINTAINER_INPUT_RECORD_NOT_INSTALL_AUTHORITY",
  };
  const record = Buffer.from(JSON.stringify(description, null, 2) + "\n");
  await writeFile(join(output, "official-inputs.json"), record, { flag: "wx" });
  process.stdout.write(JSON.stringify({ outcome: "EXACT_OFFICIAL_NPM_INPUTS", packages: acquired.length,
    totalBytes: total, descriptionBytes: record.length, sha256: hash(record), signed: false }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(String(error.message) + "\n"); process.exitCode = 1; });
}
