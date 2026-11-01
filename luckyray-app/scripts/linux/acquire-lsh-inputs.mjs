// Maintainer acquisition of fixed official Linux inputs; never an install trust
// root. Runtime admission binds the resulting bytes in compiled product data.
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frozenLockedInputs } from '../dsh-frozen-inputs.mjs';
import { auditNpmTarball } from '../dsh-npm-tar-policy.mjs';
import { ARCHIVE_SHA256, ARCHIVE_URL } from './prepare-node-input.mjs';

const execute = promisify(execFile);
export const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const LOCK_SHA256 = '0faaa6a7163bf2248735883e69e6051825b45fafb253a42432b4b6ee5a3bbbea';
export const PACKAGE_SET_SHA256 = '7fcf8fbfa53c2598658a96d5ab84b9658f5f03554991c53ac42c34ae479b6f5b';
export const PNPM_SHA256 = 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee';
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const fail = code => { throw new Error(`linux-lsh-${code}`); };

export async function frozenLinuxInputs() {
  const lock = await readFile(join(APP_ROOT, 'dsh-host/pnpm-lock.yaml'));
  const selection = await readFile(join(APP_ROOT, 'dsh-host/linux-x64/input-packages.json'));
  if (hash(lock) !== LOCK_SHA256 || hash(selection) !== PACKAGE_SET_SHA256) fail('frozen-input-changed');
  const ids = JSON.parse(selection);
  if (!Array.isArray(ids) || ids.length !== 564 || new Set(ids).size !== ids.length) fail('package-set-invalid');
  const locked = frozenLockedInputs(lock.toString());
  const byId = new Map(locked.map(pkg => [`${pkg.name}@${pkg.version}`, pkg]));
  const selected = ids.map(id => byId.get(id));
  if (selected.some(pkg => !pkg) || locked.length !== 634) fail('package-lock-mismatch');
  return { locked, selected };
}

async function officialBytes(url, directory, maxBytes) {
  const target = join(directory, `.download-${randomBytes(16).toString('hex')}`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org'
      || parsed.username || parsed.password || parsed.search || parsed.hash) fail('official-url-invalid');
  const env = {};
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  try {
    // --disable is first: do not read the maintainer's curl configuration.
    await execute('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https',
      '--max-time', '120', '--max-filesize', String(maxBytes), '--output', target, url],
    { env, timeout: 125_000, maxBuffer: 4096 });
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maxBytes) fail('download-invalid');
    return await readFile(target);
  } finally { await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function parallel(items, count, work) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await work(items[index], index);
    }
  }));
  return result;
}

export async function acquireLinuxInputs(output) {
  output = resolve(output);
  await mkdir(output, { mode: 0o700 });
  const cache = join(output, 'tarballs');
  await mkdir(cache, { mode: 0o700 });
  const { locked, selected } = await frozenLinuxInputs();
  let inputBytes = 0;
  const packages = await parallel(selected, 4, async (pkg, index) => {
    const bytes = await officialBytes(pkg.url, output, 256 * 1024 * 1024);
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== pkg.integrity) fail('tarball-integrity-invalid');
    auditNpmTarball(bytes);
    inputBytes += bytes.length;
    if (inputBytes > 1024 * 1024 * 1024) fail('input-budget');
    const sha256 = hash(bytes);
    await writeFile(join(cache, sha256 + '.tgz'), bytes, { flag: 'wx', mode: 0o600 });
    if ((index + 1) % 50 === 0) console.log(`verified official Linux tarballs ${index + 1}/${selected.length}`);
    return { ...pkg, bytes: bytes.length, sha256 };
  });
  const names = [...new Set(locked.map(pkg => pkg.name))];
  let metadataBytes = 0;
  const groups = await parallel(names, 4, async name => {
    const bytes = await officialBytes(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, output, 32 * 1024 * 1024);
    metadataBytes += bytes.length;
    if (metadataBytes > 512 * 1024 * 1024) fail('metadata-budget');
    const value = JSON.parse(bytes);
    if (value.name !== name || !value.time || !value.versions) fail('publication-identity-invalid');
    return locked.filter(pkg => pkg.name === name).map(pkg => {
      const publishedAt = value.time[pkg.version];
      const manifest = value.versions[pkg.version];
      if (manifest?.name !== name || manifest.version !== pkg.version || manifest.dist?.integrity !== pkg.integrity
          || typeof publishedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(publishedAt)
          || !Number.isFinite(Date.parse(publishedAt)) || Date.parse(publishedAt) > Date.now()) fail('publication-time-invalid');
      return { ...pkg, publishedAt };
    });
  });
  const times = new Map(groups.flat().map(pkg => [`${pkg.name}@${pkg.version}`, pkg]));
  const hostFiles = [];
  for (const name of ['package.json', '.npmrc', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const bytes = await readFile(join(APP_ROOT, 'dsh-host', name));
    hostFiles.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  const record = { schemaVersion: 1, platform: 'linux', architecture: 'x64', libc: 'glibc',
    runtimePackage: '@deepseek-ai/dsh@0.2.1-rc.3', lockSha256: LOCK_SHA256,
    packageSetSha256: PACKAGE_SET_SHA256, hostFiles,
    node: { version: '22.19.0', archive: ARCHIVE_URL, archiveSha256: ARCHIVE_SHA256 },
    packageManager: { name: 'pnpm', version: '11.7.0', archiveSha256: PNPM_SHA256 },
    packages, releaseTimes: locked.map(pkg => times.get(`${pkg.name}@${pkg.version}`)) };
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
  await writeFile(join(output, 'inputs.json'), bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ kind: 'official-linux-inputs', packages: packages.length,
    lockedPublicationTimes: record.releaseTimes.length, inputBytes, sha256: hash(bytes) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('usage: acquire-lsh-inputs.mjs new-output-directory');
  acquireLinuxInputs(process.argv[2]).catch(error => {
    console.error(error.code === undefined ? error.message : 'linux-lsh-acquisition-failed');
    process.exitCode = 1;
  });
}
