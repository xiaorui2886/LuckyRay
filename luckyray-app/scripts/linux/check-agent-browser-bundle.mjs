// T55: refuse to package the Linux Agent Browser engine unless the staged
// bundle is exactly the pinned chrome-headless-shell.
//
// Stage it first with:
//   python3 tools/linux-agent-browser/shell.py stage <archive> src-tauri/agent-browser
//
// Checks: the whole-bundle digest and file count (same manifest as shell.py
// bundle-digest), the executable sha256, the licence files, no symlinks or
// special files, the Tauri resource mapping, the deb AppArmor profile naming
// exactly the installed engine path, and the host's packaged engine path.
// Messages name only repository-relative paths and pinned values.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEX64 = /^[0-9a-f]{64}$/;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Same manifest as shell.py bundle-digest. Throws on a refused entry. */
export function bundleManifest(root) {
  const lines = [];
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory()) { walk(path); continue; }
      if (!info.isFile()) throw new Error('bundle entry is not a regular file');
      const mode = info.mode & 0o7777;
      if (mode !== 0o755 && mode !== 0o644) throw new Error('bundle file mode refused');
      lines.push(`${sha256File(path)}  ${mode.toString(8)}  ${relative(root, path).split(sep).join('/')}\n`);
    }
  };
  walk(root);
  // Python sorts by code point; these paths are ASCII, so default sort agrees.
  return lines.sort();
}

export function bundleDigest(root) {
  const lines = bundleManifest(root);
  return { digest: createHash('sha256').update(lines.join('')).digest('hex'), files: lines.length };
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/**
 * Returns a list of problems; empty means the bundle may be packaged.
 * `appRoot` is luckyray-app/, `bundleDir` the staged resource directory.
 */
export function checkAgentBrowserBundle({ appRoot, pin, bundleDir = join(appRoot, 'src-tauri', 'agent-browser') }) {
  const problems = [];
  if (!HEX64.test(pin.bundleSha256 ?? '') || !HEX64.test(pin.executableSha256 ?? '')
      || !Number.isInteger(pin.bundleFileCount) || pin.bundleFileCount < 1
      || typeof pin.executable !== 'string' || !Array.isArray(pin.licenseFiles) || pin.licenseFiles.length === 0) {
    return ['pin.json is incomplete'];
  }
  const installed = `/usr/lib/LuckyRay/agent-browser/${pin.executable}`;
  if (pin.installPath !== '/usr/lib/LuckyRay/agent-browser') problems.push('pin installPath is not /usr/lib/LuckyRay/agent-browser');

  let root;
  try { root = lstatSync(bundleDir); } catch { root = null; }
  if (!root) problems.push('agent-browser bundle missing: stage it with shell.py stage');
  else if (!root.isDirectory()) problems.push('agent-browser bundle is not a plain directory');
  else {
    try {
      const { digest, files } = bundleDigest(bundleDir);
      if (files !== pin.bundleFileCount) problems.push(`agent-browser bundle has ${files} files, pinned ${pin.bundleFileCount}`);
      if (digest !== pin.bundleSha256) problems.push('agent-browser bundle digest does not match pin.json');
    } catch (error) {
      problems.push(`agent-browser bundle refused: ${error.message}`);
    }
    try {
      if (sha256File(join(bundleDir, pin.executable)) !== pin.executableSha256) problems.push('agent-browser executable does not match pin.json');
    } catch { problems.push('agent-browser executable missing'); }
    for (const name of pin.licenseFiles) {
      let ok = false;
      try { ok = lstatSync(join(bundleDir, name)).isFile(); } catch { ok = false; }
      if (!ok) problems.push(`licence notice missing: ${name}`);
    }
  }

  const linuxConfig = JSON.parse(readText(join(appRoot, 'src-tauri', 'tauri.linux.conf.json')) ?? '{}');
  if (linuxConfig.bundle?.resources?.['agent-browser/'] !== 'agent-browser/') problems.push('tauri.linux.conf.json does not map agent-browser/ as a resource');
  const deb = linuxConfig.bundle?.linux?.deb ?? {};
  if (deb.files?.['/usr/share/luckyray/apparmor/luckyray-agent-browser'] !== 'linux/apparmor/luckyray-agent-browser'
      || deb.postInstallScript !== 'linux/deb/postinst' || deb.postRemoveScript !== 'linux/deb/postrm') {
    problems.push('deb does not ship the AppArmor profile with its postinst/postrm');
  }
  const profile = readText(join(appRoot, 'src-tauri', 'linux', 'apparmor', 'luckyray-agent-browser'));
  const header = `profile luckyray-agent-browser ${installed} flags=(unconfined) {`;
  if (profile === null) problems.push('AppArmor profile missing');
  else {
    const rules = profile.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const expected = ['abi <abi/4.0>,', 'include <tunables/global>', header, 'userns,',
      'include if exists <local/luckyray-agent-browser>', '}'];
    if (JSON.stringify(rules) !== JSON.stringify(expected)) problems.push('AppArmor profile is not exactly the userns grant for the installed engine path');
  }
  const host = readText(join(appRoot, 'src-tauri', 'src', 'browser_host_poc', 'mod.rs')) ?? '';
  if (!host.includes(`"lib/LuckyRay/agent-browser/${pin.executable}"`)) problems.push('browser host does not resolve the packaged engine path');
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appRoot = fileURLToPath(new URL('../..', import.meta.url));
  const pin = JSON.parse(readFileSync(join(appRoot, 'tools', 'linux-agent-browser', 'pin.json'), 'utf8'));
  const bundleDir = process.argv[2];
  const problems = checkAgentBrowserBundle({ appRoot, pin, ...(bundleDir ? { bundleDir } : {}) });
  if (problems.length) {
    console.error('LuckyRay Linux Agent Browser bundle refused:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    const { digest, files } = bundleDigest(bundleDir ?? join(appRoot, 'src-tauri', 'agent-browser'));
    console.log(`chrome-headless-shell ${pin.version} bundle-sha256=${digest} files=${files}`);
  }
}
