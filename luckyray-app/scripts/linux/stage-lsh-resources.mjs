// Stage genuine Linux resources for native development and later packaging.
// This is not a complete desktop package or a redistribution-license gate.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditLinuxClosure, safeRelative, sha256 } from './lsh-closure.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const records = join(app, 'dsh-host/linux-x64');
const recordHashes = {
  'runtime-authority.json': '061bb2e7f06419e9b67a53cbec90457e5e51222d1633e246cfa523eacced2db2',
  'runtime-manifest.json': '3003363bf2f03a7c241dac8c15dc083b6a16f1fcb06662c176a19ce35bfc364e',
  'dependency-audit.json': '6bdae5278832f87befaf343d2735c6d19118362933d16c4ee23b498ccde205f0',
  'THIRD-PARTY-NOTICES.txt': 'aaf953ce1bab3c5de84d3fc9363754d787093dfae26003390635852fae077880',
};
const hostFiles = [
  ['HOST_SCRIPT_SHA256', 'luckyray-dsh-host.mjs'],
  ['HOST_COMPAT_SCRIPT_SHA256', 'luckyray-dsh-plugin-compat.mjs'],
  ['SURFACE_PLUGIN_SHA256', 'luckyray-dsh-authenticated-webserver/index.mjs'],
  ['RESOURCE_PLUGIN_SHA256', 'luckyray-dsh-resource-tools/index.mjs'],
  ['RESOURCE_MANIFEST_SHA256', 'luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json'],
  ['SURFACE_PATCH_SHA256', 'luckyray-dsh-native-surface.patch.yml'],
  ['SURFACE_STATE_PACKAGE_SHA256', 'luckyray-dsh-native-surface-state/package.json'],
  ['SURFACE_STATE_CLIENT_SHA256', 'luckyray-dsh-native-surface-state/client.js'],
  ['LIGHTSEEK_UI_PACKAGE_SHA256', 'luckyray-dsh-lightseek-ui/package.json'],
  ['LIGHTSEEK_UI_CLIENT_SHA256', 'luckyray-dsh-lightseek-ui/client.js'],
  ['LIGHTSEEK_UI_BACKGROUND_SHA256', 'luckyray-dsh-lightseek-ui/lightseek-cosmic-home.webp', true],
  ['PROVIDER_EXPORT_SHA256', 'luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs'],
  ['CARRIER_PACKAGE_SHA256', 'luckyray-dsh-authenticated-webserver/package.json'],
  ['RESOURCE_PACKAGE_SHA256', 'luckyray-dsh-resource-tools/package.json'],
  ['CANVAS_AGENT_SHA256', 'luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs'],
  ['CANVAS_PROJECTION_SHA256', 'luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-projection.mjs'],
  ['CANVAS_TASK_STATE_SHA256', 'luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-task-state.mjs'],
  ['CANVAS_CREATION_SCHEMA_SHA256', 'luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-creation-schema.mjs'],
];
const fail = code => { throw new Error(`linux-lsh-stage-${code}`); };

export async function readRegular(path, maximum = 512 * 1024 * 1024) {
  if (await realpath(dirname(path)) !== dirname(path)) fail('source-parent-invalid');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum
        || before.mode & 0o7022) fail('source-file-invalid');
    const bytes = await file.readFile();
    const after = await file.stat();
    const named = await lstat(path);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || named.ino !== before.ino || named.dev !== before.dev
        || named.isSymbolicLink()) fail('source-file-changed');
    return bytes;
  } finally { await file.close(); }
}

export async function stageLinuxLsh(runtime, destination) {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('platform-invalid');
  if (await realpath(runtime) !== runtime || await realpath(dirname(destination)) !== dirname(destination)) fail('path-invalid');
  const recordBytes = {};
  for (const [name, hash] of Object.entries(recordHashes)) {
    const bytes = await readRegular(join(records, name));
    if (sha256(bytes) !== hash) fail('record-identity-invalid');
    recordBytes[name] = bytes;
  }
  const manifest = JSON.parse(recordBytes['runtime-manifest.json']);
  const audit = await auditLinuxClosure(runtime);
  const { notices, packages, ...actual } = audit;
  if (sha256(Buffer.from(JSON.stringify(actual, null, 2) + '\n')) !== recordHashes['runtime-manifest.json']) fail('closure-invalid');
  const native = await readFile(join(app, 'src-tauri/src/dsh_host.rs'), 'utf8');
  const host = [];
  for (const [pin, path, binary] of hostFiles) {
    const expected = native.match(new RegExp(`const ${pin}: &str =\\s*"([a-f0-9]{64})";`))?.[1];
    const bytes = await readRegular(join(app, 'src-tauri/dsh-host', path), binary ? 600 * 1024 : 160 * 1024);
    const normalized = binary ? bytes : Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n'));
    if (!expected || !binary && normalized.includes(13) || sha256(normalized) !== expected) fail('host-identity-invalid');
    host.push({ path, bytes: normalized });
  }
  // A new destination prevents partial assembly from replacing a live bundle.
  await mkdir(destination, { mode: 0o755 });
  const slot = join(destination, 'lr-lsh/199-1');
  const stagedRuntime = join(slot, 'deepseek-harness');
  for (const entry of manifest.files) {
    safeRelative(entry.path);
    const bytes = await readRegular(join(runtime, entry.path));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail('closure-changed');
    const target = join(stagedRuntime, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, bytes, { flag: 'wx', mode: entry.mode });
    await chmod(target, entry.mode);
  }
  for (const { path, bytes } of host) {
    const target = join(slot, 'dsh-host', path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    await chmod(target, 0o644);
  }
  const licenseRoot = join(destination, 'licenses/lsh-linux');
  await mkdir(licenseRoot, { recursive: true, mode: 0o755 });
  for (const [name, bytes] of Object.entries(recordBytes)) {
    await writeFile(join(licenseRoot, name), bytes, { flag: 'wx', mode: 0o644 });
    await chmod(join(licenseRoot, name), 0o644);
  }
  async function directoryModes(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await directoryModes(join(path, entry.name));
      else if (!entry.isFile() || entry.isSymbolicLink()) fail('destination-invalid');
    }
    await chmod(path, 0o755);
  }
  await directoryModes(destination);
  const final = await auditLinuxClosure(stagedRuntime);
  if (final.closureSha256 !== manifest.closureSha256 || final.fileCount !== manifest.fileCount) fail('copied-closure-invalid');
  return { kind: 'linux-lsh-staged-resources', fileCount: final.fileCount, byteCount: final.byteCount,
    closureSha256: final.closureSha256, hostFileCount: host.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('usage: stage-lsh-resources.mjs runtime new-resource-root');
  stageLinuxLsh(resolve(process.argv[2]), resolve(process.argv[3])).then(value => console.log(JSON.stringify(value)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
