// Synthetic transfers and real local file IO only: no network or archive execution.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { APP, BUILD, directory, sha256 } from "../scripts/macos-build-common.mjs";
import { importPinnedSource, stagePinnedSource } from "../scripts/import-macos-app-source.mjs";
import { OFFICIAL_SOURCE_URL, fetchAndStagePinnedSource, safeSourceFetchFailure } from "../scripts/fetch-macos-app-source.mjs";

const payload = Buffer.from("synthetic source bytes retained for pinned staging\n");
const input = { bytes: payload.length, sha256: sha256(payload) };
const trailer = status => Buffer.from(`\nLR_HTTP_STATUS:${String(status).padStart(3, "0")}\n`);

async function fixture(t) {
  await directory(BUILD);
  const root = await mkdtemp(join(BUILD, "source-fetch-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source: join(root, "source.tar.xz"), cache: join(root, "cache") };
}

function fakeChild(chunks, { code = 0, signal = null, hang = false, streamError = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let stopped = false;
  child.kill = sent => {
    if (stopped) return true;
    stopped = true;
    queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit("close", null, sent); });
    return true;
  };
  if (streamError) process.nextTick(() => child.stdout.emit("error", new Error("synthetic stream failure")));
  else if (!hang) process.nextTick(() => {
    for (const chunk of chunks) { if (stopped) break; child.stdout.write(chunk); }
    if (!stopped) {
      child.stdout.once("end", () => child.emit("close", code, signal));
      child.stdout.end(); child.stderr.end();
    }
  });
  return child;
}

function options(root, childFactory, onLaunch = () => {}) {
  const env = { HOME: root, HTTPS_PROXY: "http://proxy.invalid:8000", NO_PROXY: "localhost" };
  return { env, accountHome: root, timeoutMs: 1000,
    launch: (command, args, settings) => { onLaunch(command, args, settings, env); return childFactory(); } };
}

test("one bounded official request stages verified bytes for the unchanged importer", async t => {
  const f = await fixture(t);
  const output = Buffer.concat([payload, trailer(200)]);
  let launches = 0;
  const opts = options(f.root, () => fakeChild([output.subarray(0, 5), output.subarray(5, payload.length + 3), output.subarray(payload.length + 3)]),
    (command, args, settings, env) => {
      launches++;
      assert.equal(command, "/usr/bin/curl"); assert.strictEqual(settings.env, env);
      assert.deepEqual(settings.stdio, ["ignore", "pipe", "pipe"]);
      assert.equal(args[0], "-q");
      for (const flag of ["--fail", "--no-insecure", "--no-proxy-insecure", "--connect-timeout", "--max-time", "--max-filesize", "--proto", "--max-redirs"])
        assert(args.includes(flag));
      assert.equal(args[args.indexOf("--connect-timeout") + 1], "45");
      assert.equal(args[args.indexOf("--max-time") + 1], "120");
      assert.equal(args[args.indexOf("--max-filesize") + 1], String(payload.length));
      assert.equal(args[args.indexOf("--proto") + 1], "=https");
      assert.equal(args[args.indexOf("--max-redirs") + 1], "0");
      for (const flag of ["--location", "--insecure", "--proxy-insecure", "--resolve", "--connect-to", "--retry"])
        assert(!args.includes(flag));
      assert.deepEqual(args.filter(arg => arg.startsWith("https://")), [OFFICIAL_SOURCE_URL]);
    });
  const staged = await fetchAndStagePinnedSource(input, f.source, opts);
  assert.equal(launches, 1); assert.equal(staged.status, "staged-exact-source");
  assert.deepEqual(await readFile(f.source), payload);
  const sourceMeta = await lstat(f.source);
  assert.equal(sourceMeta.mode & 0o777, 0o600); assert.equal(sourceMeta.nlink, 1);
  const imported = await importPinnedSource(input, f.source, f.cache);
  assert.equal(imported.status, "imported-exact-source");
  assert.deepEqual(await readFile(join(f.cache, input.sha256)), payload);
});

test("a fragmented synthetic response at the full production size is staged exactly", async t => {
  const f = await fixture(t), bytes = Buffer.alloc(12_036_420, 0x5a);
  const descriptor = { bytes: bytes.length, sha256: sha256(bytes) };
  const fragments = [];
  for (let offset = 0; offset < bytes.length; offset += 65_521)
    fragments.push(bytes.subarray(offset, offset + 65_521));
  fragments.push(trailer(200));
  const result = await fetchAndStagePinnedSource(descriptor, f.source,
    options(f.root, () => fakeChild(fragments)));
  assert.equal(result.status, "staged-exact-source");
  assert.equal((await lstat(f.source)).size, descriptor.bytes);
  assert.equal(sha256(await readFile(f.source)), descriptor.sha256);
});

test("denial, redirect, failed transfer, wrong bytes and wrong lengths never stage input", async t => {
  const cases = [
    { chunks: [trailer(401)], code: 22, error: /http-denied/ },
    { chunks: [trailer(403)], code: 22, error: /http-denied/ },
    { chunks: [trailer(451)], code: 22, error: /http-denied/ },
    { chunks: [trailer(302)], code: 0, error: /http-redirect/ },
    { chunks: [trailer(404)], code: 22, error: /http-client-error/ },
    { chunks: [trailer(429)], code: 22, error: /http-rate-limited/ },
    { chunks: [trailer(503)], code: 22, error: /http-server-error/ },
    { chunks: [trailer(0)], code: 28, error: /curl-timeout/ },
    { chunks: [trailer(0)], code: 6, error: /curl-resolution-connect/ },
    { chunks: [trailer(0)], code: 60, error: /curl-tls/ },
    { chunks: [payload, trailer(200)], code: 56, error: /transfer-failed/ },
    { chunks: [Buffer.alloc(payload.length, 0x78), trailer(200)], error: /digest-invalid/ },
    { chunks: [payload.subarray(0, -1), trailer(200)], error: /size-invalid/ },
    { chunks: [payload, Buffer.from("x"), trailer(200)], error: /size-invalid/ },
  ];
  for (const c of cases) {
    const f = await fixture(t);
    let launches = 0;
    await assert.rejects(fetchAndStagePinnedSource(input, f.source,
      options(f.root, () => { launches++; return fakeChild(c.chunks, { code: c.code ?? 0 }); })), c.error);
    assert.equal(launches, 1);
    await assert.rejects(lstat(f.source), { code: "ENOENT" });
    await assert.rejects(lstat(f.cache), { code: "ENOENT" });
  }
});

test("safe fetch errors expose only fixed classifications, never raw detail", () => {
  for (const code of ["http-denied", "curl-timeout", "curl-resolution-connect", "curl-tls", "http-redirect", "http-rate-limited",
    "http-client-error", "http-server-error", "transfer-failed", "size-invalid", "digest-invalid", "stream-failed", "launch-failed", "timeout"])
    assert.equal(safeSourceFetchFailure(new Error(`macos-source-fetch-${code}`)), `macos-source-fetch-${code}`);
  for (const code of ["directory-unsafe", "directory-changed", "object-changed", "output-unsafe", "file-unsafe", "bytes-invalid"])
    assert.equal(safeSourceFetchFailure(new Error(`macos-source-import-${code}`)), `macos-source-import-${code}`);
  const privateCanary = "private-path-proxy-or-curl-error-must-not-escape";
  for (const error of [new Error(privateCanary), new Error(`macos-source-fetch-curl-timeout:${privateCanary}`), {}, null])
    assert.equal(safeSourceFetchFailure(error), "macos-source-fetch-failed");
  let reads = 0;
  const changing = { get message() {return ++reads === 1 ? "macos-source-fetch-curl-timeout" : privateCanary;} };
  assert.equal(safeSourceFetchFailure(changing), "macos-source-fetch-curl-timeout");assert.equal(reads, 1);
  assert.equal(safeSourceFetchFailure({ get message() {throw new Error(privateCanary);} }), "macos-source-fetch-failed");
});

test("a failed process launch stops without retrying or staging input", async t => {
  const f = await fixture(t);
  let launches = 0;
  const opts = options(f.root, () => { launches++; throw new Error("private diagnostic must not be emitted"); });
  await assert.rejects(fetchAndStagePinnedSource(input, f.source, opts), /launch-failed/);
  assert.equal(launches, 1);
  await assert.rejects(lstat(f.source), { code: "ENOENT" });
});

test("stream errors stop the process and cannot stage input", async t => {
  const f = await fixture(t);
  await assert.rejects(fetchAndStagePinnedSource(input, f.source,
    options(f.root, () => fakeChild([], { streamError: true }))), /stream-failed/);
  await assert.rejects(lstat(f.source), { code: "ENOENT" });
});

test("an unresponsive process times out and cannot stage input", async t => {
  const f = await fixture(t), opts = options(f.root, () => fakeChild([], { hang: true }));
  opts.timeoutMs = 30;
  await assert.rejects(fetchAndStagePinnedSource(input, f.source, opts), /timeout/);
  await assert.rejects(lstat(f.source), { code: "ENOENT" });
});

test("an existing curl configuration stops before any process or network launch", async t => {
  for (const variable of ["HOME", "CURL_HOME", "XDG_CONFIG_HOME", "accountHome"]) {
    const f = await fixture(t), configHome = join(f.root, "config");
    await mkdir(configHome, { mode: 0o700 });
    const file = join(configHome, variable === "XDG_CONFIG_HOME" ? "curlrc" : ".curlrc");
    await writeFile(file, "proxy = http://configured-policy.invalid\n", { flag: "wx", mode: 0o600 });
    let launches = 0;
    const opts = options(f.root, () => { launches++; return fakeChild([payload, trailer(200)]); });
    if (variable === "accountHome") opts.accountHome = configHome; else opts.env[variable] = configHome;
    await assert.rejects(fetchAndStagePinnedSource(input, f.source, opts), /curl-config-present/);
    assert.equal(launches, 0); await assert.rejects(lstat(f.source), { code: "ENOENT" });
  }
});

test("TLS key logging stops before any process or network launch", async t => {
  const f = await fixture(t);
  let launches = 0;
  const opts = options(f.root, () => { launches++; return fakeChild([payload, trailer(200)]); });
  opts.env.SSLKEYLOGFILE = join(f.root, "forbidden-keylog");
  await assert.rejects(fetchAndStagePinnedSource(input, f.source, opts), /tls-keylog-configured/);
  assert.equal(launches, 0);
  await assert.rejects(lstat(f.source), { code: "ENOENT" });
  await assert.rejects(lstat(opts.env.SSLKEYLOGFILE), { code: "ENOENT" });
});

test("conflicting staged files, symlinks and hardlinks are preserved", async t => {
  for (const kind of ["file", "symlink", "hardlink"]) {
    const f = await fixture(t), backing = join(f.root, "backing");
    await writeFile(backing, "original", { flag: "wx", mode: 0o600 });
    if (kind === "file") await writeFile(f.source, "conflict", { flag: "wx", mode: 0o600 });
    else if (kind === "symlink") await symlink(backing, f.source);
    else await link(backing, f.source);
    const before = await lstat(f.source);
    await assert.rejects(fetchAndStagePinnedSource(input, f.source,
      options(f.root, () => fakeChild([payload, trailer(200)]))));
    const after = await lstat(f.source);
    assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
    assert.equal(after.isSymbolicLink(), kind === "symlink");
    assert.equal(await readFile(backing, "utf8"), "original");
    if (kind === "file") assert.equal(await readFile(f.source, "utf8"), "conflict");
  }
});

test("unsafe stage parent and same-byte inode replacement fail without cleanup of replacements", async t => {
  const f = await fixture(t), targetDir = join(f.root, "parent"), linked = join(f.root, "linked");
  await assert.rejects(stagePinnedSource(input, payload, "/tmp/outside-source"), /outside-worktree/);
  await mkdir(targetDir, { mode: 0o700 }); await symlink(targetDir, linked);
  await assert.rejects(stagePinnedSource(input, payload, join(linked, "source.tar.xz")));
  await assert.rejects(lstat(join(targetDir, "source.tar.xz")), { code: "ENOENT" });
  await chmod(targetDir, 0o777);
  await assert.rejects(stagePinnedSource(input, payload, join(targetDir, "source.tar.xz")));
  await chmod(targetDir, 0o700);

  const probe = await open(join(f.root, "probe"), "wx", 0o600);
  const prototype = Object.getPrototypeOf(probe), original = prototype.writeFile;
  await probe.close();
  let replaced = false;
  prototype.writeFile = async function (...args) {
    const value = await original.apply(this, args);
    const held = await this.stat(), named = await lstat(f.source).catch(() => null);
    if (!replaced && named && held.dev === named.dev && held.ino === named.ino) {
      replaced = true;
      await rename(f.source, `${f.source}.retained`);
      await writeFile(f.source, payload, { flag: "wx", mode: 0o600 });
    }
    return value;
  };
  try { await assert.rejects(stagePinnedSource(input, payload, f.source), /object-changed/); }
  finally { prototype.writeFile = original; }
  assert.equal(replaced, true);
  assert.notEqual((await lstat(f.source)).ino, (await lstat(`${f.source}.retained`)).ino);
  assert.deepEqual(await readFile(f.source), payload);
  assert.deepEqual(await readFile(`${f.source}.retained`), payload);
});

test("the production CLI rejects overrides and non-runner execution before network activity", () => {
  const script = join(APP, "scripts/fetch-macos-app-source.mjs");
  for (const args of [["https://invalid.example/archive"], []]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: {} });
    assert.equal(result.status, 1); assert.equal(result.signal, null); assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "macos-source-fetch-failed");
  }
});
