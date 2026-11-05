// S3: place a verified Linux LSH runtime at src-tauri/dsh for Tauri bundling.
// Reuses stageLinuxLsh (closure, record and host pins) and refuses to replace
// an existing src-tauri/dsh.
import { lstat, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageLinuxLsh } from './stage-lsh-resources.mjs';
import { checkLinuxLshPackage } from './check-lsh-package.mjs';

const appRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/u, '');

export async function stageLinuxLshPackage(runtime) {
  const target = join(appRoot, 'src-tauri/dsh');
  if (await lstat(target).then(() => true, () => false)) throw new Error('linux-lsh-package-target-exists');
  const scratch = join(appRoot, 'src-tauri', `.lsh-package-stage-${process.pid}`);
  try {
    const staged = await stageLinuxLsh(runtime, scratch);
    await rename(join(scratch, 'lr-lsh/199-1/deepseek-harness'), target);
    const problems = await checkLinuxLshPackage({ appRoot });
    if (problems.length) {
      await rm(target, { recursive: true, force: true });
      throw new Error(`linux-lsh-package-unsealed: ${problems.join('; ')}`);
    }
    return { ...staged, kind: 'linux-lsh-package-staged' };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('usage: stage-lsh-package.mjs runtime');
  stageLinuxLshPackage(resolve(process.argv[2])).then(value => console.log(JSON.stringify(value)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
