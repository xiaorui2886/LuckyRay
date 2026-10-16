// Maintainer-only diagnosis on a retained synthetic failed workspace. Never
// embedded or used to authorize an update. Outputs error tokens, not raw logs.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { workerPaths } from "./dsh-frozen-assembly-worker.mjs";
const [workspace, stage] = process.argv.slice(2);
if (process.argv.length !== 4) throw new Error("diagnostic-arguments-invalid");
workerPaths("assemble", workspace, stage, "0".repeat(64), "1");
const policy = join(workspace, "engineering-offline-diagnostic-policy");
await mkdir(policy); // New only. No user/global store or config.
const bundle = join(workspace, "worker");
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
  PATH: join(workspace, "node"), CI: "true", LUCKYRAY_FROZEN_CACHE_PORT: "" };
for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PNPM_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) env[key] = policy;
const child = spawn(join(workspace, "node/node.exe"), ["--import", pathToFileURL(join(bundle, "dsh-assembly-network-fence.mjs")).href,
  join(bundle, "dsh-supply-chain.mjs"), "run-pnpm", "--authority", join(bundle, "runtime-authority.json"), "--pnpm-root", join(workspace, "pnpm"), "--",
  "install", "--fetch-retries=0", "--node-linker=hoisted", "--package-import-method=copy", "--strict-peer-dependencies=true",
  "--registry=http://127.0.0.1:9/", "--offline", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--prod", "--verify-store-integrity=true",
  "--cache-dir", join(workspace, "metadata-cache"), "--store-dir", join(workspace, "store")],
  { cwd: join(stage, "host"), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "", bytes = 0;
const deadline = setTimeout(() => child.kill(), 90000);
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > 8 * 1024 * 1024) child.kill();
  else output += chunk.toString("utf8");
});
child.once("close", (code) => {
  clearTimeout(deadline);
  const tokens = [...new Set(output.match(/\bERR_PNPM_[A-Z_]{1,80}\b|\b(?:ENAMETOOLONG|ENOENT|EPERM|EACCES|ENOTDIR|EEXIST)\b|\bassembly-(?:network|dns)-denied\b|\bdsh-[a-z-]{1,80}\b/gu) ?? [])];
  console.log(JSON.stringify({ outcome: "ENGINEERING_OFFLINE_ERROR_TOKENS", code, bytes, tokens }));
  process.exitCode = code === 0 ? 0 : 1;
});
