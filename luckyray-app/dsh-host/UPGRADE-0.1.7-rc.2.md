# DSH 0.1.5-rc.2 → 0.1.7-rc.2 candidate admission

**2026-09-26 admission update:** [Independent central review of exact candidate
`3305ec407ad2a1b74f6cf049d631ce78f36c27f3`](#historical-review-scope)
granted **source + isolated development candidate ALLOW** after reproducing
the complete upgrade gate and real plugin recovery scenario. The separate
[#182 development delivery card](#historical-review-scope)
authorizes a guarded update of the existing main-development instance. This
report's isolated results are not themselves evidence that the daily runtime
has been replaced, that real user data has migrated, or that a release is
approved. The delivery receipt must establish those separately.

## Exact candidate and authority

| Item | Pinned value |
| --- | --- |
| From runtime | `@deepseek-ai/dsh@0.1.5-rc.2`, sealed Win x64, Node 22.19.0 |
| To runtime | official npm `@deepseek-ai/dsh@0.1.7-rc.2`, Win x64, Node 22.19.0 |
| To npm tarball SHA-256 | `5f2da7272d9485abc223e681075809a8d929697c5232ee445718e1b7e066bff8` |
| To pnpm lock SHA-256 | `27879348455b15729c05aa9491710a7a4cbd252130a5137a6be809a4df2cb25b` |
| Locked / staged / platform-pruned | 591 / 516 / 75 identities |
| Original admitted portable release tree SHA-256 | `1ddf49eb2c09ede017bf97f908d05e702a484221ee37e4822fb554db34f5bbbe` |
| Detached runtime bytes (old → new) | 311,717,048 → 563,610,418 bytes (+251,893,370) |
| Upstream patch count / install scripts | 0 / disabled |

### Distribution metadata projection (2026-10-16)

The official runtime/version, dependency versions, runtime source and lock remain
unchanged. Formal isolated and portable assembly now exclude only
`debug@2.6.9/.coveralls.yml`, an upstream coverage-service development/CI
configuration, after verifying its exact SHA-256
`64e6b64f19837a76c30865579aabdde1a825729ae0204ba73ba6de77296ce18e`.
No credential value is classified as safe, printed or probed. Unexpected bytes
fail assembly rather than being silently removed. All original license files and
runtime entrypoints remain. No signed installer is modified in place.

The existing audit/record generator regenerated the complete dependency and
resolver records from real projected stages: only this package's file count
changes (17 to16, 46bytes removed), all other515 package records and the lock
reconciliation are identical. Portable release seal is now25658files,
SHA-256 `35e43f0fc3b627e74a5b53b14e19dc18f4e2e8c48ffa0e030df0b96eb1a5f98b`.
Full stage/native/version gates still apply; reinserting the file changes the
sealed audit and is rejected. This is a packaging-only projection, not an
official runtime logic patch or an upgrade of LSH.

The npm tarball and frozen lock are runtime authority. The
[official `dsh-v0.1.7-rc.2` Git release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)
(commit
`477b4f420553e8a52c2fbccc464d7561b239c443`, tree
`e3e63253d1d35ad07f785273235c40813cb6c8bd`) is an audit-only source
identity, not a claim that Git bytes produced the npm tarball. The closure
adds two MPL-2.0 `libreoffice-kit` packages; their published license/notice
files and native bytes are inventoried in the generated records. The pinned
Node archive and pnpm 11.7.0 remain unchanged.

## Upgrade seams and observed results

| Seam | Evidence | Boundary |
| --- | --- | --- |
| Official CLI and supply chain | Both `--version` values and both independent sealed-stage verifiers passed. New release was rebuilt by `prepare-dsh-runtime.ps1 -ReleaseLayout` from pinned archives and an offline store; no network, install scripts, system Node, or upstream edits. | Win x64 / Node 22.19.0 only. |
| Canonical production supply-chain gate | 20/20 passed, zero failures and zero skips, including offline detached publication, exact lock reconciliation, native architecture, resolver graph, and stage drift. | This qualifies the isolated candidate's supply-chain evidence; live delivery has a separate receipt. |
| Development runtime publication | Publication contract: 7/7, zero skips. | Contract of the development publication path, not proof of the later daily runtime update. |
| Host ready, auth and exit cleanup | New CLI accepts the host's deterministic native turn over `/v1/messages`; the old `/chat/completions` diagnostic remains valid. Host contract: 20/20; official native surface: 12/12, both zero skips. | Loopback synthetic provider and process tree, not a real model. |
| Same data root and active settings | Upgrade gate: 3/3, zero skips. Old v3 turn remains readable; new v4 conversations survive restart. Credentials and workspace identities, paths, ownership, and archive state survive. A separate same-identity official Web-profile test first reads effective old theme/locale/provider values on 0.1.5, reads them again after 0.1.7 import, edits them through 0.1.7 `settings.update`, and checks those active values plus old/new conversations after restart. | Synthetic isolated Web profile; no real user profile or screen. The old source also remains byte-for-byte in `.imported`. |
| Plugin compatibility | Compatibility contract: 34/34, zero skips. Real official-surface data continuity: 1/1, zero skips. The healthy fixture declares a current `Config` form; a separate plugin throws during activation twice. Loader output identifies it, the owner reclaims the failed tree, targeted isolation preserves existing data, and compatible-mode additions persist through restart, restore, and ordinary boot. Old session logs, attachment, credential reference, archive, and plugin-owned bytes are checked. | The static scanner reports `pass` for the deliberately throwing plugin, because it cannot predict runtime throws; actual loader failure is separately asserted. No external model or user data. |
| Resource adapter | Resource-tool contract: 18/18, zero skips. | Material/note bridge unit seam only; full product integration was not exercised. |
| Native surface | Authenticated official Web composition, carrier request failure handling, reusable owner/close and crash cleanup, state observer, and draft intent were exercised. | No user screen or native desktop interaction. |
| LSH Remote | 3/3, zero skips: bootstrap token stays server-side, real remote-origin `/api/remote.mux` WebSocket opens and is revoked, and authority rotation invalidates prior Remote sessions while desktop remains unaffected. | Local loopback tunnel; no physical LAN/mobile device. |

The earlier headless-only probe found `settings.yaml.imported` but no Web
theme, locale, or provider rows in the headless profile. This was a profile
composition mismatch, not proof that the desktop lost settings. The follow-up
uses the official Web bundle on both versions and reads the old settings
through its active `settings.get` API and the new settings through live
`settings.describe` forms. The 0.1.7 importer runs asynchronously after the
loader settles, so the test waits for the live values before asserting them.
It then updates theme, locale, and provider through the supported current API
and rechecks after restart. The legacy source bytes are preserved unchanged.

The earlier plugin fixture used removed `settings.register` and v3 for a new
0.1.7 session. The healthy fixture now exports an official volatile `Config`
schema and writes v4 events; its profile bundle is editable. The failure
plugin is separate, and the test observes actual loader failure before
targeted isolation. A prior static check binds the plugin bytes for subsequent
status reporting; that check alone is not treated as failure detection.

## Reproduce the bounded gate

### Rust seal preflight before any daily-instance window

The earlier isolated JavaScript supply-chain and upgrade gates did not compile
the desktop's Rust `dsh_runtime_seal.rs`. The first guarded delivery of this
candidate found that the Rust-embedded record digests still named the old
0.1.5 records; the new runtime would have failed closed at launch. For this
and every later pinned-version update, **before closing the daily desktop or
touching its profile**, check the four embedded Rust digests against the
candidate authority, audit, launch, and runtime records after the production
CRLF-to-LF normalization. Check all 14 pinned host resources, including the
host wrapper and compatibility module, through the two existing backend
identity tests. Run these Rust tests in an isolated checkout and target.
Explicitly run the normally ignored positive seal test against the
exact sealed candidate stage; the regular negative tests can pass even when
the record seal rejects every launch. A failure blocks the daily window and
requires a bounded reviewed source change, not a skipped assertion or an
automatic acceptance of new hashes.

```powershell
$env:CARGO_TARGET_DIR = '<isolated cargo target>'
$env:DSH_TEST_RUNTIME_ROOT = '<verified, sealed candidate release stage>'
cargo test --manifest-path src-tauri/Cargo.toml --lib dsh_runtime_seal -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib `
  dsh_host::tests::host_script_identity_is_checkout_eol_stable_and_rejects_unbound_bytes -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --lib `
  dsh_host::tests::tracked_surface_assets_match_the_backend_identity_contract -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --lib `
  dsh_runtime_seal::tests::exact_stage_passes_identity_check -- --ignored --exact --nocapture
```

All four commands must exit zero. The seal test group reports one intentionally
ignored positive case; the explicit positive run must report it as **passed**,
not ignored. Each host identity command must report one passed test, not zero
selected tests. Do not point them at a user profile or a live DSH process.

Use a clean isolated state root and the pinned archives/offline store. The
`from` side needs the 0.1.5-rc.2 authority, records, and supply-chain verifier
from the `978e7ade` baseline; `to` needs this candidate's tracked files. The
verifier SHA-256 values are printed in the gate result so they can be compared
to the chosen source revisions.

```powershell
$fromRoot = '<sealed 0.1.5-rc.2 release root>'
$fromRepo = '<checkout of 978e7ade>'
$toRoot = '<new empty output path for 0.1.7-rc.2>'
$nodeArchive = '<pinned node-v22.19.0-win-x64.zip>'
$pnpmTarball = '<pinned pnpm-11.7.0.tgz>'
$offlineStore = '<fully fetched pinned offline store>'

./scripts/prepare-dsh-runtime.ps1 -NodeArchive $nodeArchive -PnpmTarball $pnpmTarball `
  -OfflineStore $offlineStore -OutputRoot $toRoot -ReleaseLayout
& "$toRoot/node/node.exe" scripts/run-dsh-upgrade-gate.mjs `
  --from-root $fromRoot --from-version 0.1.5-rc.2 `
  --from-authority "$fromRepo/dsh-host/runtime-authority.json" `
  --from-records "$fromRepo/dsh-host/records" `
  --from-verifier "$fromRepo/scripts/dsh-supply-chain.mjs" `
  --to-root $toRoot --to-version 0.1.7-rc.2 `
  --to-authority ./dsh-host/runtime-authority.json --to-records ./dsh-host/records `
  --to-verifier ./scripts/dsh-supply-chain.mjs `
  --host-adapter ./src-tauri/dsh-host/luckyray-dsh-host.mjs
```

The canonical DSH-0 gate uses a separate isolated resolver stage for its
destructive drift matrix:

```powershell
$isolatedRoot = '<second new empty output path>'
./scripts/prepare-dsh-runtime.ps1 -NodeArchive $nodeArchive -PnpmTarball $pnpmTarball `
  -OfflineStore $offlineStore -OutputRoot $isolatedRoot
$env:DSH_NODE_ARCHIVE = $nodeArchive
$env:DSH_PNPM_TARBALL = $pnpmTarball
$env:DSH_OFFLINE_STORE = $offlineStore
$env:DSH_EXISTING_STAGE = $isolatedRoot
& "$toRoot/node/node.exe" scripts/run-dsh-supply-chain-gate.mjs
```

The runner rejects missing arguments, mismatched authority/package/CLI
versions, invalid seals, skipped continuity tests, and test failures. It
records each supplied verifier's hash rather than treating one version's
hard-coded authority as valid for both sides. A gate PASS covers its three
continuity tests only; it is not an admission decision. Run the plugin data
scenario separately with the same sealed candidate:

```powershell
$env:DSH_M1_RUNTIME_ROOT = $toRoot
& "$toRoot/node/node.exe" --test --test-reporter=tap `
  tests/dshPluginCompat.dataContinuity.integration.test.mjs
```

## Evidence on the execution host

Raw outputs under `C:/Cursor/_coordination/issue182/`:

- `candidate/official-stage-rerun.log` — formal offline release prepare and
  two-location seal; published directory `candidate/official-stage`.
- `candidate/official-isolated-stage.log` — formal offline isolated prepare,
  resolver rebind and two-location seal for the production drift matrix.
- `upgrade-gate-r1-final.log` — exact from/to seal and 3/3 continuity including
  actual official Web-profile settings migration.
- `host-contract-official.log`, `native-surface-official-3.log`,
  `remote-surface-official.log`, `resource-tools.log`,
  `plugin-compat-contract-real.log`, `dev-runtime-publication.log` — bounded
  seam tests.
- `plugin-data-continuity-r1-final.log` — real failure/isolation/recovery/restart
  scenario, 1/1 with zero skips. `production-supply-gate-final.log` — unchanged
  canonical production gate,
  20/20 passed with zero failures and zero skips.

The isolated gate did not exercise a real provider, user profile, desktop
screen, mobile client, physical LAN, daily runtime replacement, or full
material/note UI flow. Independent source review is complete; the guarded
development delivery reports its own observed boundary. Keep 0.1.5-rc.2
available for recovery analysis without launching it against migrated state
or overwriting new user work. Review the additional 252 MB of detached
runtime bytes in the app package budget before any release.

## Historical review scope

Non-public historical review links are omitted from this public projection. The recorded candidate results are not a current release approval.
