import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSecureDirectory } from "./dsh-production-maintenance.mjs";

// Public-only parser/preflight fixtures. NO initializer, private directory,
// production key, genuine-candidate signature, network or real user profile.
// A missing initializer in these fixtures additionally prevents secret prompts
// if CheckOnly accidentally stops being honored. Small fixtures are retained.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lsh-public-preflight-"));
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "empty-hooks"));
  const entry = join(root, "scripts", "Start-LshReviewedSigning.ps1");
  writeFileSync(entry, readFileSync(fileURLToPath(new URL("./Start-LshReviewedSigning.ps1", import.meta.url)), "utf8").replace("xiaorui2886/luckyray-app/issues/195", "example/luckyray/issues/195"));
  const git = (...args) => execFileSync("git.exe", ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, ...args], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet"); git("add", "scripts");
  git("-c", "user.name=Local public preflight test", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Public parser fixture only");
  const payload = Buffer.from("{}\n"), candidate = join(root, "candidate.public-test.json"), descriptor = join(root, "descriptor.public-test.json"), contract = join(root, "contract.public-test.json");
  for (const path of [candidate, descriptor, contract]) writeFileSync(path, payload);
  const request = { schema: 1, state: "approved-final-first-signing", centralReview: "https://github.com/example/luckyray/issues/195#issuecomment-123",
    sourceHead: git("rev-parse", "HEAD").trim(), candidatePath: candidate, descriptorPath: descriptor, contractPath: contract,
    approvedPayloadSha256: createHash("sha256").update(payload).digest("hex"), envelopeOutput: join(root, "never-created-signed-output.json") };
  const requestFile = join(root, "public-only-test-request.json");
  const check = value => {
    writeFileSync(requestFile, JSON.stringify(value));
    return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", entry, "-RequestPath", requestFile, "-CheckOnly"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  };
  return { root, entry, request, check };
}

test("one-entry public CheckOnly succeeds without initializer, key, prompt or signed output (fixture only)", { skip: process.platform !== "win32" }, () => {
  const f = fixture();
  assert.equal(f.check(f.request).trim(), "REVIEWED_PUBLIC_REQUEST_PREFLIGHT_PASS_NO_PRIVATE_OPERATION");
  assert.ok(!readdirSync(f.root).some(name => /encrypted|receipt|signed-output/u.test(name)));
});

test("one-entry rejects pending, stale source, payload mutation, missing inputs and existing output before private operation", { skip: process.platform !== "win32" }, () => {
  const f = fixture();
  for (const [changed, reason] of [[{ ...f.request, state: "waiting-final-combined-review" }, "Final combined candidate review is pending"],
    [{ ...f.request, sourceHead: "0".repeat(40) }, "Reviewed source HEAD differs"],
    [{ ...f.request, approvedPayloadSha256: "0".repeat(64) }, "Reviewed payload bytes differ"],
    [{ ...f.request, descriptorPath: join(f.root, "missing.json") }, "Reviewed public input is missing"],
    [{ ...f.request, extraPrivateField: "rejected" }, "Final combined candidate review is pending"],
    [{ ...f.request, centralReview: "https://github.com/other/repo/issues/195#issuecomment-123" }, "Missing exact central review"],
    [{ ...f.request, envelopeOutput: f.request.candidatePath }, "Signed output already exists"]]) {
    assert.throws(() => f.check(changed), error => String(error.stderr).includes(reason));
  }
  writeFileSync(f.entry, readFileSync(f.entry, "utf8") + "\n# Changed fixture source\n");
  assert.throws(() => f.check(f.request), error => String(error.stderr).includes("Reviewed signing/host source has changed"));
  assert.ok(!readdirSync(f.root).some(name => /encrypted|receipt|signed-output/u.test(name)));
});

test("actual Node-to-WindowsPowerShell ACL guard works without module autoload (empty non-secret directory only)", { skip: !process.env.LSH_EMPTY_ACL_SELFTEST || process.platform !== "win32" }, () => {
  const path = process.env.LSH_EMPTY_ACL_SELFTEST;
  assert.equal(readdirSync(path).length, 0, "must not inspect a real production storage directory");
  validateSecureDirectory(path);
  const repositoryScripts = fileURLToPath(new URL(".", import.meta.url));
  assert.throws(() => validateSecureDirectory(repositoryScripts));
});
