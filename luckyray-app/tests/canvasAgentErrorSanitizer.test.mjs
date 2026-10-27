import assert from 'node:assert/strict';
import test from 'node:test';
import {canvasAgentErrorDetail as detail} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs';

test('error projection never serializes raw exception diagnostics', () => {
  assert.equal(detail({response:{body:'private'},cause:new Error('private')}), undefined);
  assert.equal(detail(new Error('canvas-agent-model-failed')), undefined);
  for (const message of [
    'Failed. Authorization: Bearer supersecret',
    'Failed. api_key=supersecret',
    'Failed. token: supersecret',
    'Failed. https://user:supersecret@example.test/private?key=supersecret',
    'Failed. C:\\Users\\supersecret\\private',
    'Failed. /home/supersecret/private',
    'Failed. sk-supersecret',
    'Failed. request body: supersecret',
    'Failed. headers: supersecret',
    'Failed. prompt: supersecret',
    'Failed. {"supersecret":true}',
    'Failed. <script>supersecret</script>',
  ]) assert.ok(!String(JSON.stringify(detail(new Error(message)))).includes('supersecret'), message);
  assert.deepEqual(detail(new Error('Request rejected: private prompt'), ['private prompt']), {message:'Request rejected: [redacted]'});
});
test('error detail is bounded by UTF8 bytes without splitting Unicode', () => {
  const result = detail(new Error('失败'.repeat(1000)));
  assert.ok(Buffer.byteLength(result.message, 'utf8') <= 2000);
  assert.ok(!result.message.includes('\ufffd'));
  assert.deepEqual(detail({message: result.message}), result);
  assert.equal(detail(new Error('x'.repeat(16385))), undefined);
});

test('structured or credential-bearing diagnostic messages are withheld rather than guessed', () => {
  for (const message of ['HTTP 429: {"error":{"message":"Quota exceeded"}}', 'Credential abc123 is invalid', 'token: abc123', 'Response body: private dump', 'Failed. payload=[private dump]']) assert.equal(detail(new Error(message)), undefined);
});
test('control and bidirectional formatting cannot invalidate the wire projection', () => {
  assert.deepEqual(detail(new Error('Failed\u061c\u200e\u200f\u202e\u2066 now.')), {message:'Failed now.'});
});

test('complete credential reasons survive but suffixes cannot carry a secret', () => {
  for (const message of ['Invalid API key', 'Missing API key.', 'Invalid credentials']) assert.deepEqual(detail(new Error(message)), {message});
  for (const message of ['Invalid credentials: SECRET', 'Invalid API key: SECRET', 'Missing API key SECRET', 'Credential SECRET is invalid']) assert.equal(detail(new Error(message)), undefined);
});

test('public error extraction does not evaluate hostile or inherited getters', () => {
  let calls = 0;
  assert.equal(detail({get message(){calls++;throw Error('private');}}),undefined);
  assert.equal(detail(Object.create({message:'inherited private text'})),undefined);
  assert.equal(detail(new Proxy({}, {getOwnPropertyDescriptor(){throw Error('private');}})),undefined);
  assert.equal(calls,0);
});

test('installed LSH masked classes use code-based guidance, never provider prose', () => {
  for (const code of ['AUTH','QUOTA','ACCOUNT_QUOTA','ACCOUNT_SIGN_IN_REQUIRED'])
    assert.equal(detail(Object.assign(new Error('private provider text'),{code})),undefined);
});
