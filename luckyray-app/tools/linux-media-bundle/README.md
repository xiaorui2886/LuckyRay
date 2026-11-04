# Linux LGPL media bundle (T51) — CI artifact only, not a release

Builds FFmpeg 9.0.1 (`ffmpeg`, `ffprobe`) and libmpv (mpv 3186d369, same pins
as Windows v1.9.9) for Linux x86_64 under **LGPL-2.1-or-later**:

- FFmpeg: no `--enable-gpl`, `--enable-nonfree` or `--enable-version3`; the
  configure `License:` line and the shipped buildconf are checked.
- mpv: `-Dgpl=false`, libmpv only, `-Dauto_features=disabled`, software render
  only (`-Dgl=disabled -Dvulkan=disabled`); the meson option is checked.
- Static inside libmpv: FFmpeg, libplacebo v7.360.1, Lua 5.2.4 (MIT, needed by
  the app's `load-scripts`/`ytdl`/`osc` options) and libstdc++. Only `mpv_*`
  symbols are exported. Runtime NEEDED: libass.so.9, libz.so.1, libm, libgcc_s,
  libc. Vulkan-Headers 1.4.309 is compile-time only.

Every source is a pinned tarball with size and sha256 in `sources.json`
(meson 1.5.2 is a hash-checked wheel, run in place without pip).

## Files

| file | purpose |
| --- | --- |
| `build.sh <work> <out>` | fetch → verify → build → stage → `bundle.py verify` |
| `bundle.py fetch/assemble/verify/pins` | sha256 fetch, licences + `SOURCE-OFFER.txt` + `bundle-manifest.json`, exact re-verification, pins |
| `ci-build-deps.txt` | pinned ubuntu-22.04 apt packages (CI runner only) |
| `live-fixtures.sh` | synthetic clips made by the bundled ffmpeg |
| `stage-for-tauri.py` | copy a verified bundle into `src-tauri` and write a Linux-only `--config` overlay (resources + deb `Depends: libass9, zlib1g`) |

Pins: `bundle.py pins <dir>` prints `LUCKYRAY_LINUX_LIBMPV_SHA256`,
`LUCKYRAY_LINUX_LIBMPV_SIZE` (compile-time env for the Linux app) and the
manifest sha256. Always take them from the verified manifest, never by hand.

## Licence / relink / source offer

`licenses/` holds each upstream licence and `SOURCE-OFFER.txt` (exact source
URLs + sha256, a 3-year written source offer, relinking instructions: rerun
`build.sh` with modified sources, or replace `native-video/libmpv.so.2`).
Codec patents are not covered by any of these licences.

## Reproducibility

Same sources, same toolchain and same `<work>` path give bit-identical output
(checked on the box). The work path is embedded in FFmpeg's buildconf, so a
different path changes the hashes.

## Box vs CI

The CI job `linux-media-bundle` (`.github/workflows/linux-desktop-preflight.yml`)
installs `ci-build-deps.txt`, builds with pulse+alsa audio, caches the tar keyed
on this directory, and uploads it as a 3-day artifact. Box test builds use
user-local toolchains only, `LUCKYRAY_MEDIA_AUDIO=none` and a libass header shim,
so box hashes differ from CI hashes.
