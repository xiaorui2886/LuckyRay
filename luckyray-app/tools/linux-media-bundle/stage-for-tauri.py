#!/usr/bin/env python3
"""Stage a verified LGPL media bundle into a Tauri resource root (Linux only).

usage: stage-for-tauri.py <verified-bundle-dir> <src-tauri-dir> <overlay-out.json>

Copies native-video/, media-engine/ffmpeg/ and licenses/ into <src-tauri-dir>,
writes a Linux-only Tauri config overlay (resources + deb Depends) for use with
`tauri build --config <overlay-out.json>`, and prints the compile-time pins.
Nothing here builds, signs, uploads or releases; Windows/macOS are untouched.
"""
import json, shutil, subprocess, sys
from pathlib import Path

here = Path(__file__).resolve().parent


def main(bundle: str, tauri: str, overlay: str) -> None:
    bundle_dir, tauri_dir = Path(bundle).resolve(), Path(tauri).resolve()
    subprocess.run([sys.executable, str(here / "bundle.py"), "verify", str(bundle_dir)], check=True)
    pins = subprocess.run([sys.executable, str(here / "bundle.py"), "pins", str(bundle_dir)],
                          check=True, capture_output=True, text=True).stdout
    copies = {"native-video": "native-video", "media-engine/ffmpeg": "media-engine/ffmpeg",
              "licenses": "third-party-notices/linux-lgpl-media"}
    for src, dst in copies.items():
        target = tauri_dir / dst
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(bundle_dir / src, target, symlinks=False)
    shutil.copy2(bundle_dir / "bundle-manifest.json", tauri_dir / "third-party-notices/linux-lgpl-media/bundle-manifest.json")
    config = {
        "bundle": {
            "resources": {"native-video/": "native-video/"},
            "linux": {"deb": {"depends": ["libass9", "zlib1g"]}},
        }
    }
    Path(overlay).write_text(json.dumps(config, indent=2) + "\n")
    sys.stdout.write(pins)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
