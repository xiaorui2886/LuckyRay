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

## Runtime input candidates

- The existing LSH authority remains `@deepseek-ai/dsh` **0.2.1-rc.3**. Its
  published lockfile includes Linux native dependencies, but the checked-in
  audited release closure and execution controls are Windows-specific. A
  Linux-specific, sealed and audited closure has not been produced.
- Node.js **22.19.0**: the official `linux-x64` gzip archive has SHA-256
  `d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d`,
  as published in the [Node.js release announcement](https://nodejs.org/en/blog/release/v22.19.0).
  `scripts/linux/prepare-node-input.mjs` accepts only that archive, checks the
  ELF header and executable version, and stages its LICENSE. Its output is only
  an input for subsequent review, not a sealed LSH installation or authority.
  Actual archive extraction and binary hash remain unverified until CI runs.
- Deno **2.9.4**: the official GitHub release asset
  `deno-x86_64-unknown-linux-gnu.zip` has SHA-256
  `c24f955d9fbfe0ea5ae2b501c8e71ae76e31e4c9782390a54a284b3364fda725`
  according to the [release metadata](https://api.github.com/repos/denoland/deno/releases/tags/v2.9.4).
  Linux staging, extracted binary verification, and redistribution review
  remain outstanding. In particular, the upstream project's
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

1. Prepare and seal the complete Linux LSH closure, including the Linux Node
   binary, native addons, the node-pty spawn helper and executable permissions.
   Preserve offline installation, ownership and hash checks.
2. Implement Linux process-tree ownership and cleanup with guarantees appropriate
   to the current Windows Job-based lifecycle; a plain detached subprocess is
   not equivalent. Build-script naming now recognizes Linux sidecars, but the
   provenance-producing preparation and remaining build steps are still needed.
3. Implement and verify a real Linux browser host and embedded LSH surface.
   The present browser host reports unsupported on non-Windows.
4. Complete Linux media, browser Native Messaging registration and revocation,
   external drag and application build/packaging integration.
5. Build real `.deb` and AppImage candidates on the older baseline and validate
   installation, startup, exit and the requested product flows on Linux. X11
   tests do not establish Wayland, hardware audio, GPU or multi-display support.

## Partial implementation and security limits

- Linux XDG application-data lookup and a GTK external-drag implementation are
  present but have not been compiled or exercised on Linux. The GTK fixture
  compiles the actual module and checks URI escaping and image validation; it
  does not demonstrate a desktop drag or launch the application.
- Linux knowledge-index opens now refuse a final-component symlink. Parent
  directory identity, existing-note exclusivity and identity-preserving
  transactions remain unresolved; this change must not be described as a
  completed secure write implementation.
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
- Ordinary process groups, advisory `flock`, `O_NOFOLLOW`, and no-replace
  rename alone do not enforce the Windows security contract. Linux file leases
  can be broken and do not in themselves pin the whole runtime's directory and
  filename identity throughout use. A same-user external process may modify
  ordinary user-owned files despite mode bits the owner can change. A solution
  needs a documented architecture and a proof that matches the required threat
  model, potentially involving separately protected storage or privilege
  separation; no such system requirement is silently introduced here.
- The non-Windows runtime file lease still fails closed. The browser host,
  embedded LSH surface and native-messaging installation/revocation are not
  complete. Neither the probe nor the staged Node input bypasses those gates.

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
