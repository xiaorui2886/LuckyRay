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
