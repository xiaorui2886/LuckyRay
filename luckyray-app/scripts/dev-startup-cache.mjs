import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink, open } from 'node:fs/promises';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// A build cache, not a replacement authority. A receipt is written only after
// the original preparation/qualification succeeds. Every hit hashes all inputs
// and output bytes again; timestamps and directory existence cannot grant a hit.
export async function fingerprint(paths, optionalPaths = []) {
  const digest = createHash('sha256');
  let files = 0;
  const entries = [];
  function visit(path) {
    const meta = lstatSync(path);
    const entry = { path, metadata: JSON.stringify([path, meta.nlink, meta.mode]), file: meta.isFile(), content: null };
    entries.push(entry);
    if (meta.isSymbolicLink()) {
      throw new Error(`dev-cache-reparse-point: ${path}`);
    } else if (meta.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (meta.isFile()) {
      files++;
    } else throw new Error(`dev-cache-unsupported-file: ${path}`);
  }
  for (const path of [...paths].map(p => resolve(p)).sort()) visit(path);
  for (const path of [...optionalPaths].map(p => resolve(p)).sort()) {
    try { lstatSync(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries.push({ metadata: JSON.stringify(['absent', path]), file: false, content: null });
      continue;
    }
    // A disappearance while traversing/reading is still an error.
    visit(path);
  }
  // Bound I/O concurrency; keep the digest order identical to the directory
  // traversal. This scans every byte without a serialized await per file.
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      if (entry.file) entry.content = createHash('sha256').update(await readFile(entry.path)).digest();
    }
  }));
  for (const entry of entries) { digest.update(entry.metadata); if (entry.content) digest.update(entry.content); }
  return { hash: digest.digest('hex'), files };
}

export async function cachedStage({ name, inputs, outputs, optionalOutputs = [], receiptPath, context = {}, run, log = console.log }) {
  const started = performance.now();
  const input = await fingerprint(inputs);
  const key = JSON.stringify({ schema: 1, name, input, context });
  let receipt, output;
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); } catch { /* cold or interrupted cache */ }
  try { output = await fingerprint(outputs, optionalOutputs); } catch { /* incomplete output needs original preparation */ }
  const hit = receipt?.key === key && output && receipt?.output?.hash === output.hash;
  if (!hit) {
    log(`[dev] ${name}: preparing (inputs or verified output changed)`);
    // An unsuccessful requalification must never leave a reusable old receipt.
    await unlink(receiptPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await run();
    if (JSON.stringify(await fingerprint(inputs)) !== JSON.stringify(input)) {
      throw new Error(`dev-preparation-input-changed: ${name}; retry after the edit/build finishes`);
    }
    output = await fingerprint(outputs, optionalOutputs);
    await mkdir(dirname(receiptPath), { recursive: true });
    const temp = `${receiptPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ key, output }), { flag: 'wx' });
    try { await rename(temp, receiptPath); } finally { await unlink(temp).catch(() => {}); }
  }
  const result = { stage: name, cache: hit ? 'hit' : 'qualified', milliseconds: Math.round(performance.now() - started), files: output.files };
  log(`[dev] ${JSON.stringify(result)}`);
  return result;
}

export async function withPreparationLock(path, run) {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await readFile(path, 'utf8')).pid; } catch { /* another writer may still be recording its owner */ }
    throw new Error(`dev-preparation-busy: lock ${path}, pid ${owner ?? 'unknown'}; do not overlap preparation/build. If interrupted, verify that owner has exited before removing this lock.`);
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await run(); }
  finally { await handle.close(); await unlink(path); }
}
