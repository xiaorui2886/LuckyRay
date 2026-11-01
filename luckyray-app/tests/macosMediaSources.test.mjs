import assert from "node:assert/strict";
import test from "node:test";
import { SOURCES, validateSourceListing, verifySourceBytes } from "../scripts/check-macos-media-sources.mjs";

test("media source checks reject altered bytes and missing or duplicate licenses", () => {
  for (const kind of ["python", "ffmpeg"]) {
    assert.throws(() => verifySourceBytes(kind, Buffer.from("synthetic")), /hash-invalid/);
    const listing = `${SOURCES[kind].licenses.join("\n")}\n`;
    assert.doesNotThrow(() => validateSourceListing(kind, listing));
    assert.throws(() => validateSourceListing(kind, ""), /license-members-invalid/);
    assert.throws(() => validateSourceListing(kind, listing + `${SOURCES[kind].licenses[0]}\n`), /license-members-invalid/);
  }
  assert.throws(() => verifySourceBytes("unknown", Buffer.from("synthetic")), /hash-invalid/);
});
