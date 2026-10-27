import { cleanupLinuxSyntheticChildren } from './fixtures/dshLinuxSyntheticCleanup.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createNativeSurfaceOwner } from '../src-tauri/dsh-host/luckyray-dsh-host.mjs';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = process.env.DSH_M1_RUNTIME_ROOT;
const rawFetch = (url, headers = {}) => new Promise((done, fail) => {
  const req = request(url, { headers: { connection: 'close', ...headers } }, response => {
    const bytes = [];
    response.on('data', chunk => bytes.push(chunk));
    response.on('end', () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(bytes).toString('utf8') }));
  });
  req.on('error', fail);
  req.setTimeout(10000, () => req.destroy(new Error('synthetic cookie request timeout')));
  req.end();
});
const putCookies = (jar, response) => {
  for (const value of response.headers['set-cookie'] ?? []) {
    const pair = value.split(';', 1)[0];
    const at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
};
const cookieHeader = jar => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

test('native browser uses two bounded authentication slots across warm bindings and cold ports', { timeout: 75000 }, async t => {
  assert.ok(runtimeRoot, 'explicit existing LSH runtime required; never install or upgrade');
  const root = await mkdtemp(join(tmpdir(), 'luckyray-cookie-lifecycle-'));
  const patch = join(root, 'native.patch.yml');
  for (const name of ['dsh-authenticated-webserver', 'dsh-resource-tools', 'dsh-native-surface-state', 'dsh-lightseek-ui']) {
    const destination = join(root, 'profiles', 'node_modules', '@luckyray', name);
    await mkdir(destination, { recursive: true });
    await cp(join(appRoot, 'src-tauri', 'dsh-host', `luckyray-${name}`), destination, { recursive: true });
  }
  await writeFile(patch, await readFile(join(appRoot, 'src-tauri/dsh-host/luckyray-dsh-native-surface.patch.yml')));
  const children = [];
  const makeOwner = () => createNativeSurfaceOwner({ runtimeRoot, stateRoot: root, surfaceHome: root, surfacePatch: patch, onChildStarted: child => children.push(child) });
  let owner = makeOwner();
  const jar = new Map();
  let previousOfficial;
  let previousPort;
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      if (cycle === 2) { await owner.shutdown(); await cleanupLinuxSyntheticChildren(children); owner = makeOwner(); }
      const ready = await owner.open();
      const base = `http://127.0.0.1:${ready.port}`;
      const bootstrap = await rawFetch(`${base}${ready.bootstrapPath}?ref=${ready.bootstrapRef}`, { cookie: cookieHeader(jar) });
      assert.equal(bootstrap.status, 302);
      putCookies(jar, bootstrap);
      if (cycle === 2) {
        assert.notEqual(ready.port, previousPort);
        // Fresh carrier authorization must not make an old signed audience valid.
        const withOldOfficial = cookieHeader(jar);
        assert.equal((await rawFetch(base, { cookie: withOldOfficial })).status, 401);
      }
      const exchange = await rawFetch(new URL(bootstrap.headers.location, base), { cookie: cookieHeader(jar) });
      assert.equal(exchange.status, 303);
      putCookies(jar, exchange);
      const index = await rawFetch(base, { cookie: cookieHeader(jar) });
      assert.equal(index.status, 200);
      assert.match(index.body, /__DSH_BOOT__/);
      assert.equal(jar.size, 2, `cycle ${cycle}: browser cookies must not accumulate per generation or port`);
      assert.equal(Buffer.byteLength(cookieHeader(jar)) < 1024, true);
      assert.equal((await rawFetch(base, { cookie: cookieHeader(jar), origin: 'http://127.0.0.1:1' })).status, 403);
      assert.equal((await rawFetch(base, { cookie: cookieHeader(jar), host: 'localhost:1' })).status, 403);
      previousOfficial = [...jar].find(([name]) => name.startsWith('dsh-auth-'));
      previousPort = ready.port;
      assert.ok(previousOfficial);
      await owner.close();
    }
    t.diagnostic(JSON.stringify({ root, authenticationSlots: jar.size, headerBytes: Buffer.byteLength(cookieHeader(jar)), cycles: 4 }));
  } finally {
    await owner.shutdown(); await cleanupLinuxSyntheticChildren(children);
    // Preserve synthetic failure roots; never remove real profile data.
  }
});

test('69 legacy cookies plus ordinary browser fields exceed the default parser before any handler', async () => {
  const { createServer, maxHeaderSize } = await import('node:http');
  let handlerCalls = 0;
  const server = createServer((_request, response) => { handlerCalls++; response.end('called'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const legacy = Array.from({ length: 69 }, (_, index) => `dsh-auth-${String(index).padStart(43, 'a')}=${'v'.repeat(172)}`).join('; ');
    const response = await rawFetch(`http://127.0.0.1:${server.address().port}/_luckyray/bootstrap`, {
      cookie: legacy, 'user-agent': 'synthetic-browser'.repeat(40), 'sec-ch-ua': 'x'.repeat(280),
    });
    assert.equal(maxHeaderSize, 16384);
    assert.equal(response.status, 431);
    assert.equal(handlerCalls, 0);
  } finally { await new Promise(done => server.close(done)); }
});
