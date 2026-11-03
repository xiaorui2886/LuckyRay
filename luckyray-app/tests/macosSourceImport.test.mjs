// Real Linux/macOS filesystem contracts with synthetic bytes. No upstream
// download, archive execution, native build or signature acceptance is implied.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { APP, BUILD, directory, sha256 } from "../scripts/macos-build-common.mjs";
import { FFMPEG_SOURCE_INPUT, importPinnedSource } from "../scripts/import-macos-app-source.mjs";

const payload = Buffer.from("exact retained source fixture\n");
const input = { sha256: sha256(payload), bytes: payload.length };
async function fixture(t) {
  await directory(BUILD);
  const root = await mkdtemp(join(BUILD, "source-import-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.tar.xz"), cache = join(root, "cache");
  await writeFile(source, payload, { flag: "wx", mode: 0o600 });
  return { root, source, cache, output: join(cache, input.sha256) };
}

test("offline import publishes exact private bytes and safely reuses the same object", async t => {
  const f = await fixture(t);
  const first = await importPinnedSource(input, f.source, f.cache);
  assert.equal(first.status, "imported-exact-source");
  assert.equal(first.pgp, "not-verified-by-importer");
  const original = await lstat(f.output);
  assert.equal(original.mode & 0o777, 0o600); assert.equal(original.nlink, 1);
  assert.deepEqual(await readFile(f.output), payload);
  assert.equal((await importPinnedSource(input, f.source, f.cache)).status, "verified-existing-source");
  assert.equal((await lstat(f.output)).ino, original.ino);
  assert.deepEqual(await readFile(f.source), payload);
});

test("nonprivate read-only source permissions are preserved without automatic chmod", async t => {
  const f = await fixture(t); await chmod(f.source, 0o644);
  await importPinnedSource(input, f.source, f.cache);
  assert.equal((await lstat(f.source)).mode & 0o777, 0o644);
});

test("wrong size, digest and unsafe writes cannot create a cache object", async t => {
  for (const variant of ["size", "hash", "mode"]) {
    const f = await fixture(t);
    if (variant === "size") await writeFile(f.source, "short");
    if (variant === "hash") await writeFile(f.source, Buffer.alloc(payload.length, 0x78));
    if (variant === "mode") await chmod(f.source, 0o666);
    await assert.rejects(importPinnedSource(input, f.source, f.cache), /source-import-(file-unsafe|bytes-invalid)/);
    await assert.rejects(lstat(f.output), { code: "ENOENT" });
  }
});

test("symlink and hardlink inputs are rejected and kept intact", async t => {
  for (const variant of ["symlink", "hardlink"]) {
    const f = await fixture(t), alias = join(f.root, "alias");
    if (variant === "symlink") await symlink(f.source, alias); else await link(f.source, alias);
    await assert.rejects(importPinnedSource(input, alias, f.cache));
    assert.deepEqual(await readFile(f.source), payload);
    assert.equal((await lstat(alias)).isSymbolicLink(), variant === "symlink");
    await assert.rejects(lstat(f.output), { code: "ENOENT" });
  }
});

test("linked or writable source/cache directories fail without adopting them", async t => {
  for (const variant of ["source-link", "source-mode", "cache-link", "cache-mode"]) {
    const f = await fixture(t);
    await mkdir(f.cache, { mode: 0o700 });
    let source = f.source, cache = f.cache;
    if (variant === "source-mode") await chmod(f.root, 0o777);
    if (variant === "cache-mode") await chmod(f.cache, 0o777);
    if (variant.endsWith("link")) {
      const alias = join(f.root, "linked");
      await symlink(variant.startsWith("source") ? f.root : f.cache, alias);
      if (variant.startsWith("source")) source = join(alias, "source.tar.xz"); else cache = alias;
    }
    await assert.rejects(importPinnedSource(input, source, cache));
    await assert.rejects(lstat(f.output), { code: "ENOENT" });
    if (variant.endsWith("mode")) assert.equal((await lstat(variant.startsWith("source") ? f.root : f.cache)).mode & 0o777, 0o777);
  }
});

test("existing conflicting bytes, links and unsafe files remain untouched", async t => {
  for (const variant of ["bytes", "symlink", "hardlink", "mode"]) {
    const f = await fixture(t); await mkdir(f.cache, { mode: 0o700 });
    if (variant === "symlink") await symlink(f.source, f.output);
    else if (variant === "hardlink") await link(f.source, f.output);
    else await writeFile(f.output, variant === "bytes" ? "preserve conflict" : payload, { flag: "wx", mode: 0o600 });
    if (variant === "mode") await chmod(f.output, 0o666);
    const before = await lstat(f.output), body = await readFile(f.output);
    await assert.rejects(importPinnedSource(input, f.source, f.cache));
    const after = await lstat(f.output);
    assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
    assert.deepEqual(await readFile(f.output), body);
  }
});

test("same-byte replacement during real source/cache reads is a conflict, not fresh authority", async t => {
  for (const variant of ["source", "cache"]) {
    const f = await fixture(t);
    if (variant === "cache") {
      await mkdir(f.cache, { mode: 0o700 });
      await writeFile(f.output, payload, { flag: "wx", mode: 0o600 });
    }
    const path = variant === "source" ? f.source : f.output;
    const probe = await open(path, "r");
    const identity = await probe.stat(), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
    await probe.close();
    let replaced = false;
    // Exercise the unmodified production importer. The real read completes,
    // then this test replaces that name before its production identity check.
    prototype.read = async function (...args) {
      const held = await this.stat(), result = await originalRead.apply(this, args);
      if (!replaced && held.dev === identity.dev && held.ino === identity.ino) {
        replaced = true;
        await rename(path, `${path}.retained`);
        await writeFile(path, payload, { flag: "wx", mode: 0o600 });
      }
      return result;
    };
    try { await assert.rejects(importPinnedSource(input, f.source, f.cache), /source-import-object-changed/); }
    finally { prototype.read = originalRead; }
    assert.equal(replaced, true);
    assert.equal((await lstat(`${path}.retained`)).ino, identity.ino);
    assert.notEqual((await lstat(path)).ino, identity.ino);
    assert.deepEqual(await readFile(path), payload);
    assert.deepEqual(await readFile(`${path}.retained`), payload);
  }
});

test("worktree boundary and fixed CLI cannot be changed by path/hash arguments", async t => {
  const f = await fixture(t);
  await assert.rejects(importPinnedSource(input, "/tmp/outside-source", f.cache), /outside-worktree/);
  await assert.rejects(importPinnedSource(input, f.source, "/tmp/outside-cache"), /outside-worktree/);
  const result = spawnSync(process.execPath, [join(APP, "scripts/import-macos-app-source.mjs"), f.source, input.sha256], { encoding: "utf8", env: {} });
  assert.equal(result.status, 1); assert.equal(result.signal, null);
  assert.equal(result.stderr.trim(), "macos-source-import-failed");
  assert(!result.stderr.includes(f.source));
  assert.equal(FFMPEG_SOURCE_INPUT.filename, "ffmpeg-9.0.1.tar.xz");
  assert.equal(FFMPEG_SOURCE_INPUT.bytes, 12_036_420);
  assert.equal(FFMPEG_SOURCE_INPUT.sha256, "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635");
});
