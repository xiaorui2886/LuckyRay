// Only official installed runtime APIs and newly-created synthetic files.
// This script is a test harness, not LuckyRay product implementation.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, 'xiaorui2886/LuckyRay');
assert.equal(process.env.USERNAME, 'runneradmin');
const [mode, runtimeArg, hostArg, profileArg, proofArg] = process.argv.slice(2);
const runtime = resolve(runtimeArg), host = resolve(hostArg), profile = resolve(profileArg), proof = resolve(proofArg);
assert.equal(profile.toLowerCase(), resolve(process.env.APPDATA, 'com.luckyray.desktop').toLowerCase());
assert(proof.startsWith(resolve(process.env.RUNNER_TEMP) + '\\'));
const state = join(profile, 'deepseek-harness/native-state/rc8-native-surface-v1');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(root) {
  const result = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    assert(!e.isSymbolicLink()); const p = join(root, e.name);
    if (e.isDirectory()) result.push(...await files(p)); else { assert(e.isFile()); result.push(p); }
  }
  return result;
}
async function context() {
  const load = name => import(pathToFileURL(join(runtime, 'host/node_modules', name, 'lib/index.js')));
  const { Context } = await load('@deepseek-ai/cordis'); const ctx = new Context();
  await ctx.plugin((await load('@deepseek-ai/dsh-storage')).default);
  await ctx.plugin(await load('@deepseek-ai/dsh-storage-json'), { root: join(state, 'storages') });
  await ctx.plugin(await load('@deepseek-ai/dsh-storage-domain'), { backend: 'json' });
  const p = await load('@deepseek-ai/dsh-session-persistence-jsonl');
  await ctx.plugin(p.default ?? p, { root: join(state, 'sessions') });
  await ctx.plugin((await load('@deepseek-ai/dsh-workspace')).default);
  return ctx;
}
try {
  if (mode === 'seed') {
    await mkdir(profile, { recursive: true });
    const { runNativeDshProbe } = await import(pathToFileURL(join(host, 'luckyray-dsh-host.mjs')));
    // Product's local fixed-response fixture only; no upstream model request.
    await runNativeDshProbe({ runtimeRoot: runtime, stateRoot: state });
    const ctx = await context(); const sessions = await ctx.sessionPersistence.list();
    assert.equal(sessions.length, 1); const id = sessions[0].header.id;
    const handle = await ctx.sessionPersistence.open(id, 'read'); const events = (await handle.read()).events;
    await handle.close(); assert(events.length > 0);
    const workspace = ctx.workspaceRegistry.list().find(x => x.sessionIds.includes(id)); assert(workspace);
    await workspace.setTitle('LR installed synthetic preservation'); await ctx.fiber.dispose();
    const attachments = join(state, 'workspace/lr-synthetic-attachments'); await mkdir(attachments, { recursive: true });
    await writeFile(join(attachments, 'synthetic-original.md'), '# Synthetic original\nNo user data.\n');
    await writeFile(join(attachments, 'synthetic-pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    const protectedFiles = [];
    for (const dir of ['sessions', 'storages', 'workspace/lr-synthetic-attachments']) for (const p of await files(join(state, dir))) {
      const b = await readFile(p); protectedFiles.push({ kind: dir === 'storages' ? 'index' : dir === 'sessions' ? 'session' : 'attachment', path: relative(profile, p), bytes: b.length, sha256: hash(b) });
    }
    await writeFile(proof, JSON.stringify({ sessionId: id, eventCount: events.length, eventsSha256: hash(JSON.stringify(events)), files: protectedFiles }));
    console.log(JSON.stringify({ seeded: true, sessionCount: 1, eventCount: events.length, protectedFiles: protectedFiles.length, modelRequests: 0 }));
  } else if (mode === 'read') {
    const previous = JSON.parse(await readFile(proof, 'utf8'));
    let changedIndexes = 0;
    for (const file of previous.files) {
      const same = hash(await readFile(join(profile, file.path))) === file.sha256;
      if (file.kind === 'index') { if (!same) changedIndexes++; } else assert(same);
    }
    const ctx = await context(); const sessions = await ctx.sessionPersistence.list();
    assert(sessions.some(x => x.header.id === previous.sessionId));
    const handle = await ctx.sessionPersistence.open(previous.sessionId, 'read'); const events = (await handle.read()).events;
    assert.equal(hash(JSON.stringify(events)), previous.eventsSha256); await handle.close();
    assert(ctx.workspaceRegistry.list().some(x => x.sessionIds.includes(previous.sessionId) && x.title === 'LR installed synthetic preservation'));
    await ctx.fiber.dispose();
    for (const file of previous.files.filter(x => x.kind !== 'index')) assert.equal(hash(await readFile(join(profile, file.path))), file.sha256);
    console.log(JSON.stringify({ preserved: true, sessionCount: 1, eventCount: events.length, protectedFiles: previous.files.length, changedIndexes, workspaceOwnershipPreserved: true, modelRequests: 0 }));
  } else throw Error('unknown-synthetic-mode');
} catch (e) { console.error(JSON.stringify({ stage: mode, errorType: e.constructor.name, code: 'synthetic-data-check-failed' })); process.exitCode = 1; }
