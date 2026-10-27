import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeSurfaceOwner } from '../../src-tauri/dsh-host/luckyray-dsh-host.mjs';
import { cleanupLinuxSyntheticChildren } from './dshLinuxSyntheticCleanup.mjs';

export async function openSyntheticCarrier() {
  const app = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), 'dsh021-original-files-'));
  const children = [];
  for (const name of ['dsh-authenticated-webserver', 'dsh-resource-tools', 'dsh-native-surface-state', 'dsh-lightseek-ui']) {
    const target = join(root, 'profiles/node_modules/@luckyray', name);
    await mkdir(target, { recursive: true });
    await cp(join(app, 'src-tauri/dsh-host', `luckyray-${name}`), target, { recursive: true });
  }
  const patch = join(root, 'native.patch.yml');
  await writeFile(patch, await readFile(join(app, 'src-tauri/dsh-host/luckyray-dsh-native-surface.patch.yml')));
  const owner = createNativeSurfaceOwner({ runtimeRoot: process.env.DSH_M1_RUNTIME_ROOT,
    stateRoot: root, surfaceHome: root, surfacePatch: patch, onChildStarted: child => children.push(child) });
  let ready, origin, jar = new Map();
  async function raw(path, init = {}) {
    const url = new URL(path, origin);
    assert.equal(url.origin, origin, 'synthetic transport stays on its exact loopback origin');
    const response = await new Promise((done, fail) => {
      const req = request(url, { method: init.method ?? 'GET', headers: { connection: 'close',
        cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '), origin, ...init.headers } }, res => {
        const chunks = []; res.on('data', x => chunks.push(x)); res.on('error', fail);
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      });
      req.on('error', fail);req.setTimeout(10000, () => req.destroy(new Error('synthetic-http-timeout')));
      req.end(init.body);
    });
    for (const cookie of response.headers['set-cookie'] ?? []) {
      const pair = cookie.split(';',1)[0], at = pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));
    }
    return response;
  }
  async function open() {
    ready = await owner.open();assert.equal(ready.stage, 'surface-ready');origin = `http://127.0.0.1:${ready.port}`;
    const bootstrap = await raw(`${ready.bootstrapPath}?ref=${ready.bootstrapRef}`);assert.equal(bootstrap.status,302);
    const exchange = await raw(bootstrap.headers.location);assert.equal(exchange.status,303);
    assert.equal((await raw('/')).status,200);
  }
  try { await open(); } catch (e) { await owner.shutdown();await cleanupLinuxSyntheticChildren(children);throw e; }
  return { root, owner, raw, open, get origin(){return origin;},
    stage: intent => owner.stageIntent(Buffer.from(JSON.stringify(intent)).toString('base64url')),
    async fetch(path, init={}) { const r=await raw(path,init);return new Response(r.status===204?null:r.bytes,{status:r.status,headers:r.headers}); },
    async dispose() { await owner.shutdown();await cleanupLinuxSyntheticChildren(children);await rm(root,{recursive:true,force:true}); },
  };
}
