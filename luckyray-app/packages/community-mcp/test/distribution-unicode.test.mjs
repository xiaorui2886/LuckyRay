import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
test('Markdown component candidate preserves Unicode fix, old inventories and immutable artifact pins', async () => {
  const catalog = JSON.parse(await read('../../../src-tauri/community-mcp/catalog.json'));
  assert.equal(catalog.version, '0.1.3');
  assert.equal(catalog.artifactUrl, 'https://github.com/xiaorui2886/LuckyRay/releases/download/mcp-v0.1.3/luckyray-web-mcp-0.1.3-windows-x64.zip');
  assert.equal(catalog.artifactSha256, '1e1692e6e07baa4861dd543a8ed84bf0817fc070faeb5f49cbf5668fb001a807');
  assert.equal(catalog.inventorySha256, '81870ce8baec6bff686be0ec3589a5d198502efbef6afc40c15dc7b7d0baf7f4');
  assert.equal(catalog.downloadBytes, 61477035);
  assert.deepEqual(catalog.previousInventories.find(row => row.version === '0.1.2'), {
    version: '0.1.2', inventorySha256: '0a835987daae2cf3217efcb8e3e76a3a0b8d448daae14419044a380ba0238a26',
  });
  assert.deepEqual(catalog.previousInventories.find(row => row.version === '0.1.1'), {
    version: '0.1.1', inventorySha256: 'e5091e98fed26447c9c0679d8a581dd97c53ff27570cb811761523a988fc8c31',
  });
  assert.deepEqual(catalog.previousInventories.find(row => row.version === '0.1.0'), {
    version: '0.1.0', inventorySha256: '52e63ee7b80692d29736004b01d16de37e2d4504e4e08e7293e50a3f802eb76f',
  });
  assert.equal(catalog.previousInventories.length, 5);
  const packageInfo = JSON.parse(await read('../package.json'));
  assert.equal(packageInfo.version, catalog.version);
  const transport = await read('../../materials-mcp/src/transport.mjs');
  assert.ok(transport.includes('[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false);'));
  assert.ok(transport.includes('target-not-running'));
});
