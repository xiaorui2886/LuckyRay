# Building LuckyRay

This is the **1.9.15 update-acceptance candidate source**, not a stable release or
a claim that the two installed upgrade scenarios passed. Existing downloads and
the website are unchanged. See [updater validation](updater-validation.md).

## Layout and basic checks

`luckyray-app/src` contains React/TypeScript, `src-tauri` the Rust/Tauri host,
`browser-extension-prototype` the Collector snapshot, and `packages` the optional MCP
connection code. `dsh-host` records the frozen public runtime inputs. `sdk/` is the
existing public SDK. Native independent windows and the old standalone workspace
experience remain withdrawn; do not reconnect historical internal entry points.

The frozen desktop source's Collector manifest is 1.9.5. Comparing all 61 source
files against the separately published Collector 1.9.6 ZIP shows only manifest
version/name differences after CRLF normalization. No extension ZIP is replaced
or new extension version claimed by this source export.

Use Node.js **24.14.1** and pnpm **11.3.0**. From the repository root:

```powershell
cd luckyray-app
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm build
pnpm run test:desktop-signed-update
node --test tests/dshDesktopUpdateLifecycle.test.mjs
```

No private repository access, account, installed LuckyRay, model key or pairing
credential is needed. Tests use synthetic data. These bounded checks do not imply
that every historical component or native/visual integration test passes.

## Windows desktop and installer

Use Windows x64, Rust **1.95.0** MSVC, Visual Studio C++ Build Tools and Windows SDK,
Windows PowerShell 5.1, WebView2 Runtime, and the Node/pnpm versions above. Install
them from official sources. Use a short independent checkout, such as `D:\lr-src`:
NSIS rejects resource source paths longer than 259 characters.

```powershell
cd luckyray-app
pnpm install --frozen-lockfile
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-media-engine.ps1
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-dsh-package-runtime.ps1
cargo check --locked --manifest-path src-tauri/Cargo.toml
& .\scripts\build-nsis.ps1 -LshBackgroundPreload
```

Tauri checks its declared resource paths even during `cargo check`, so run the
two real staging commands above first; do not create empty resource directories.
The existing before-build entry also downloads public fixed-hash inputs, verifies the
LSH closure, stages media, builds four owned sidecars and matching identity receipts,
builds the frontend and runs readiness gates. Do not copy another build's receipts
or invent placeholder release resources. Output: `src-tauri/target/release/bundle/nsis/`.
Read [third-party redistribution requirements](third-party.md) before distributing
any resulting installer; a successful compile is not license or upgrade acceptance.

Runtime versions remain official **DeepSeek Harness 0.1.7-rc.2**, Node **22.19.0**,
and separate frozen-assembly pnpm **11.7.0**. They do not replace the frontend tool
versions. Public URLs, versions and hashes are in `dsh-host/runtime-authority.json`,
`dsh-host/pnpm-lock.yaml`, and `third_party/media-engine/manifest.json`.

No production signing private key is included or needed to build. Verification
public keys remain public and unchanged. Local builds cannot produce official
update signatures. Production-identity installers must be tested on an independent
disposable Windows OS, not beside a real LuckyRay profile under the same user.

## Development safety

`scripts/start-luckyray-dev.ps1` owns checkout/frontend identity and the physical
development profile. Read its guards; do not disable them or copy AppData around
them. `pnpm dev` alone is only a frontend and does not prove native behavior.

Public CI runs cheap bounded checks first. Installed updater acceptance is separate
and uses frozen reviewed inputs, not freshly substituted binaries. Each report
must distinguish PASS, FAIL, BLOCKED and NOT_RUN.
