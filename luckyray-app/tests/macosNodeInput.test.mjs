import assert from "node:assert/strict";
import test from "node:test";
import { NODE_INPUT, validateArchiveListing, validateArm64Executable, verifyArchiveBytes } from "../scripts/prepare-macos-node-input.mjs";

const root = `node-v${NODE_INPUT.version}-darwin-arm64`;

test("the official archive gate rejects arbitrary or empty input", () => {
  for (const value of [null, Buffer.alloc(0), Buffer.from("synthetic archive")]) {
    assert.throws(() => verifyArchiveBytes(value), /archive-hash-invalid/);
  }
});

test("the archive listing must contain both exact members once", () => {
  const valid = `${root}/bin/node\n${root}/LICENSE\n`;
  assert.doesNotThrow(() => validateArchiveListing(valid));
  for (const value of ["", `${root}/bin/node\n`, `${valid}${root}/bin/node\n`, `${valid}\0`]) {
    assert.throws(() => validateArchiveListing(value), /archive-(?:list|members)-invalid/);
  }
});

test("the selected executable must be a Darwin arm64 Mach-O executable", () => {
  const valid = Buffer.alloc(32);
  valid.writeUInt32LE(0xfeedfacf, 0);
  valid.writeUInt32LE(0x0100000c, 4);
  valid.writeUInt32LE(2, 12);
  assert.doesNotThrow(() => validateArm64Executable(valid));
  const intel = Buffer.from(valid); intel.writeUInt32LE(0x01000007, 4);
  const dylib = Buffer.from(valid); dylib.writeUInt32LE(6, 12);
  for (const value of [Buffer.alloc(0), Buffer.from("MZ"), intel, dylib]) {
    assert.throws(() => validateArm64Executable(value), /architecture-invalid/);
  }
});
