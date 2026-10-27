import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { auditPortableTree, validateDshRuntimeAuthority } from './dsh-supply-chain.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = files => {
  const hash = createHash('sha256');
  for (const item of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    hash.update(item.path).update('\0').update(String(item.size)).update('\0').update(item.sha).update('\n');
  return hash.digest('hex');
};

test('native full-tree admission binds path, size, content and exact ordering', () => {
  const files = [{ path: 'b/a', size: 3, sha: sha('one') }, { path: 'A/b', size: 3, sha: sha('two') }];
  assert.equal(digest(files), digest([...files].reverse()));
  for (const change of [{ path: 'b/c' }, { size: 4 }, { sha: sha('two') }])
    assert.notEqual(digest([{ ...files[0], ...change }, files[1]]), digest(files));
  assert.notEqual(digest(files.slice(1)), digest(files));
});

test('real prepared bundle matches both sealed portable and compiled native full-tree identities',
  { skip: !process.env.DSH_BUNDLED_RUNTIME_ROOT }, async () => {
    const root = resolve(process.env.DSH_BUNDLED_RUNTIME_ROOT);
    const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(join(app, 'dsh-host/runtime-authority.json'), 'utf8')));
    assert.equal(authority.runtimePackage.version, '0.2.1-rc.3');
    const files = [];
    const visit = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name), metadata = await lstat(path);
        assert(!metadata.isSymbolicLink());
        if (metadata.isDirectory()) await visit(path);
        else {
          assert(metadata.isFile()); assert.equal(metadata.nlink, 1);
          const bytes = await readFile(path);
          files.push({ path: relative(root, path).replaceAll('\\', '/'), size: bytes.length, sha: sha(bytes) });
        }
      }
    };
    await visit(root);
    const portable = await auditPortableTree(root);
    assert.equal(portable.fileCount, authority.dependencyClosure.releaseLayout.fileCount);
    assert.equal(portable.contentSha256, authority.dependencyClosure.releaseLayout.contentSha256);
    const rust = await readFile(join(app, 'src-tauri/src/dsh_runtime_seal.rs'), 'utf8');
    const expected = rust.match(/const BUNDLED_NATIVE_CLOSURE_SHA256: &str = "([a-f0-9]{64})";/u)?.[1];
    assert(expected);
    assert.equal(files.length, portable.fileCount);
    assert.equal(digest(files), expected);
    assert.notEqual(expected, portable.contentSha256, 'the two digest formats must not be conflated');
  });
