// Byte/object inventory shared by preparation and offline source qualification.
// This never executes a runtime or declares a native probe successful.
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readRegular, APP } from "./macos-build-common.mjs";

export const RECEIPT = "macos-build.json";
const prefix = "luckyray-macos-lsh-tree-v1\0";
export function sealRows(rows) {
  const digest = createHash("sha256"); digest.update(prefix);
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  let previous = null, files = 0, directories = 0, bytes = 0;
  for (const row of rows) {
    if (typeof row.path !== "string" || row.path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(row.path)
        || row.path !== "" && row.path.split("/").some(part => !part || part === "." || part === "..")
        || row.path === previous) throw new Error("macos-lsh-seal-path-invalid");
    previous = row.path;
    if (row.kind === "directory") { directories++; digest.update(`D\0${row.path}\n`); }
    else if (row.kind === "file" && Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= 512 * 1024 * 1024
        && typeof row.executable === "boolean" && /^[a-f0-9]{64}$/.test(row.sha256)) {
      files++; bytes += row.size;
      digest.update(`F\0${row.path}\0${row.size}\0${row.executable ? 1 : 0}\0${row.sha256}\n`);
    } else throw new Error("macos-lsh-seal-row-invalid");
  }
  if (files === 0 || files > 40000 || directories === 0 || directories > 40000 || bytes > 8 * 1024 ** 3)
    throw new Error("macos-lsh-seal-capacity");
  return { format: "luckyray-macos-lsh-tree-v1", sha256: digest.digest("hex"), fileCount: files,
    directoryCount: directories, byteCount: bytes };
}
export async function runtimeSeal(root) {
  const rows = [];
  async function walk(path, relative) {
    const meta = await lstat(path);
    if (!meta.isDirectory() || meta.isSymbolicLink() || meta.mode & 0o7022)
      throw new Error("macos-lsh-seal-directory-invalid");
    rows.push({ kind: "directory", path: relative });
    for (const name of await readdir(path)) {
      const child = join(path, name), key = relative ? `${relative}/${name}` : name;
      const meta = await lstat(child);
      if (meta.isSymbolicLink()) throw new Error("macos-lsh-seal-linked-entry");
      if (meta.isDirectory()) await walk(child, key);
      else {
        if (!meta.isFile() || meta.nlink !== 1 || meta.mode & 0o7022)
          throw new Error("macos-lsh-seal-file-invalid");
        // The non-code native build receipt has its own compilation-time pin.
        // It cannot authorize any payload in this source-reviewed tree seal.
        if (key === RECEIPT) continue;
        const bytes = await readRegular(child);
        rows.push({ kind: "file", path: key, size: bytes.length, executable: (meta.mode & 0o111) !== 0,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      if (rows.length > 80000) throw new Error("macos-lsh-seal-capacity");
    }
  }
  await walk(root, "");
  return { closure: sealRows(rows), rows };
}
export async function verifyPreparedLsh(root) {
  const authority = JSON.parse((await readRegular(join(APP, "src-tauri/macos-lsh-authority.json"), 64 * 1024)).toString());
  const actual = await runtimeSeal(root);
  if (authority.schemaVersion !== 1 || authority.platform !== "darwin" || authority.architecture !== "arm64"
      || JSON.stringify(actual.closure) !== JSON.stringify(authority.closure))
    throw new Error("macos-lsh-source-closure-mismatch");
  return actual.closure;
}
