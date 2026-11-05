# Linux app-owned media engine (T52 S1) — CI artifact only, not a release

Assembles `resources/media-engine/` for Linux x86_64 in exactly the shape
`media_transfer.rs` `ExternalMediaResolver::app_owned` verifies (the Linux
counterpart of `scripts/prepare-media-engine.ps1`):

| path | source |
| --- | --- |
| `runner.py` | `tools/linux-media-engine/runner.py` (Linux-only; bare `ffmpeg`/`ffprobe` names). Windows keeps `third_party/media-engine/runner.py` byte-identical; `test_engine.py` pins its sha256 and checks this file equals that runner with only the two Path constructions renamed. |
| `python/bin/python3.11`, `python/lib/libpython3.11.so.1.0` | python-build-standalone 20240224, CPython 3.11.8 `install_only` |
| `python/lib/python311.zip` | that build's stdlib `.py` files, minus `test`, `idlelib`, `tkinter`, `turtledemo`, `ensurepip`, `lib2to3`, `venv`, `site-packages`, bytecode; fixed timestamps |
| `python/lib/python3.11/os.py` | getpath landmark only (`os` itself is frozen) |
| `python/lib/python3.11/lib-dynload/*` | that build, minus `_test*` |
| `wheels/` | yt-dlp 2026.7.4 + yt-dlp-ejs 0.8.0 from the shared Windows manifest |
| `deno/deno` | Deno 2.9.4 official zip (sha matches the release `.sha256sum`) |
| `ffmpeg/ffmpeg`, `ffmpeg/ffprobe` | only from a T51 LGPL bundle that `linux-media-bundle/bundle.py verify` accepts |
| `licenses/cpython/` | `python/licenses/*` + `PYTHON.json` of the same build's `pgo+lto-full` archive (OpenSSL, SQLite, libffi, zlib, …) |
| `licenses/linux-lgpl-media/` | the T51 bundle's licences, source offer and manifest |
| `licenses/*-LICENSE` | yt-dlp, yt-dlp-ejs, Deno (shared Windows manifest) |

`sources.json` pins every Linux download (url, size, sha256) and binds the
shared Windows manifest by sha256, so both platforms ship the same yt-dlp.

```
engine.py fetch    <download-dir> [cache-dir]
engine.py assemble <download-dir> <verified-lgpl-bundle> <out>/media-engine
engine.py verify   <out>/media-engine
engine.py pin      <out>/media-engine   # LUCKYRAY_MEDIA_ENGINE_MANIFEST_SHA256=...
python3 test_engine.py                  # offline, synthetic
```

`verify` mirrors the Rust checks (exact schema and pins, at most 512 files, the
exact declared file set, sizes and hashes) and adds no-symlink, no-hard-link,
mode (0755 ELF executables / 0644 data, nothing group/world-writable or setid)
and ELF-header checks. `assemble` also starts the staged interpreter isolated
(`-I -B`, empty environment) and requires it to load the stdlib from its zip.

Not covered here: real (non-loopback) site extraction; CA discovery uses the
build's OpenSSL defaults (`/etc/ssl`), as the distro packages do. Desktop
packaging (S2/S3) and any release use are separate decisions.
