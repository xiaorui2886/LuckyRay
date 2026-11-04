#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MaterialError } from "../../materials-mcp/src/transport.mjs";
import { LibraryTransport, credentialForConfig } from "./transport.mjs";
import { serve } from "./protocol.mjs";
import { LibraryTools, TOOLS } from "./library.mjs";
// The tunnel parent needs its key; the MCP child never does.
delete process.env.CONTROL_PLANE_API_KEY;
delete process.env.OPENAI_API_KEY;
// Linux has no DPAPI file to point at. The desktop hands the sealed pairing
// (read from the Secret Service) to this process only: on stdin for the
// one-shot `--check`, and through the tunnel's inherited environment for the
// long-running server. Take it out of the environment before anything can
// spawn, so no grandchild inherits it. Nothing is ever written to disk.
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
async function main() {
  // Both desktop preflight and tunnel child use the same known Windows helpers,
  // independent of the launching Agent's inherited PATH.
  if (process.platform === "win32") {
    const root = process.env.SystemRoot;
    if (!root || !isAbsolute(root))
      throw new MaterialError("system-runtime-unavailable");
    process.env.PATH = [
      join(root, "System32"),
      join(root, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";");
  }

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
  let deps = {};
  if (process.platform === "linux") {
    const pair = parseLinuxPair(
      check ? await readBoundedStdin(process.stdin) : linuxPair,
    );
    linuxPair = undefined;
    deps = { credential: async (c) => credentialForConfig(c, pair) };
  }
  const transport = new LibraryTransport(config, deps);
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
