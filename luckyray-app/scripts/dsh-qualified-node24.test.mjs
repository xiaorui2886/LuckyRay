import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { validateReviewedPackageLicense, validateRequiredWindowsOfficeRuntime } from "./dsh-supply-chain.mjs";
import { updateClosureIdentity } from "./prepare-dsh-production-candidate.mjs";

test("the reviewed Blue Oak package requires its exact included notice", () => {
  const manifest = { name: "lru-cache", version: "11.5.3", license: "BlueOak-1.0.0" };
  const files = [{ path: "LICENSE.md", sha256: "8a1af140fdfbf5afd3df27f7e662f989c5b963a300020dfafce42033cae9e004" }];
  assert.doesNotThrow(() => validateReviewedPackageLicense(manifest, files));
  for (const changed of [{ ...manifest, name: "other" }, { ...manifest, version: "11.5.4" },
    { ...manifest, license: "BlueOak-unknown" }]) assert.throws(() => validateReviewedPackageLicense(changed, files));
  for (const changed of [[], [{ ...files[0], path: "OTHER.md" }], [{ ...files[0], sha256: "0".repeat(64) }]])
    assert.throws(() => validateReviewedPackageLicense(manifest, changed));
  assert.doesNotThrow(() => validateReviewedPackageLicense({ name: "old", version: "1", license: "MIT" }, []));
});

test("a Windows Office kit cannot be frozen without its exact native engine", () => {
  const kit = { name: "@deepseek-ai/libreoffice-kit", version: "0.1.5" };
  const engine = { name: "@deepseek-ai/libreoffice-kit-win32-x64", version: "0.1.5",
    nativeArtifacts: [{ path: "bin/libreoffice-kit.exe" }] };
  assert.doesNotThrow(() => validateRequiredWindowsOfficeRuntime([]));
  assert.doesNotThrow(() => validateRequiredWindowsOfficeRuntime([kit, engine]));
  for (const incomplete of [[kit], [kit, { ...engine, version: "0.1.4" }],
    [kit, { ...engine, nativeArtifacts: [] }]]) {
    assert.throws(() => validateRequiredWindowsOfficeRuntime(incomplete), { code: "dsh-native-prebuild-evidence-missing" });
  }
});

test("update closure identity uses the native admission format", async () => {
  const parent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(parent, "luckyray-closure-fixture-")));
  assert.equal(dirname(root), parent);
  assert.match(basename(root), /^luckyray-closure-fixture-/u);
  try {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "dir", "z.txt"), "omega");
    await writeFile(join(root, "z-\uE000.txt"), "one");
    await writeFile(join(root, "z-\u{10000}.txt"), "two");
    assert.deepEqual(await updateClosureIdentity(root), {
      sha256: "89bcd023e65857b15993142cc4da49a9243a4afae21cdc0bb181e7c12c0e6b58", fileCount: 4,
    });
  } finally {
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  }
});
