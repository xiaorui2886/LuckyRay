// Newly authored generic platform fixture. No product source, provider calls,
// real accounts, credentials, session imports, screenshots, or artifact uploads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright-core';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Generic functional fixture only, NOT the product's account scheduler.
class SerialPerKey {
  tails = new Map();
  run(key, fn) {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(fn);
    this.tails.set(key, result.catch(() => {}));
    return result;
  }
}

test('real Windows Edge: synthetic isolation, persistence, concurrency and explicit headed lifecycle',
  {timeout: 180_000}, async () => {
    assert.equal(process.platform, 'win32', 'This is a Windows-only platform acceptance fixture.');
    const parent = process.env.RUNNER_TEMP ?? os.tmpdir();
    const root = await fs.mkdtemp(path.join(parent, 'synthetic-edge-primitives-'));
    const contexts = new Set();
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end('<!doctype html><title>Synthetic local fixture</title><h1>Synthetic account fixture</h1><p>No provider login or generation.</p>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let edgeVersion;
    const launch = async (name, headless = true) => {
      const context = await chromium.launchPersistentContext(path.join(root, name), {
        channel: 'msedge', headless, acceptDownloads: false, serviceWorkers: 'block', timeout: 30_000,
        args: ['--no-first-run', '--disable-background-networking', '--disable-component-update',
          '--disable-sync', '--disable-default-apps', '--disable-domain-reliability',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
      });
      contexts.add(context);
      context.on('close', () => contexts.delete(context));
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin ? route.continue() : route.abort('blockedbyclient');
      });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(origin);
      edgeVersion ??= await page.evaluate(() => navigator.userAgent.match(/Edg\/([0-9.]+)/)?.[1]);
      assert.ok(edgeVersion, 'Actual Microsoft Edge required, not bundled Chromium.');
      return {context, page};
    };
    const read = page => page.evaluate(() => ({cookie: document.cookie, marker: localStorage.getItem('marker')}));
    const seed = (page, marker) => page.evaluate(value => {
      document.cookie = `syntheticAccount=${value}; Max-Age=3600; Path=/; SameSite=Strict`;
      localStorage.setItem('marker', value);
    }, marker);
    try {
      const a = await launch('synthetic-a');
      const b = await launch('synthetic-b');
      assert.deepEqual(await read(a.page), {cookie: '', marker: null});
      assert.deepEqual(await read(b.page), {cookie: '', marker: null});
      await seed(a.page, 'alpha');
      assert.deepEqual(await read(b.page), {cookie: '', marker: null});
      await seed(b.page, 'beta');
      assert.deepEqual(await read(a.page), {cookie: 'syntheticAccount=alpha', marker: 'alpha'});
      assert.deepEqual(await read(b.page), {cookie: 'syntheticAccount=beta', marker: 'beta'});

      // Real pages in independent contexts progress concurrently; overlap is
      // established by a barrier, not an unreliable wall-clock threshold.
      const queue = new SerialPerKey();
      let active = 0, maximum = 0, entered = 0, release;
      const barrier = new Promise(resolve => { release = resolve; });
      const job = page => async () => {
        active++; maximum = Math.max(maximum, active);
        await page.evaluate(() => { document.body.dataset.task = 'active'; });
        if (++entered === 2) release();
        await Promise.race([barrier, pause(10_000).then(() => { throw Error('parallel_barrier_timeout'); })]);
        await page.evaluate(() => { document.body.dataset.task = 'complete'; });
        active--;
      };
      await Promise.all([queue.run('alpha', job(a.page)), queue.run('beta', job(b.page))]);
      assert.equal(maximum, 2);
      const order = []; let sameActive = 0, sameMaximum = 0;
      await Promise.all([1, 2, 3].map(i => queue.run('alpha', async () => {
        sameActive++; sameMaximum = Math.max(sameMaximum, sameActive); order.push(`start${i}`);
        await a.page.evaluate(value => { document.body.dataset.sequence = String(value); }, i);
        await pause(20); order.push(`end${i}`); sameActive--;
      })));
      assert.equal(sameMaximum, 1);
      assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
      await a.context.close(); await b.context.close();

      const reopenedA = await launch('synthetic-a');
      const reopenedB = await launch('synthetic-b');
      assert.deepEqual(await read(reopenedA.page), {cookie: 'syntheticAccount=alpha', marker: 'alpha'});
      assert.deepEqual(await read(reopenedB.page), {cookie: 'syntheticAccount=beta', marker: 'beta'});
      await reopenedA.context.close();
      // Explicit headed context reuses only our own synthetic profile after
      // background context closes; no actual login is attempted.
      const headed = await launch('synthetic-a', false);
      const cdp = await headed.context.newCDPSession(headed.page);
      const window = await cdp.send('Browser.getWindowForTarget');
      assert.equal(typeof window.windowId, 'number');
      assert.ok(window.bounds.width > 0 && window.bounds.height > 0);
      assert.deepEqual(await read(headed.page), {cookie: 'syntheticAccount=alpha', marker: 'alpha'});
      const popup = await headed.context.newPage(); await popup.goto(origin + '/explicit-login-fixture');
      await popup.bringToFront(); await popup.close(); assert.equal(popup.isClosed(), true);
      await headed.context.close();
      const backgroundAgain = await launch('synthetic-a');
      assert.deepEqual(await read(backgroundAgain.page), {cookie: 'syntheticAccount=alpha', marker: 'alpha'});
      assert.deepEqual(await read(reopenedB.page), {cookie: 'syntheticAccount=beta', marker: 'beta'});
      console.log(JSON.stringify({schema: 1, scope: 'generic-platform-only-not-product-acceptance',
        platform: process.platform, node: process.version, playwright: '1.56.1', edge: edgeVersion,
        checks: ['separate-profiles', 'cookie-isolation', 'localstorage-isolation', 'restart-persistence',
          'two-account-concurrency', 'generic-same-account-serialization', 'explicit-headed-window',
          'headed-close-background-reopen'], result: 'pass', syntheticRequests: requests}));
    } finally {
      await Promise.allSettled([...contexts].map(context => context.close()));
      await new Promise(resolve => server.close(resolve));
      assert.ok(path.dirname(root) === path.resolve(parent));
      await fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 300});
    }
  });
