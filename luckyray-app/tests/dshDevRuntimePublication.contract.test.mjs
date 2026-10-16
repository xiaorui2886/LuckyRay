import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const helper = join(repoRoot, "scripts", "dsh-runtime-publication-lock.ps1");
const devPrepare = join(repoRoot, "scripts", "prepare-dsh-dev-runtime.ps1");
const runtimePrepare = join(repoRoot, "scripts", "prepare-dsh-runtime.ps1");

test("ordinary Tauri dev prepares the existing bundled DSH source before the debug runtime projection", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const tauriConfig = JSON.parse(await readFile(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.equal(packageJson.scripts.predev, undefined, 'Vite must not run the desktop qualification lifecycle');
  const preparation = await readFile(join(repoRoot, 'scripts/prepare-dev-startup.mjs'), 'utf8');
  const packagePreparation = preparation.indexOf("prepare-dsh-package-runtime.ps1");
  const debugPreparation = preparation.indexOf("prepare-dsh-dev-runtime.ps1");

  assert.ok(packagePreparation >= 0, "ordinary dev must prepare the existing src-tauri/dsh resource source");
  assert.ok(debugPreparation > packagePreparation, "the resource source must exist before the debug runtime projection");
  assert.equal(tauriConfig.bundle.resources["dsh/"], "deepseek-harness/");
});

function runPowerShell(script, args = []) {
  return startPowerShell(script, args).completed;
}

function startPowerShell(script, args = []) {
  const child = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args,
  ], { windowsHide: true });
  const completed = new Promise((resolveRun, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
  return { child, completed };
}

function runExecutable(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("cold DSH publication has one cross-process owner and both callers reuse the verified result", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-publication-"));
  const destination = join(root, "runtime");
  const publishers = join(root, "publishers.txt");
  const runner = join(root, "publish.ps1");
  await writeFile(runner, String.raw`
param([string]$Helper,[string]$Destination,[string]$Publishers)
$ErrorActionPreference = 'Stop'
. $Helper
$validate = {
  param([string]$Root)
  $marker = Join-Path $Root 'verified.txt'
  (Test-Path -LiteralPath $marker -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $marker) -eq 'verified')
}
$publish = {
  param([string]$Root)
  Add-Content -LiteralPath $Publishers -Value ([string]$PID)
  Start-Sleep -Milliseconds 700
  New-Item -ItemType Directory -Path $Root -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Root 'verified.txt'), 'verified')
}
Invoke-DshRuntimePublication -DestinationRoot $Destination -ValidateRuntime $validate -PublishRuntime $publish -TimeoutMilliseconds 10000
`, "utf8");

  const [first, second] = await Promise.all([
    runPowerShell(runner, [helper, destination, publishers]),
    runPowerShell(runner, [helper, destination, publishers]),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.match(first.stdout, /runtime/u);
  assert.match(second.stdout, /runtime/u);
  const owners = (await readFile(publishers, "utf8")).trim().split(/\r?\n/u);
  assert.equal(owners.length, 1, "only one process may build and publish a cold runtime");
  assert.equal(await readFile(join(destination, "verified.txt"), "utf8"), "verified");
  assert.deepEqual((await readdir(root)).sort(), ["publish.ps1", "publishers.txt", "runtime"]);
});

test("a hard-killed DSH publication owner leaves its unique partial untouched while a successor publishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-publication-abandoned-"));
  const destination = join(root, "runtime");
  const ownerReady = join(root, "owner-ready.txt");
  const owner = join(root, "owner.ps1");
  const recover = join(root, "recover.ps1");
  const unrelatedPrefix = join(root, "runtime.partial-not-a-pid");
  const unrelatedSibling = join(root, "runtime-other.partial-123");
  await mkdir(unrelatedPrefix);
  await mkdir(unrelatedSibling);
  await writeFile(owner, String.raw`
param([string]$Helper,[string]$Destination,[string]$OwnerReady)
$ErrorActionPreference = 'Stop'
. $Helper
$validate = { param([string]$Root) $false }
$publish = {
  param([string]$Root)
  $partial = New-DshRuntimePublicationSiblingPath -DestinationRoot $Root -Kind Partial
  $collisionProbe = New-DshRuntimePublicationSiblingPath -DestinationRoot $Root -Kind Partial
  if ($partial -eq $collisionProbe) { throw 'dsh-dev-runtime-partial-path-collision' }
  New-Item -ItemType Directory -Path $partial | Out-Null
  Set-Content -NoNewline -LiteralPath (Join-Path $partial 'populated.txt') -Value 'unverified-partial-bytes'
  Set-Content -LiteralPath $OwnerReady -Value @([string]$PID,$partial,$collisionProbe)
  while ($true) { Start-Sleep -Seconds 1 }
}
Invoke-DshRuntimePublication -DestinationRoot $Destination -ValidateRuntime $validate -PublishRuntime $publish -TimeoutMilliseconds 10000
`, "utf8");
  await writeFile(recover, String.raw`
param([string]$Helper,[string]$Destination,[string]$RecoveredPartial)
$ErrorActionPreference = 'Stop'
. $Helper
$validate = { param([string]$Root) Test-Path -LiteralPath (Join-Path $Root 'verified.txt') -PathType Leaf }
$publish = {
  param([string]$Root)
  $partial = New-DshRuntimePublicationSiblingPath -DestinationRoot $Root -Kind Partial
  Set-Content -NoNewline -LiteralPath $RecoveredPartial -Value $partial
  New-Item -ItemType Directory -Path $partial | Out-Null
  Set-Content -NoNewline -LiteralPath (Join-Path $partial 'verified.txt') -Value 'verified'
  Move-Item -LiteralPath $partial -Destination $Root
}
Invoke-DshRuntimePublication -DestinationRoot $Destination -ValidateRuntime $validate -PublishRuntime $publish -TimeoutMilliseconds 5000
`, "utf8");

  const runningOwner = startPowerShell(owner, [helper, destination, ownerReady]);
  const ownerEvidence = (await waitForFile(ownerReady)).trim().split(/\r?\n/u);
  const ownerPid = Number(ownerEvidence[0]);
  const ownerPartial = ownerEvidence[1];
  const collisionProbe = ownerEvidence[2];
  assert.equal(ownerPid, runningOwner.child.pid);
  assert.match(ownerPartial, new RegExp(`runtime\\.partial-${ownerPid}-[0-9a-f]{32}$`, "u"));
  assert.match(collisionProbe, new RegExp(`runtime\\.partial-${ownerPid}-[0-9a-f]{32}$`, "u"));
  assert.notEqual(ownerPartial, collisionProbe);
  assert.equal(await readFile(join(ownerPartial, "populated.txt"), "utf8"), "unverified-partial-bytes");
  const killed = await runExecutable("taskkill.exe", ["/PID", String(ownerPid), "/T", "/F"]);
  assert.equal(killed.code, 0, killed.stderr);
  await runningOwner.completed;

  const recoveredPartialEvidence = join(root, "recovered-partial.txt");
  const recovered = await runPowerShell(recover, [helper, destination, recoveredPartialEvidence]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const recoveredPartial = await readFile(recoveredPartialEvidence, "utf8");
  assert.notEqual(recoveredPartial, ownerPartial);
  assert.equal(await readFile(join(destination, "verified.txt"), "utf8"), "verified");
  assert.equal(await readFile(join(ownerPartial, "populated.txt"), "utf8"), "unverified-partial-bytes");
  const siblings = await readdir(root);
  assert.ok(siblings.includes(ownerPartial.split(/[\\/]/u).at(-1)));
  assert.ok(siblings.includes("runtime.partial-not-a-pid"));
  assert.ok(siblings.includes("runtime-other.partial-123"));
});

test("an invalid final junction is quarantined by entry rename without touching its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-publication-reparse-"));
  const destination = join(root, "runtime");
  const hostileTarget = join(root, "hostile-target");
  const runner = join(root, "publish.ps1");
  await mkdir(hostileTarget);
  await writeFile(join(hostileTarget, "keep.txt"), "keep", "utf8");
  await symlink(hostileTarget, destination, "junction");
  await writeFile(runner, String.raw`
param([string]$Helper,[string]$Destination)
$ErrorActionPreference = 'Stop'
. $Helper
$validate = { param([string]$Root) (Test-Path -LiteralPath (Join-Path $Root 'verified.txt') -PathType Leaf) -and ((Get-Content -Raw -LiteralPath (Join-Path $Root 'verified.txt')) -eq 'verified') }
$publish = { param([string]$Root) New-Item -ItemType Directory -Path $Root | Out-Null; Set-Content -NoNewline -LiteralPath (Join-Path $Root 'verified.txt') -Value 'verified' }
Invoke-DshRuntimePublication -DestinationRoot $Destination -ValidateRuntime $validate -PublishRuntime $publish -TimeoutMilliseconds 5000
`, "utf8");

  const result = await runPowerShell(runner, [helper, destination]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(destination, "verified.txt"), "utf8"), "verified");
  assert.equal(await readFile(join(hostileTarget, "keep.txt"), "utf8"), "keep");
  assert.rejects(readFile(join(hostileTarget, "verified.txt"), "utf8"));
  const quarantine = (await readdir(root)).filter((entry) => /^runtime\.quarantine-[1-9][0-9]*-[0-9a-f]{32}$/u.test(entry));
  assert.equal(quarantine.length, 1);
  assert.equal(await readFile(join(root, quarantine[0], "keep.txt"), "utf8"), "keep");
});

test("an invalid final containing a nested junction is quarantined without traversing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-publication-nested-reparse-"));
  const destination = join(root, "runtime");
  const hostileTarget = join(root, "hostile-target");
  const unrelatedSibling = join(root, "runtime-unrelated");
  const runner = join(root, "publish.ps1");
  await mkdir(destination);
  await mkdir(hostileTarget);
  await mkdir(unrelatedSibling);
  await writeFile(join(hostileTarget, "keep.txt"), "keep", "utf8");
  await writeFile(join(unrelatedSibling, "keep.txt"), "unrelated", "utf8");
  await symlink(hostileTarget, join(destination, "nested"), "junction");
  await writeFile(runner, String.raw`
param([string]$Helper,[string]$Destination)
$ErrorActionPreference = 'Stop'
. $Helper
$validate = { param([string]$Root) (Test-Path -LiteralPath (Join-Path $Root 'verified.txt') -PathType Leaf) -and ((Get-Content -Raw -LiteralPath (Join-Path $Root 'verified.txt')) -eq 'verified') }
$publish = { param([string]$Root) New-Item -ItemType Directory -Path $Root | Out-Null; Set-Content -NoNewline -LiteralPath (Join-Path $Root 'verified.txt') -Value 'verified' }
Invoke-DshRuntimePublication -DestinationRoot $Destination -ValidateRuntime $validate -PublishRuntime $publish -TimeoutMilliseconds 5000
`, "utf8");

  const result = await runPowerShell(runner, [helper, destination]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(destination, "verified.txt"), "utf8"), "verified");
  assert.equal(await readFile(join(hostileTarget, "keep.txt"), "utf8"), "keep");
  assert.equal(await readFile(join(unrelatedSibling, "keep.txt"), "utf8"), "unrelated");
  const quarantine = (await readdir(root)).filter((entry) => /^runtime\.quarantine-[1-9][0-9]*-[0-9a-f]{32}$/u.test(entry));
  assert.equal(quarantine.length, 1);
  assert.equal(await readFile(join(root, quarantine[0], "nested", "keep.txt"), "utf8"), "keep");
});

test("an invalid final fails closed when its quarantine entry rename cannot complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-publication-quarantine-failure-"));
  const destination = join(root, "runtime");
  const blockedQuarantine = join(root, "runtime.quarantine-blocked");
  const publishCalled = join(root, "publish-called.txt");
  const runner = join(root, "publish.ps1");
  await mkdir(destination);
  await writeFile(join(destination, "old.txt"), "old", "utf8");
  await writeFile(blockedQuarantine, "blocked", "utf8");
  await writeFile(runner, String.raw`
param([string]$Helper,[string]$Destination,[string]$PublishCalled)
$ErrorActionPreference = 'Stop'
. $Helper
function New-DshRuntimePublicationSiblingPath {
  param([string]$DestinationRoot,[string]$Kind)
  return "$DestinationRoot.quarantine-blocked"
}
$validate = { param([string]$Root) $false }
$publish = { param([string]$Root) Set-Content -NoNewline -LiteralPath $PublishCalled -Value 'called' }
Invoke-DshRuntimePublication -DestinationRoot $Destination -ValidateRuntime $validate -PublishRuntime $publish -TimeoutMilliseconds 5000
`, "utf8");

  const result = await runPowerShell(runner, [helper, destination, publishCalled]);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(join(destination, "old.txt"), "utf8"), "old");
  assert.equal(await readFile(blockedQuarantine, "utf8"), "blocked");
  assert.rejects(readFile(publishCalled, "utf8"));
});

test("DSH dev publication exposes no recursive deletion authority over final partial or quarantine trees", async () => {
  const [publicationSource, devPrepareSource, runtimePrepareSource] = await Promise.all([
    readFile(helper, "utf8"),
    readFile(devPrepare, "utf8"),
    readFile(runtimePrepare, "utf8"),
  ]);

  assert.doesNotMatch(publicationSource, /CleanupInvalidRuntime/u);
  assert.doesNotMatch(publicationSource, /Remove-Item[^\r\n]*-Recurse/u);
  assert.doesNotMatch(devPrepareSource, /CleanupInvalidRuntime/u);
  assert.doesNotMatch(devPrepareSource, /dsh-dev-runtime-disabled|\$env:[A-Z0-9_]+[\s\S]{0,120}exit 0/u);
  assert.doesNotMatch(devPrepareSource, /Remove-Item[^\r\n]*\$Root[^\r\n]*-Recurse/u);
  assert.match(devPrepareSource, /\$supplyChain,'verify-release-stage'/u,
    'debug publication must reject an otherwise valid isolated pnpm layout');
  assert.match(devPrepareSource, /-OfflineStore \$offlineStore -OutputRoot \$Root -ReleaseLayout \| Out-Null/u,
    'debug publication must build the link-free layout accepted by the startup cache');
  assert.doesNotMatch(runtimePrepareSource, /Remove-Item[^\r\n]*\$(?:resolvedPartial|outputPath)[^\r\n]*-Recurse/u);
  assert.match(runtimePrepareSource, /New-DshRuntimePublicationSiblingPath[\s\S]*-Kind Partial/u);
  assert.doesNotMatch(runtimePrepareSource, /\$outputPath\.partial-\$PID/u);
});
