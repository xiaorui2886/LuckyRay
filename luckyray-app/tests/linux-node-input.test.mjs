import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ARCHIVE_SHA256, ARCHIVE_URL, NODE_VERSION, prepareNodeInput, verifyArchive, verifyElfHeader } from "../scripts/linux/prepare-node-input.mjs";

test("the official archive pin refuses altered or missing bytes", () => {
  assert.equal(NODE_VERSION, "22.19.0");
  assert.equal(ARCHIVE_SHA256.length, 64);
  assert.match(ARCHIVE_URL, /^https:\/\/nodejs\.org\/dist\/v22\.19\.0\//);
  for (const bytes of [Buffer.alloc(0), Buffer.from("synthetic unrelated archive"), null]) {
    assert.throws(() => verifyArchive(bytes), /linux-node-archive-hash-invalid/);
  }
});

test("the executable gate rejects non-ELF and wrong-architecture headers", () => {
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(62, 18);
  assert.doesNotThrow(() => verifyElfHeader(header));
  for (const [offset, value] of [[0, 0], [4, 1], [5, 2], [6, 0], [18, 183]]) {
    const invalid = Buffer.from(header);
    invalid[offset] = value;
    assert.throws(() => verifyElfHeader(invalid), /linux-node-elf-invalid/);
  }
});

test("a tampered or symlinked archive creates no staged runtime", { skip: process.platform !== "linux" || process.arch !== "x64" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "luckyray-node-input-test-"));
  try {
    const archive = path.join(root, "forged.tar.gz");
    const output = path.join(root, "output");
    writeFileSync(archive, "synthetic archive");
    assert.throws(() => prepareNodeInput(archive, output), /linux-node-archive-hash-invalid/);
    assert.equal(existsSync(output), false);
    const link = path.join(root, "archive-link");
    symlinkSync(archive, link);
    assert.throws(() => prepareNodeInput(link, output), error => error?.code === "ELOOP");
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
