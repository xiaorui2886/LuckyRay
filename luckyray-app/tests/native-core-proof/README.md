# Native core adapter proof (headless Linux)

```sh
cargo run --manifest-path tests/native-core-proof/Cargo.toml --locked --offline
```

Compiles the actual `tools/native.rs`, full KnowledgeService and CanvasAgentService plus the real filesystem-identity owner. `build.rs` extracts registry schema helpers and one metadata DTO verbatim from current source. Backend wiring and Canvas ID minting are synthetic host seams; no user profile is opened.

The existing Knowledge owner deliberately refuses Windows-exclusive writes and replacement-fenced reads on non-Windows. Unconditional attachment modules also refer to two Windows-only symbols; this test package supplies only missing, fail-closed non-Windows definitions. It never enables, emulates, or claims to exercise the Windows mutation path. There are no production portability edits.

Four groups cover actual note listing and guarded-operation refusal with unchanged bytes; five actual Canvas operations and revision/digest CAS; malformed graph rejection without changes, preserved nested data and oversized full-read refusal; declared risks and committed-output fallback schemas.

This is **not** proof of the full ToolRegistry authentication/cache, HTTP, official MCP/CLI, or Windows runtime. Their regression tests remain in the main crate for a supported desktop build environment.
