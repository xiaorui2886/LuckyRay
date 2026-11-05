// S3: verify the sealed Linux LSH resources at the exact paths Tauri bundles.
// src-tauri/dsh            -> lr-lsh/199-1/deepseek-harness (base config)
// src-tauri/dsh-host       -> lr-lsh/199-1/dsh-host         (base config)
// dsh-host/linux-x64/*     -> licenses/lsh-linux/*           (tauri.linux.conf.json)
// Returns a list of problems; an empty list means the resources are sealed.
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditLinuxClosure, sha256 } from './lsh-closure.mjs';
import { hostFiles, recordHashes } from './stage-lsh-resources.mjs';

export const licenseResources = Object.fromEntries(Object.keys(recordHashes)
  .map(name => [`../dsh-host/linux-x64/${name}`, `licenses/lsh-linux/${name}`]));

function regular(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o7022) return null;
    return readFileSync(path);
  } catch { return null; }
}

export async function checkLinuxLshPackage({ appRoot, audit = auditLinuxClosure }) {
  const problems = [];
  const records = {};
  for (const [name, hash] of Object.entries(recordHashes)) {
    const bytes = regular(join(appRoot, 'dsh-host/linux-x64', name));
    if (!bytes || sha256(bytes) !== hash) problems.push(`redistribution record ${name} missing or changed`);
    else records[name] = bytes;
  }
  const config = JSON.parse(readFileSync(join(appRoot, 'src-tauri/tauri.linux.conf.json'), 'utf8'));
  for (const [source, target] of Object.entries(licenseResources)) {
    if (config.bundle?.resources?.[source] !== target) problems.push(`redistribution record ${source} not bundled at ${target}`);
  }
  const native = readFileSync(join(appRoot, 'src-tauri/src/dsh_host.rs'), 'utf8');
  for (const [pin, path] of hostFiles) {
    const expected = native.match(new RegExp(`const ${pin}: &str =\\s*"([a-f0-9]{64})";`))?.[1];
    const bytes = regular(join(appRoot, 'src-tauri/dsh-host', path));
    // Bundled bytes are copied verbatim, so the pins apply without normalization.
    if (!expected || !bytes || sha256(bytes) !== expected) problems.push(`dsh-host ${path} does not match ${pin}`);
  }
  const runtime = join(appRoot, 'src-tauri/dsh');
  let present = false;
  try { present = lstatSync(runtime).isDirectory(); } catch {}
  if (!present) problems.push('sealed LSH runtime missing at src-tauri/dsh');
  else if (records['runtime-manifest.json']) {
    try {
      const { notices, packages, ...actual } = await audit(runtime);
      if (sha256(Buffer.from(JSON.stringify(actual, null, 2) + '\n')) !== recordHashes['runtime-manifest.json']) {
        problems.push('sealed LSH runtime at src-tauri/dsh does not match runtime-manifest.json');
      }
    } catch (error) {
      problems.push(`sealed LSH runtime at src-tauri/dsh refused (${error.message})`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const appRoot = fileURLToPath(new URL('../..', import.meta.url));
  checkLinuxLshPackage({ appRoot }).then(problems => {
    for (const problem of problems) console.error(`- LSH: ${problem}`);
    if (problems.length) process.exitCode = 1;
    else console.log(JSON.stringify({ kind: 'linux-lsh-package-sealed' }));
  });
}
