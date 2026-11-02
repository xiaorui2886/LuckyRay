// The transport executor is controlled; real Node children write the real
// no-follow descriptors. These are failure-handling contracts, not upstream
// download, native build or DSH acceptance evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { link, lstat, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BUILD, directory, download, sha256 } from "../scripts/macos-build-common.mjs";

const payload = Buffer.from("pinned source transfer fixture\n");
const input = { url: "https://source.invalid/frozen-source", sha256: sha256(payload) };
async function cache(t) {
  await directory(BUILD);
  const value = await mkdtemp(join(BUILD, "source-download-contract-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
function writeChild(options, bytes, exit = 0) {
  const child = spawnSync(process.execPath, ["-e",
    `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64'),()=>process.exit(${exit}));`],
    { stdio: options.stdio, env: {} });
  assert.equal(child.signal, null); assert.equal(child.status, exit);
  if (exit) throw new Error(`macos-build-command-failed:/usr/bin/curl:${exit}`);
}
function assertPolicy(command, args, options) {
  assert.equal(command, "/usr/bin/curl"); assert.equal(args[0], "--disable");
  for (const [key, value] of [["--proto", "=https"], ["--proto-redir", "=https"],
    ["--connect-timeout", "20"], ["--max-time", "180"], ["--max-filesize", "536870912"]])
    assert.equal(args[args.indexOf(key) + 1], value);
  assert(args.includes("--fail")); assert(args.includes("--tlsv1.2"));
  assert(!args.includes("--insecure")); assert(!args.includes("--retry"));
  assert.equal(args.at(-1), input.url); assert.equal(options.diagnosticInput, input.sha256);
}

test("one timeout retries into a new object and publishes only exact complete bytes", async t => {
  const cacheDirectory = await cache(t), objects = [];
  const result = await download(input, { cacheDirectory, transfer: async (command, args, options) => {
    assertPolicy(command, args, options);
    const meta = fstatSync(options.stdio[1]);
    objects.push(`${meta.dev}:${meta.ino}`);
    assert.equal(meta.mode & 0o777, 0o600);
    writeChild(options, objects.length === 1 ? Buffer.from("partial") : payload, objects.length === 1 ? 28 : 0);
  } });
  assert.equal(objects.length, 2); assert.notEqual(objects[0], objects[1]);
  assert.deepEqual(await readFile(result), payload);
  const partials = (await readdir(cacheDirectory)).filter(name => name.endsWith(".download"));
  assert.equal(partials.length, 2);
  const bodies = await Promise.all(partials.map(name => readFile(join(cacheDirectory, name), "utf8")));
  assert(bodies.includes("partial")); assert(bodies.includes(payload.toString()));
});

test("two timeouts remain failed even if a partial transfer happens to match the hash", async t => {
  const cacheDirectory = await cache(t);
  let calls = 0;
  await assert.rejects(download(input, { cacheDirectory, transfer: async (_command, _args, options) => {
    calls += 1; writeChild(options, payload, 28);
  } }), /curl:28/);
  assert.equal(calls, 2);
  assert(!(await readdir(cacheDirectory)).includes(input.sha256));
});

test("HTTP errors, TLS errors and byte mismatches fail without another attempt", async t => {
  for (const exit of [22, 35, 60, 0]) {
    const cacheDirectory = await cache(t);
    let calls = 0;
    await assert.rejects(download(input, { cacheDirectory, transfer: async (_command, _args, options) => {
      calls += 1; writeChild(options, Buffer.from("wrong bytes"), exit);
    } }), exit ? new RegExp(`curl:${exit}`) : /download-hash-invalid/);
    assert.equal(calls, 1);
    assert(!(await readdir(cacheDirectory)).includes(input.sha256));
  }
});

test("verified cached sources are reused and conflicting bytes never contact a source", async t => {
  const cacheDirectory = await cache(t), existing = join(cacheDirectory, input.sha256);
  await writeFile(existing, payload, { flag: "wx", mode: 0o600 });
  let contacted = false;
  assert.equal(await download(input, { cacheDirectory, transfer: async () => { contacted = true; } }), existing);
  assert.equal(contacted, false); assert.deepEqual(await readFile(existing), payload);
  await writeFile(existing, "keep conflict");
  await assert.rejects(download(input, { cacheDirectory, transfer: async () => { contacted = true; } }), /cache-conflict/);
  assert.equal(contacted, false); assert.equal(await readFile(existing, "utf8"), "keep conflict");
});

test("a replaced download name cannot publish or trigger another transfer", async t => {
  const cacheDirectory = await cache(t);
  let calls = 0;
  await assert.rejects(download(input, { cacheDirectory, transfer: async (_command, _args, options) => {
    calls += 1; writeChild(options, payload);
    const name = (await readdir(cacheDirectory)).find(value => value.endsWith(".download"));
    const path = join(cacheDirectory, name);
    await rename(path, `${path}.retained`); await symlink(`${path}.retained`, path);
  } }), /download-object-changed/);
  assert.equal(calls, 1);
  assert(!(await readdir(cacheDirectory)).includes(input.sha256));
});

test("timeout with a replaced, linked or missing name preserves the scene without retry", async t => {
  for (const variant of ["symlink", "replacement", "hardlink", "missing"]) {
    const cacheDirectory = await cache(t);
    let calls = 0, path, retained;
    await assert.rejects(download(input, { cacheDirectory, transfer: async (_command, _args, options) => {
      calls += 1;
      let failure;
      try { writeChild(options, payload, 28); } catch (error) { failure = error; }
      assert.equal(failure.message, "macos-build-command-failed:/usr/bin/curl:28");
      if (calls === 1) {
        const name = (await readdir(cacheDirectory)).find(value => value.endsWith(".download"));
        path = join(cacheDirectory, name); retained = `${path}.retained`;
        if (variant === "hardlink") await link(path, retained);
        else await rename(path, retained);
        if (variant === "symlink") await symlink(retained, path);
        if (variant === "replacement") await writeFile(path, "preserve replacement", { flag: "wx", mode: 0o600 });
      }
      throw failure;
    } }), /download-object-changed/);
    assert.equal(calls, 1, variant);
    assert.deepEqual(await readFile(retained), payload);
    if (variant === "symlink") {
      assert((await lstat(path)).isSymbolicLink());
      assert.equal(await readlink(path), retained);
    } else if (variant === "replacement") assert.equal(await readFile(path, "utf8"), "preserve replacement");
    else if (variant === "hardlink") {
      assert.equal((await lstat(path)).nlink, 2);
      assert.equal((await lstat(retained)).nlink, 2);
    } else await assert.rejects(lstat(path), { code: "ENOENT" });
    assert(!(await readdir(cacheDirectory)).includes(input.sha256));
  }
});
