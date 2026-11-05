#!/usr/bin/env python3
"""T52 S5: verify the .deb and AppImage produced by `tauri build` on Linux.

  artifacts.py verify <bundle-dir> <src-tauri>

<bundle-dir> is $CARGO_TARGET_DIR/release/bundle. Both packages must exist under
their exact names (LuckyRay_<version>_amd64.deb / .AppImage). Each is extracted
into a private temporary directory (dpkg-deb -x; AppImage --appimage-extract) and
its installed tree must hold, byte-for-byte and with matching executable bits:
the sealed LSH runtime and dsh-host, the Agent Browser bundle, the media engine,
the third-party notices, the four LSH redistribution records, the four sidecars
and the main binary. The deb must also carry the AppArmor profile. Output names
only package-relative paths and counts.
"""
import hashlib, json, os, shutil, stat, subprocess, sys, tempfile
from pathlib import Path

PRODUCT = "LuckyRay"
MAIN = "luckyray-app"
TARGET = "x86_64-unknown-linux-gnu"
SIDECARS = ("luckyray-native-host", "luckyray-cli", "luckyray-mcp", "luckyray-browser-host")
RECORDS = ("runtime-authority.json", "runtime-manifest.json", "dependency-audit.json", "THIRD-PARTY-NOTICES.txt")
APPARMOR = "usr/share/luckyray/apparmor/luckyray-agent-browser"


class Refused(Exception):
    pass


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def executable(path):
    return bool(os.lstat(path).st_mode & stat.S_IXUSR)


def tree(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise Refused(f"{root.name}: directory missing")
    out = {}
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            p = Path(d) / n
            mode = os.lstat(p).st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise Refused(f"{p.relative_to(root)}: not a plain file or directory")
            if stat.S_ISREG(mode):
                out[p.relative_to(root).as_posix()] = (digest(p), bool(mode & stat.S_IXUSR))
    return out


def same_file(source, packaged, label, need_exec=None):
    packaged = Path(packaged)
    if packaged.is_symlink() or not packaged.is_file():
        raise Refused(f"{label}: missing")
    if digest(source) != digest(packaged):
        raise Refused(f"{label}: bytes differ")
    if (executable(source) if need_exec is None else need_exec) and not executable(packaged):
        raise Refused(f"{label}: not executable")


def verify_root(root, src_tauri, kind):
    """Check one extracted package root; returns a count summary."""
    root, src = Path(root), Path(src_tauri)
    app = src.parent
    res = root / "usr/lib" / PRODUCT
    trees = {
        "lr-lsh/199-1/deepseek-harness": src / "dsh",
        "lr-lsh/199-1/dsh-host": src / "dsh-host",
        "agent-browser": src / "agent-browser",
        "media-engine": src / "media-engine",
        "third-party-notices": app / "third-party-notices",
    }
    counts = {}
    for target, source in trees.items():
        want, got = tree(source), tree(res / target)
        if set(want) != set(got):
            raise Refused(f"{kind} {target}: file set differs ({len(got)} packaged, {len(want)} staged)")
        for rel, (sha, exe) in want.items():
            if got[rel][0] != sha:
                raise Refused(f"{kind} {target}/{rel}: bytes differ")
            if exe and not got[rel][1]:
                raise Refused(f"{kind} {target}/{rel}: not executable")
        counts[target] = len(want)
    for name in RECORDS:
        same_file(app / "dsh-host/linux-x64" / name, res / "licenses/lsh-linux" / name, f"{kind} licenses/lsh-linux/{name}")
    for name in SIDECARS:
        same_file(src / "binaries" / f"{name}-{TARGET}", root / "usr/bin" / name, f"{kind} usr/bin/{name}", True)
    main = root / "usr/bin" / MAIN
    if main.is_symlink() or not main.is_file() or not executable(main):
        raise Refused(f"{kind} usr/bin/{MAIN}: missing or not executable")
    if kind == "deb":
        same_file(src / "linux/apparmor/luckyray-agent-browser", root / APPARMOR, f"deb {APPARMOR}")
    counts["licenses/lsh-linux"] = len(RECORDS)
    counts["sidecars"] = len(SIDECARS)
    return counts


def version(src_tauri):
    return json.loads((Path(src_tauri) / "tauri.conf.json").read_text())["version"]


def package_paths(bundle, ver):
    bundle = Path(bundle)
    deb = bundle / "deb" / f"{PRODUCT}_{ver}_amd64.deb"
    appimage = bundle / "appimage" / f"{PRODUCT}_{ver}_amd64.AppImage"
    for p in (deb, appimage):
        if p.is_symlink() or not p.is_file() or p.stat().st_size == 0:
            raise Refused(f"{p.parent.name}/{p.name}: missing")
    return deb, appimage


def extract_deb(deb, into):
    subprocess.run(["dpkg-deb", "-x", str(deb), str(into)], check=True, timeout=600)
    return Path(into)


def extract_appimage(appimage, into):
    work = Path(into)
    work.mkdir()
    copy = work / "package.AppImage"
    shutil.copyfile(appimage, copy)
    os.chmod(copy, 0o700)
    subprocess.run([str(copy), "--appimage-extract"], cwd=work, check=True, timeout=600,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return work / "squashfs-root"


def verify(bundle, src_tauri, extract=(extract_deb, extract_appimage)):
    src_tauri = Path(src_tauri).resolve()
    ver = version(src_tauri)
    deb, appimage = package_paths(bundle, ver)
    summary = {"status": "PASS", "version": ver, "deb": deb.name, "appimage": appimage.name}
    with tempfile.TemporaryDirectory(prefix="luckyray-pkg-") as tmp:
        summary["debContents"] = verify_root(extract[0](deb, Path(tmp) / "deb"), src_tauri, "deb")
        summary["appimageContents"] = verify_root(extract[1](appimage, Path(tmp) / "appimage"), src_tauri, "appimage")
    return summary


def main(argv):
    if len(argv) != 4 or argv[1] != "verify":
        print(__doc__, file=sys.stderr)
        return 2
    try:
        summary = verify(argv[2], argv[3])
    except (Refused, OSError, ValueError, KeyError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"linux package refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
