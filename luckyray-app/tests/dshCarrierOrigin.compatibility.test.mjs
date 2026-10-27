import assert from 'node:assert/strict';
import test from 'node:test';
import { carrierOrigin } from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs';

test('carrier origin is a bound HTTP loopback URL', () => {
  for (const port of [1, 3080, 43210, 65535]) {
    assert.equal(carrierOrigin(port), `http://127.0.0.1:${port}`);
    assert.equal(new URL(carrierOrigin(port)).hostname, '127.0.0.1');
  }
});
test('carrier origin fails closed before listen and rejects invalid ports', () => {
  for (const port of [0, -1, 65536, undefined, null, '3080', NaN, Infinity, 1.5]) {
    assert.throws(() => carrierOrigin(port), /origin-before-listen/);
  }
});
