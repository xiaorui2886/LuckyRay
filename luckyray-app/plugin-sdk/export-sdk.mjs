// Public allowlist export; never packages a host/profile/node_modules or stale target.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const files = ["LICENSE", "package.json", "index.d.ts", "cli.mjs", "export-sdk.mjs", "README.md", "README.zh-CN.md", "DELIVERY.md", "COMPATIBILITY.md", "material-library-consumer.js", "material-library-consumer.d.ts", "material-library-consumer.md"];
const examples = ["palette", "outline", "canvas-export", "material-manifest", "page-desk", "material-reader"];
const all = [...files, ...examples.flatMap(name => [`examples/${name}/plugin.json`, `examples/${name}/main.js`])];
try {
  if (!process.argv[2] || process.argv.length !== 3) throw Error("Usage: node export-sdk.mjs <new-target-dir> (parent must exist)");
  const target = path.resolve(process.argv[2]);
  if (fs.existsSync(target)) throw Error("Export target must be a new directory; refusing to mix or overwrite files");
  const content = all.map(rel => ({ rel, bytes: fs.readFileSync(path.join(here, rel)) }));
  const metadata = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
  const existingManifest = path.join(here, "MANIFEST.json");
  let sourceCommit = "unknown", sourceDirty = null;
  if (fs.existsSync(existingManifest)) {
    const previous = JSON.parse(fs.readFileSync(existingManifest, "utf8"));
    if (content.some(({ rel, bytes }) => previous.files?.[rel]?.sha256 !== sha(bytes))) throw Error("Exported SDK content no longer matches MANIFEST.json");
    ({ sourceCommit, sourceDirty } = previous);
  } else {
    try {
      sourceCommit = execFileSync("git", ["-C", here, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      sourceDirty = !!execFileSync("git", ["-C", here, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim();
    } catch { /* standalone source without git: provenance remains explicitly unknown */ }
  }
  const manifest = { formatVersion: 1, sdkVersion: metadata.version, scriptApiVersion: 1, materialConsumerVersion: 1, sourceCommit, sourceDirty, files: {} };
  fs.mkdirSync(target);
  for (const { rel, bytes } of content) {
    const destination = path.join(target, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    manifest.files[rel] = { sha256: sha(bytes), bytes: bytes.length };
  }
  fs.writeFileSync(path.join(target, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ target, sourceCommit, sourceDirty, files: all.length }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
