# Mac DSH source and library modification materials

The original packages, license grants and copyright notices remain in
`host/node_modules` and `node/LICENSE`. `distribution/index.json` identifies
verbatim notice bodies, source inputs, upstream recipes and any missing input.
The app's own MIT license does not replace any component's terms.

## Obtain the corresponding source

Provided archives and patches are in `distribution/sources/archives`. Their
original names, exact SHA-256 digests, byte sizes and component associations are
in the index. They are archives stored with a `.source` extension; copy them to
the recorded original name or let `tar`/`unzip` inspect their format. Engine
source and patches already shipped by the exact LibreOffice package are in
`distribution/sources/packaged` and their original package locations.

A source URL with `provided: false` is a reference, not delivered source. An
index with `readyToPackage: false` is an incomplete build stage. The controlled
product builder refuses app/DMG distribution in that state. Missing source must
be obtained and verified, added to the reviewed source-input manifest, and
included with the candidate before packaging. No network link is substituted
for an unavailable source archive, and no new long-term written source offer
or source-hosting service is promised here.

## Build a modified libvips library

1. Use a separate writable source checkout and an empty build directory on an
   Apple Silicon Mac. Preserve the original app and its data. The upstream
   scripts require Xcode command-line tools, pkg-config, Meson, CMake, make,
   autotools, NASM, and a suitable Rust nightly with cargo-c. These are build
   prerequisites, not additional runtime dependencies. This preparation step
   does not install those tools or run upstream source scripts.
2. Copy the preserved recipe tree from `distribution/sources/recipes`. Keep
   `build.sh`, `build/posix.sh`, `versions.properties`, the Darwin ARM64 platform
   files and the original LICENSE together. The recipe is from sharp-libvips
   commit `ebb95f8add54eee8bed840e3fb587e4cbec857d7`, package version 1.3.4,
   libvips 8.18.7. It includes upstream source patches and inline source edits;
   retaining only the unpatched libvips tarball is insufficient.
3. Match every recipe download to the indexed provided archive or patch. Use
   those local files when adapting the download commands. Preserve all upstream
   patches and apply the inline edits shown in the recipe. The recipe's Rust
   toolchain install was not version-pinned upstream. Use an already installed
   suitable toolchain and record it; do not claim a bit-identical reproduction
   from a guessed compiler version. Librsvg's effective Cargo lock and source
   dependencies, and glib's fallback subprojects, must also be supplied before
   the source set is considered complete.
4. Make the desired source modification, retain its original licensing, and
   document that modification. From that recipe directory, the upstream native
   entry is `bash build.sh darwin-arm64v8`. Review the recipe before running it;
   upstream installation/download commands must be adjusted for the preinstalled
   tools and local source set. The resulting library is
   `target/lib-filtered/libvips-cpp.8.18.7.dylib`. Its public ABI and install name
   must remain compatible with the sharp addon. This document does not assert
   that the modified library has already been compiled or tested.

## Recombine the app with an interface-compatible library

The frozen sharp addon is a separate Mach-O module. Its load command names
`@rpath/libvips-cpp.8.18.7.dylib`; its loader-relative paths select the adjacent
`@img/sharp-libvips-darwin-arm64/lib` directory. This is the replacement boundary,
not an instruction to load an arbitrary library into the original signed app.

Use a source build of LuckyRay under its MIT terms. Stage the modified library
at that package's existing library path, preserve the original notices, and
regenerate the fork's package fingerprint and inventories for the actual new
bytes. The stock build's exact six-file libvips admission intentionally accepts
only the official input; it must not falsely describe modified bytes as that
input. Build the fork's matching sidecars, source identity and app together
through `scripts/build-macos.mjs`. Keep a separate profile and source identity;
the modified build is not entitled to the stock app's credentials or accounts.

macOS signatures cover modified code. Re-sign the modified build with its own
ad-hoc signatures through that build process, instead of editing the installed
official app, bypassing its checks, disabling Gatekeeper, or changing system
permissions. Developer ID or Apple account access is not required for the
controlled ad-hoc build. Validate a replacement with real module loading and
an image operation using the modified ABI-compatible library. These source
instructions do not claim that this native replacement check has already run.

## Other source and licensing scopes

The LibreOffice engine includes its own MPL source revision, modification
patches and build helper sources. Its preferred adapter source and embedded
component sources must be mapped to the exact published build; a merely
same-numbered repository snapshot is not asserted as byte provenance.

Sherpa's npm Apache-2.0 declaration does not describe all code in its native
libraries. The frozen Mac C API defines eSpeak NG symbols and includes that
GPLv3 component. Its exact source/COPYING and pinned build inputs are indexed.
The GPL-covered combined runtime's complete source and license scope must be
settled before distributing it. This document neither relicenses all LuckyRay
code as GPL nor silently removes TTS or widens a package-license allowlist.

The original cairo MPL-1.1 notice and AOM Patent License 1.0 are retained. MPL
sections 3.2/3.6 concern source availability and executable notices; section 3.7
permits larger works while retaining the covered code's terms. AOM section
1.2.1 concerns Necessary Claims and reproducing the patent license, and section
1.3 supplies its defensive-termination condition. Preparing these texts adds no
separate patent grant, warranty or support commitment by LuckyRay. No specific
conflicting project policy has been identified merely from these license names.
