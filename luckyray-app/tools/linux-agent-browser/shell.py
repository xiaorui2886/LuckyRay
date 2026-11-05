#!/usr/bin/env python3
"""T55: fetch, verify and unpack the pinned chrome-headless-shell.

    shell.py fetch <archive>      download pin.json's url, check size + sha256
    shell.py unpack <archive> <dir>  check the archive again, unpack, check the executable
    shell.py verify <dir>         re-check the unpacked executable and licence files
    shell.py stage <archive> <dir>   unpack into a fresh <dir> and check the whole-bundle digest
    shell.py bundle-digest <dir>  print the whole-bundle digest and file count

The bundle digest is the sha256 of the sorted manifest lines
"<sha256>  <mode>  <path>\n" over every regular file (mode 755 or 644, paths
relative to <dir>). Symlinks, special files and other modes are refused.
scripts/linux/check-agent-browser-bundle.mjs computes the same digest.

Prints only the pinned version and hashes, never environment or paths of the
user. Exits non-zero on any mismatch.
"""
import hashlib, json, os, pathlib, stat, sys, urllib.request, zipfile

HERE = pathlib.Path(__file__).resolve().parent
PIN = json.loads((HERE / "pin.json").read_text())


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_archive(archive):
    archive = pathlib.Path(archive)
    if archive.stat().st_size != PIN["size"] or sha256(archive) != PIN["sha256"]:
        sys.exit("pinned archive mismatch")


def fetch(archive):
    archive = pathlib.Path(archive)
    if not PIN["url"].startswith("https://storage.googleapis.com/chrome-for-testing-public/"):
        sys.exit("unexpected source")
    partial = archive.with_suffix(".partial")
    with urllib.request.urlopen(PIN["url"], timeout=120) as response, open(partial, "wb") as out:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            if out.tell() > PIN["size"]:
                sys.exit("pinned archive too large")
    check_archive(partial)
    partial.replace(archive)


def unpack(archive, target):
    check_archive(archive)
    target = pathlib.Path(target)
    target.mkdir(parents=True, exist_ok=False)
    root = target.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            destination = (root / info.filename).resolve()
            if root not in destination.parents and destination != root:
                sys.exit("archive escapes its directory")
            mode = (info.external_attr >> 16) & 0o777
            if stat.S_ISLNK(info.external_attr >> 16):
                sys.exit("archive symlink refused")
            bundle.extract(info, root)
            if not info.is_dir():
                os.chmod(destination, 0o755 if mode & 0o111 else 0o644)
    verify(target)


def verify(target):
    target = pathlib.Path(target)
    executable = target / PIN["executable"]
    if not executable.is_file() or executable.is_symlink():
        sys.exit("pinned executable missing")
    if sha256(executable) != PIN["executableSha256"]:
        sys.exit("pinned executable mismatch")
    for name in PIN["licenseFiles"]:
        if not (target / name).is_file():
            sys.exit("licence file missing")
    print(f"chrome-headless-shell {PIN['version']} archive-sha256={PIN['sha256']} executable-sha256={PIN['executableSha256']}")


def bundle_manifest(target):
    root = pathlib.Path(target)
    lines = []
    for current, directories, files in os.walk(root):
        for name in sorted(directories + files):
            path = pathlib.Path(current) / name
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                sys.exit("bundle entry is not a regular file")
            mode = stat.S_IMODE(info.st_mode)
            if mode not in (0o755, 0o644):
                sys.exit("bundle file mode refused")
            lines.append(f"{sha256(path)}  {mode:o}  {path.relative_to(root).as_posix()}\n")
    lines.sort()
    return lines


def bundle_digest(target, quiet=False):
    lines = bundle_manifest(target)
    digest = hashlib.sha256("".join(lines).encode()).hexdigest()
    if not quiet:
        print(f"bundle-sha256={digest} files={len(lines)}")
    return digest, len(lines)


def stage(archive, target):
    unpack(archive, target)
    if bundle_digest(target, quiet=True) != (PIN["bundleSha256"], PIN["bundleFileCount"]):
        sys.exit("pinned bundle mismatch")
    print(f"bundle-sha256={PIN['bundleSha256']} files={PIN['bundleFileCount']}")


if __name__ == "__main__":
    commands = {
        "fetch": (fetch, 1),
        "unpack": (unpack, 2),
        "verify": (verify, 1),
        "stage": (stage, 2),
        "bundle-digest": (bundle_digest, 1),
    }
    if len(sys.argv) < 2 or sys.argv[1] not in commands or len(sys.argv) != commands[sys.argv[1]][1] + 2:
        sys.exit(__doc__)
    commands[sys.argv[1]][0](*sys.argv[2:])
