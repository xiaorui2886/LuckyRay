import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
const script = new URL("./dsh-assembly-network-fence.mjs", import.meta.url).href;
function run(code, port = "") {
  return spawnSync(process.execPath, ["--import", script, "--input-type=module", "-e", code],
    { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, LUCKYRAY_FROZEN_CACHE_PORT: port } });
}
test("offline child cannot connect even to loopback or perform DNS", () => {
  const result = run(`import net from 'node:net'; import dns from 'node:dns';
    try { net.connect({host:'127.0.0.1',port:9}); } catch(e) { if(e.message!=='assembly-network-denied') throw e; }
    try { await dns.promises.lookup('registry.npmjs.org'); } catch(e) { if(e.message!=='assembly-dns-denied') throw e; }`);
  assert.equal(result.status, 0, result.stderr); const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.allowedSockets, 0); assert.equal(evidence.blockedSockets, 1); assert.equal(evidence.blockedDns, 1);
});
test("cache child cannot connect to other ports, hosts or named pipes", () => {
  const result = run(`import net from 'node:net';
    for(const args of [[9,'127.0.0.1'], [{host:'registry.npmjs.org',port:12345}], ['some-pipe'], [{path:'some-pipe',host:'127.0.0.1',port:12345}]]) {
      try { net.connect(...args); throw new Error('unexpected-network'); } catch(e) { if(e.message!=='assembly-network-denied') throw e; }
    }`, "12345");
  assert.equal(result.status, 0, result.stderr); const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.allowedSockets, 0); assert.equal(evidence.blockedSockets, 4);
});
test("real HTTP fetch to the exact private cache port is allowed", async () => {
  const server = createServer((_, response) => response.end("verified-bytes"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", script, "--input-type=module", "-e",
        `const r = await fetch('http://127.0.0.1:${port}/'); if(await r.text()!=='verified-bytes') throw new Error('wrong-bytes');`],
        { env: { SystemRoot: process.env.SystemRoot, LUCKYRAY_FROZEN_CACHE_PORT: String(port) }, windowsHide: true });
      let out = "", err = "";
      child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { err += b; });
      child.once("error", reject); child.once("exit", (status) => resolve({ status, out, err }));
    });
    assert.equal(result.status, 0, result.err);
    const evidence = JSON.parse(result.out.trim());
    assert.equal(evidence.allowedSockets, 1); assert.equal(evidence.blockedSockets, 0);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("malformed policy fails before child code", () => {
  for(const port of ["0", "65536", "123;command", "localhost:123", "01"]) {
    const result = run("throw new Error('child-ran')", port);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /assembly-network-policy-invalid/);
    assert.doesNotMatch(result.stderr, /Error: child-ran/);
  }
});
