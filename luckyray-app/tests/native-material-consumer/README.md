# Native material tool proof (headless)

Run locally with Cargo:

```sh
cargo run --locked --manifest-path tests/native-material-consumer/Cargo.toml
```

This executable compiles the actual `tools/native_materials.rs`, `materials/consumer.rs`, Catalog, library ownership, import and preview implementations. Registry schema helpers are extracted from the current production source by `build.rs`; they are not reimplemented. It uses only an ephemeral synthetic SQLite fixture and library directories.

Covered: all 8 native definitions and dispatch paths, strict input/output schemas, explicit library IDs despite UI selection changes, bounded offset paging and terminal pages, content deduplication, safe preview, no original-file authority, foreign-library IDs, revision-checked metadata/tag/category changes, concurrent CAS single winner, invalid image/path refusal without changes, hidden-library denial and committed receipt fallback after a controlled projection failure.

The fixture substitutes only the app's event sink, catalog-owned file opening, and the Backend/principal host objects. **It does not prove native transport authentication, revocation, registry idempotency, CLI or MCP protocol behavior.** Three production-registry tests for these material operations live in `src-tauri/src/tools/native_materials_tests.rs` and run with the main crate on an environment containing its desktop dependencies.
