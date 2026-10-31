# Linux desktop work in progress

This branch is not a runnable or releasable Linux desktop. The target under
investigation is `x86_64-unknown-linux-gnu`, using Ubuntu 22.04 as the build
baseline and Ubuntu 24.04 as a separate future compatibility check. Neither a
deb nor an AppImage has been produced or tested.

## Work implemented but not yet tested on Linux

- The Linux-only Tauri configuration selects deb and AppImage, asks Tauri to
  include the GStreamer media framework in the AppImage, and preserves all
  shared resource and sidecar entries through Tauri's JSON merge. The media
  plugin inventory and licenses are not complete. Its build hook intentionally
  fails until the listed platform blockers are resolved; it is not a substitute
  for the existing `build.rs` admission checks or a guard against invoking a
  different bundling command directly.
- The LSH child webview gets a GTK focus notification wired to the existing
  fixed drawer-dismissal event. This does not start LSH or grant content any
  new IPC authority, and real GTK compilation, focus and window behavior remain
  untested. Creating the child is still behind the existing LSH host gates.
- An explicitly invoked `luckyray-native-host --install-linux-manifest` path
  is prepared for a per-user manifest for `chrome`, `chromium`, `edge`, or
  `chrome-for-testing`. If the admission gate is eventually opened, it uses the
  existing exact extension-origin allowlist, rejects AppImage, and checks the
  executing sidecar's identity at registration time. It does not replace a
  pre-existing manifest. A new
  manifest is published through an unnamed file and held directory descriptor,
  with a no-replace link; unsupported filesystems or `/proc` access fail
  closed. The older generic command, which can overwrite an arbitrary manifest
  path, is rejected on Linux. There is no auto-install, update or manifest
  deletion. The CLI currently returns
  `linux-credential-storage-unavailable` before touching the
  filesystem. It must remain closed until the host executable's use window and
  credential persistence have an approved, verified Linux contract.

  This is a partial implementation, not an end-to-end registration result:
  it has not been compiled or run on Linux, a browser has not launched the
  host, and a held descriptor does not prove that an adversary cannot move or
  change a name before or after publication. It does not provide a lasting
  stable-file lease for the host executable. Browser-specific command-line
  profile overrides, Snap/Flatpak, Chrome channels other than those named
  above, and AppImage registration remain unsupported or unverified. The
  browser's environment must match the selected configuration directory.
- Autostart reads use no-follow and nonblocking open followed by an opened
  regular-file check. Creation and deletion fail closed before mutation: the
  former named temporary file could be replaced before linking or cleanup, and
  the former pathname unlink could remove a replacement after inspection. A
  synthetic FIFO regression has a bounded child and cleans only its test root;
  Linux execution remains unverified. Idempotent requests need no write.

## Actual blockers and call chains

1. `dsh_host::DshHostService::open_native_surface` requires a sealed host
   closure and launches the host via `owned_process::spawn_in_owned_job`.
   `dsh_runtime_seal::acquire_stable_file` and the non-Windows
   `dsh_host::is_reparse` fail closed on this platform. Those guarantees and
   the associated process/notes choices are documented separately in
   [linux-security-design-notes.md](linux-security-design-notes.md).
2. `browser_host_poc::open_production_webview` rejects non-Windows platforms.
   The Windows `attach_production_handlers` mediates document and subresource
   requests; the agent browser routes its requests through an authenticated
   gateway. A WebKitGTK web-process extension's request interception is a
   possible building block, but worker/WebSocket coverage, process lifetime,
   sealed extension resources and gateway integration have not been proved.
   Linux must not open an unrestricted replacement webview.
3. `agent_browser::runtime` depends on `owned_process` for its owned job.
   Independently, the embedded personal-browser viewport is Windows-only in
   `lib.rs::browser_personal_open`. These are not fixed by the GTK LSH focus
   hook.
4. `local_transport::revoke_extension_origin` revokes an approved credential;
   deleting a browser manifest alone would only affect future host launches.
   Safe, identity-bound manifest replacement/removal and its integration with
   origin revocation remain unresolved. The new installer deliberately does
   not delete or overwrite any existing name. The existing credential chain
   `native_messaging::run` -> `load_native_credential` -> `AuthState::load_or_create`
   and `revoke_extension_origin` -> `AuthState::persist` -> `persist_auth_record`
   also requires review: the latter uses a random temporary name with
   create/truncate followed by pathname rename, which does not establish the
   requested identity-bound, exclusive Linux file-concurrency guarantee. The
   current Linux candidate fails closed at credential load, persistence,
   local-transport startup, native-host run and both manifest writers. It also
   blocks normal desktop startup before Tauri/profile initialization and
   blocks the credential-backed CLI/MCP paths before their runtime work. These
   guards are not a replacement for the missing storage implementation.
5. Node and Deno have fixed official Linux inputs prepared only for verification;
   the sealed LSH closure, Python, FFmpeg, all sidecars, media plugins and
   complete third-party notices are not assembled as a deliverable.

   The existing media resolver explicitly requires Python 3.11.8, whereas
   Python.org now lists [3.11.18 as a security release](https://www.python.org/downloads/release/python-31118/).
   FFmpeg.org lists both the existing 9.0.1 and a newer 9.0.2 source release in
   its [release archive](https://ffmpeg.org/releases/). This is a compatibility
   and security review item, not a version change in this branch. Source builds,
   exact archive verification, dependent libraries and redistribution notices
   remain unimplemented.

## Shared files and Windows coordination

The dependency target move in `src-tauri/Cargo.toml` leaves the exact Windows
dependency versions, features and feature graph intact, while avoiding those
dependencies on Linux. Its bytes are an input to the CLI contract fingerprint
in `build.rs`, however, so Windows sidecar identity must be regenerated and
verified if this change is ever merged. `src-tauri/src/lib.rs` also contributes
to the DSH adapter fingerprint even though its new calls are Linux-gated. The
native-messaging CLI additions are Linux-gated; the existing Windows manifest
writer and NSIS hooks are unchanged. These shared-file effects require parent
review before cross-platform integration. The Linux-only CLI admission guard
also changes the bytes of `src/tool_cli.rs`, another CLI fingerprint input.

References: [Tauri platform configuration](https://v2.tauri.app/develop/configuration-files/),
[Tauri AppImage media](https://v2.tauri.app/distribute/appimage/),
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
and [Edge native messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging).
