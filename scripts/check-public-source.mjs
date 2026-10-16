import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Read actual index blobs, not just .gitignore or a directory inventory.
const rows = execFileSync('git', ['ls-files', '-s', '-z'], { maxBuffer: 8e6 })
  .toString('utf8').split('\0').filter(Boolean).map(line => {
    const at = line.indexOf('\t');
    const [mode, oid, stage] = line.slice(0, at).split(' ');
    assert.equal(stage, '0');
    return { path: line.slice(at + 1), mode, oid };
  });
const forbidden = /(?:^|\/)(?:node_modules|target|output|\.mavis|_coordination)(?:\/|$)|(?:\.dpapi|\.pfx|\.key|\.sqlite3?|\.db|\.exe|\.dll)$/i;
for (const { path, mode } of rows) {
  assert.ok(!forbidden.test(path), 'forbidden tracked artifact: ' + path);
  assert.ok(mode === '100644' || mode === '100755', 'non-regular tracked entry: ' + path);
  assert.ok(!path.startsWith('luckyray-app/docs/integration/'), 'internal evidence path: ' + path);
}
const newObjects = [...new Set(rows.map(row => row.oid))];
const batch = execFileSync('git', ['cat-file', '--batch'], { input: newObjects.join('\n') + '\n', maxBuffer: 100e6 });
let at = 0, bytes = 0;
const forbiddenContent = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})/,
  /https:\/\/github\.com\/xiaorui2886\/luckyray-app\/(?:issues|blob|pull)/,
];
while (at < batch.length) {
  const end = batch.indexOf(10, at);
  const [oid, type, sizeText] = batch.subarray(at, end).toString('ascii').split(' ');
  assert.ok(newObjects.includes(oid)); assert.equal(type, 'blob');
  const size = Number(sizeText), content = batch.subarray(end + 1, end + 1 + size).toString('utf8');
  for (const pattern of forbiddenContent) assert.ok(!pattern.test(content), 'sensitive/internal content in blob ' + oid);
  bytes += size; at = end + 1 + size + 1;
}
assert.match(readFileSync('LICENSE', 'utf8'), /MIT License/);
assert.match(readFileSync('README.md', 'utf8'), /https:\/\/luckyray\.me/);
assert.equal(JSON.parse(readFileSync('luckyray-app/src-tauri/tauri.conf.json')).version, '1.9.16');
console.log(JSON.stringify({ status: 'PASS', trackedFiles: rows.length, uniqueBlobs: newObjects.length, bytes, scope: 'actual index blobs; complementary to external secret/license review' }));
