// One ordinary-sandbox Chromium session renders the actual reading/Live components.
// Only closed observations leave this owned fixture. This is never Main acceptance.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CdpConnection, attachSession, evaluate } from './browser-extension-runtime/lib/cdp-client.mjs';

const CASES = ['read-small', 'read-regular', 'live-small', 'live-regular'];
const FLAGS = ['toolbarVisible', 'toolbarFullyVisible', 'buttonEnabled', 'controlsFullyVisible', 'buttonCenterHit', 'allButtonCentersHit'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  do { const value = await action(); if (value) return value; await pause(50); } while (Date.now() < deadline);
  throw new Error('required-native-observation-missing');
}
function privateDirectory(directory) {
  const value = fs.lstatSync(directory);
  assert(value.isDirectory() && !value.isSymbolicLink() && value.uid === process.getuid()
    && (value.mode & 0o7777) === 0o700 && fs.realpathSync(directory) === directory);
}
async function digest(file) {
  const value = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) value.update(bytes);
  return value.digest('hex');
}
function argumentsFor(profile) {
  const args = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  assert(!args.some(value => /no-sandbox|disable.*sandbox|single-process|in-process-gpu|disable-web-security/i.test(value)));
  return args;
}
export function socketPathBytes(temporary) {
  assert(path.isAbsolute(temporary) && path.resolve(temporary) === temporary);
  const bytes = Buffer.byteLength(path.join(temporary, 'org.chromium.Chromium.XXXXXX', 'SingletonSocket'));
  assert(bytes < 108);
  return bytes;
}
export function displaySizeValid(value, small) {
  return value?.naturalWidth === (small ? 32 : 320) && value?.naturalHeight === (small ? 24 : 240)
    && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0
    && (small ? Math.abs(value.width - 32) <= 0.5 && Math.abs(value.height - 24) <= 0.5
      : value.width <= 320.5 && value.height <= 240.5 && Math.abs(value.width / value.height - 4 / 3) < 0.02);
}
export async function nativeBackTab(send) {
  for (const event of [{ type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 },
    { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
    { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
    { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 }]) {
    await send('Input.dispatchKeyEvent', event);
  }
}
export async function audit(options) {
  const source = { commit: options['--source-commit'], tree: options['--source-tree'] };
  const html = path.resolve(options['--html']), output = path.resolve(options['--output']);
  privateDirectory(path.dirname(output));
  let phase = 'ordinary-user', child, connection, owned, spawnError;
  const report = { schemaVersion: 1, scope: 'production-note-media-component-layout-only', status: 'FAIL', source,
    attempts: 1, browserLaunches: 0, userNamespaceExitCode: null, scriptSha256: await digest(fileURLToPath(import.meta.url)),
    fixtureSha256: null, fixtureSourceMatches: false, mainProductAcceptance: 'NOT_RUN', javascriptError: 'NONE',
    browser: { version: null, sha256: null, bytes: null, elf: false },
    sandbox: { status: 'NOT_RUN', namespace: null, pidNamespaces: null, networkNamespaces: null, seccompBpf: null,
      adequatelySandboxed: false, securityDisablingFlags: [], source: 'ACTUAL_CHROME_SANDBOX_PAGE' },
    cleanup: { processGone: false, exitCode: null, signal: null }, observations: [], observationOverflow: false };
  const exited = () => child && (child.exitCode !== null || child.signalCode !== null);
  const ensureAlive = () => { if (spawnError) throw spawnError; assert(!exited()); };
  try {
    assert(process.platform === 'linux' && process.getuid() !== 0);
    assert(/^[0-9a-f]{40}$/.test(source.commit) && /^[0-9a-f]{40}$/.test(source.tree) && process.env.GITHUB_SHA === source.commit);
    privateDirectory(path.dirname(html));
    const fixture = fs.lstatSync(html);
    assert(fixture.isFile() && !fixture.isSymbolicLink() && fixture.uid === process.getuid() && fixture.nlink === 1
      && !(fixture.mode & 0o022) && fixture.size < 16 * 1024 * 1024);
    report.fixtureSha256 = await digest(html);
    phase = 'user-namespace';
    const namespace = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '/bin/true'], { stdio: 'ignore', timeout: 10000 });
    report.userNamespaceExitCode = namespace.status;
    assert(!namespace.error && !namespace.signal && namespace.status === 0);
    phase = 'browser-identity';
    assert.equal(options['--browser'], '/usr/bin/chromium');
    const browser = fs.realpathSync(options['--browser']);
    assert.equal(browser, '/usr/local/share/chromium/chrome-linux/chrome');
    const metadata = fs.lstatSync(browser), header = Buffer.alloc(20), fd = fs.openSync(browser, 'r');
    try {
      assert(metadata.isFile() && !metadata.isSymbolicLink() && [0, process.getuid()].includes(metadata.uid)
        && !(metadata.mode & 0o7022) && metadata.mode & 0o111 && metadata.nlink === 1);
      fs.accessSync(browser, fs.constants.X_OK);
      assert.equal(fs.readSync(fd, header, 0, header.length, 0), header.length);
      assert(header.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) && header.readUInt16LE(18) === 62);
    } finally { fs.closeSync(fd); }
    const identity = spawnSync(browser, ['--version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
    const version = identity.stdout?.trim().match(/^Chromium [0-9]+(?:\.[0-9]+){1,5}(?=\s|$)/)?.[0];
    assert(identity.status === 0 && !identity.signal && !identity.error && version && version.length <= 80);
    report.browser = { version, sha256: await digest(browser), bytes: metadata.size, elf: true };
    const parent = fs.lstatSync('/tmp');
    assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && fs.realpathSync('/tmp') === '/tmp'
      && (!(parent.mode & 0o022) || (parent.mode & 0o1000)));
    owned = fs.mkdtempSync('/tmp/lrl-'); privateDirectory(owned);
    const directories = Object.fromEntries(['home', 'tmp', 'profile', 'config', 'data', 'cache', 'runtime'].map(name => {
      const directory = path.join(owned, name); fs.mkdirSync(directory, { mode: 0o700 }); privateDirectory(directory); return [name, directory];
    }));
    socketPathBytes(directories.tmp);
    phase = 'browser-start';
    const stderr = fs.openSync(path.join(owned, 'browser.stderr'), 'wx', 0o600);
    try {
      report.browserLaunches = 1;
      child = spawn(browser, argumentsFor(directories.profile), { stdio: ['ignore', 'ignore', stderr], env: {
        ...process.env, HOME: directories.home, TMPDIR: directories.tmp, RUNNER_TEMP: directories.tmp,
        XDG_CONFIG_HOME: directories.config, XDG_DATA_HOME: directories.data, XDG_CACHE_HOME: directories.cache,
        XDG_RUNTIME_DIR: directories.runtime, CHROME_CONFIG_HOME: directories.config,
      } });
      child.on('error', error => { spawnError = error; });
    } finally { fs.closeSync(stderr); }
    const endpoint = await until(() => {
      ensureAlive(); const file = path.join(directories.profile, 'DevToolsActivePort');
      if (!fs.existsSync(file)) return false;
      const value = fs.lstatSync(file); assert(value.isFile() && !value.isSymbolicLink() && value.uid === process.getuid() && value.size < 1024);
      const [port, route] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      return /^[0-9]{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535
        && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route) ? `ws://127.0.0.1:${port}${route}` : false;
    }, 20000);
    phase = 'cdp-connect'; connection = await CdpConnection.connect(endpoint);
    const read = (session, expression) => { ensureAlive(); return evaluate(connection, session, expression, { timeoutMs: 10000 }); };
    phase = 'sandbox-page';
    const sandboxTarget = await connection.send('Target.createTarget', { url: 'chrome://sandbox/' });
    const sandboxSession = await attachSession(connection, sandboxTarget.targetId);
    const state = await until(async () => {
      const value = await read(sandboxSession, "({evaluation:document.querySelector('#evaluation')?.innerText,rows:[...document.querySelectorAll('#sandbox-status tr')].map(r=>[...r.cells].map(c=>c.innerText))})");
      return value?.evaluation && value.rows.length ? value : false;
    }, 15000);
    phase = 'sandbox-assertion'; const rows = Object.fromEntries(state.rows);
    assert(rows['Layer 1 Sandbox'] === 'Namespace' || rows['Namespace Sandbox'] === 'Yes');
    assert(['PID namespaces', 'Network namespaces', 'Seccomp-BPF sandbox'].every(name => rows[name] === 'Yes'));
    assert.equal(state.evaluation, 'You are adequately sandboxed.');
    report.sandbox = { status: 'PASS', namespace: 'Yes', pidNamespaces: 'Yes', networkNamespaces: 'Yes', seccompBpf: 'Yes',
      adequatelySandboxed: true, securityDisablingFlags: [], source: 'ACTUAL_CHROME_SANDBOX_PAGE' };
    await connection.send('Target.closeTarget', { targetId: sandboxTarget.targetId });
    phase = 'fixture-ready';
    const fixtureTarget = await connection.send('Target.createTarget', { url: 'about:blank' });
    const session = await attachSession(connection, fixtureTarget.targetId);
    connection.on('Runtime.exceptionThrown', event => {
      const name = event.exceptionDetails?.exception?.className;
      report.javascriptError = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(name) ? name : 'UNKNOWN';
    });
    await connection.send('Runtime.enable', {}, session);
    await connection.send('Page.enable', {}, session);
    await connection.send('Page.navigate', { url: pathToFileURL(html).href }, session);
    await until(async () => {
      const value = await read(session, "({source:window.fixtureSource,cases:window.fixtureCases,ready:[...document.querySelectorAll('.note-media img')].filter(i=>i.complete&&i.naturalWidth>0).length})");
      if (value?.ready !== 4) return false;
      assert.deepEqual(value.source, source);
      assert.deepEqual(value.cases?.map(item => item.id), CASES);
      report.fixtureSourceMatches = true; return true;
    }, 15000);
    const mouse = params => connection.send('Input.dispatchMouseEvent', params, session);
    const click = async point => {
      await mouse({ type: 'mouseMoved', ...point });
      await mouse({ type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await mouse({ type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const center = selector => read(session, `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();if(!r||!r.width||!r.height)throw Error();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const viewport of [1024, 560]) {
      phase = 'fixture-ready';
      await connection.send('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: false }, session);
      for (const id of CASES) for (const mode of ['hover', 'focus']) {
        phase = mode === 'hover' ? 'native-hover' : 'native-focus';
        const row = { case: id, mode, viewport, naturalWidth: null, naturalHeight: null, displaySizeValid: false,
          hoverApplied: false, focusWithin: false, controlFocused: false, ...Object.fromEntries(FLAGS.map(key => [key, false])),
          clickedOnce: false, clickAttempts: 0 };
        report.observations.push(row);
        // A real outside button makes focus deterministic without JS focus or editor Tab overrides.
        await click(await center(`[data-fixture-focus-end="${id}"]`));
        assert(await read(session, `document.activeElement===document.querySelector('[data-fixture-focus-end="${id}"]')`));
        if (mode === 'hover') await mouse({ type: 'mouseMoved', ...await center(`#${id} .note-media img`) });
        else await nativeBackTab((method, params) => connection.send(method, params, session));
        const selector = `#${id} button[aria-label="打开素材详情"]`;
        await until(async () => {
          const value = await read(session, `window.readMediaCase(${JSON.stringify(selector)})`);
          for (const key of ['hoverApplied', 'focusWithin', 'controlFocused', ...FLAGS]) row[key] = value?.[key] === true;
          return FLAGS.every(key => row[key]) && row.hoverApplied === (mode === 'hover')
            && row.focusWithin === (mode === 'focus') && row.controlFocused === (mode === 'focus');
        });
        const dimensions = await read(session, `(()=>{const i=document.querySelector('#${id} .note-media img'),r=i.getBoundingClientRect();return{naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,width:r.width,height:r.height}})()`);
        row.naturalWidth = dimensions.naturalWidth; row.naturalHeight = dimensions.naturalHeight;
        row.displaySizeValid = displaySizeValid(dimensions, id.endsWith('small')); assert(row.displaySizeValid);
        phase = 'native-click';
        const before = await read(session, `window.fixtureEvents.filter(id=>id===${JSON.stringify(id)}).length`);
        row.clickAttempts = 1; await click(await center(selector));
        await until(async () => await read(session, `window.fixtureEvents.filter(id=>id===${JSON.stringify(id)}).length`) === before + 1);
        row.clickedOnce = true;
      }
    }
    assert.equal(report.javascriptError, 'NONE');
    phase = 'complete';
  } catch {
    report.failure = { phase, code: `${phase}-failed` };
  } finally {
    try {
      if (child) {
        if (!exited() && !spawnError && connection) {
          try { await connection.send('Browser.close'); } catch {
            report.failure ||= { phase: 'browser-cleanup', code: 'browser-cleanup-failed' };
          }
        }
        await connection?.close();
        if (!exited() && !spawnError) {
          try { await until(exited, 5000); } catch {
            child.kill('SIGTERM'); try { await until(exited, 2000); } catch { child.kill('SIGKILL'); await until(exited, 2000); }
          }
        }
        report.cleanup = { processGone: !!spawnError || !!exited(), exitCode: child.exitCode, signal: child.signalCode };
      } else report.cleanup.processGone = true;
      assert(report.cleanup.processGone && report.cleanup.exitCode === 0 && report.cleanup.signal === null);
    } catch {
      report.failure ||= { phase: 'browser-cleanup', code: 'browser-cleanup-failed' };
    } finally {
      await connection?.close();
      if (owned && report.cleanup.processGone) { privateDirectory(owned); fs.rmSync(owned, { recursive: true }); }
      if (!report.failure && phase === 'complete') report.status = 'PASS';
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
  }
  return report.status === 'PASS' ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const values = process.argv.slice(2), names = ['--html', '--output', '--browser', '--source-commit', '--source-tree'];
  assert.equal(values.length, names.length * 2);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    assert(names.includes(values[index]) && !Object.hasOwn(options, values[index]) && values[index + 1]);
    options[values[index]] = values[index + 1];
  }
  process.exitCode = await audit(options);
}
