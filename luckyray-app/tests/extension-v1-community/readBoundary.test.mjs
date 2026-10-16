// QA1 read-boundary test: the daily-profile observation helper must be metadata-only.
// Proves it with synthetic files and a throwing fs proxy, plus a static source guard
// over the helper and both fixture drivers. Never touches a real profile.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotDailyProfile } from "./profile-observation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("metadata-only: a throwing fs proxy exposes any attempt to read content or enumerate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lr-boundary-"));
  try {
    const profileDir = path.join(root, "com.luckyray.desktop.dev");
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, "luckyray.db"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const touched = [];
    const io = new Proxy({}, {
      get(_target, prop) {
        const name = String(prop);
        touched.push(name);
        if (name === "existsSync" || name === "statSync") return (...args) => fs[name](...args);
        throw new Error(`metadata-only boundary violated: helper tried to use fs.${name}`);
      },
    });
    const snap = snapshotDailyProfile("com.luckyray.desktop.dev", io, root);
    assert.equal(snap.exists, true);
    assert.equal(snap.dbExists, true);
    assert.equal(snap.dbSize, 8);
    assert.ok(Number.isFinite(snap.dbMtime));
    assert.deepEqual([...new Set(touched)].sort(), ["existsSync", "statSync"]);
    // absent profile
    const missing = snapshotDailyProfile("com.luckyray.desktop.dev", io, path.join(root, "nope"));
    assert.equal(missing.exists, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("static guard: no content-read or hash APIs on the daily-profile path anywhere in the drivers", () => {
  const helper = fs.readFileSync(path.join(here, "profile-observation.mjs"), "utf8");
  for (const banned of ["readFileSync", "createReadStream", "openSync", "createHash", "readFile", "copyFileSync", "readdirSync"]) {
    assert.equal(helper.includes(banned), false, `helper must not use ${banned}`);
  }
  for (const file of ["drive.mjs", "negative.mjs", "profile-observation.mjs"]) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.equal(source.includes("certutil"), false, `${file}: certutil hashing removed`);
    assert.equal(source.includes("hashfile"), false, `${file}: no hashfile`);
    // Any line that names a real daily profile must only pass it to the metadata helper.
    for (const line of source.split(/\r?\n/)) {
      if (/com\.luckyray\.desktop/.test(line)) {
        assert.match(line, /snapshotDailyProfile\(|DAILY_PROFILE_IDS/, `${file}: daily profile id may only appear inside snapshotDailyProfile(...) or the shared id list — offending line: ${line.trim()}`);
        assert.doesNotMatch(line, /readFileSync|createHash|readdirSync|execFileSync|spawnSync|statSync/, `${file}: daily profile line must not read/hash/enumerate — offending line: ${line.trim()}`);
      }
    }
  }
  // The old byte-hashing snapshot is really gone from the drivers.
  const drive = fs.readFileSync(path.join(here, "drive.mjs"), "utf8");
  assert.equal(drive.includes("snapshotProfile("), false, "old snapshotProfile (certutil sha of the daily db) removed");
});
