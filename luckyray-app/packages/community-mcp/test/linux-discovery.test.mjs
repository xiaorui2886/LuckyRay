// T42c: Linux desktop discovery (/proc) and the end-to-end `--check` against a
// synthetic desktop. Synthetic credentials and processes only; nothing real.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_NAME,
  linuxInventory,
  loopbackListeners,
  stableIdentity,
} from "../src/server-linux.mjs";
import { selectTarget } from "../../materials-mcp/src/transport.mjs";

const linux = { skip: process.platform !== "linux" };
const SERVER = fileURLToPath(new URL("../src/server-linux.mjs", import.meta.url));
const SYNTHETIC = "7".repeat(64);
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row = (local, remote, st, inode) =>
  `   0: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;

test("non-Linux discovery refuses like the Windows inventory does elsewhere", async () => {
  await assert.rejects(linuxInventory({ platform: "darwin" }), { code: "platform-unsupported" });
});

test("only 127.0.0.1 listeners count (IPv4 and IPv4-mapped tcp6)", () => {
  const v4 = HEADER +
    row("0100007F:921A", "00000000:0000", "0A", "111") + // 127.0.0.1:37402 LISTEN
    row("00000000:921B", "00000000:0000", "0A", "112") + // 0.0.0.0 LISTEN
    row("0100007F:921C", "0100007F:D431", "01", "113") + // established
    row("0100007F:921D", "00000000:0000", "0A", "0");    // no inode
  const v6 = HEADER +
    row("0000000000000000FFFF00000100007F:921E", "00000000000000000000000000000000:0000", "0A", "114") +
    row("00000000000000000000000001000000:921F", "00000000000000000000000000000000:0000", "0A", "115"); // ::1
  const map = loopbackListeners(v6, "tcp6", loopbackListeners(v4, "tcp"));
  assert.deepEqual([...map].map(([k, v]) => [k, [...v]]), [["111", [0x921a]], ["114", [0x921e]]]);
});

test("identity: $APPIMAGE only while the exe runs inside $APPDIR; never a mount path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lr-ident-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const image = join(dir, "LuckyRay_1.9.9_amd64.AppImage");
  writeFileSync(image, "synthetic");
  const mount = join(dir, ".mount_Ab12Cd");
  const inner = join(mount, "usr/bin", DESKTOP_NAME);
  assert.equal(await stableIdentity(inner, { APPIMAGE: image, APPDIR: mount }), image);
  assert.equal(await stableIdentity("/usr/bin/luckyray-app", {}), "/usr/bin/luckyray-app");
  for (const [exe, env] of [
    [inner, {}], // mount path without the AppImage variables
    [inner, { APPIMAGE: image }], // no APPDIR
    ["/usr/bin/luckyray-app", { APPIMAGE: image, APPDIR: mount }], // not inside APPDIR
    [inner, { APPIMAGE: join(dir, "missing.AppImage"), APPDIR: mount }],
    [inner, { APPIMAGE: "relative.AppImage", APPDIR: mount }],
    [inner, { APPIMAGE: image, APPDIR: "/" }],
    [inner, { APPIMAGE: dir + "/x/../LuckyRay_1.9.9_amd64.AppImage", APPDIR: mount }],
    ["relative/luckyray-app", {}],
  ])
    assert.equal(await stableIdentity(exe, env), undefined, JSON.stringify([exe, env]));
  symlinkSync(image, join(dir, "link.AppImage"));
  assert.equal(await stableIdentity(inner, { APPIMAGE: join(dir, "link.AppImage"), APPDIR: mount }), undefined);
});

test("synthetic /proc: fields, socket ownership and skipped processes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "lr-proc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "net"));
  writeFileSync(join(root, "net/tcp"), HEADER +
    row("0100007F:922A", "00000000:0000", "0A", "501") +
    row("0100007F:922B", "00000000:0000", "0A", "502") +
    row("0100007F:922C", "00000000:0000", "0A", "503"));
  const proc = (pid, exe, { env = "", sockets = [], stat = true } = {}) => {
    const d = join(root, String(pid));
    mkdirSync(join(d, "fd"), { recursive: true });
    if (exe) symlinkSync(exe, join(d, "exe"));
    writeFileSync(join(d, "environ"), env);
    if (stat) writeFileSync(join(d, "stat"), `${pid} (luckyray app) S 1 ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 0 0`);
    symlinkSync("/dev/null", join(d, "fd/0"));
    sockets.forEach((s, i) => symlinkSync(`socket:[${s}]`, join(d, "fd", String(10 + i))));
  };
  proc(101, "/opt/LuckyRay/luckyray-app", { sockets: [501, 999] });
  proc(102, "/usr/bin/node", { sockets: [502] }); // other name
  proc(103, "/tmp/.mount_Zz/usr/bin/luckyray-app", { sockets: [503] }); // mount path, no APPIMAGE
  proc(104, null); // unreadable exe (other user)
  proc(105, "/opt/LuckyRay/luckyray-app", { stat: false }); // exited mid-scan
  mkdirSync(join(root, "self"));
  const items = await linuxInventory({ root, platform: "linux" });
  assert.deepEqual(items, [{ pid: 101, exe: "/opt/LuckyRay/luckyray-app", created: "98765", ports: [0x922a] }]);
  assert.deepEqual(Object.keys(items[0]), ["pid", "exe", "created", "ports"]);
  await assert.rejects(linuxInventory({ root: join(root, "missing"), platform: "linux" }), { code: "instance-inventory-unavailable" });
});

test("real /proc: this process is not mistaken for the desktop", linux, async () => {
  const items = await linuxInventory();
  assert.ok(Array.isArray(items));
  assert.ok(!items.some((i) => i.pid === process.pid));
});

// ---- End to end against a synthetic desktop -------------------------------
const FAKE_DESKTOP = `
import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const listen = (port) => new Promise((ok, no) => {
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { clientNonce } = JSON.parse(body || "{}");
      const serverNonce = randomBytes(32).toString("hex");
      const port = s.address().port;
      const proof = createHmac("sha256", Buffer.from(cfg.credential, "hex")).update([
        "luckyray-local-transport-credential-v1", "library-mcp-proof", "v3", cfg.clientId,
        cfg.libraryId, cfg.vaultId, cfg.expiresAt, port, clientNonce, serverNonce,
        cfg.profileRoot, cfg.identity].join("\\0")).digest("hex");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, data: { protocolVersion: 3, clientId: cfg.clientId,
        libraryId: cfg.libraryId, vaultId: cfg.vaultId, expiresAt: cfg.expiresAt, port,
        clientNonce, serverNonce, profileRoot: cfg.profileRoot, desktopExe: cfg.identity, proof } }));
    });
  });
  s.once("error", no);
  s.listen(port, "127.0.0.1", () => ok(port));
});
for (let p = 37418; p <= 37468; p++) {
  try { process.stdout.write(await listen(p) + "\\n"); break; } catch {}
}
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function copyExecutable(from, to) {
  mkdirSync(join(to, ".."), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, 0o755);
}
async function startDesktop(exe, script, cfgPath, env) {
  let child;
  // A fresh copy can briefly be busy (ETXTBSY) while the write fd drains.
  for (let i = 0; ; i++) {
    child = spawn(exe, [script, cfgPath], { env, stdio: ["ignore", "pipe", "inherit"] });
    const [ok] = await Promise.race([
      once(child, "spawn").then(() => [true]),
      once(child, "error").then(([e]) => { if (e.code !== "ETXTBSY" || i > 50) throw e; return [false]; }),
    ]);
    if (ok) break;
    await sleep(100);
  }
  let out = "";
  for await (const chunk of child.stdout) {
    out += chunk;
    if (out.includes("\n")) break;
  }
  const port = Number(out.trim());
  assert.ok(port >= 37418 && port <= 37468, "fake desktop listens in the transport range");
  return { child, port };
}
function check(cfgPath, input) {
  return new Promise((ok) => {
    const c = execFile(process.execPath, [SERVER, "--config", cfgPath, "--check"],
      { env: { PATH: "/usr/bin:/bin" }, timeout: 30000 }, (err, stdout, stderr) =>
        ok(err ? { error: stderr.trim() } : JSON.parse(stdout)));
    c.stdin.end(input);
  });
}
const SCOPE = ["materials.search", "materials.inspect", "folders.read", "materials.import",
  "knowledge.search", "knowledge.read", "knowledge.import-markdown"];
async function scenario(t, { appimage, pairWith }) {
  const dir = mkdtempSync(join(tmpdir(), "lr-e2e-"));
  const children = [];
  t.after(() => {
    for (const c of children) c.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  const image = join(dir, "LuckyRay_1.9.9_amd64.AppImage");
  const mount = join(dir, ".mount_T42cAb");
  const exe = appimage ? join(mount, "usr/bin", DESKTOP_NAME) : join(dir, "opt", DESKTOP_NAME);
  copyExecutable(process.execPath, exe);
  writeFileSync(image, "synthetic AppImage carrier");
  const identity = appimage ? image : exe;
  const script = join(dir, "fake-desktop.mjs");
  writeFileSync(script, FAKE_DESKTOP);
  const base = {
    version: 1, authKind: "library-mcp-scoped-v1", profileProofVersion: 3,
    profileRoot: join(dir, "profile"), clientId: randomBytes(32).toString("hex"),
    clientName: "Web", libraryId: "library-a", vaultId: "vault-a", expiresAt: 2000000000, scope: SCOPE,
  };
  const desktopCfg = join(dir, "desktop.json");
  writeFileSync(desktopCfg, JSON.stringify({ ...base, credential: SYNTHETIC, identity }));
  const env = { PATH: "/usr/bin:/bin", ...(appimage ? { APPIMAGE: image, APPDIR: mount } : {}) };
  const { child, port } = await startDesktop(exe, script, desktopCfg, env);
  children.push(child);
  const desktopExe = pairWith === "mount" ? exe : identity;
  const connection = { ...base, desktopExe, baseUrl: `http://127.0.0.1:${port}`,
    credentialFile: join(dir, "private/credential.keyring") };
  const cfgPath = join(dir, "connection.json");
  writeFileSync(cfgPath, JSON.stringify(connection));
  const { credentialFile, ...sealed } = connection;
  return { dir, exe, script, desktopCfg, env, cfgPath, children, port,
    input: JSON.stringify({ ...sealed, credential: SYNTHETIC }) };
}

test("e2e --check: installed (deb-style) desktop is found and proven", linux, async (t) => {
  const s = await scenario(t, { appimage: false });
  const out = await check(s.cfgPath, s.input);
  assert.equal(out.ready, true, JSON.stringify(out));
  assert.equal(out.pid, s.children[0].pid);
  assert.equal(out.port, s.port);
  assert.equal(out.protocolVersion, 3);
  assert.deepEqual(readdirSync(join(s.dir)).filter((n) => n === "private"), [], "no credential file written");
});

test("e2e --check: AppImage desktop pairs by $APPIMAGE, not by its mount path", linux, async (t) => {
  const s = await scenario(t, { appimage: true });
  const out = await check(s.cfgPath, s.input);
  assert.equal(out.ready, true, JSON.stringify(out));
  assert.equal(out.pid, s.children[0].pid);
});

test("e2e --check: a pairing bound to the /tmp/.mount_* path never matches", linux, async (t) => {
  const s = await scenario(t, { appimage: true, pairWith: "mount" });
  assert.deepEqual(await check(s.cfgPath, s.input), { error: "target-not-running" });
});

test("e2e --check: wrong credential and a second same-identity desktop are refused", linux, async (t) => {
  const s = await scenario(t, { appimage: false });
  const wrong = JSON.parse(s.input);
  wrong.credential = "8".repeat(64);
  assert.deepEqual(await check(s.cfgPath, JSON.stringify(wrong)), { error: "wrong-instance" });
  const second = await startDesktop(s.exe, s.script, s.desktopCfg, s.env);
  s.children.push(second.child);
  assert.deepEqual(await check(s.cfgPath, s.input), { error: "target-ambiguous" });
});

test("selectTarget over Linux items is the shared Windows rule", () => {
  const items = [{ pid: 1, exe: "/a/luckyray-app", created: "1", ports: [] }];
  assert.equal(selectTarget({ desktopExe: "/a/luckyray-app" }, items).pid, 1);
  assert.throws(() => selectTarget({ desktopExe: "/b/luckyray-app" }, items), { code: "target-not-running" });
});
