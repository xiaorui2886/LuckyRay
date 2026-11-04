#!/usr/bin/env python3
"""Prepare a synthetic, pinned media runtime for the T45 Linux preview smoke.

Only the *generator* lives here: the manifest shape mirrors
src-tauri/src/media_transfer.rs `Synthetic::manifest()`. Verification is never
reimplemented -- the production `ExternalMediaResolver::app_owned` (manifest
sha, per-file sha/size, exact inventory) is the sole authority. ffmpeg and
ffprobe are byte copies of the runner's pinned apt binaries (not wrappers), so
the digest, the descriptor pins and the tamper check cover the executable that
actually runs. The copies still load the runner's system libav* libraries; the
runtime is test-only and never shipped (see T45-result.md, V4 licensing).

Usage: linux-media-preview-runtime.py <media-engine-dir> <ffmpeg-bin> <ffprobe-bin>
Prints only the runtime manifest sha256 (needed as a compile-time env var).
"""

import hashlib
import json
import os
import pathlib
import stat
import sys


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    root = pathlib.Path(sys.argv[1])
    ffmpeg_bin = pathlib.Path(sys.argv[2]).resolve()
    ffprobe_bin = pathlib.Path(sys.argv[3]).resolve()
    if not (ffmpeg_bin.is_file() and ffprobe_bin.is_file()):
        raise SystemExit("pinned ffmpeg/ffprobe binaries missing")
    if root.exists() and any(root.iterdir()):
        raise SystemExit("media-engine directory must start empty")
    root.mkdir(parents=True, exist_ok=True)
    files = {
        "bin/python3": b"#!/bin/sh\nexit 0\n",
        "runner.py": b"print('synthetic runner')\n",
        "wheels/yt_dlp.whl": b"synthetic wheel",
        "wheels/ejs.whl": b"synthetic ejs wheel",
        "bin/deno": b"synthetic deno",
        "ffmpeg/ffmpeg": ffmpeg_bin.read_bytes(),
        "ffmpeg/ffprobe": ffprobe_bin.read_bytes(),
    }
    declared = []
    for relative, data in sorted(files.items()):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        if relative.startswith("ffmpeg/") or relative.startswith("bin/"):
            path.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        declared.append({"path": relative, "size": len(data), "sha256": sha256(data)})
    manifest = {
        "schemaVersion": 1,
        "sourceManifestSha256": "0" * 64,
        "pythonVersion": "3.11.8",
        "python": "bin/python3",
        "ytDlpVersion": "2026.7.4",
        "ytDlpWheel": "wheels/yt_dlp.whl",
        "ytDlpEjsWheel": "wheels/ejs.whl",
        "deno": "bin/deno",
        "ffmpeg": "ffmpeg/ffmpeg",
        "files": declared,
    }
    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    (root / "runtime-manifest.json").write_bytes(manifest_bytes)
    print(sha256(manifest_bytes))
    print("synthetic runtime prepared", file=sys.stderr)


if __name__ == "__main__":
    main()
