import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { auditNpmTarball } from "./dsh-npm-tar-policy.mjs";

function entry(name, content = "x", { type = "0", link = "", mode = 0o644 } = {}) {
  const body = Buffer.from(content), header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write(type, 156); header.write(link, 157, 100); header.write("ustar\0", 257);
  header.fill(32, 148, 156);
  header.write(header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function pax(values) {
  return Object.entries(values).map(([key, value]) => {
    const tail = ` ${key}=${value}\n`;
    let size = Buffer.byteLength(tail) + 1;
    while (size !== Buffer.byteLength(tail) + String(size).length) size = Buffer.byteLength(tail) + String(size).length;
    return `${size}${tail}`;
  }).join("");
}
function archive(...entries) { return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])); }
const reject = (...entries) => assert.throws(() => auditNpmTarball(archive(...entries)), /npm-tar-policy-invalid/);

test("ordinary npm and legacy @types roots are link-free", () => {
  assert.equal(auditNpmTarball(archive(entry("package/index.js"))).fileCount, 1);
  assert.equal(auditNpmTarball(archive(entry("node/index.d.ts"))).fileCount, 1);
});
test("bounded legacy PAX builder data is inert; exact size and type remain mandatory", () => {
  const metadata = { path: "package/index.js", size: "1", "NODETAR.type": "File", "NODETAR.follow": "false",
    "SCHILY.nlink": "1", "NODETAR.package.scripts.test": "this must NEVER execute", "SCHILY.ino": "37102453" };
  assert.equal(auditNpmTarball(archive(entry("PaxHeader/index.js", pax(metadata), { type: "x" }), entry("package/index.js"))).paxCount, 1);
  for (const changed of [{ size: "2" }, { size: "9007199254740992" }, { "NODETAR.type": "Directory" },
    { "NODETAR.follow": "true" }, { "SCHILY.nlink": "2" }, { linkpath: "../../escape" }, { command: "execute" }]) {
    reject(entry("PaxHeader/index.js", pax({ ...metadata, ...changed }), { type: "x" }), entry("package/index.js"));
  }
});
test("dangling/consecutive/global PAX and duplicate keys are rejected", () => {
  const extension = entry("PaxHeader/file", pax({ path: "package/index.js" }), { type: "x" });
  reject(extension); reject(extension, extension, entry("package/index.js"));
  reject(entry("PaxHeader/file", pax({ path: "package/index.js" }), { type: "g" }), entry("package/index.js"));
  reject(entry("PaxHeader/file", pax({ path: "package/index.js" }) + pax({ path: "package/other.js" }), { type: "x" }), entry("package/index.js"));
});
test("Windows traversal, reserved names, alternate streams and case collisions are rejected", () => {
  for (const name of ["../escape", "package/../escape", "/package/file", "package/C:stream", "package/CON.txt",
    "package/file.", "package/a\\b", "package//file", "package/\u0065\u0301", "package/\u0001file"]) reject(entry(name));
  reject(entry("package/F.js"), entry("package/f.js"));
  reject(entry("package/file"), entry("different/file"));
});
test("links/devices and file/directory overlap cannot reach pnpm", () => {
  for (const type of ["1", "2", "3", "4", "6", "L", "K"]) reject(entry("package/file", "", { type, link: "package/target" }));
  reject(entry("package/file"), entry("package/file/child"));
  reject(entry("package/file/child"), entry("package/file"));
});
test("only exact same-case/mode/byte canonical aliases are tolerated", () => {
  assert.equal(auditNpmTarball(archive(entry("package/./file.js"), entry("package/file.js"))).identicalAliases, 1);
  reject(entry("package/./file.js"), entry("package/file.js", "changed"));
  reject(entry("package/./file.js"), entry("package/file.js", "x", { mode: 0o755 }));
});
test("checksum, padding, truncated streams and budgets are enforced", () => {
  const changed = entry("package/file"); changed[0] ^= 1;
  reject(changed);
  const padding = entry("package/file"); padding[513] = 1;
  reject(padding);
  assert.throws(() => auditNpmTarball(gzipSync(entry("package/file"))), /npm-tar-policy-invalid/);
  assert.throws(() => auditNpmTarball(archive(entry("package/file", "xx")), { maxBytes: 1 }), /npm-tar-policy-invalid/);
  assert.throws(() => auditNpmTarball(archive(entry("package/one"), entry("package/two")), { maxFiles: 1 }), /npm-tar-policy-invalid/);
});
