const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, 'dsh_login_browser.js'), 'utf8');
function harness() {
  const navigations = [];
  const normalPopups = [];
  const sentinel = {};
  const window = {
    open(...args) { normalPopups.push(args); return sentinel; },
    location: { assign(value) { navigations.push(value); } },
  };
  const context = vm.createContext({ window, URL });
  vm.runInContext(script, context);
  return { window, context, navigations, normalPopups, sentinel };
}
const auth = 'https://platform.deepseek.com/dsh/authorize?authorize_id=synthetic&theme=dark';
test('native authorization opens a URL with the existing default-browser opener, never the directory helper', () => {
  const native = fs.readFileSync(path.join(__dirname, 'lib.rs'), 'utf8');
  const start = native.indexOf('fn open_dsh_login_in_system_browser(');
  const end = native.indexOf('\nfn create_dsh_native_surface_child(', start);
  assert.ok(start >= 0 && end > start);
  const handler = native.slice(start, end);
  assert.match(handler, /if dsh_login_browser::is_official_authorize_url\(target\)/);
  assert.match(handler, /tauri_plugin_opener::open_url\(target\.as_str\(\), None::<&str>\)/);
  assert.doesNotMatch(handler, /open_directory\(|Command::|target\s*\}/);
});
test('official preopen and delayed replace reaches native navigation once', () => {
  const h = harness();
  const popup = h.window.open('about:blank', '_blank');
  popup.opener = null;
  assert.equal(popup.closed, false);
  assert.deepEqual(h.navigations, []);
  popup.location.replace(auth);
  popup.location.replace(auth);
  assert.deepEqual(h.navigations, [auth]);
  assert.deepEqual(h.normalPopups, []);
});
test('cancelled blank popup cannot navigate', () => {
  const h = harness();
  const popup = h.window.open('about:blank', '_blank');
  popup.close();
  assert.equal(popup.closed, true);
  popup.location.replace(auth);
  assert.deepEqual(h.navigations, []);
});
test('other window.open forms retain original behavior', () => {
  const h = harness();
  for (const args of [[auth, '_blank'], ['about:blank', 'named'],
    ['about:blank', '_blank', 'noopener'], []]) {
    assert.equal(h.window.open(...args), h.sentinel);
  }
  assert.equal(h.normalPopups.length, 4);
  assert.deepEqual(h.navigations, []);
});
test('rejects nonofficial URLs without navigating the child', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/x',
    'http://127.0.0.1:1234/private', 'http://platform.deepseek.com/dsh/authorize',
    'https://platform.deepseek.com:8443/dsh/authorize',
    'https://platform.deepseek.com.evil.test/dsh/authorize',
    'https://platform.deepseek.com/dsh/authorize/',
    'https://user:pass@platform.deepseek.com/dsh/authorize',
    'https://platform.deepseek.com/dsh/authorize#fragment',
    'https://platform.deepseek.com/dsh/%61uthorize']) {
    const h = harness();
    assert.throws(() => h.window.open('about:blank', '_blank').location.replace(url));
    assert.deepEqual(h.navigations, []);
  }
});
test('new attempts each have a fresh popup facade', () => {
  const h = harness();
  h.window.open('about:blank', '_blank').location.replace(auth);
  h.window.open('about:blank', '_blank').location.replace(auth);
  assert.equal(h.navigations.length, 2);
});
// Optional offline integration with the exact installed official client. Never
// starts DSH, contacts an auth server, opens a browser, or supplies credentials.
test('official BrowserLogin start/update/dispose contract', {
  skip: !process.env.DSH_ACCOUNT_CLIENT,
}, async () => {
  const source = fs.readFileSync(process.env.DSH_ACCOUNT_CLIENT, 'utf8');
  const start = source.indexOf('var BrowserLogin = class {');
  const end = source.indexOf('//#endregion', start);
  assert.ok(start >= 0 && end > start);
  const h = harness();
  vm.runInContext(source.slice(start, end) + '\nglobalThis.Login = BrowserLogin;', h.context);
  const login = new h.context.Login(value => value);
  const waiting = { attempt: { id: 'synthetic', phase: 'waiting', authorizeUrl: auth } };
  await login.start(async () => waiting, () => waiting);
  login.update(waiting);
  assert.deepEqual(h.navigations, [auth]);
  login.dispose();
  const cancelled = { attempt: { id: 'synthetic-next', phase: 'cancelled' } };
  await login.start(async () => cancelled, () => cancelled);
  assert.deepEqual(h.navigations, [auth]);
});
