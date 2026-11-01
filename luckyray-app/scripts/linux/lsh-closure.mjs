// Linux packaging primitives. No network, package resolution, hooks or launch.
import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readdir, readlink, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectDshDistributionMetadata } from '../dsh-supply-chain.mjs';

export const LSH_VERSION = '0.2.1-rc.3';
export const LINUX_PACKAGE_COUNT = 564;
export const LSH_ENTRY = 'host/node_modules/@deepseek-ai/dsh/lib/bin.js';
export const NODE_ENTRY = 'node/node';
export const MAX_FILES = 40_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const allowedLicenses = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
  'ISC', 'Unlicense', '0BSD', '(MIT OR CC0-1.0)', 'MPL-2.0', 'Python-2.0', 'LGPL-3.0-or-later']);
const fail = code => { throw new Error(`linux-lsh-${code}`); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const portable = path => path.split(sep).join('/');

export function safeRelative(path) {
  if (typeof path !== 'string' || path.length === 0 || Buffer.byteLength(path) > 1024
      || isAbsolute(path) || /[\\\u0000-\u001f\u007f]/u.test(path)
      || path.normalize('NFC') !== path || path.split('/').some(p => !p || p === '.' || p === '..')) fail('path-invalid');
  return path;
}

async function regular(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size > 512 * 1024 * 1024) fail('file-invalid');
  return metadata;
}

async function packageRoots(nodeModules) {
  const roots = [];
  async function scan(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('package-root-invalid');
      const path = join(directory, entry.name);
      const candidates = entry.name.startsWith('@')
        ? (await readdir(path, { withFileTypes: true })).map(item => {
          if (!item.isDirectory() || item.isSymbolicLink()) fail('package-root-invalid');
          return join(path, item.name);
        }) : [path];
      for (const root of candidates) {
        await regular(join(root, 'package.json'));
        roots.push(root);
        await scan(join(root, 'node_modules'));
      }
    }
  }
  await scan(nodeModules);
  return roots.sort(order);
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export async function projectLinuxLayout(root) {
  const nodeModules = join(root, 'host/node_modules');
  const bin = join(nodeModules, '.bin');
  const links = await readdir(bin, { withFileTypes: true });
  const expected = ['anthropic-ai-sdk', 'cordis', 'dsh', 'dsoffice', 'is-docker', 'is-inside-container',
    'js-yaml', 'loose-envify', 'node-which', 'pi-ai', 'semver', 'which-command', 'yaml'].sort(order);
  if (links.map(x => x.name).sort(order).join('\0') !== expected.join('\0')) fail('bin-set-invalid');
  const plans = [];
  for (const item of links) {
    const path = join(bin, item.name);
    if (!item.isSymbolicLink()) fail('bin-link-invalid');
    const link = await readlink(path);
    if (isAbsolute(link)) fail('bin-link-invalid');
    const target = resolve(bin, link);
    if (!target.startsWith(nodeModules + sep) || await realpath(target) !== target) fail('bin-link-invalid');
    await regular(target);
    const head = (await readFile(target)).subarray(0, 160).toString();
    if (!head.startsWith('#!/usr/bin/env node')) fail('bin-interpreter-invalid');
    const node = relative(bin, join(root, NODE_ENTRY));
    const script = '#!/bin/sh\nset -eu\ncase "$0" in /*) self=$0;; *) self=$PWD/$0;; esac\nbase=${self%/*}\n'
      + `exec "$base"/${quote(portable(node))} "$base"/${quote(portable(relative(bin, target)))} "$@"\n`;
    plans.push({ path, script });
  }
  for (const plan of plans) {
    await unlink(plan.path);
    await writeFile(plan.path, plan.script, { flag: 'wx', mode: 0o755 });
  }
  // Only pnpm's known, detached installation metadata is omitted. The frozen
  // input lock remains at host/pnpm-lock.yaml and is authenticated separately.
  const pnpm = join(nodeModules, '.pnpm');
  if ((await readdir(pnpm)).join('\0') !== 'lock.yaml') fail('pnpm-layout-invalid');
  for (const name of ['.modules.yaml', '.pnpm-workspace-state-v1.json', '.pnpm/lock.yaml']) {
    const path = join(nodeModules, name);
    await regular(path);
    await unlink(path);
  }
  await rmdir(pnpm);
  await projectDshDistributionMetadata({ nodeModulesRoot: nodeModules });
  async function modes(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('link-in-runtime');
      if (entry.isDirectory()) {
        await modes(path);
        if ((await readdir(path)).length === 0) await rmdir(path);
        else await chmod(path, 0o755);
      } else if (entry.isFile()) {
        const metadata = await regular(path);
        if (metadata.mode & 0o7000) fail('special-mode');
        await chmod(path, metadata.mode & 0o111 ? 0o755 : 0o644);
      } else fail('special-file');
    }
  }
  await modes(root);
  await chmod(root, 0o755);
}

export function closureDigest(files) {
  const hash = createHash('sha256');
  let previous = '';
  for (const file of files) {
    safeRelative(file.path);
    if (previous && order(previous, file.path) >= 0 || ![0o644, 0o755].includes(file.mode)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[a-f0-9]{64}$/u.test(file.sha256)) fail('manifest-entry-invalid');
    hash.update(`${file.path}\0${file.mode}\0${file.bytes}\0${file.sha256}\n`);
    previous = file.path;
  }
  return hash.digest('hex');
}

export async function auditLinuxClosure(root) {
  if (!isAbsolute(root) || await realpath(root) !== root) fail('root-invalid');
  const files = [];
  let bytes = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('link-in-runtime');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const metadata = await regular(path);
        const mode = metadata.mode & 0o7777;
        if (![0o644, 0o755].includes(mode)) fail('mode-invalid');
        bytes += metadata.size;
        if (files.length >= MAX_FILES || bytes > MAX_BYTES) fail('closure-budget');
        const value = await readFile(path);
        const after = await regular(path);
        if (after.ino !== metadata.ino || after.dev !== metadata.dev || after.size !== metadata.size
            || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) fail('file-changed');
        files.push({ path: safeRelative(portable(relative(root, path))), bytes: metadata.size, mode, sha256: sha256(value) });
      } else fail('special-file');
    }
  }
  await walk(root);
  files.sort((a, b) => order(a.path, b.path));
  const roots = await packageRoots(join(root, 'host/node_modules'));
  const packages = new Map();
  const notice = [];
  for (const packageRoot of roots) {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string'
        || !allowedLicenses.has(manifest.license)) fail('package-license-invalid');
    const identity = `${manifest.name}@${manifest.version}`;
    const prefix = portable(relative(root, packageRoot)) + '/';
    const owned = files.filter(file => file.path.startsWith(prefix)
      && !file.path.slice(prefix.length).startsWith('node_modules/'));
    const licensed = owned.filter(file => /^(?:licen[cs]e|copying|notice)(?:[-.].*)?$/iu.test(basename(file.path))
      || manifest.name === '@img/sharp-libvips-linux-x64' && file.path === prefix + 'README.md');
    const record = { name: manifest.name, version: manifest.version, license: manifest.license,
      contentSha256: closureDigest(owned.map(file => ({ ...file, path: file.path.slice(prefix.length) }))),
      licenseFiles: licensed.map(file => ({ path: file.path.slice(prefix.length), bytes: file.bytes, sha256: file.sha256 })),
      lifecycleScripts: ['preinstall', 'install', 'postinstall'].filter(name => manifest.scripts?.[name])
        .map(name => ({ stage: name, command: manifest.scripts[name] })) };
    const old = packages.get(identity);
    if (old && old.contentSha256 !== record.contentSha256) fail('ambiguous-package');
    packages.set(identity, record);
    if (!old) {
      notice.push(`${identity}\nLicense: ${manifest.license}\n`);
      for (const file of licensed) notice.push(`--- ${file.path.slice(prefix.length)} ---\n${await readFile(join(root, file.path), 'utf8')}\n`);
    }
  }
  if (packages.size !== LINUX_PACKAGE_COUNT) fail('package-count-invalid');
  return { schemaVersion: 1, platform: 'linux', architecture: 'x64', libc: 'glibc',
    runtimePackage: { name: '@deepseek-ai/dsh', version: LSH_VERSION },
    executable: NODE_ENTRY, entryPoint: LSH_ENTRY, fileCount: files.length, byteCount: bytes,
    closureSha256: closureDigest(files), files,
    packages: [...packages.values()].sort((a, b) => order(`${a.name}@${a.version}`, `${b.name}@${b.version}`)),
    notices: notice.join('\n') };
}
