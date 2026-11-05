# Linux product sidecars (T52 S2)

Linux-only. `sidecars.py build <src-tauri> <binaries>` compiles
luckyray-native-host, luckyray-cli, luckyray-mcp and luckyray-browser-host
(`--release --locked --features sidecar-binaries --target x86_64-unknown-linux-gnu`,
symbols stripped, HOME and source root remapped, C `-DNDEBUG` and
`-ffile-prefix-map`), refuses non-x86-64-ELF output and a CLI carrying the
build root or HOME, then writes the two records the unchanged build.rs
validators require:

- `luckyray-cli-x86_64-unknown-linux-gnu.identity.json` (identity from the
  binary's own `protocol identity` handshake, which must equal the source
  contract digest);
- `luckyray-sidecars.origin.identity.json` (canonical private-release origin
  from `config/release-extension-origins.json` and the extension manifest key;
  Linux takes no `LUCKYRAY_EXTENSION_ORIGINS` override).

`verify` re-checks everything offline. The authority stays build.rs: CI runs a
release `cargo check` with no `LUCKYRAY_SIDECAR_PREPARE` (accepts), then
appends one byte to a sidecar (refuses). The Windows script
`scripts/prepare-native-host.ps1` is untouched. Browser host here is the Agent
Browser host only (T55 slice 3); PersonalBrowser stays unsupported.

Offline tests: `python3 test_sidecars.py` (14 tests, synthetic ELF stubs).
