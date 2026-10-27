/** Verify the official implementation is intact, independently of app builds. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('source-manifest.json'));
for (const [name, expected] of Object.entries(manifest.files)) {
  let bytes = readFileSync(path.join(root, 'upstream/primitives', name));
  if (name === 'lib/index.js') {
    const compatibility = JSON.parse(read('compatibility-manifest.json'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), compatibility.patched_sha256, 'Unexpected compatibility patch changes');
    bytes = Buffer.from(bytes.toString().replace(compatibility.reverse_from, compatibility.reverse_to));
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Upstream file changed: ${name}`);
}
const source = read('upstream/primitives/lib/index.js');
const proposal = JSON.parse(read('runtime-dependencies.json')).dependencies;
const host = new Set(['react', 'react-dom']);
const imports = [...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)]
  .map((match) => match[1]).filter((specifier) => !specifier.startsWith('.'));
for (const specifier of imports) {
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  assert.ok(host.has(name) || proposal[name], `Undeclared runtime dependency: ${name}`);
}
for (const [name, version] of Object.entries(proposal)) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/, `Dependency must be exact: ${name}`);
}
assert.ok(proposal.immer && proposal.zustand, 'Upstream store runtime omissions must be explicitly supplied');
const exports = source.slice(source.lastIndexOf('export {'));
for (const name of ['DisclosureRow', 'TextShimmer', 'MarkdownText', 'IconThinkOutlineRegular', 'IconApiOutlineRegular', 'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular', 'JsonTree', 'CodeBlock', 'ReadBlock', 'DiffBlock', 'SearchBlock', 'TerminalBlock', 'WebBlock']) {
  assert.ok(new RegExp(`\\b${name}\\b`).test(exports), `Missing official export: ${name}`);
}
assert.match(read('primitives.ts'), /export \* from "\.\/upstream\/primitives\/lib\/index\.js"/);
console.log(`PASS: ${Object.keys(manifest.files).length} official files match original SHA-256 provenance after reversing documented React 19 inert compatibility patch; all runtime imports and requested exports are accounted for.`);
