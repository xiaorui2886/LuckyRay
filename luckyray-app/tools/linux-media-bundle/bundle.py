#!/usr/bin/env python3
"""Fetch/verify sources, assemble licences + manifest, verify a bundle, emit pins.

  bundle.py fetch    <sources.json> <download-dir> [cache-dir]
  bundle.py assemble <sources.json> <src-dir> <stage-dir>
  bundle.py verify   <bundle-dir>
  bundle.py pins     <bundle-dir>      # KEY=VALUE lines for the app build
Standard library only.
"""
import hashlib, json, os, shutil, stat, sys, urllib.request

MANIFEST = "bundle-manifest.json"
LIBMPV = "native-video/libmpv.so.2"   # = linux_mpv::LIBRARY_RELATIVE
FFMPEG = "media-engine/ffmpeg/ffmpeg"
FFPROBE = "media-engine/ffmpeg/ffprobe"
MAX = 512 * 1024 * 1024


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fail(msg):
    sys.exit(f"linux-media-bundle: {msg}")


def checked(path, entry):
    return os.path.isfile(path) and os.path.getsize(path) == entry["size"] and sha256(path) == entry["sha256"]


def fetch(sources, dl, cache):
    os.makedirs(dl, exist_ok=True)
    for s in json.load(open(sources))["sources"]:
        dest = os.path.join(dl, s["fileName"])
        if checked(dest, s):
            continue
        cached = os.path.join(cache, s["fileName"]) if cache else ""
        tmp = dest + ".part"
        if cached and os.path.isfile(cached):
            shutil.copyfile(cached, tmp)
        else:
            with urllib.request.urlopen(s["url"], timeout=120) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
        if not checked(tmp, s):
            os.unlink(tmp)
            fail(f"{s['fileName']}: size/sha256 mismatch")
        os.replace(tmp, dest)
        print(f"verified {s['fileName']} {s['sha256']}")


def walk(root):
    out = []
    for d, dirs, files in os.walk(root):
        dirs.sort()
        for n in sorted(files):
            p = os.path.join(d, n)
            rel = os.path.relpath(p, root)
            if rel != MANIFEST:
                out.append(rel)
    return out


SOURCE_OFFER = """LuckyRay Linux media bundle - corresponding source and relinking
===================================================================

This bundle contains FFmpeg {ffmpeg} (LGPL-2.1-or-later), libplacebo {placebo}
(LGPL-2.1-or-later) and libmpv built from mpv commit {mpv} with -Dgpl=false
(LGPL-2.1-or-later). FFmpeg and libplacebo are statically linked into
native-video/libmpv.so.2 and into the ffmpeg/ffprobe tools.

Corresponding source: the exact upstream tarballs listed below (URL, size,
SHA-256), unmodified, plus the build script that produced this bundle
(luckyray-app/tools/linux-media-bundle/build.sh in the LuckyRay source at the
commit that built it). Rebuilding with a modified FFmpeg, libplacebo or mpv
source and dropping the resulting libmpv.so.2 / ffmpeg / ffprobe in place is
the supported way to exercise your LGPL rights to modify and relink.
On request, LuckyRay provides the same source archives for at least three years
from distribution of this bundle.

Vulkan-Headers {vk} (Apache-2.0 OR MIT) were used only as compile-time headers for\nlibplacebo's disabled-Vulkan stubs.\n\nLua {lua} (MIT) is statically linked into libmpv.so.2.\n\nSystem libraries used dynamically (not shipped here): glibc, libstdc++ (GCC runtime exception), zlib, libass
(ISC) with its FreeType/HarfBuzz/FriBidi dependencies, PulseAudio client and
ALSA (LGPL-2.1-or-later).

Codec patents are a separate matter from these copyright licences; no patent
licence is granted or implied.

Sources:
{sources}
"""


def assemble(sources, src, stage):
    spec = json.load(open(sources))["sources"]
    lic = os.path.join(stage, "licenses")
    os.makedirs(lic, exist_ok=True)
    by = {s["name"]: s for s in spec}
    dirs = {"ffmpeg": "ffmpeg-9.0.1", "libplacebo": "libplacebo-v7.360.1",
            "mpv": "mpv-3186d369f9f090cd1363be0ac46a037824b702c6",
            "lua": "lua-5.2.4",
            "vulkan-headers": "libplacebo-v7.360.1/3rdparty/Vulkan-Headers"}
    for name, d in dirs.items():
        for f in by[name]["licenseFiles"]:
            p = os.path.join(src, d, f)
            if not os.path.isfile(p):
                fail(f"missing licence file {d}/{f}")
            shutil.copyfile(p, os.path.join(lic, f"{name}-" + f.replace("/", "-")))
    lines = "\n".join(f"- {s['name']} {s['version']}: {s['url']}\n  size {s['size']}, sha256 {s['sha256']}, {s['license']}"
                      for s in spec if s["name"] in dirs)
    with open(os.path.join(lic, "SOURCE-OFFER.txt"), "w") as f:
        f.write(SOURCE_OFFER.format(ffmpeg=by["ffmpeg"]["version"], placebo=by["libplacebo"]["version"],
                                    mpv=by["mpv"]["version"], lua=by["lua"]["version"], vk=by["vulkan-headers"]["version"], sources=lines))
    for rel in walk(stage):
        os.chmod(os.path.join(stage, rel), 0o755 if rel in (LIBMPV, FFMPEG, FFPROBE) else 0o644)
    manifest = {
        "schemaVersion": 1,
        "status": "ci-artifact-not-a-release",
        "license": "LGPL-2.1-or-later",
        "libmpv": LIBMPV, "ffmpeg": FFMPEG, "ffprobe": FFPROBE,
        "sources": [{k: s[k] for k in ("name", "version", "url", "size", "sha256", "license")}
                    for s in spec if s["name"] in dirs],
        "files": [{"path": r, "size": os.path.getsize(os.path.join(stage, r)),
                   "sha256": sha256(os.path.join(stage, r))} for r in walk(stage)],
    }
    with open(os.path.join(stage, MANIFEST), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")


def verify(root):
    m = json.load(open(os.path.join(root, MANIFEST)))
    if m.get("schemaVersion") != 1 or m.get("license") != "LGPL-2.1-or-later":
        fail("manifest schema/licence")
    declared = [f["path"] for f in m["files"]]
    if declared != walk(root):
        fail("file set differs from manifest")
    for f in m["files"]:
        p = os.path.join(root, f["path"])
        st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX or not checked(p, f):
            fail(f"{f['path']}: mismatch")
    for need in (LIBMPV, FFMPEG, FFPROBE, "licenses/SOURCE-OFFER.txt", "licenses/ffmpeg-buildconf.txt"):
        if need not in declared:
            fail(f"missing {need}")
    conf = open(os.path.join(root, "licenses/ffmpeg-buildconf.txt")).read()
    for bad in ("--enable-gpl", "--enable-nonfree", "--enable-version3"):
        if bad in conf:
            fail(f"ffmpeg built with {bad}")
    print(f"bundle ok: {len(declared)} files")
    return m


def pins(root):
    m = verify(root)
    f = {e["path"]: e for e in m["files"]}
    print(f"LUCKYRAY_LINUX_LIBMPV_SHA256={f[LIBMPV]['sha256']}")
    print(f"LUCKYRAY_LINUX_LIBMPV_SIZE={f[LIBMPV]['size']}")
    print(f"LUCKYRAY_LINUX_MEDIA_BUNDLE_MANIFEST_SHA256={sha256(os.path.join(root, MANIFEST))}")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["help"]
    if cmd == "fetch" and len(args) in (2, 3):
        fetch(args[0], args[1], args[2] if len(args) == 3 else "")
    elif cmd == "assemble" and len(args) == 3:
        assemble(*args)
    elif cmd == "verify" and len(args) == 1:
        verify(args[0])
    elif cmd == "pins" and len(args) == 1:
        pins(args[0])
    else:
        sys.exit(__doc__)
