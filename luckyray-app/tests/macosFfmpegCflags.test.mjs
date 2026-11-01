import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeFfmpegCflags } from "../scripts/prepare-macos-runtimes.mjs";
import { APP, stage, releaseEnvironment } from "../scripts/macos-build-common.mjs";
const skip = process.platform === "win32";

test("FFmpeg flags retain each release mapping without literal shell quoting", { skip }, async () => {
  const raw = "-O2 -DNDEBUG '-ffile-prefix-map=/build/project=.' '-ffile-prefix-map=/build/home=.'";
  assert.equal(await normalizeFfmpegCflags(raw), "-O2 -DNDEBUG -ffile-prefix-map=/build/project=. -ffile-prefix-map=/build/home=.");
  await assert.rejects(normalizeFfmpegCflags("'-ffile-prefix-map=/build/with space=.'"), /macos-ffmpeg-cflags-unrepresentable/);
  await assert.rejects(normalizeFfmpegCflags("bad\0flag"), /macos-ffmpeg-cflags-invalid/);
});

test("real compiler probe fails with inherited quoting and succeeds with the same normalized maps", { skip }, async () => {
  const root = await stage("ffmpeg-cflags-compiler-fixture");
  const source = join(root, "probe.c"); const output = join(root, "probe.o");
  await writeFile(source, "const char *origin = __FILE__; int main(void) { return origin[0] == 0; }\n", { flag: "wx" });
  const raw = releaseEnvironment().CFLAGS;
  const normalized = await normalizeFfmpegCflags(raw);
  const compiler = process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc";
  // Match FFmpeg test_cc's unquoted CFLAGS word expansion; no eval is used.
  const command = '"$COMPILER" $CFLAGS -std=c17 -c "$SOURCE" -o "$OUTPUT"';
  const probe = flags => spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, COMPILER: compiler, CFLAGS: flags, SOURCE: source, OUTPUT: output } });
  const before = probe(raw); const after = probe(normalized);
  assert(before.status !== 0, "original quoting must reproduce the compiler argument failure");
  assert.equal(after.status, 0, "normalized compiler arguments must compile");
  assert(normalized.includes("-DNDEBUG")); assert(normalized.includes(`-ffile-prefix-map=${APP}=.`));
  const object = await readFile(output);
  assert(!object.includes(Buffer.from(APP)), "compiled __FILE__ must retain the release path remapping");
});
