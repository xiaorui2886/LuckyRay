import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import test from 'node:test';
import {
  bindNativeBrowserCookieResponse,
  nativeBrowserCookieHeader,
  nativeBrowserSetCookie,
  NATIVE_BROWSER_AUTH_COOKIE,
} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs';

const host = '127.0.0.1:43210';
const officialName = authority => `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;
const signedValue = 'v1.unchangedSignedAudience.unchangedSignature';

test('translation preserves signed value and unrelated cookies; audience is still the exact carrier', () => {
  const first = nativeBrowserCookieHeader(`unrelated=kept; ${NATIVE_BROWSER_AUTH_COOKIE}=${signedValue}`, host);
  assert.equal(first, `unrelated=kept; ${officialName(host)}=${signedValue}`);
  const other = nativeBrowserCookieHeader(`${NATIVE_BROWSER_AUTH_COOKIE}=${signedValue}`, '127.0.0.1:43211');
  assert.equal(other, `${officialName('127.0.0.1:43211')}=${signedValue}`);
  // Only the NAME changes. The official verifier rejects the unchanged signed
  // audience at the wrong port (covered using real upstream code in integration).
  assert.equal(nativeBrowserCookieHeader(undefined, host), undefined);
  assert.equal(nativeBrowserCookieHeader('other=kept', host), 'other=kept');
  assert.equal(nativeBrowserCookieHeader(`${NATIVE_BROWSER_AUTH_COOKIE}=one; ${NATIVE_BROWSER_AUTH_COOKIE}=two`, host), null);
});

test('new browser slot retains expiry/HttpOnly/SameSite/path and never rewrites another authority', () => {
  const attributes = '; Max-Age=2592000; Path=/; Expires=Sat, 31 Oct 2026 00:00:00 GMT; HttpOnly; SameSite=Strict';
  assert.equal(nativeBrowserSetCookie(`${officialName(host)}=${signedValue}${attributes}`, host), `${NATIVE_BROWSER_AUTH_COOKIE}=${signedValue}${attributes}`);
  const foreign = `${officialName('127.0.0.1:43211')}=${signedValue}${attributes}`;
  assert.equal(nativeBrowserSetCookie(foreign, host), foreign);
  assert.deepEqual(nativeBrowserSetCookie(['other=kept', `${officialName(host)}=${signedValue}${attributes}`], host), ['other=kept', `${NATIVE_BROWSER_AUTH_COOKIE}=${signedValue}${attributes}`]);
});

test('real ServerResponse setHeader/writeHead variants retain all other response fields', async () => {
  let variant = 0;
  const server = createServer((_req, response) => {
    bindNativeBrowserCookieResponse(response, host);
    const cookie = `${officialName(host)}=${signedValue}; HttpOnly; SameSite=Strict; Path=/`;
    if (variant === 0) { response.setHeader('Set-Cookie', cookie); response.writeHead(200, { 'x-kept': 'yes' }); }
    if (variant === 1) response.writeHead(200, { 'Set-Cookie': [cookie, 'other=kept'], 'x-kept': 'yes' });
    if (variant === 2) response.writeHead(200, 'OK', ['Set-Cookie', cookie, 'x-kept', 'yes']);
    response.end('unchanged');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    for (variant = 0; variant < 3; variant++) {
      const result = await new Promise((done, fail) => {
        const req = request(`http://127.0.0.1:${server.address().port}/`, { headers: { connection: 'close' } }, response => {
          response.resume(); response.on('end', () => done(response));
        }); req.on('error', fail); req.end();
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers['x-kept'], 'yes');
      assert.match(result.headers['set-cookie'][0], /^dsh-auth-luckyray-native=/);
      assert.match(result.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/$/);
      if (variant === 1) assert.equal(result.headers['set-cookie'][1], 'other=kept');
    }
  } finally { await new Promise(done => server.close(done)); }
});
