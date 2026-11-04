#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MaterialError } from "../../materials-mcp/src/transport.mjs";
import { LibraryTransport } from "./transport.mjs";
import { serve } from "./protocol.mjs";
import { LibraryTools, TOOLS } from "./library.mjs";
// The tunnel parent needs its key; the MCP child never does.
delete process.env.CONTROL_PLANE_API_KEY;
delete process.env.OPENAI_API_KEY;
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
  const transport = new LibraryTransport(config);
  if (process.argv.includes("--check")) {
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
