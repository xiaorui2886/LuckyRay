# Linux desktop port: work in progress

This branch targets x86_64 Linux and uses Ubuntu 22.04 as a prospective build
baseline. It does not yet provide a supported desktop package. In particular,
the WebKitGTK probe is a small native dependency program, not LuckyRay.

The first preflight at commit
`6d823665e9aaeda403c53e3c6fb5c1e67e410abe` ran on a standard Ubuntu 22.04
runner. GTK 3 and WebKitGTK 4.1 compiled and linked, and seven isolated Linux
autostart tests passed, including desktop-file validation and symlink refusal.
It did not build or launch the app. Run:
https://github.com/xiaorui2886/LuckyRay/actions/runs/41232407784

The second preflight ran on the same baseline at public commit
`6def3aa8c9687cf166e3469aa71a98723687af0a`:
https://github.com/xiaorui2886/LuckyRay/actions/runs/41235425979
The two synthetic security experiments passed their limited scenarios, as did
the independent XDG, sidecar naming and autostart tests. The GTK fixture did
not compile because the test crate resolved the module path incorrectly. The
path fix was exercised in the later fourth run described below. The overall
workflow failed; it did not build or start LuckyRay.

Those historical autostart results predate the later security review. The
fourth-run candidate kept reads and refused mutations. The current source
implements checked enable/disable transactions bound to the running executable,
retaining backups and using `Hidden=true` for disabling. See
[per-user integration](linux-user-integration.md) for its supported layout and
recovery boundaries; the historical workflow did not test this implementation.

The fourth preflight compiled and ran the corrected GTK fixture (16 passed;
one helper was invoked by its parent test). Its main-library check failed with
33 compiler errors. The fifth preflight,
[run 41242624319](https://github.com/xiaorui2886/LuckyRay/actions/runs/41242624319),
used public commit `461684e7449a6b07eb5dbc7934e4fbe840802e16` and tree
`22268e76e95bbf28290bf18c2f48d40a3f321ab6`. The actual Linux main-library
`cargo check` and test-binary compilation succeeded; 11 individually named
admission tests executed and passed. The full suite was not run. Its temporary
diagnostic configuration excluded bundle inputs, so it did not verify release
resources, sidecar identities or packaging. It did not launch the application.

The sixth preflight,
[run 41261321782](https://github.com/xiaorui2886/LuckyRay/actions/runs/41261321782),
used public commit `5e991c15595c37f26328ce8d2af54a548cb8f558` and tree
`5c38741d1e6c4d8edab8967e03f30d38100b308b`. The main-library check, 12 named
production-module tests, three GIO tests, frontend and native diagnostic build
passed. The real Tauri window started and note creation/save executed. The
overall run failed because the smoke adapter mistook the expected stale-write
business error for a WebDriver protocol error. Material import, reopening and
quit checks were not reached in that run. The adapter now preserves command
results separately from HTTP protocol failures, with two focused HTTP tests.

## Runtime input candidates

- The existing LSH authority remains `@deepseek-ai/dsh` **0.2.1-rc.3**. A
  separate [Linux closure](linux-lsh-runtime.md) now pins its Linux Node and
  native dependencies, package inventory and notices, with offline assembly
  and production admission checks. Integrating those resources and complete
  redistribution materials into an installer remains outstanding.
- Node.js **22.19.0**: the official `linux-x64` gzip archive has SHA-256
  `d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d`,
  as published in the [Node.js release announcement](https://nodejs.org/en/blog/release/v22.19.0).
  `scripts/linux/prepare-node-input.mjs` accepts only that archive, checks the
  ELF header and executable version, and stages its LICENSE. Its output is only
  an input for subsequent review, not a sealed LSH installation or authority.
  The second preflight verified the official archive and executed its exact
  extracted binary as Node 22.19.0. The x86-64 ELF was 121,674,800 bytes,
  SHA-256 `596b5144ff242737f1c1be6a5f0ccb3907dbba2482344143cb1a6898633402a9`;
  the staged license SHA-256 was
  `e991d81497a85bb24fc6bffae0a3637a6accd6c6bc5ce1f2c5698bd555cf9d49`.
  The observed highest GLIBC symbol version was `2.28`. This checks only the
  Node input, not the LSH closure or the desktop's minimum system version. The
  original symlink test did not distinguish a no-follow rejection from a later
  hash rejection; its stricter `ELOOP` assertion is local and awaits Linux.
- Deno **2.9.4**: the official GitHub release asset
  `deno-x86_64-unknown-linux-gnu.zip` has SHA-256
  `c24f955d9fbfe0ea5ae2b501c8e71ae76e31e4c9782390a54a284b3364fda725`
  according to the [release metadata](https://api.github.com/repos/denoland/deno/releases/tags/v2.9.4).
  `scripts/linux/prepare-deno-input.mjs` is a new input-only staging tool that
  pins this archive and the upstream MIT notice. The fourth preflight verified
  the official archive, extraction and executable as an input; redistribution
  review remains incomplete.
  Its report explicitly says that the third-party notice inventory is unaudited.
  In particular, the upstream project's
  [binary-license inventory issue](https://github.com/denoland/deno/issues/13515)
  discusses third-party notices beyond Deno's own MIT license; the version- and
  platform-specific inventory must be established before redistribution. The
  public repository already contains a 2.9.4 notice inventory, but its Cargo
  metadata explicitly targets `x86_64-pc-windows-msvc`, so it is not evidence
  of a complete Linux dependency closure.
- Python **3.11.8**: the [official release](https://www.python.org/downloads/release/python-3118/)
  supplies source, but the repository's embeddable runtime is Windows-only.
  A pinned Linux build and its standard-library/native dependency inventory are
  still needed.
- FFmpeg **9.0.1**: the repository's locked LGPL shared build is Windows-only.
  A pinned Linux build, its build configuration, corresponding source and
  redistribution notices still need to be established and checked.

## Required before a candidate package

1. Integrate the actual [Linux LSH resources](linux-lsh-runtime.md) into package
   preparation and complete corresponding-source, license and relinking
   materials. The closure already has its own Linux Node/native-addon pins,
   offline assembly and permission checks. Linux node-pty uses `pty.node`;
   its Darwin spawn helper is not a missing Linux executable.
2. Complete source-bound Linux sidecar preparation while retaining the
   implemented process-group owner and its documented escape/abrupt-exit
   limits. Build-script naming alone does not establish provenance.
3. Implement and verify the request-mediated Linux personal-browser host.
   Embedded LSH uses its own real host and GTK child; the personal-browser
   host still reports unsupported on non-Windows.
4. Complete Linux media, real-browser Native Messaging connection testing,
   external drag and application build/packaging integration. Scoped
   [registration, revocation and autostart transactions](linux-user-integration.md)
   are implemented for unpacked or installed executables; AppImage carrier
   binding remains outstanding.
5. Build real `.deb` and AppImage candidates on the older baseline and validate
   installation, startup, exit and the requested product flows on Linux. X11
   tests do not establish Wayland, hardware audio, GPU or multi-display support.

## Partial implementation and security limits

- Linux XDG application-data lookup and a GTK external-drag implementation are
  present. The fourth-run GTK fixture compiled the actual module and exercised
  its URI and image validation; it did not demonstrate a desktop drag or launch
  the application.
- A later local change routes the Linux `open_directory` command through the
  registered GIO directory handler after checking an absolute existing
  directory and encoding a file URI. This removes that command's direct
  `xdg-open` lookup from `PATH`; GIO still uses the desktop's configured
  handler. The sixth preflight passed the Linux path-validation, URI and
  synthetic registered-handler tests. This does not change the other
  file-opening commands or establish an identity-bound file lease.
- Linux note writes now prepare descriptor-relative optimistic transactions,
  independent backups and interruption recovery. Filesystem object, content and
  parent identities are checked at operation boundaries. Same-user mandatory
  exclusion is not provided. The sixth preflight passed the focused native
  note and file-store tests; see [Linux integration](linux-desktop-port-notes.md)
  for their boundaries and remaining runtime requirements.
- Linux attachment copy-publish and material-file deletion are implemented
  locally with private staging, no-replace renames and recorded quarantine
  identity (see [Linux integration](linux-desktop-port-notes.md)). Deletion
  matches Windows (quarantine, then permanent delete) and does not use the
  system trash. Their offline filesystem tests pass; the full application
  build and native flows for these paths are verified only on CI.
- `tests/linux-security/atomic_create_probe.c` explores an unnamed inode and a
  previously opened directory descriptor, with no-overwrite tests after a
  synthetic directory rename. It does not establish how to acquire a trusted
  directory or exclude external writers, and is not used by the product.
  `O_TMPFILE` also depends on filesystem support and proc-fd publication may be
  unavailable. See [open(2)](https://man7.org/linux/man-pages/man2/open.2.html).
- `tests/linux-security/pid_namespace_probe.c` explores a user/PID namespace
  and parent-death signal with synthetic `setsid` descendants. The kernel
  [terminates namespace members](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
  after its init exits, but user namespaces may be disabled, and this experiment
  does not establish Windows Job creation binding, owner-handle semantics,
  crash behavior in the full multi-threaded application, or a settled-zero
  generation boundary. No product supervisor uses the probe. The preflight
  bounds both synthetic probes with an outer timeout and removes only their
  dedicated runner-temporary directory; it does not relax host restrictions.
- Linux uses process-group cleanup and optimistic file transactions. Process
  groups do not contain escaped descendants or guarantee cleanup after abrupt
  desktop death. File checks detect observed changes at operation boundaries;
  a same-user external process may still modify user-owned files between those
  checks. Conflicts preserve independent backups and the displaced inode for
  recovery. Ownership, permissions, path and object-identity checks remain
  required within this model; mandatory exclusion or a privileged supervisor
  is not a Linux package prerequisite.
- Linux runtime file leases revalidate held objects and content digests at use
  boundaries. The LSH runtime now authenticates its separate Linux closure.
  Personal-browser hosting, real-browser Native Messaging testing, complete runtime
  redistribution materials and installer integration remain outstanding.

## Shared-file merge coordination

The branch does not modify the Windows checkout or its build artifacts. The
platform-specific branches in shared Rust files preserve the existing Windows
code paths, but a future merge is not fingerprint-neutral: `Cargo.toml` and
`Cargo.lock` are inputs to the CLI contract identity, and `src/lib.rs` is an
input to the DSH host adapter fingerprint. A Windows build from merged sources
would need correctly rebuilt sidecars and review of update compatibility; the
local source-contract tests here are not a Windows installer regression. Merge
coordination must also account for macOS changes to the same shared files.

Do not publish an installer or weaken the existing runtime, signature, ownership
or executable-source checks to make a partial build pass.
