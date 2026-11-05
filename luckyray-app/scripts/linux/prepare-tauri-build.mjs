// Linux Tauri beforeBuildCommand. It manufactures nothing: every release input
// must already be staged, and each one is judged by its own Linux gate. Any
// problem refuses the build; build.rs keeps its own release checks.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkAgentBrowserBundle } from './check-agent-browser-bundle.mjs';
import { checkLinuxLshPackage } from './check-lsh-package.mjs';

const defaultRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/u, '');

// The shared base config bundles the tracked ../third-party-notices/ folder;
// these are the files the Windows readiness gate also requires.
export const requiredNotices = ['README.md', 'LuckyRay-MIT-LICENSE', 'deno-2.9.4/INDEX.json',
  'deno-2.9.4/NATIVE-INDEX.json', 'seahash-4.1.0/LICENSE'];

function plainFile(path) {
  try { const s = lstatSync(path); return s.isFile() && s.size > 0; } catch { return false; }
}

function python(appRoot, args) {
  const run = spawnSync('python3', args, { cwd: appRoot, encoding: 'utf8', timeout: 600_000 });
  if (run.status === 0) return [];
  const last = (run.stderr || run.error?.message || 'failed').trim().split('\n').pop();
  return [last || `exit ${run.status}`];
}

export async function linuxPackageProblems({ appRoot = defaultRoot, run = python } = {}) {
  const tauri = join(appRoot, 'src-tauri');
  const pin = JSON.parse(readFileSync(join(appRoot, 'tools/linux-agent-browser/pin.json'), 'utf8'));
  const problems = [];
  for (const p of checkAgentBrowserBundle({ appRoot, pin })) problems.push(`Agent Browser: ${p}`);
  for (const p of await checkLinuxLshPackage({ appRoot })) problems.push(`LSH: ${p}`);
  for (const p of run(appRoot, ['tools/linux-sidecars/sidecars.py', 'verify', tauri, join(tauri, 'binaries')])) {
    problems.push(`Sidecars: ${p}`);
  }
  for (const p of run(appRoot, ['tools/linux-media-engine/engine.py', 'verify', join(tauri, 'media-engine')])) {
    problems.push(`Media engine: ${p}`);
  }
  for (const name of requiredNotices) {
    if (!plainFile(join(appRoot, 'third-party-notices', name))) problems.push(`Notices: third-party-notices/${name} missing`);
  }
  if (!plainFile(join(appRoot, 'dist/index.html'))) problems.push('Frontend: dist/index.html missing');
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = await linuxPackageProblems();
  if (problems.length) {
    console.error('LuckyRay Linux package preparation is unavailable:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ kind: 'linux-package-prepared', gates: 6 }));
  }
}
