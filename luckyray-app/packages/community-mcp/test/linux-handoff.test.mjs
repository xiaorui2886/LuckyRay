// T42b: Linux pairing handoff without a file. Synthetic credentials only.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  LINUX_PAIR_ENV,
  LINUX_PAIR_LIMIT,
  takeLinuxPair,
  parseLinuxPair,
  readBoundedStdin,
} from "../src/server.mjs";
import { credentialForConfig, validateConfig } from "../src/transport.mjs";

const SYNTHETIC = "5".repeat(64);
const config = validateConfig({
  version: 1,
  authKind: "library-mcp-scoped-v1",
  profileProofVersion: 3,
  desktopExe: resolve("/fixture/luckyray-app"),
  profileRoot: resolve("/fixture/profile"),
  credentialFile: resolve("/fixture/private/credential.keyring"),
  baseUrl: "http://127.0.0.1:37419",
  clientId: "a".repeat(64),
  clientName: "Web",
  libraryId: "library-a",
  vaultId: "vault-a",
  expiresAt: 2000000000,
  scope: [
    "materials.search",
    "materials.inspect",
    "folders.read",
    "materials.import",
    "knowledge.search",
    "knowledge.read",
    "knowledge.import-markdown",
  ],
});
const sealed = () => {
  const { credentialFile, ...rest } = config;
  return { ...rest, scope: [...config.scope], credential: SYNTHETIC };
};

test("the env handoff is taken exactly once and removed", () => {
  const env = { [LINUX_PAIR_ENV]: "{}", OTHER: "x" };
  assert.equal(takeLinuxPair(env), "{}");
  assert.equal(LINUX_PAIR_ENV in env, false);
  assert.equal(takeLinuxPair(env), undefined);
  assert.equal(env.OTHER, "x");
});

test("the handoff name is outside every tunnel-client log-export prefix", () => {
  for (const p of ["ADMIN_UI_", "CLOUDFLARED_", "CONTROL_PLANE_", "HARPOON_", "LOG_", "MCP_", "OPENAI_TUNNEL_", "TUNNEL_"])
    assert.equal(LINUX_PAIR_ENV.startsWith(p), false, p);
});

test("parse wipes the buffer and binds like the Windows helper output", () => {
  const buf = Buffer.from(JSON.stringify(sealed()));
  const pair = parseLinuxPair(buf);
  assert.ok(buf.every((b) => b === 0), "input bytes wiped");
  assert.equal(credentialForConfig(config, pair), SYNTHETIC);
  assert.throws(
    () => credentialForConfig(config, { ...pair, libraryId: "library-b" }),
    { code: "pairing-binding-mismatch" },
  );
});

test("missing, empty, oversized or malformed handoff is refused", () => {
  for (const bad of [undefined, "", Buffer.alloc(0), "x".repeat(LINUX_PAIR_LIMIT + 1), "not json", "[]", "null", "7"]) {
    assert.throws(() => parseLinuxPair(bad), { code: "authorization-unavailable" });
  }
  assert.throws(
    () => credentialForConfig(config, parseLinuxPair(JSON.stringify({ ...sealed(), credential: "short" }))),
    { code: "credential-unusable" },
  );
});

test("stdin read is bounded and wipes its chunks", async () => {
  const a = Buffer.from("ab"), b = Buffer.from("cd");
  const all = await readBoundedStdin(Readable.from([a, b]));
  assert.equal(all.toString(), "abcd");
  assert.ok(a.every((x) => x === 0) && b.every((x) => x === 0));
  const big = await readBoundedStdin(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 5);
  assert.ok(big.length > 5 && big.length <= 20, "stops once past the limit");
});

test("on Linux the server module strips the handoff before any child can inherit it, and writes nothing", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-handoff-"));
  try {
    const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
    const probe = `
      await import(${JSON.stringify(server)});
      const { execFileSync } = await import("node:child_process");
      const child = execFileSync("/usr/bin/env", { encoding: "utf8" });
      process.stdout.write(JSON.stringify({
        self: ${JSON.stringify(LINUX_PAIR_ENV)} in process.env,
        child: child.includes(${JSON.stringify(LINUX_PAIR_ENV)}),
        leaked: child.includes(${JSON.stringify(SYNTHETIC)}),
      }));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", [LINUX_PAIR_ENV]: JSON.stringify(sealed()) },
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(out), { self: false, child: false, leaked: false });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on Linux --check takes the pairing from stdin only", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-check-"));
  try {
    const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
    const cfg = join(dir, "connection.json");
    writeFileSync(cfg, JSON.stringify({ ...config, scope: [...config.scope] }));
    const run = (input, env = {}) => {
      try {
        execFileSync(process.execPath, [server, "--config", cfg, "--check"], {
          cwd: dir, input, env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        });
        return "ok";
      } catch (e) {
        return e.stderr.trim();
      }
    };
    // No stdin: refused before any discovery. The env var is not a --check channel.
    assert.equal(run(""), "authorization-unavailable");
    assert.equal(run("", { [LINUX_PAIR_ENV]: JSON.stringify(sealed()) }), "authorization-unavailable");
    // With the sealed pairing on stdin it gets past the handoff (and then fails
    // on the absent synthetic desktop, which is a different, later error).
    const later = run(JSON.stringify(sealed()));
    assert.notEqual(later, "authorization-unavailable");
    assert.notEqual(later, "ok");
    assert.deepEqual(readdirSync(dir).sort(), ["connection.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
