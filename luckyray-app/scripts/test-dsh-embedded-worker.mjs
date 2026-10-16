// Maintainer engineering diagnostic ONLY. Not embedded in the native client.
// Reuses previously verified raw inputs in a NEW identity, never a machine
// pnpm store/node_modules. Does not claim native acquisition or authorization.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

const [out, inputRecord, tarCache, bootstrap] = process.argv.slice(2);
if (process.argv.length !== 6 || ![out, inputRecord, tarCache, bootstrap].every((path) => isAbsolute(path ?? ""))) throw new Error("explicit-new-engineering-paths-required");
await mkdir(out); // Existing directory is never a target.
const workspace = join(out, `.assembly-${randomBytes(16).toString("hex")}`);
const stageName = `.stage-${randomBytes(16).toString("hex")}`;
const bundle = join(workspace, "worker");
await mkdir(workspace); await mkdir(bundle); await mkdir(join(bundle, "host")); await mkdir(join(bundle, "records"));
await mkdir(join(workspace, "node")); await mkdir(join(workspace, "tarballs"));
for (const file of ["dsh-frozen-assembly-worker.mjs", "dsh-supply-chain.mjs", "dsh-frozen-assembly-description.mjs",
  "dsh-frozen-inputs.mjs", "dsh-npm-tar-policy.mjs", "dsh-frozen-cache-relay.mjs", "dsh-assembly-network-fence.mjs"])
  await copyFile(resolve("scripts", file), join(bundle, file));
await copyFile(resolve("dsh-host/runtime-authority.json"), join(bundle, "runtime-authority.json"));
for (const file of ["package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
  await copyFile(resolve("dsh-host", file), join(bundle, "host", file));
for (const file of ["dependency-audit.json", "sbom.cdx.json", "launch-manifest.json", "runtime-manifest.json", "THIRD-PARTY-NOTICES.txt"])
  await copyFile(resolve("dsh-host/records", file), join(bundle, "records", file));
for (const file of ["node.exe", "LICENSE"])
  await copyFile(join(bootstrap, "bootstrap-node/node-v22.19.0-win-x64", file), join(workspace, "node", file));
await copyFile(join(bootstrap, "cache/inputs/pnpm-11.7.0.tgz"), join(workspace, "pnpm.tgz"));
const bytes = await readFile(inputRecord);
const hash = createHash("sha256").update(bytes).digest("hex");
await writeFile(join(workspace, "description.json"), bytes, { flag: "wx" });
for (const input of JSON.parse(bytes).packages) {
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) throw new Error("invalid-cached-input-name");
  await copyFile(join(tarCache, input.sha256 + ".tgz"), join(workspace, "tarballs", input.sha256 + ".tgz"));
}
const policy = join(workspace, "native-policy-assemble"); await mkdir(policy);
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
  PATH: join(workspace, "node"), CI: "true" };
for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PNPM_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) env[name] = policy;
const child = spawn(join(workspace, "node/node.exe"), ["dsh-frozen-assembly-worker.mjs", "assemble", stageName, hash, String(bytes.length)],
  { cwd: bundle, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = 0;
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  output += chunk.length;
  if (output > 2 * 1024 * 1024) child.kill();
  else process.stdout.write(chunk); // Worker output is bounded fixed shapes, not pnpm stderr.
});
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code === 0 && output <= 2 * 1024 * 1024 ? 0 : 1; });
