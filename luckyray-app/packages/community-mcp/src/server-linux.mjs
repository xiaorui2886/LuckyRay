#!/usr/bin/env node
// Linux entry point of the community web MCP package. Shipped only in the
// Linux package (build-package.py --platform linux-x86_64); the Windows
// package keeps the published server.mjs byte for byte.
//
// Two things differ from Windows and live only here:
// 1. The sealed pairing. Windows hands the plugin a DPAPI file path; Linux has
//    no such file. The desktop reads the pairing from the Secret Service and
//    hands it to this process only: on stdin for the one-shot `--check`, and
//    through the tunnel's inherited environment for the long-running server.
//    It is taken out of the environment at module load, before anything can
//    spawn, so no grandchild inherits it. Nothing is ever written to disk.
// 2. Desktop discovery. The shared materials-mcp `inventory()` is Windows-only
//    (CIM + netstat). `linuxInventory()` returns the same shape from /proc:
//    {pid, exe, created, ports}, with the same refusal codes.
import { readFile, readdir, readlink, lstat, writeFile } from "node:fs/promises";
import { resolve, isAbsolute, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MaterialError } from "../../materials-mcp/src/transport.mjs";
import { LibraryTransport, credentialForConfig } from "./transport.mjs";
import { serve } from "./protocol.mjs";
import { LibraryTools, TOOLS } from "./library.mjs";
// The tunnel parent needs its key; the MCP child never does.
delete process.env.CONTROL_PLANE_API_KEY;
delete process.env.OPENAI_API_KEY;
export const LINUX_PAIR_ENV = "LUCKYRAY_LIBRARY_PAIR";
export const LINUX_PAIR_LIMIT = 16384;
export function takeLinuxPair(env) {
  const raw = env[LINUX_PAIR_ENV];
  delete env[LINUX_PAIR_ENV];
  return typeof raw === "string" ? raw : undefined;
}
export function parseLinuxPair(raw) {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LINUX_PAIR_LIMIT)
      throw new MaterialError("authorization-unavailable");
    let pair;
    try {
      pair = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new MaterialError("authorization-unavailable");
    }
    if (!pair || typeof pair !== "object" || Array.isArray(pair))
      throw new MaterialError("authorization-unavailable");
    return pair;
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
  }
}
export async function readBoundedStdin(stream, limit = LINUX_PAIR_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    chunks.push(chunk);
    if (size > limit) break;
  }
  const all = Buffer.concat(chunks);
  for (const c of chunks) c.fill(0);
  return all;
}
let linuxPair =
  process.platform === "linux" ? takeLinuxPair(process.env) : undefined;

// ---- Desktop discovery (/proc) -------------------------------------------
// Same executable name as the Windows filter (Name='luckyray-app.exe').
export const DESKTOP_NAME = "luckyray-app";
const LOOPBACK = { tcp: "0100007F", tcp6: "0000000000000000FFFF00000100007F" };
const fail = (code) => {
  throw new MaterialError(code);
};
const normalPath = (p) =>
  typeof p === "string" && isAbsolute(p) && resolve(p) === p && !p.includes("\0");
/// Stable desktop identity, identical to the desktop's own
/// `desktop_identity::executable()`: an AppImage is named by $APPIMAGE (its
/// /tmp/.mount_* path changes every launch), but only while the executable
/// really runs inside that image's $APPDIR; otherwise the executable path.
/// A mount path is never an identity.
export async function stableIdentity(exe, env, stat = lstat) {
  if (!normalPath(exe)) return undefined;
  if (env.APPIMAGE !== undefined) {
    const image = env.APPIMAGE, dir = env.APPDIR;
    if (!normalPath(image) || !normalPath(dir) || dir === "/") return undefined;
    if (!exe.startsWith(dir + "/")) return undefined;
    try {
      if (!(await stat(image)).isFile()) return undefined;
    } catch {
      return undefined;
    }
    return image;
  }
  if (exe.split("/").some((part) => part.startsWith(".mount_"))) return undefined;
  return exe;
}
/// `inode -> ports` for sockets listening on 127.0.0.1 (IPv4, or IPv4-mapped
/// in tcp6), the Linux form of netstat's `TCP 127.0.0.1:N 0.0.0.0:0 LISTENING`.
export function loopbackListeners(text, family, into = new Map()) {
  const local = LOOPBACK[family];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [addr, portHex] = f[1].split(":");
    const [remote, remotePort] = f[2].split(":");
    if (addr?.toUpperCase() !== local || !/^0+$/.test(remote || "") || !/^0+$/.test(remotePort || ""))
      continue;
    if (!/^[0-9A-Fa-f]{4}$/.test(portHex || "") || !/^[1-9][0-9]*$/.test(f[9])) continue;
    const port = parseInt(portHex, 16);
    if (port <= 0 || port > 65535) continue;
    if (!into.has(f[9])) into.set(f[9], new Set());
    into.get(f[9]).add(port);
  }
  return into;
}
const environOf = (raw) => {
  const env = {};
  for (const item of raw.toString("utf8").split("\0")) {
    const at = item.indexOf("=");
    if (at > 0 && (item.startsWith("APPIMAGE=") || item.startsWith("APPDIR=")))
      env[item.slice(0, at)] = item.slice(at + 1);
  }
  return env;
};
const startTime = (stat) => {
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // Field 22 (starttime, clock ticks since boot); f[0] is field 3.
  return /^[0-9]+$/.test(f[19] || "") ? f[19] : undefined;
};
export async function linuxInventory(deps = {}) {
  if ((deps.platform || process.platform) !== "linux") fail("platform-unsupported");
  const root = deps.root || "/proc";
  try {
    const listeners = new Map();
    // tcp is required; tcp6 is absent when IPv6 is disabled.
    loopbackListeners(await readFile(join(root, "net/tcp"), "utf8"), "tcp", listeners);
    try {
      loopbackListeners(await readFile(join(root, "net/tcp6"), "utf8"), "tcp6", listeners);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const items = [];
    for (const name of await readdir(root)) {
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      const pid = Number(name);
      if (!Number.isSafeInteger(pid)) continue;
      const dir = join(root, name);
      // Other users' processes (unreadable exe) are skipped, as Windows
      // reports them with a null ExecutablePath that never matches. A process
      // that exits mid-scan is simply gone.
      try {
        const link = await readlink(join(dir, "exe"));
        if (basename(link) !== DESKTOP_NAME) continue;
        const exe = await stableIdentity(
          link,
          environOf(await readFile(join(dir, "environ"))),
          deps.lstat || lstat,
        );
        if (!exe) continue;
        const created = startTime(await readFile(join(dir, "stat"), "utf8"));
        if (!created) continue;
        const ports = new Set();
        for (const fd of await readdir(join(dir, "fd"))) {
          let target;
          try {
            target = await readlink(join(dir, "fd", fd));
          } catch {
            continue;
          }
          const m = /^socket:\[([0-9]+)\]$/.exec(target);
          for (const port of (m && listeners.get(m[1])) || []) ports.add(port);
        }
        items.push({ pid, exe, created, ports: [...ports] });
      } catch {
        continue;
      }
    }
    return items;
  } catch {
    fail("instance-inventory-unavailable");
  }
}

async function main() {
  if (process.platform !== "linux") throw new MaterialError("platform-unsupported");
  const index = process.argv.indexOf("--config");
  const path = process.argv[index + 1];
  if (index < 0 || !path || !isAbsolute(path))
    throw new MaterialError("configuration-required");
  let config;
  try {
    config = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw new MaterialError("configuration-invalid");
  }
  if (
    config.authKind !== "library-mcp-scoped-v1" ||
    config.profileProofVersion !== 3
  )
    throw new MaterialError("library-grant-required");
  const check = process.argv.includes("--check");
  const pair = parseLinuxPair(
    check ? await readBoundedStdin(process.stdin) : linuxPair,
  );
  linuxPair = undefined;
  const transport = new LibraryTransport(config, {
    credential: async (c) => credentialForConfig(c, pair),
    inventory: () => linuxInventory(),
  });
  if (check) {
    process.stdout.write(JSON.stringify(await transport.status()) + "\n");
    return;
  }
  const seenIndex = process.argv.indexOf("--activity-file");
  const activity = seenIndex < 0 ? null : process.argv[seenIndex + 1];
  if (activity && !isAbsolute(activity))
    throw new MaterialError("configuration-invalid");
  await serve(
    new LibraryTools(transport, async () => {
      // Timestamp only. No prompt, URL, filename, credential or note content in logs.
      if (activity)
        await writeFile(activity, JSON.stringify({ at: Date.now() }), {
          mode: 0o600,
        }).catch(() => {});
    }),
    process.stdin,
    process.stdout,
    {
      tools: TOOLS,
      serverInfo: {
        name: "luckyray-library-web-mcp",
        version: "0.1.3",
      },
    },
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    process.stderr.write(
      (e instanceof MaterialError ? e.code : "startup-failed") + "\n",
    );
    process.exitCode = 1;
  });
