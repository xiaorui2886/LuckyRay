# Disposable Windows installed-product reproduction

This manual-only workflow belongs to `xiaorui2886/LuckyRay`. The private desktop application source and history are not copied into this harness. It installs the publicly released, hash-pinned 1.9.8 setup, overlays one fixed private failed candidate, and starts that installed product EXE in a fresh standard Windows runner with a Chinese, non-default installation path.

`inputs.json` contains approved fixed asset identities, never credentials or candidate bytes. The Contents-read-only PAT was experimentally rejected for the private Draft (repository 200, Draft and asset 403). Its Secret is retired. With separate user approval, the download step now receives only `LUCKYRAY_FIXED_ASSET_DOWNLOAD_URL`: a GitHub-issued HTTPS capability for the fixed, hash-pinned asset, expiring within at most one hour. No repository login token enters this job. Remove this Secret after testing; the original unused PAT must also be revoked by its owner.

Security review:

- Only `workflow_dispatch` on the exact trusted QA branch. No pull request or push trigger, untrusted workflow, shell input, repository access expansion or billing change.
- Pinned checkout action, credentials not persisted, sparse public harness checkout. No private source checkout, cache, installer artifact or raw profile/log upload.
- Single-asset capability exists only in the download step, with exact HTTPS CDN origin and short-expiry checks plus fixed byte count/SHA256. Runtime child environment strips credential-like variables. No script is downloaded and executed from the private release. No repository credential or private source access is granted to the Runner.
- Installers stay under disposable `RUNNER_TEMP`. The only uploaded file is the newly constructed allowlisted `red-result.json`; no workspace, wildcard directory, binaries, profile, certificate, session body or process command line is uploaded.
- Process-scoped localhost DevTools drives the actual application. It is not an alternate host or rebuilt test application, does not skip native caller/validation checks, and sends no model requests.
- Existing ordinary `close_window` path is used. No force-kill, security policy, firewall, excluded-port, certificate-store, proxy, system-account or phone modifications.

RED observation is not final acceptance. Fresh/overlay/repeated/interrupted fixed-candidate installation, preserved synthetic conversations/attachments, selected engine and actual carrier reopening remain separate GREEN work. A cloud Windows VM is not user Windows 11 or real Android acceptance.

## Frozen repair acceptance

The current manual workflow runs `Run-Green.ps1` for `fresh`, `old020`, and `old021`, each on a separate clean `windows-2022` VM, sequentially with fail-fast. It does not clear a profile to make a failing case pass. `inputs-green.json` pins one private QA transport archive and every file inside. Its three entries are exactly the frozen repaired installer, the existing frozen old021 installer, and a qualified synthetic signed020 runtime fixture. The public1.9.8 installer actually bundles017rc2; the old020 case explicitly adds a qualified signed020 synthetic active/journal/runtime fixture, then runs the actual old product before overlay. It does not claim1.9.8 bundled020.

Actual installed-product checks cover the read-only resource entry point, normal and compatible native LSH surfaces reaching client-ready/session-open, exact owned Node/carrier location, selectedrc3, normal exit/reopen, legacy resource retention, exact synthetic session/attachment preservation and semantic workspace ownership. Old cases enter an unsent draft through the actual WebView editor and check its saved restoration. Repeated installation repairs an intentionally incomplete *synthetic* owned slot while preserving its complete previous runtime and host. These are product-EXE checks, separate from offline contracts and static extraction.

The fresh case also starts the actual Gateway, exits normally, holds its saved endpoint with a separate synthetic TCP listener, checks the resulting bind failure, cancels recovery, explicitly confirms same-interface recovery, verifies actual OS listener ownership and identity/pin preservation, checks the exact five-field recovery presentation, and reopens the application to verify persistence. No firewall, TLS, authorization or system port reservation is changed. This is not an Android endpoint-update acceptance test.

After a proven harness-only correction, the manual `old-upgrades` suite can resume just the two old cases without repeating an already-passed fresh case. These independent old-case VMs each stop at their first failed check, but one failure does not cancel the other old-case VM. Results retain their original run IDs and must not be presented as one all-green run. The fixed installer, EXE and input hashes remain unchanged.

Only the constructed `green-result.json` for each case is public. Raw synthetic program logs, signed fixtures, installers, certificates, credentials and profile files remain private inside the disposable VM. The unused PAT was revoked by its owner. No model requests or real phone operations are part of this workflow. The first failing installed check stops that case; the all-cases suite also cancels queued cases. A harness error must be distinguished from a product failure before any further run.
