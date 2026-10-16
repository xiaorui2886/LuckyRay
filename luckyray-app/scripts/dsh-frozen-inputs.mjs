// Pure bounded projections of the accepted frozen lock/audit. No acquisition,
// process execution, signing, registry metadata or mutable version resolution.
export function npmTarballUrl(name, version) {
  if (typeof name !== "string" || name.length > 214 || typeof version !== "string" || version.length > 128
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)
      || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/u.test(version)) throw new Error("input-identity-invalid");
  return `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
}

export function frozenLockedInputs(lockfile) {
  const section = lockfile.split("\npackages:\n")[1]?.split("\nsnapshots:\n")[0];
  if (!section) throw new Error("input-lock-invalid");
  const inputs = new Map();
  for (const block of section.split(/\n(?=  \S)/u)) {
    const match = /^  '?([^\n']+)'?:\n    resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}/u.exec(block.trimEnd());
    if (!match) { if (block.trim()) throw new Error("input-resolution-not-npm-integrity"); else continue; }
    const separator = match[1].lastIndexOf("@");
    const name = match[1].slice(0, separator), version = match[1].slice(separator + 1);
    if (inputs.has(match[1])) throw new Error("input-duplicate-invalid");
    inputs.set(match[1], { name, version, integrity: match[2], url: npmTarballUrl(name, version) });
  }
  if (inputs.size < 1 || inputs.size > 2048) throw new Error("input-package-count-invalid");
  return [...inputs.values()];
}

export function frozenPackageInputs(lockfile, audit) {
  const inputs = new Map(frozenLockedInputs(lockfile).map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
  if (!Array.isArray(audit?.packages) || audit.packages.length < 1 || audit.packages.length > 2048
      || new Set(audit.packages.map(pkg => `${pkg.name}@${pkg.version}`)).size !== audit.packages.length)
    throw new Error("input-package-count-invalid");
  return audit.packages.map((pkg) => {
    const input = inputs.get(`${pkg.name}@${pkg.version}`);
    if (!input) throw new Error("input-audit-lock-mismatch");
    return { ...input, extractedFileCount: pkg.fileCount, extractedBytes: pkg.byteCount,
      contentSha256: pkg.contentSha256, nativeArtifacts: pkg.nativeArtifacts };
  });
}
