// Fixed Linux build inputs -> detached runtime, without upstream lifecycle hooks.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractVerifiedPnpmPackage } from '../dsh-supply-chain.mjs';
import { auditNpmTarball } from '../dsh-npm-tar-policy.mjs';
import { openFrozenCacheRelay } from '../dsh-frozen-cache-relay.mjs';
import { prepareNodeInput } from './prepare-node-input.mjs';
import { APP_ROOT, frozenLinuxInputs, LOCK_SHA256, PACKAGE_SET_SHA256, PNPM_SHA256 } from './acquire-lsh-inputs.mjs';
import { auditLinuxClosure, projectLinuxLayout, LSH_ENTRY, NODE_ENTRY, sha256 } from './lsh-closure.mjs';

export const INPUTS_SHA256 = '1087d42e5fe738a1da06cefc0c7956af60f7b40afd7a7e9a2e822f963c0eb9c3';
const fail = code => { throw new Error(`linux-lsh-${code}`); };

async function exactFile(path, expectedHash, expectedBytes = null) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size > 256 * 1024 * 1024 || expectedBytes !== null && metadata.size !== expectedBytes) fail('input-file-invalid');
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size || sha256(bytes) !== expectedHash) fail('input-file-invalid');
  return bytes;
}

async function runPnpm({ node, entry, cwd, work, registry, port, command }) {
  const policy = await mkdtemp(join(work, 'policy-'));
  await writeFile(join(policy, 'user.npmrc'), '', { flag: 'wx' });
  await writeFile(join(policy, 'global.npmrc'), '', { flag: 'wx' });
  const env = { PATH: [dirname(node), '/usr/bin', '/bin'].join(':'), LANG: 'C.UTF-8', CI: 'true',
    NPM_CONFIG_USERCONFIG: join(policy, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(policy, 'global.npmrc'),
    XDG_CONFIG_HOME: policy, XDG_DATA_HOME: policy, XDG_CACHE_HOME: policy,
    PNPM_HOME: policy, TMPDIR: policy, LUCKYRAY_FROZEN_CACHE_PORT: port === null ? '' : String(port) };
  const args = ['--import', pathToFileURL(join(APP_ROOT, 'scripts/dsh-assembly-network-fence.mjs')).href,
    entry, ...command, `--registry=${registry}`, '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile',
    '--prod', '--config.node-linker=hoisted', '--config.package-import-method=copy',
    '--store-dir', join(work, 'store'), '--cache-dir', join(work, 'metadata-cache')];
  const output = await new Promise((complete, reject) => {
    const child = spawn(node, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', tooLarge = false;
    const consume = chunk => {
      if (text.length + chunk.length > 8 * 1024 * 1024) { tooLarge = true; child.kill(); }
      else text += chunk;
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal || tooLarge) {
        // Output belongs to this isolated build, with synthetic policy paths.
        process.stderr.write(text);
        reject(new Error('linux-lsh-pnpm-failed'));
      } else complete(text);
    });
  });
  const fences = output.split('\n').filter(line => line.startsWith('{')).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(value => value?.outcome === 'ASSEMBLY_NETWORK_FENCE');
  if (fences.length === 0 || fences.some(fence => fence.blockedSockets !== 0 || fence.blockedDns !== 0
      || port === null && fence.allowedSockets !== 0)) fail('network-fence-failed');
  const allowedSockets = fences.reduce((total, fence) => total + fence.allowedSockets, 0);
  if (port !== null && allowedSockets === 0) fail('cache-network-accounting-missing');
  console.log(JSON.stringify({ outcome: 'ASSEMBLY_NETWORK_FENCE', contexts: fences.length,
    phase: port === null ? 'offline' : 'verified-loopback-cache', allowedSockets, blockedSockets: 0, blockedDns: 0 }));
}

export async function prepareLinuxLsh({ nodeArchive, pnpmArchive, inputDirectory, output, records }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('build-platform-invalid');
  for (const path of [output, records]) {
    if (await realpath(dirname(path)) !== dirname(path)) fail('output-parent-invalid');
  }
  const bytes = await exactFile(join(inputDirectory, 'inputs.json'), INPUTS_SHA256);
  const inputs = JSON.parse(bytes);
  const source = await frozenLinuxInputs();
  if (inputs.platform !== 'linux' || inputs.architecture !== 'x64' || inputs.libc !== 'glibc'
      || inputs.lockSha256 !== LOCK_SHA256 || inputs.packageSetSha256 !== PACKAGE_SET_SHA256
      || inputs.packages.length !== source.selected.length) fail('input-descriptor-invalid');
  for (let index = 0; index < inputs.packages.length; index++) {
    const input = inputs.packages[index], selected = source.selected[index];
    if (input.name !== selected.name || input.version !== selected.version
        || input.url !== selected.url || input.integrity !== selected.integrity) fail('input-descriptor-invalid');
    const archive = await exactFile(join(inputDirectory, 'tarballs', `${input.sha256}.tgz`), input.sha256, input.bytes);
    if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== input.integrity) fail('input-integrity-invalid');
    auditNpmTarball(archive);
  }
  await exactFile(pnpmArchive, PNPM_SHA256);
  await mkdir(output, { mode: 0o700 });
  await mkdir(records, { mode: 0o700 });
  const work = await mkdtemp(join(dirname(output), '.lsh-linux-build-'));
  try {
    const nodeReport = prepareNodeInput(nodeArchive, join(output, 'node'));
    await unlink(join(output, 'node/input-report.json'));
    const node = join(output, NODE_ENTRY);
    const pnpm = join(work, 'pnpm');
    // Only the platform-neutral pnpm tool is extracted through the existing
    // archive verifier. No Windows Node/closure/launch record is a Linux input.
    await extractVerifiedPnpmPackage({ authorityPath: join(APP_ROOT, 'dsh-host/runtime-authority.json'),
      pnpmTarballPath: pnpmArchive, outputRoot: pnpm });
    const acquisition = join(work, 'acquisition'), host = join(output, 'host');
    for (const directory of [acquisition, host]) {
      await mkdir(directory, { mode: 0o700 });
      for (const input of inputs.hostFiles) {
        await exactFile(join(APP_ROOT, 'dsh-host', input.path), input.sha256, input.bytes);
        await copyFile(join(APP_ROOT, 'dsh-host', input.path), join(directory, input.path));
      }
    }
    const relay = await openFrozenCacheRelay(inputs.packages, join(inputDirectory, 'tarballs'), inputs.releaseTimes);
    const registry = relay.registry;
    const port = Number(new URL(registry).port);
    const common = { node, entry: join(pnpm, 'package/bin/pnpm.mjs'), work, registry };
    try {
      await runPnpm({ ...common, cwd: acquisition, port, command: ['fetch', '--fetch-retries=0', '--network-concurrency=4'] });
    } finally { await relay.close(); }
    const stats = relay.statistics();
    if (stats.rejected || stats.droppedConnections || stats.tarballRequests !== inputs.packages.length) fail('cache-accounting-invalid');
    await runPnpm({ ...common, cwd: host, port: null, command: ['install', '--offline'] });
    await projectLinuxLayout(output);
    const audit = await auditLinuxClosure(output);
    const { notices, packages, ...manifest } = audit;
    const packageIds = packages.map(pkg => `${pkg.name}@${pkg.version}`).sort();
    if (packageIds.join('\0') !== source.selected.map(pkg => `${pkg.name}@${pkg.version}`).sort().join('\0')) fail('staged-package-set-invalid');
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const auditBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, platform: 'linux', architecture: 'x64', libc: 'glibc', packages }, null, 2) + '\n');
    const nodeFile = manifest.files.find(file => file.path === NODE_ENTRY);
    const entryFile = manifest.files.find(file => file.path === LSH_ENTRY);
    if (nodeFile?.sha256 !== nodeReport.binarySha256 || !entryFile) fail('critical-input-invalid');
    const authority = { schemaVersion: 1, platform: 'linux', architecture: 'x64', libc: 'glibc',
      runtimePackage: { name: '@deepseek-ai/dsh', version: '0.2.1-rc.3',
        archiveSha256: '9a8f9493bfab8218215a8ca38ab8821e76dff63dc4fcb65841ef87c0aa277141' },
      nodeRuntime: { version: nodeReport.version, executable: NODE_ENTRY, sha256: nodeFile.sha256,
        archiveSha256: nodeReport.archiveSha256, licenseSha256: nodeReport.licenseSha256 },
      entryPoint: { path: LSH_ENTRY, sha256: entryFile.sha256 },
      inputsSha256: INPUTS_SHA256, manifestSha256: sha256(manifestBytes), packageAuditSha256: sha256(auditBytes),
      noticesSha256: sha256(Buffer.from(notices)),
      closure: { fileCount: manifest.fileCount, byteCount: manifest.byteCount, sha256: manifest.closureSha256 } };
    for (const [name, value] of [['runtime-manifest.json', manifestBytes], ['dependency-audit.json', auditBytes],
      ['THIRD-PARTY-NOTICES.txt', notices], ['runtime-authority.json', JSON.stringify(authority, null, 2) + '\n']]) {
      await writeFile(join(records, name), value, { flag: 'wx', mode: 0o644 });
    }
    console.log(JSON.stringify({ kind: 'linux-lsh-detached-closure', ...authority.closure,
      authoritySha256: sha256(Buffer.from(JSON.stringify(authority, null, 2) + '\n')) }));
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 5) throw new Error('usage: prepare-lsh-runtime.mjs node-archive pnpm-archive input-directory new-runtime new-records');
  prepareLinuxLsh({ nodeArchive: resolve(args[0]), pnpmArchive: resolve(args[1]), inputDirectory: resolve(args[2]),
    output: resolve(args[3]), records: resolve(args[4]) }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
