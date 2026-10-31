import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ARCHIVE_BYTES, ARCHIVE_SHA256, ARCHIVE_URL, DENO_VERSION, LICENSE_SHA256,
  prepareDenoInput, verifyArchive, verifyLicense } from "../scripts/linux/prepare-deno-input.mjs";

test("the official Linux Deno archive is fixed and rejects other bytes", () => {
  assert.equal(DENO_VERSION, "2.9.4");
  assert.equal(ARCHIVE_BYTES, 43_834_754);
  assert.equal(ARCHIVE_SHA256.length, 64);
  assert.match(ARCHIVE_URL, /^https:\/\/github\.com\/denoland\/deno\/releases\/download\/v2\.9\.4\//);
  for (const value of [null, Buffer.alloc(0), Buffer.from("synthetic archive")]) {
    assert.throws(() => verifyArchive(value), /linux-deno-archive-hash-invalid/);
  }
  assert.throws(() => verifyArchive(Buffer.alloc(ARCHIVE_BYTES)), /linux-deno-archive-hash-invalid/);
});

test("the checked-in upstream Deno MIT notice is hash pinned", () => {
  const notice = readFileSync(fileURLToPath(new URL("../scripts/linux/deno-license-2.9.4.txt", import.meta.url)));
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const attributes = execFileSync("git", ["check-attr", "-z", "eol", "--", "luckyray-app/scripts/linux/deno-license-2.9.4.txt"], { cwd: repository }).toString().split("\0");
  assert.equal(attributes[2], "lf");
  assert.equal(LICENSE_SHA256.length, 64);
  assert.doesNotThrow(() => verifyLicense(notice));
  assert.throws(() => verifyLicense(Buffer.concat([notice, Buffer.from("changed")])), /linux-deno-license-hash-invalid/);
});

test("a forged or symlinked archive does not create a Deno input", { skip: process.platform !== "linux" || process.arch !== "x64" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "luckyray-deno-input-test-"));
  try {
    const archive = path.join(root, "forged.zip");
    const output = path.join(root, "output");
    writeFileSync(archive, "synthetic archive");
    assert.throws(() => prepareDenoInput(archive, output), /linux-deno-archive-size-invalid/);
    assert.equal(existsSync(output), false);
    const link = path.join(root, "archive-link");
    symlinkSync(archive, link);
    assert.throws(() => prepareDenoInput(link, output), error => error?.code === "ELOOP");
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
