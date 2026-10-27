import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Linux qualification fixture only. The production owner uses Windows
// taskkill /T; this closes only descendants of a captured synthetic child.
export async function cleanupLinuxSyntheticChildren(children) {
  if (process.platform !== 'linux') return;
  const descendants = async pid => {
    let raw;
    try { raw = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const ids = raw.trim() ? raw.trim().split(/\s+/).map(Number) : [];
    return (await Promise.all(ids.map(async id => [...await descendants(id), id]))).flat();
  };
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1);
    const ids = [...await descendants(child.pid), child.pid];
    const exited = new Promise(resolve => child.once('exit', resolve));
    for (const pid of ids) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('synthetic-child-exit-unconfirmed')), 5000);
      })]);
    } finally { clearTimeout(timer); }
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
}
