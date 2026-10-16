// Daily-profile observation for the fixture drivers: existence and file METADATA
// only (existsSync/statSync). This helper must never touch file contents — no
// content reads, no streams, no digest of the user's database. The read-boundary
// test (readBoundary.test.mjs) enforces that with a throwing fs proxy on synthetic
// files and a static source guard over this file and both drivers.
import fs from "node:fs";
import path from "node:path";

export const DAILY_PROFILE_IDS = Object.freeze(["com.luckyray.desktop.dev", "com.luckyray.desktop"]);

export function snapshotDailyProfile(id, io = fs, appdata = process.env.APPDATA) {
  const dir = appdata ? path.join(appdata, id) : null;
  const exists = dir ? io.existsSync(dir) : false;
  if (!exists) return { id, exists: false };
  const dirStat = io.statSync(dir);
  const db = path.join(dir, "luckyray.db");
  const dbExists = io.existsSync(db);
  const dbStat = dbExists ? io.statSync(db) : null;
  return {
    id,
    exists: true,
    dirMtime: dirStat.mtimeMs,
    dbExists,
    // Size/mtime are observations only: a running daily instance rewrites its own
    // database, so these can neither prove nor disprove anything about the fixture.
    // NOT_PROVEN by design.
    dbSize: dbStat ? dbStat.size : null,
    dbMtime: dbStat ? dbStat.mtimeMs : null,
  };
}
