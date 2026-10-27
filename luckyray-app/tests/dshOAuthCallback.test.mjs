import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  acceptsOfficialOAuthCallback, createCarrierAuthorization, evaluateHttpAuthorization,
  evaluateWebSocketAuthorization,
} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs';

const authority = createCarrierAuthorization({ generation: 1, host: '127.0.0.1:7889',
  origin: 'http://127.0.0.1:7889', cookieName: 'native', cookieValue: 'x'.repeat(32),
  bootstrapRef: 'y'.repeat(32), exactPaths: ['/oauth/callback', '/api/private'],
  prefixPaths: ['/'], upgradePaths: ['/ws'] });
const route = {kind: 'exact', path: '/oauth/callback', handler() {}};
const request = {method: 'GET', url: '/oauth/callback?code=synthetic&state=synthetic',
  path: '/oauth/callback', headers: {host: authority.host, 'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document'}};

test('external-browser callback reaches only the live exact official handler', () => {
  assert.equal(evaluateHttpAuthorization(authority, request).accepted, false);
  assert.equal(acceptsOfficialOAuthCallback(authority, request, route), true);
  for (const absent of [undefined, {...route, kind: 'prefix'}, {...route, path: '/'}])
    assert.equal(acceptsOfficialOAuthCallback(authority, request, absent), false);
  assert.equal(acceptsOfficialOAuthCallback({...authority, active: false}, request, route), false);
});

test('callback bridge rejects wrong authority, method, subresource and origin', () => {
  for (const headers of [{host: 'localhost:7889'}, {host: '127.0.0.1:7890'},
    {host: 'phone.example'}, {origin: 'https://evil.example'},
    {'sec-fetch-mode': 'cors'}, {'sec-fetch-dest': 'image'}]) {
    assert.equal(acceptsOfficialOAuthCallback(authority,
      {...request, headers: {...request.headers, ...headers}}, route), false);
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS'])
    assert.equal(acceptsOfficialOAuthCallback(authority, {...request, method}, route), false);
});

test('callback bridge rejects aliases, malformed and duplicate parameters', () => {
  for (const url of ['/api/private?code=x&state=y', '/oauth/callback/extra?code=x&state=y',
    '/oauth/%63allback?code=x&state=y', 'http://127.0.0.1:7889/oauth/callback?code=x&state=y',
    '/oauth/callback', '/oauth/callback?code=x', '/oauth/callback?state=y',
    '/oauth/callback?code=&state=y', '/oauth/callback?code=x&state=',
    '/oauth/callback?code=x&code=z&state=y', '/oauth/callback?code=x&state=y&state=z',
    `/oauth/callback?code=${'x'.repeat(8192)}&state=y`])
    assert.equal(acceptsOfficialOAuthCallback(authority, {...request, url}, route), false);
});

test('ordinary HTTP and WebSocket authority fences remain closed', () => {
  assert.equal(evaluateHttpAuthorization(authority, {...request, path: '/api/private'}).accepted, false);
  assert.equal(evaluateWebSocketAuthorization(authority, {...request, path: '/ws'}).accepted, false);
  assert.equal(evaluateHttpAuthorization(authority, {...request,
    headers: {host: authority.host, cookie: `native=${'x'.repeat(32)}`}}).accepted, true);
});

// No network, browser, account or credential store is used. Invoke the real
// pinned official handler with synthetic auth_init and an in-memory attempt.
test('official DSH callback still rejects bad state and replay before PKCE exchange', {
  skip: !process.env.DSH_M1_RUNTIME_ROOT && 'requires official runtime fixture',
}, async () => {
  const {PlatformAccount} = await import(pathToFileURL(join(process.env.DSH_M1_RUNTIME_ROOT,
    'host/node_modules/@deepseek-ai/dsh-deepseek-account-platform/lib/index.js')).href);
  let live, state, touchedCredential = false;
  const stop = new Error('synthetic-stop-before-credential-write');
  const attempt = {origin: authority.origin, locale: 'en_US', loginSource: 'web',
    clientHeaders: {}, view: {phase: 'initializing'}};
  const controller = new AbortController();
  const fake = {
    ctx: {get: () => ({register(value) {live = value; return () => {live = undefined;};}}),
      effect: fn => fn(), credentials: {modifyRecord() {touchedCredential = true; throw stop;}}},
    attemptTimeout: 30_000, origin: 'https://chat.deepseek.com', rewriteBrowserOrigin: false,
    update(a, v) {Object.assign(a.view, v);},
    async request(method, body) {
      assert.equal(method, 'auth_init'); state = body.state;
      return {authorize_url: 'https://chat.deepseek.com/dsh/authorize', authorize_id: 'synthetic', expires_in: 30};
    },
  };
  const running = PlatformAccount.prototype.run.call(fake, {signal: controller.signal}, attempt);
  const stopped = assert.rejects(running, error => error === stop);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempt.view.phase, 'waiting-browser');
  const response = () => ({status: null, writeHead(status) {this.status = status; return this;}, end() {}});
  const dispatch = (query, res) => {
    const req = {...request, url: `/oauth/callback?${query}`};
    if (acceptsOfficialOAuthCallback(authority, req, live)) live.handler(req, res);
  };
  const bad = response(); dispatch('code=synthetic&state=wrong', bad);
  assert.equal(bad.status, 400); assert.equal(touchedCredential, false);
  const duplicate = response();
  live.handler({...request, url: `/oauth/callback?code=synthetic&state=${state}&state=${state}`}, duplicate);
  assert.equal(duplicate.status, 400); assert.equal(touchedCredential, false);
  attempt.view.phase = 'initializing';
  const wrongPhase = response(); dispatch(`code=synthetic&state=${state}`, wrongPhase);
  assert.equal(wrongPhase.status, 410); assert.equal(touchedCredential, false);
  attempt.view.phase = 'waiting-browser';
  const good = response(); dispatch(`code=synthetic&state=${state}`, good);
  assert.equal(attempt.callback, good);
  const replay = response(); dispatch(`code=synthetic&state=${state}`, replay);
  assert.equal(replay.status, 410);
  await stopped;
  attempt.disposeCallback();
  assert.equal(acceptsOfficialOAuthCallback(authority, request, live), false);
});

test('live loopback carrier dispatches callback without issuing a carrier cookie', async () => {
  const {mkdtempSync, writeFileSync, openSync, closeSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {request: httpRequest} = await import('node:http');
  const {apply} = await import('../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs');
  const home = mkdtempSync(join(tmpdir(), 'dsh-oauth-test-'));
  const oldHome = process.env.DSH_HOME;
  const fds = [], disposers = [];
  let service;
  try {
    process.env.DSH_HOME = home;
    const fd = (name, contents) => {
      const file = join(home, name); writeFileSync(file, contents);
      const handle = openSync(file, 'r+'); fds.push(handle); return handle;
    };
    await apply({provide(name, value) {if (name === 'webServer') service = value;},
      get() {}, effect(fn) {disposers.push(fn());}}, {
      authorityFd: fd('authority', JSON.stringify({protocol: 1, generation: 1,
        cookieName: 'native', cookieValue: 'x'.repeat(32), bootstrapRef: 'y'.repeat(32),
        bootstrapPath: '/_luckyray/bootstrap'})), readyFd: fd('ready', ''),
      controlFd: fd('control', ''), controlLineFd: fd('reply', ''),
    });
    let calls = 0;
    const unregister = service.register({...route, handler(req, res) {
      calls++; res.writeHead(400, {'cache-control': 'no-store'}).end('synthetic-state-rejected');
    }});
    service.registerFallback((_req, res) => res.writeHead(200).end('private-fallback'));
    const get = (path, headers = {}) => new Promise((resolve, reject) => {
      const req = httpRequest({host: '127.0.0.1', port: service.port, path,
        headers: {...request.headers, host: `127.0.0.1:${service.port}`, ...headers}}, res => {
        res.resume(); res.on('end', () => resolve({status: res.statusCode, headers: res.headers}));
      }); req.on('error', reject); req.end();
    });
    const result = await get(request.url);
    assert.equal(result.status, 400); assert.equal(calls, 1);
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal((await get('/api/private')).status, 403);
    assert.equal((await get('/')).status, 403);
    assert.equal((await get(request.url, {host: 'attacker.example'})).status, 403);
    assert.equal(calls, 1);
    unregister();
    assert.equal((await get(request.url)).status, 403);
    assert.equal(calls, 1);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    // Let the file-backed control stream consume EOF before closing its fd.
    await new Promise(resolve => setImmediate(resolve));
    for (const fd of fds) closeSync(fd);
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(home, {recursive: true, force: true});
  }
});
