"""Prepare one source-bound diagnostic build of the existing pinned test driver.

Only add closed typed observations before anyhow hides the forwarding source.
Do not alter the client builder, pool, retry policy, request or response behavior.
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
KIND = "TAURI_2_1_0_WITH_CLOSED_FORWARD_DIAGNOSTICS_NOT_RELEASE"
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
    main = files["src/main.rs"].decode()
    require(main.count("mod server;") == 1)
    files["src/main.rs"] = main.replace("mod server;", "mod server;\n#[cfg(any(target_os = \"linux\", windows))]\nmod luckyray_forward_diagnostics;").encode()
    server = files["src/server.rs"].decode()
    previous = "    .request(forward_to_native_driver(new_req, args)?)\n    .err_into()"
    require(server.count(previous) == 1)
    files["src/server.rs"] = server.replace(previous, "    .request(forward_to_native_driver(new_req, args)?)\n    .inspect_err(crate::luckyray_forward_diagnostics::emit)\n    .err_into()").encode()
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
