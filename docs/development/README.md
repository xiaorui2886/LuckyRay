# Building LuckyRay 1.9.10

This branch contains the public application-source projection for desktop **1.9.10**.
It keeps the public repository's history, licenses and public build checks. See
[source identity and differences](source-1.9.10.md) for the exact release source
archive and the small public-only adapters. It is not a new installer build or
an assertion that all installed-app scenarios have been retested.

## Layout and frontend checks

`luckyray-app/src` contains React/TypeScript, `src-tauri` the Rust/Tauri host,
`browser-extension-prototype` the Collector source, and `packages` the optional
MCP code. `dsh-host` records frozen runtime inputs; `sdk/` contains the public SDK.
Collector 1.9.6 remains an independently released ZIP. Its desktop-source manifest
may retain a development version; use the official Collector download to install it.

Public CI uses Node.js **24.14.1**, pnpm **11.3.0**, and Rust **1.95.0**.
From the repository root:

```powershell
cd luckyray-app
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm build
pnpm run test:desktop-signed-update
node --test tests/dshDesktopUpdateLifecycle.test.mjs
```

No private repository, installed profile, model key or pairing credential is needed.
Tests use synthetic data. These bounded checks do not cover every historical test
or real desktop, model, GPU and mobile combination.

## Windows native checks and installer

Use Windows x64, Visual Studio C++ Build Tools, Windows SDK, Windows PowerShell 5.1
and WebView2. Install tools from official sources. Keep the checkout path short
(for example `D:\lr-src`): NSIS rejects resource paths longer than 259 characters.

The player is a fixed LGPL source build. Its **43 runtime and corresponding-source
material files** are kept in the release asset, not committed to this repository.
From the repository root, first stage those verified materials:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\prepare-public-native-video.ps1
cd luckyray-app
pnpm install --frozen-lockfile
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\prepare-media-engine.ps1
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\prepare-dsh-package-runtime.ps1
cargo check --locked --manifest-path src-tauri/Cargo.toml --lib --no-default-features --features browser-host-runtime,lsh-background-surface-preload
& .\scripts\build-nsis.ps1 -LshBackgroundPreload
```

The public staging helper checks the exact archive size and SHA-256, extracts only
allowlisted player materials, and invokes the existing product verifier for every
file's size/hash and full runtime-manifest binding. It refuses an existing destination
rather than overwriting an unreviewed staged runtime. Never create empty resources,
replace receipts, weaken verification, or substitute a different FFmpeg package.
Keep both `.gitattributes` files: sealed LSH metadata and notices must retain LF.

Bundled runtime authority is **DeepSeek Harness 0.2.2-rc.1**, **Node 24.22.2** and
frozen-assembly **pnpm 11.7.0**. These are separate from the frontend tools above.
Exact public URLs and hashes are in `dsh-host/runtime-authority.json`, its lockfile,
`third_party/media-engine/manifest.json` and `third_party/native-video/manifest.json`.

The before-build chain verifies LSH, stages media, builds owned sidecars and the
frontend, and runs readiness gates. Output is under
`src-tauri/target/release/bundle/nsis/`. A source checkout has its own commit identity;
do not forge the official release's build identity. Official update-signing private
keys are neither included nor required for a self-build.

## Development and distribution safety

Use `pnpm dev:desktop` for the isolated development profile. `pnpm dev` alone is only
a frontend. Do not disable checkout/profile guards or copy production AppData into
a development instance. Test production-identity installers on a separate disposable
Windows OS, not alongside a real profile under the same user.

Read [third-party redistribution requirements](third-party.md) and the current
[source/distribution notes](source-1.9.10.md). Source availability and successful
compilation do not establish patent clearance, byte-for-byte reproduction, or full
upgrade acceptance. Historical frozen updater fixtures remain under
`tests/formal-update/`; they are not new 1.9.10 installed acceptance results.
