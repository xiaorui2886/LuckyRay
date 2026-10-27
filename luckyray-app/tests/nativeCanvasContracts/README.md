# Native Canvas contract seam validation

This harness extracts the exact contiguous production functions from `canvas_agent_id` through `decode_canvas_agent_snapshot` in `src-tauri/src/dsh_host.rs`, including the actual native creation schema constant. It compiles those functions with the real `serde_json` and `base64` crates, without Tauri or a GUI. It does not rewrite the validators as JavaScript mocks.

Run from repository root (Rust/Cargo and Node with TypeScript stripping required):

```
python3 tests/nativeCanvasContracts/prepare.py
cargo build --manifest-path /tmp/luckyray-native-canvas-contracts/Cargo.toml
node --experimental-strip-types --import ./tests/ts-extension-loader.mjs tests/nativeCanvasContracts/verify.mjs
```

For an isolated toolchain, set `CARGO_HOME`, `RUSTUP_HOME`, and `PATH` before the Cargo invocation. No cloud runners, application startup, model/provider calls, user-computer execution, or package publication are involved.

`prepare.py` writes the source and extracted-seam SHA-256 proof. `verify.mjs` runs real compiled native schema, context, request, and snapshot validators; compares creation fixtures with both authenticated-host JS and frontend TS; checks the exact embedded-schema mirror; exercises every operation, every Director change (required and optional fields), all enum members, unknown fields/patterns, string and numeric bounds, invalid selectors, batch limits/byte caps, and operation receipts. The report is written to `/tmp/luckyray-native-canvas-contracts/report.json` (override via `NATIVE_CANVAS_REPORT`).

This is focused native contract compilation and execution, not a full application/Tauri build, GUI test, native rendering validation, provider execution, or proof of all semantic engine behavior. Source changes require re-running prepare and Cargo build before verify.

## Module staging seam

`python3 tests/nativeCanvasContracts/prepare_staging.py` prepares a second isolated crate. Run `cargo run --manifest-path /tmp/luckyray-native-canvas-staging/Cargo.toml -- /tmp/a-fresh-nonexistent-output-directory` to compile and execute the exact production `materialize_surface_modules` function with the real tracked 16-source array. This checks all 15 staged outputs, byte/digest equality, idempotence, corrupted-output repair, and empty/oversize input rejection. Filesystem safety checks use clearly labeled local test shims; this is not evidence of Windows reparse/StableFileLease security behavior.
