#!/usr/bin/env python3
"""Linux app-owned media engine (T52 S1): pinned CPython + yt-dlp + Deno + LGPL FFmpeg.

  engine.py fetch    <download-dir> [cache-dir]
  engine.py assemble <download-dir> <verified-lgpl-bundle-dir> <out-media-engine-dir>
  engine.py verify   <media-engine-dir>
  engine.py pin      <media-engine-dir>   # LUCKYRAY_MEDIA_ENGINE_MANIFEST_SHA256=<sha>

Produces exactly the runtime-manifest.json shape media_transfer.rs
ExternalMediaResolver::app_owned reads (Windows: scripts/prepare-media-engine.ps1,
untouched). The runner is Linux-only (tools/linux-media-engine/runner.py, bare
ffmpeg/ffprobe); third_party/media-engine/runner.py stays byte-identical to
origin and is only read to assert the documented transform. yt-dlp, yt-dlp-ejs
and their licences come from the shared Windows source manifest (bound by
sha256), so both platforms pin the same versions. FFmpeg/ffprobe come only
from a T51 bundle that `linux-media-bundle/bundle.py verify` accepts.
Standard library only (the licence archive needs `zstd` on PATH or the
`zstandard` module). Never signs, uploads or releases anything.
"""
import hashlib, io, json, os, re, shlex, shutil, stat, subprocess, sys, tarfile, tempfile, urllib.request, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent.parent
SOURCES = HERE / "sources.json"
WINDOWS_RUNNER = APP / "third_party/media-engine/runner.py"
# Linux ships its own runner (bare ffmpeg/ffprobe ELF names). Windows keeps
# third_party/media-engine/runner.py byte-identical; see linux_runner_bytes().
RUNNER = HERE / "runner.py"
WINDOWS_RUNNER_SHA256 = "189408adffb96de8475dc175765a66ad308625b5dece7c844cb536262b52c9e4"
BUNDLE_PY = HERE.parent / "linux-media-bundle/bundle.py"
MANIFEST = "runtime-manifest.json"
PYTHON = "python/bin/python3.11"
LIBPYTHON = "python/lib/libpython3.11.so.1.0"
STDLIB_ZIP = "python/lib/python311.zip"
LANDMARK = "python/lib/python3.11/os.py"
DYNLOAD = "python/lib/python3.11/lib-dynload"
DENO = "deno/deno"
FFMPEG = "ffmpeg/ffmpeg"
FFPROBE = "ffmpeg/ffprobe"
EXECUTABLES = {PYTHON, LIBPYTHON, DENO, FFMPEG, FFPROBE}
MAX_FILES = 512             # media_transfer.rs refuses more
MAX_MANIFEST = 4 * 1024 * 1024
# Stdlib parts the resolver never imports; dropping them keeps the file count
# small and keeps Tk/IDLE/test code out of the shipped engine.
STDLIB_EXCLUDE = {"test", "idlelib", "tkinter", "turtledemo", "ensurepip", "site-packages",
                  "lib2to3", "__pycache__", "config-3.11-x86_64-linux-gnu", "lib-dynload", "venv"}
ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def fail(msg):
    sys.exit(f"linux-media-engine: {msg}")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def linux_runner_bytes(windows_bytes: bytes) -> bytes:
    """Windows runner -> Linux runner: only the two Path constructions change."""
    text = windows_bytes.decode("utf-8")
    a = '(ffmpeg_dir / "ffmpeg.exe")'
    b = '(ffmpeg_dir / "ffprobe.exe")'
    if a not in text or b not in text:
        fail("Windows runner missing expected ffmpeg.exe/ffprobe.exe Path constructions")
    out = text.replace(a, '(ffmpeg_dir / "ffmpeg")').replace(b, '(ffmpeg_dir / "ffprobe")')
    if out == text or '"ffmpeg.exe"' in out or '"ffprobe.exe"' in out:
        fail("Windows -> Linux runner transform did not apply cleanly")
    return out.encode("utf-8")


def assert_runners_in_sync():
    """Shared Windows runner must match its committed pin; Linux runner is that
    file with only the ffmpeg/ffprobe Path names changed."""
    win = WINDOWS_RUNNER.read_bytes()
    if sha256_bytes(win) != WINDOWS_RUNNER_SHA256:
        fail("third_party/media-engine/runner.py does not match WINDOWS_RUNNER_SHA256 pin "
             f"(got {sha256_bytes(win)}; Windows bytes must not change for T52 S1)")
    if RUNNER.read_bytes() != linux_runner_bytes(win):
        fail("tools/linux-media-engine/runner.py is not the Windows runner with only "
             "ffmpeg/ffprobe Path names changed")



def load_sources():
    sources = json.loads(SOURCES.read_text())
    shared_path = APP / sources["sharedManifest"]
    if sources.get("schemaVersion") != 1 or sha256(shared_path) != sources["sharedManifestSha256"]:
        fail("sources.json does not bind the current shared media-engine manifest")
    shared = json.loads(shared_path.read_text())
    if shared["python"]["version"] != sources["python"]["version"]:
        fail("Linux and Windows CPython versions differ")
    return sources, shared


def artifacts(sources, shared):
    out = [sources["python"], sources["pythonLicenses"], sources["deno"], shared["ytDlp"], shared["ytDlpEjs"]]
    out += shared["licenseFiles"]
    return out


def matches(path, entry):
    return (os.path.isfile(path) and not os.path.islink(path)
            and ("size" not in entry or os.path.getsize(path) == entry["size"])
            and sha256(path) == entry["sha256"])


def fetch(dl, cache=""):
    sources, shared = load_sources()
    os.makedirs(dl, exist_ok=True)
    for entry in artifacts(sources, shared):
        dest = os.path.join(dl, entry["fileName"])
        if matches(dest, entry):
            continue
        tmp = dest + ".part"
        cached = os.path.join(cache, entry["fileName"]) if cache else ""
        if cached and os.path.isfile(cached):
            shutil.copyfile(cached, tmp)
        else:
            with urllib.request.urlopen(entry["url"], timeout=180) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
        if not matches(tmp, entry):
            os.unlink(tmp)
            fail(f"{entry['fileName']}: size/sha256 mismatch")
        os.replace(tmp, dest)
        print(f"verified {entry['fileName']} {entry['sha256']}", file=sys.stderr)


def verified_download(dl, entry):
    path = os.path.join(dl, entry["fileName"])
    if not matches(path, entry):
        fail(f"{entry['fileName']}: missing or not the pinned bytes")
    return path


def safe_member(name):
    parts = name.split("/")
    return name and not name.startswith("/") and all(p not in ("", ".", "..") for p in parts)


def unpack_python(archive, dest):
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            if not safe_member(member.name) or not member.name.startswith("python/"):
                fail(f"unsafe python archive member {member.name!r}")
            if member.isdev() or member.isfifo() or member.islnk():
                fail(f"unexpected python archive member type {member.name!r}")
        tar.extractall(dest, filter="data")
    return Path(dest) / "python"


def python_licences(archive):
    """Return {name: bytes} for python/licenses/* and PYTHON.json of the full build."""
    try:
        import zstandard  # type: ignore
        with open(archive, "rb") as f:
            raw = zstandard.ZstdDecompressor().stream_reader(f).read()
    except ImportError:
        if not shutil.which("zstd"):
            fail("the CPython licence archive needs zstd or the zstandard module")
        raw = subprocess.run(["zstd", "-dc", archive], check=True, capture_output=True).stdout
    out = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
        for member in tar:
            if not member.isfile():
                continue
            if member.name.startswith("python/licenses/") and member.name.count("/") == 2:
                out[member.name.rsplit("/", 1)[1]] = tar.extractfile(member).read()
            elif member.name == "python/PYTHON.json":
                out["PYTHON.json"] = tar.extractfile(member).read()
    if "LICENSE.cpython.txt" not in out or "PYTHON.json" not in out:
        fail("CPython licence inventory incomplete")
    return out


def write_stdlib_zip(stdlib, target):
    names = []
    for d, dirs, files in os.walk(stdlib):
        rel_dir = os.path.relpath(d, stdlib)
        dirs[:] = sorted(x for x in dirs if not (rel_dir == "." and x in STDLIB_EXCLUDE) and x != "__pycache__")
        for n in sorted(files):
            if n.endswith(".py"):
                names.append(os.path.normpath(os.path.join(rel_dir, n)).replace(os.sep, "/"))
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in sorted(names):
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, (stdlib / name).read_bytes())


def walk(root):
    out = []
    for d, dirs, files in os.walk(root):
        dirs.sort()
        for n in sorted(files):
            rel = os.path.relpath(os.path.join(d, n), root).replace(os.sep, "/")
            if rel != MANIFEST:
                out.append(rel)
    return out


def assemble(dl, lgpl_bundle, out):
    sources, shared = load_sources()
    out = Path(out)
    if out.name != "media-engine" or out.exists():
        fail("output must be a new directory named media-engine")
    subprocess.run([sys.executable, str(BUNDLE_PY), "verify", lgpl_bundle], check=True)
    lgpl = Path(lgpl_bundle)
    with tempfile.TemporaryDirectory(prefix="lr-media-engine-") as work:
        work = Path(work)
        stage = work / "media-engine"
        for d in ("python/bin", DYNLOAD, "wheels", "deno", "ffmpeg", "licenses/cpython", "licenses/linux-lgpl-media"):
            (stage / d).mkdir(parents=True, exist_ok=True)
        py = unpack_python(verified_download(dl, sources["python"]), work / "py")
        for rel_src, rel_dst in (("bin/python3.11", PYTHON), ("lib/libpython3.11.so.1.0", LIBPYTHON),
                                 ("lib/python3.11/os.py", LANDMARK)):
            src = py / rel_src
            if src.is_symlink() or not src.is_file():
                fail(f"python layout: {rel_src}")
            shutil.copyfile(src, stage / rel_dst)
        for so in sorted(p for p in (py / "lib/python3.11/lib-dynload").iterdir() if not p.name.startswith("_test")):
            if so.is_symlink() or not so.is_file():
                fail(f"python layout: {so.name}")
            shutil.copyfile(so, stage / DYNLOAD / so.name)
        write_stdlib_zip(py / "lib/python3.11", stage / STDLIB_ZIP)
        for name, data in python_licences(verified_download(dl, sources["pythonLicenses"])).items():
            (stage / "licenses/cpython" / name).write_bytes(data)
        for key in ("ytDlp", "ytDlpEjs"):
            shutil.copyfile(verified_download(dl, shared[key]), stage / "wheels" / shared[key]["fileName"])
        for lic in shared["licenseFiles"]:
            shutil.copyfile(verified_download(dl, lic), stage / "licenses" / lic["fileName"])
        with zipfile.ZipFile(verified_download(dl, sources["deno"])) as z:
            if z.namelist() != ["deno"]:
                fail("deno archive layout")
            (stage / DENO).write_bytes(z.read("deno"))
        for name in ("ffmpeg", "ffprobe"):
            src = lgpl / "media-engine/ffmpeg" / name
            shutil.copyfile(src, stage / "ffmpeg" / name)
        extra = sorted(p.name for p in (lgpl / "media-engine/ffmpeg").iterdir()) != ["ffmpeg", "ffprobe"]
        if extra:
            fail("unexpected files beside the LGPL ffmpeg/ffprobe")
        shutil.copytree(lgpl / "licenses", stage / "licenses/linux-lgpl-media", dirs_exist_ok=True, symlinks=False)
        shutil.copyfile(lgpl / "bundle-manifest.json", stage / "licenses/linux-lgpl-media/bundle-manifest.json")
        shutil.copyfile(RUNNER, stage / "runner.py")
        for rel in walk(stage):
            os.chmod(stage / rel, 0o755 if rel in EXECUTABLES else 0o644)
        for d, dirs, _ in os.walk(stage):
            os.chmod(d, 0o755)
        check_python(stage)
        files = [{"path": r, "size": os.path.getsize(stage / r), "sha256": sha256(stage / r)} for r in walk(stage)]
        manifest = {
            "schemaVersion": 1,
            "sourceManifestSha256": sha256(SOURCES),
            "pythonVersion": sources["python"]["version"],
            "python": PYTHON,
            "ytDlpVersion": shared["ytDlp"]["version"],
            "ytDlpWheel": "wheels/" + shared["ytDlp"]["fileName"],
            "ytDlpEjsWheel": "wheels/" + shared["ytDlpEjs"]["fileName"],
            "deno": DENO,
            "ffmpeg": FFMPEG,
            "files": files,
        }
        (stage / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n")
        os.chmod(stage / MANIFEST, 0o644)
        verify(stage)
        shutil.move(str(stage), str(out))
    verify(out)


def check_python(root):
    """The staged interpreter must start isolated, from an empty environment,
    with the stdlib from its own zip and report exactly the pinned version."""
    code = ("import sys,ssl,sqlite3,json,zipimport;"
            "assert sys.version_info[:3]==(3,11,8),sys.version;"
            "assert sys.path[0].endswith('/python/lib/python311.zip'),sys.path;"
            "assert json.__file__.startswith(sys.path[0]),json.__file__;print('ok')")
    r = subprocess.run([str(root / PYTHON), "-I", "-B", "-c", code], env={}, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, timeout=60)
    if r.returncode != 0 or r.stdout.strip() != "ok":
        fail("staged CPython does not start isolated from its own stdlib zip: " + (r.stderr or r.stdout)[-600:])


ELF = b"\x7fELF"


def verify(root):
    assert_runners_in_sync()
    root = Path(root)
    mpath = root / MANIFEST
    if mpath.is_symlink() or not mpath.is_file() or mpath.stat().st_size > MAX_MANIFEST:
        fail("runtime-manifest.json missing or oversized")
    m = json.loads(mpath.read_text())
    expected_keys = {"schemaVersion", "sourceManifestSha256", "pythonVersion", "python", "ytDlpVersion",
                     "ytDlpWheel", "ytDlpEjsWheel", "deno", "ffmpeg", "files"}
    if set(m) != expected_keys or m["schemaVersion"] != 1:
        fail("runtime-manifest.json shape")
    sources, shared = load_sources()
    if (m["pythonVersion"] != "3.11.8" or m["ytDlpVersion"] != shared["ytDlp"]["version"]
            or m["sourceManifestSha256"] != sha256(SOURCES)
            or (m["python"], m["deno"], m["ffmpeg"]) != (PYTHON, DENO, FFMPEG)):
        fail("runtime-manifest.json pins")
    if not 0 < len(m["files"]) <= MAX_FILES:
        fail("file count outside 1..512")
    declared = [f["path"] for f in m["files"]]
    if declared != walk(root) or len(set(declared)) != len(declared):
        fail("file set differs from runtime-manifest.json")
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            st = os.lstat(os.path.join(d, n))
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                fail(f"{n}: not a plain file or directory")
            if st.st_mode & 0o7022 or (stat.S_ISREG(st.st_mode) and st.st_nlink != 1):
                fail(f"{n}: writable, setid or hard-linked")
    for f in m["files"]:
        p = root / f["path"]
        if not set(f) == {"path", "size", "sha256"} or not matches(p, f):
            fail(f"{f['path']}: size/sha256 mismatch")
        mode = os.lstat(p).st_mode & 0o777
        if mode != (0o755 if f["path"] in EXECUTABLES else 0o644):
            fail(f"{f['path']}: mode {mode:o}")
        if f["path"] in EXECUTABLES and p.open("rb").read(4) != ELF:
            fail(f"{f['path']}: not ELF")
    for need in ("runner.py", m["ytDlpWheel"], m["ytDlpEjsWheel"], LIBPYTHON, STDLIB_ZIP, LANDMARK, FFPROBE,
                 "licenses/cpython/LICENSE.cpython.txt", "licenses/linux-lgpl-media/SOURCE-OFFER.txt",
                 *("licenses/" + lic["fileName"] for lic in shared["licenseFiles"])):
        if need not in declared:
            fail(f"missing {need}")
    if sha256(root / "runner.py") != sha256(RUNNER):
        fail("runner.py differs from tools/linux-media-engine/runner.py")
    print(f"media engine ok: {len(declared)} files", file=sys.stderr)
    return m


PIN = re.compile(r"^LUCKYRAY_MEDIA_ENGINE_MANIFEST_SHA256=[0-9a-f]{64}$")


def pin(root):
    verify(root)
    line = "LUCKYRAY_MEDIA_ENGINE_MANIFEST_SHA256=" + shlex.quote(sha256(Path(root) / MANIFEST))
    if not PIN.match(line):
        fail("pin is not a plain assignment")
    print(line)


if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["help"]
    if cmd == "fetch" and len(args) in (1, 2):
        fetch(*args)
    elif cmd == "assemble" and len(args) == 3:
        assemble(*args)
    elif cmd == "verify" and len(args) == 1:
        verify(args[0])
    elif cmd == "pin" and len(args) == 1:
        pin(args[0])
    else:
        sys.exit(__doc__)
