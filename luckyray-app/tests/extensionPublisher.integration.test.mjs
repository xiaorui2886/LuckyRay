import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

test("SDK signature verifies in native store and rejects a changed payload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lr-publisher-fixture-"));
  try {
    const key = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    const keyFile = path.join(root, "fixture-only.pem");
    fs.writeFileSync(keyFile, key);
    const packageFile = path.join(root, "unsigned.json");
    const output = path.join(root, "signed.json");
    const pkg = JSON.parse(fs.readFileSync("examples/extensions/paper-sage.lrpack.json", "utf8"));
    pkg.manifest.name = "合成插件 ✨";
    fs.writeFileSync(packageFile, JSON.stringify(pkg));
    execFileSync(process.execPath, ["plugin-sdk/sign-package.mjs", packageFile, keyFile, output]);
    const signed = JSON.parse(fs.readFileSync(output, "utf8"));
    const tampered = structuredClone(signed);
    tampered.manifest.version = "1.0.1";
    const requests = [
      { op: "install", package: signed, publisherApproved: false, expectedRevision: 0 },
      { op: "install", package: signed, publisherApproved: true, expectedRevision: 0 },
      { op: "update", package: tampered, publisherApproved: true, expectedRevision: 1 },
      { op: "list" },
    ];
    const executable = path.resolve("tests/extension-packages-native/target/debug/extension-packages-native-fixture.exe");
    const child = spawnSync(executable, [path.join(root, "store")], { input: requests.map(value => JSON.stringify(value)).join("\n") + "\n", encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const result = child.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(result[0].error, "extension-publisher-approval-required");
    assert.equal(result[1].ok.packages[0].trustedPublisher, signed.signature.publicKey);
    assert.equal(result[2].error, "extension-signature-invalid");
    assert.equal(result[3].ok.packages[0].package.manifest.version, pkg.manifest.version);
  } finally {
    const parent = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("lr-publisher-fixture-"));
    fs.rmSync(resolved, { recursive: true });
  }
});
