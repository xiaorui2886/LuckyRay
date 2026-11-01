import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DENO_INPUT, validateDenoListing, verifyDenoArchive } from "../scripts/prepare-macos-deno-input.mjs";

test("Deno input rejects unpinned bytes and unexpected archive members", () => {
  assert.throws(() => verifyDenoArchive(Buffer.from("synthetic")), /macos-deno-archive-hash-invalid/);
  assert.doesNotThrow(() => validateDenoListing("deno\n"));
  for (const listing of ["", "deno\ndeno\n", "../deno\n", "deno\nother\n", "deno\0"]) {
    assert.throws(() => validateDenoListing(listing), /macos-deno-/);
  }
});

test("Deno upstream license bytes match the pinned source commit", () => {
  const file = new URL(`../third-party-notices/deno-2.9.4/bodies/${DENO_INPUT.licenseSha256}.txt`, import.meta.url);
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), DENO_INPUT.licenseSha256);
});
