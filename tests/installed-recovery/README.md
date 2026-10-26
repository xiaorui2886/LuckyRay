# Disposable Windows installed-product reproduction

This manual-only workflow belongs to `xiaorui2886/LuckyRay`. The private desktop application source and history are not copied into this harness. It installs the publicly released, hash-pinned 1.9.8 setup, overlays one fixed private failed candidate, and starts that installed product EXE in a fresh standard Windows runner with a Chinese, non-default installation path.

`inputs.json` contains approved fixed asset identities, never credentials or candidate bytes. A short-lived fine-grained token, restricted to `xiaorui2886/luckyray-app` with **Contents: read-only**, must be entered by the owner as the repository Actions Secret `LUCKYRAY_CANDIDATE_READ_TOKEN`. No broad local login token may be reused. Use the shortest reasonable UI-supported expiration and revoke the token/remove this secret after the authorized test campaign.

Security review:

- Only `workflow_dispatch` on the exact trusted QA branch. No pull request or push trigger, untrusted workflow, shell input, repository access expansion or billing change.
- Pinned checkout action, credentials not persisted, sparse public harness checkout. No private source checkout, cache, installer artifact or raw profile/log upload.
- Secret exists only in the download step. Fixed API path, asset ID, byte count and SHA256. Runtime child environment strips any credential-like variables. No script is downloaded and executed from the private release.
- Installers stay under disposable `RUNNER_TEMP`. The only uploaded file is the newly constructed allowlisted `red-result.json`; no workspace, wildcard directory, binaries, profile, certificate, session body or process command line is uploaded.
- Process-scoped localhost DevTools drives the actual application. It is not an alternate host or rebuilt test application, does not skip native caller/validation checks, and sends no model requests.
- Existing ordinary `close_window` path is used. No force-kill, security policy, firewall, excluded-port, certificate-store, proxy, system-account or phone modifications.

RED observation is not final acceptance. Fresh/overlay/repeated/interrupted fixed-candidate installation, preserved synthetic conversations/attachments, selected engine and actual carrier reopening remain separate GREEN work. A cloud Windows VM is not user Windows 11 or real Android acceptance.
