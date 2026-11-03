"""Prepare one source-bound diagnostic build of the existing pinned test driver.

Add closed typed observations before anyhow hides the forwarding source, and
keep no idle upstream connection between forwarded requests.

CI 41558569342 (and 41521642741) lost a request 1-3 ms after it was accepted:
the forwarding trace was connect=false io=CONNECTION_RESET with tauri-driver,
the app and WebKitWebDriver all alive. connect=false means the pinned driver's
pooled hyper client wrote the request onto an idle keep-alive socket that the
native driver had already dropped (it closes them around session teardown).
With no idle pool every forwarded request opens a fresh upstream connection, so
it can no longer land on a stale one. Nothing else changes: no retries
(retry_canceled_requests stays false), same request and response bytes.
"""
import hashlib
import io
import json
import os
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath

VERSION = "2.1.0"
ARCHIVE_BYTES = 14488
ARCHIVE_SHA = "2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953"
LOCK_SHA = "94bf7caee3f76ca1d558e2636a846f12738db64264abe6dd7fa930548d3f03e1"
MAIN_SHA = "8701442faf382f7c04d27d5c885a93e63e49f9850cbbaef9efa56728d01bf574"
SERVER_SHA = "4670240b353c3430ecf5c5a6192e9107952ec5bd4eea97ee24bfb2564746fdfa"
KIND = "TAURI_2_1_0_WITH_CLOSED_FORWARD_DIAGNOSTICS_AND_NO_IDLE_UPSTREAM_POOL_NOT_RELEASE"
SOURCE_FILES = (".cargo_vcs_info.json", "CHANGELOG.md", "Cargo.lock", "Cargo.toml", "Cargo.toml.orig",
                "LICENSE-APACHE-2.0", "LICENSE-MIT", "LICENSE.spdx", "README.md", "src/cli.rs", "src/main.rs",
                "src/server.rs", "src/webdriver.rs", "src/luckyray_forward_diagnostics.rs")
sha = lambda data: hashlib.sha256(data).hexdigest()


def require(value):
    if not value:
        raise RuntimeError("pinned-driver-source-invalid")


def closure(files):
    require(set(files) == set(SOURCE_FILES))
    return sha("".join(name + "\0" + str(len(files[name])) + "\0" + sha(files[name]) + "\n" for name in sorted(files)).encode())


def verify_closure(directory):
    metadata = directory.lstat()
    require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.geteuid())
    paths = list(directory.rglob("*"))
    require(all(not path.is_symlink() for path in paths))
    require({str(path.relative_to(directory)) for path in paths if path.is_dir()} == {"src"})
    require({str(path.relative_to(directory)) for path in paths if not path.is_dir()} == set(SOURCE_FILES))
    files = {}
    for name in SOURCE_FILES:
        path = directory / name
        metadata = path.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.geteuid() and metadata.st_nlink == 1 and metadata.st_size <= 128 * 1024)
        files[name] = path.read_bytes()
    return closure(files)


FORWARD_ANCHOR = "    .request(forward_to_native_driver(new_req, args)?)\n    .err_into()"
POOL_ANCHOR = "    .retry_canceled_requests(false)\n    .build_http();"


def patch_sources(main, server):
    """Exactly one anchor each; refuse anything else instead of guessing."""
    require(main.count("mod server;") == 1)
    main = main.replace("mod server;", "mod server;\n#[cfg(any(target_os = \"linux\", windows))]\nmod luckyray_forward_diagnostics;")
    require(server.count(FORWARD_ANCHOR) == 1 and server.count(POOL_ANCHOR) == 1)
    require("pool_max_idle_per_host" not in server and "retry_canceled_requests(true)" not in server)
    server = server.replace(FORWARD_ANCHOR, "    .request(forward_to_native_driver(new_req, args)?)\n    .inspect_err(crate::luckyray_forward_diagnostics::emit)\n    .err_into()")
    server = server.replace(POOL_ANCHOR, "    .retry_canceled_requests(false)\n    .pool_max_idle_per_host(0)\n    .build_http();")
    return main, server


def prepare(archive, destination):
    require(destination.is_absolute() and destination == destination.resolve() and not destination.exists())
    parent = destination.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.geteuid() and parent.st_mode & 0o7777 == 0o700)
    metadata = archive.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_size == ARCHIVE_BYTES and metadata.st_uid == os.geteuid() and metadata.st_nlink == 1)
    with archive.open("rb") as stream:
        data = stream.read(ARCHIVE_BYTES + 1)
    require(len(data) == ARCHIVE_BYTES and sha(data) == ARCHIVE_SHA)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as package:
        members = package.getmembers()
        require(len(members) == 13 and sum(member.size for member in members) <= 256 * 1024)
        for member in members:
            path = PurePosixPath(member.name)
            require(member.isfile() and not path.is_absolute() and ".." not in path.parts and path.parts[0] == "tauri-driver-" + VERSION)
            relative = str(PurePosixPath(*path.parts[1:]))
            require(relative not in files and relative != "." and member.size <= 128 * 1024)
            value = package.extractfile(member).read(member.size + 1)
            require(len(value) == member.size)
            files[relative] = value
    require(sha(files["Cargo.lock"]) == LOCK_SHA and sha(files["src/main.rs"]) == MAIN_SHA and sha(files["src/server.rs"]) == SERVER_SHA)
    require(all(name in files for name in ("LICENSE-APACHE-2.0", "LICENSE-MIT", "LICENSE.spdx")))
    diagnostic = Path(__file__).with_name("linux-tauri-driver-forward-diagnostics.rs").read_bytes()
    main, server = patch_sources(files["src/main.rs"].decode(), files["src/server.rs"].decode())
    files["src/main.rs"], files["src/server.rs"] = main.encode(), server.encode()
    files["src/luckyray_forward_diagnostics.rs"] = diagnostic
    destination.mkdir(mode=0o700)
    for relative, value in files.items():
        output = destination / relative
        output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(value)
        output.chmod(0o600)
    return {"kind": KIND, "version": VERSION, "archiveSha256": ARCHIVE_SHA, "lockSha256": LOCK_SHA,
            "prepScriptSha256": sha(Path(__file__).read_bytes()), "diagnosticSha256": sha(diagnostic),
            "patchedMainSha256": sha(files["src/main.rs"]), "patchedServerSha256": sha(files["src/server.rs"]),
            "sourceClosureSha256": closure(files)}


if __name__ == "__main__":
    require(len(sys.argv) == 3)
    print(json.dumps(prepare(Path(sys.argv[1]), Path(sys.argv[2])), sort_keys=True))
