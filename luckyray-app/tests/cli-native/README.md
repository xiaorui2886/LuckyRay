# Isolated production CLI regression harness

Run `cargo test --manifest-path tests/cli-native/Cargo.toml --locked` from the
repository root. No desktop runtime or user profile is launched. All test
app-data and manifests live in temporary directories and are removed afterward.
The fixture server binds one available IPv4-loopback port within the production
client's fixed discovery range and accepts only the four expected test routes.

The binary compiles the production CLI and client directly via `#[path]`; it
contains no replacement parser, dispatcher, status logic, or HTTP client. Its
`local_transport` module substitutes **only** fixture credential loading and
proof verification with an explicit sentinel. This verifies the client's
proof-before-Authorization control flow, not production cryptography/storage.
The fixture binary is never a release sidecar and must not be installed.

Coverage: offline text/JSON help and version; exact protocol/manifest commands;
JSON stdout/stderr and exits 0/2/3/4; invalid/duplicate options; sensitive-input
redaction; 1 MiB stdin limit; live registry schemas and unavailable descriptions;
underscore IDs; no diagnostic tool execution; allowlisted status/doctor fields;
malformed health/registry/auth errors; invalid proof; legacy run input and request
identity. Full desktop/Windows tests remain a separate required gate.
