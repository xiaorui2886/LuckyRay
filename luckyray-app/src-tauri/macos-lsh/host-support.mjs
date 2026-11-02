// Mac-only support for the pinned shared LSH wrapper. The Rust parent admits
// these bytes and owns the inherited process group. No user account is opened.
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";

export function environment(home, key) {
  return { PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    LANG: "en_US.UTF-8", HOME: home, TMPDIR: join(home, ".tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"), DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1",
    ...(key === undefined ? {} : { DEEPSEEK_API_KEY: key }) };
}
export async function prepareHome(home) {
  for (const part of [".tmp", ".config", ".cache", ".local/share"])
    await mkdir(join(home, part), { recursive: true, mode: 0o700 });
}
export async function probeEnvironment(home, root, original) {
  await prepareHome(home);
  const result = { ...original };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) delete result[key];
  Object.assign(result, environment(home), {
    PATH: [join(root, "node"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  });
  return result;
}
function object(meta) {
  return [meta.dev, meta.ino, meta.uid, meta.gid, meta.mode, meta.size, meta.nlink, meta.mtimeNs, meta.ctimeNs].join(":");
}
export async function readProbePatch(path, expected) {
  if (!isAbsolute(path) || !Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW)
    throw new Error("macos-probe-patch-invalid");
  const parents = [];
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const meta = await lstat(current, { bigint: true });
    if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error("macos-probe-patch-invalid");
    parents.push({ path: current, object: object(meta) });
  }
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid())
        || before.mode & 0o7077n || before.size !== BigInt(Buffer.byteLength(expected))) throw new Error("macos-probe-patch-invalid");
    if (await input.readFile("utf8") !== expected) throw new Error("macos-probe-patch-invalid");
    const after = await input.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (object(before) !== object(after) || named.isSymbolicLink() || object(named) !== object(after))
      throw new Error("macos-probe-patch-invalid");
    for (const parent of parents) {
      const meta = await lstat(parent.path, { bigint: true });
      if (!meta.isDirectory() || meta.isSymbolicLink() || object(meta) !== parent.object)
        throw new Error("macos-probe-patch-invalid");
    }
  } finally { await input.close(); }
}
export async function stopDirectChild(child, waitMs) {
  // Direct-child exit cannot attest the whole group. The anchored Rust parent
  // performs the finite group sweep before admitting a replacement generation.
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    let timer;
    try { await Promise.race([new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
    finally { clearTimeout(timer); }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  return { confirmed: false, sweep: "macos-outer-group-required" };
}
