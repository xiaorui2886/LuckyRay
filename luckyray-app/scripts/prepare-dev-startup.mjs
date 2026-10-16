import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { cachedStage, withPreparationLock } from './dev-startup-cache.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const receiptRoot = join(root, 'src-tauri/target/.dev-startup');
export async function getStartupStages(root) {
const script = name => join(root, 'scripts', name);
const at = path => join(root, path);
// Installed development dependencies are not preparation inputs. The frozen
// lock/policy/authority/records and host assets are; staged closure is hashed in
// full below. Avoid walking pnpm's resolver junctions in the source checkout.
const dshInputs = (await readdir(at('dsh-host'))).filter(name => name !== 'node_modules').map(name => `dsh-host/${name}`);
dshInputs.push('src-tauri/dsh-host');
const powershell = (file, ...args) => ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script(file), ...args]];
const stages = [
  { name: 'media', inputs: ['third_party/media-engine'], outputs: ['src-tauri/media-engine'], command: powershell('prepare-media-engine.ps1') },
  { name: 'dsh-package', inputs: dshInputs, outputs: ['src-tauri/dsh'], command: powershell('prepare-dsh-package-runtime.ps1') },
  { name: 'dsh-debug', inputs: dshInputs, outputs: ['src-tauri/target/debug/deepseek-harness'], command: powershell('prepare-dsh-dev-runtime.ps1') },
  { name: 'sidecars', inputs: ['src-tauri/src','src-tauri/build.rs','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','config/release-extension-origins.json','browser-extension-prototype/manifest.json'], outputs: ['src-tauri/binaries/luckyray-cli-x86_64-pc-windows-msvc.exe','src-tauri/binaries/luckyray-cli-x86_64-pc-windows-msvc.exe.identity.json','src-tauri/target/debug/luckyray-cli.exe','src-tauri/target/debug/luckyray-browser-host.exe'],
    // Written only by -Release (all four binaries). Development does not create
    // this file, but changes to an existing release contract must invalidate it.
    optionalOutputs: ['src-tauri/binaries/luckyray-sidecars.origin.identity.json'], command: powershell('prepare-dev-sidecars.ps1') },
];
return stages.map(stage => ({ ...stage,
  inputs: [...stage.inputs, 'scripts', 'package.json'].map(at),
  outputs: stage.outputs.map(at), optionalOutputs: (stage.optionalOutputs ?? []).map(at),
  receiptPath: join(root, 'src-tauri/target/.dev-startup', `${stage.name}.json`),
}));
}
async function run(command) {
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`dev-preparation-failed: ${command[0]} exited ${code}`)));
  });
}
// --runtimes-only is a diagnostic/preparation mode. It never launches the app,
// modifies the sidecar contract, or claims the desktop build is ready.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const stages = await getStartupStages(root);
const selected = process.argv.includes('--runtimes-only') ? stages.slice(0, 3) : stages;
if (process.argv.includes('--runtimes-only')) selected.find(stage => stage.name === 'dsh-debug').command[1].push('-ValidateOnly');
const results = [];
await withPreparationLock(join(receiptRoot, 'preparation.lock'), async () => {
for (const stage of selected) {
  results.push(await cachedStage({ ...stage,
    context: { node: process.version, arch: process.arch, origins: process.env.LUCKYRAY_DEV_EXTENSION_ORIGINS ?? '', rustflags: process.env.RUSTFLAGS ?? '', encodedRustflags: process.env.CARGO_ENCODED_RUSTFLAGS ?? '', rustup: process.env.RUSTUP_TOOLCHAIN ?? '', rustc: stage.name === 'sidecars' ? execFileSync('rustc', ['--version'], { encoding: 'utf8', windowsHide: true }).trim() : '', target: process.env.CARGO_TARGET_DIR ?? '' },
    run: () => run(stage.command),
  }));
}
await mkdir(receiptRoot, { recursive: true });
await writeFile(join(receiptRoot, 'last-preparation.json'), JSON.stringify({ completedAt: new Date().toISOString(), runtimesOnly: selected.length !== stages.length, stages: results }, null, 2));
});
}
