/** Local, synthetic-only HTTP facade for cross-platform client contract tests. */
import { createServer } from 'node:http';
import { createFixture } from './fixture.mjs';

const portArg = process.argv.indexOf('--port');
const port = portArg < 0 ? 0 : Number(process.argv[portArg + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid --port');
const fixture = createFixture();
const server = createServer(async (request, response) => {
  const control = request.url === '/__fixture/control' && request.method === 'POST' &&
    request.headers.authorization === 'Bearer fixture-control-test-only';
  const token = /^Bearer fixture-(device-a|device-read|device-revoked)$/.exec(request.headers.authorization ?? '');
  if (!token && !control) { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"code":"PAIRING_REQUIRED"}'); return; }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 4198400) throw new Error('too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const body = request.url?.endsWith('/chunks') ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
    if (control) {
      if (body?.action === 'revoke' && body.deviceId === 'device-a') fixture.revoke(body.deviceId);
      else if (body?.action === 'reconnect') fixture.reconnect();
      else if (body?.action === 'busy' && typeof body.value === 'boolean') fixture.setBusy(body.value);
      else if (body?.action === 'expire-search') fixture.expireSearch();
      else if (body?.action === 'advance-editing' && Number.isSafeInteger(body.milliseconds) && body.milliseconds >= 0 && body.milliseconds <= 60000) fixture.advanceEditing(body.milliseconds);
      else if (body?.action === 'cursor-floor' && ['materials', 'knowledge'].includes(body.domain) && Number.isInteger(body.floor) && body.floor >= 0) fixture.setCursorFloor(body.domain, body.floor);
      else { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"code":"INPUT_INVALID"}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return;
    }
    const result = fixture.request({ deviceId: token[1], method: request.method, path: request.url,
      body, headers: request.headers });
    response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(result.body));
  } catch {
    response.writeHead(length > 4198400 ? 413 : 400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: length > 4198400 ? 'PAYLOAD_TOO_LARGE' : 'INPUT_INVALID' }));
  }
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`SYNTHETIC ONLY http://127.0.0.1:${address.port} bearer=fixture-device-a\n`);
});
