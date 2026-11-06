"""Offline snapshot helper. The caller must hold the secondary launcher and DSH locks.

This helper never restores or alters the sources. Its private output contains
the profile bytes, including credentials, and must never be uploaded.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time


REPARSE = 0x400
CHUNK = 1024 * 1024
EXCLUDED = {("roaming", "dsh-engine-updates/writer.lock")}
MAX_SNAPSHOT_BYTES = 32 * 1024**3
FREE_RESERVE_BYTES = 50 * 1024**3
MAX_BYTES_PER_SECOND = 32 * 1024**2
_pace_started = time.monotonic()
_paced_bytes = 0


def pace(size: int) -> None:
    global _paced_bytes
    _paced_bytes += size
    delay = _paced_bytes / MAX_BYTES_PER_SECOND - (time.monotonic() - _pace_started)
    if delay > 0.01:
        time.sleep(delay)


def normal(path: Path) -> str:
    value = os.path.abspath(str(path))
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    return os.path.normcase(value)


def safe_directory(path: Path) -> None:
    info = path.lstat()
    if not path.is_dir() or getattr(info, "st_file_attributes", 0) & REPARSE:
        raise ValueError("snapshot-directory-unsafe")
    if normal(Path(os.path.realpath(path))) != normal(path):
        raise ValueError("snapshot-directory-redirected")


def locked_file(path: Path):
    """Open a single-link file without following a final reparse point or sharing writes."""
    if os.name != "nt":
        raise RuntimeError("snapshot-windows-required")
    import msvcrt
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    class Info(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME),
                    ("accessed", wintypes.FILETIME), ("written", wintypes.FILETIME),
                    ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                    ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                    ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]
    kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(Info)]
    kernel.GetFileInformationByHandle.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x00200000 | 0x08000000, None)
    if handle == wintypes.HANDLE(-1).value:
        raise OSError("snapshot-file-open-failed")
    try:
        info, name = Info(), ctypes.create_unicode_buffer(32768)
        if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
            raise OSError("snapshot-file-information-failed")
        count = kernel.GetFinalPathNameByHandleW(handle, name, len(name), 0)
        if not count or count >= len(name) or info.attributes & REPARSE or info.links != 1:
            raise ValueError("snapshot-file-unsafe")
        if normal(Path(name.value)) != normal(path):
            raise ValueError("snapshot-file-redirected")
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None
        return os.fdopen(fd, "rb")
    finally:
        if handle is not None:
            kernel.CloseHandle(handle)


def validate_reviewed_links(records: list[dict]) -> dict[tuple[str, str], dict]:
    """Only an explicit, separately reviewed list of old runtime dependency links.

    These entries are archived as metadata, never followed or recreated here.
    All other reparse points keep the default refusal. The caller must review
    the targets; a link's location alone does not prove ownership or trust.
    """
    if not isinstance(records, list) or len(records) > 10000:
        raise ValueError("snapshot-reviewed-links-invalid")
    allowed = {}
    prefixes = tuple(f"deepseek-harness/native-state/{name}/profiles/node_modules/"
                     for name in ("rc8-v1", "rc8-native-surface-v1"))
    for record in records:
        if not isinstance(record, dict) or set(record) != {"root", "path", "tag", "kind", "target"}:
            raise ValueError("snapshot-reviewed-links-invalid")
        path, target = record["path"], record["target"]
        if (record["root"] != "roaming" or record["tag"] != "0xa0000003" or record["kind"] != "junction"
                or not isinstance(path, str) or not path.startswith(prefixes)
                or any(part in ("", ".", "..") for part in path.split("/"))
                or any(char in path for char in "\\:\x00")
                or not isinstance(target, str) or not target or "\x00" in target
                or not Path(target).is_absolute()):
            raise ValueError("snapshot-reviewed-links-invalid")
        key = (record["root"], path)
        if key in allowed:
            raise ValueError("snapshot-reviewed-links-invalid")
        allowed[key] = dict(record)
    return allowed


def load_reviewed_links(path: Path) -> list[dict]:
    with locked_file(path) as stream:
        raw = stream.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("snapshot-reviewed-links-invalid")
    policy = json.loads(raw)
    if (policy.get("schema") != 1 or policy.get("mode") != "reviewed-runtime-dependency-links"
            or policy.get("targetsFollowed") is not False):
        raise ValueError("snapshot-reviewed-links-invalid")
    allowed = validate_reviewed_links(policy.get("links"))
    return [allowed[key] for key in sorted(allowed)]


def inventory(sources: dict[str, Path], reviewed_links=None) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    directories, files = [], []
    allowed = validate_reviewed_links(reviewed_links or [])
    seen = set()
    for label, root in sources.items():
        safe_directory(root)
        pending = [(root, "")]
        while pending:
            directory, relative = pending.pop()
            safe_directory(directory)
            directories.append((label, relative))
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda item: item.name.casefold())
            for item in entries:
                rel = f"{relative}/{item.name}".lstrip("/")
                info = item.stat(follow_symlinks=False)
                if getattr(info, "st_file_attributes", 0) & REPARSE or item.is_symlink():
                    record = allowed.get((label, rel))
                    if record is None:
                        raise ValueError("snapshot-reparse-refused")
                    if getattr(info, "st_reparse_tag", 0) != 0xA0000003 or os.readlink(item.path) != record["target"]:
                        raise ValueError("snapshot-reviewed-link-mismatch")
                    seen.add((label, rel))
                    continue
                if (label, rel) in allowed:
                    raise ValueError("snapshot-reviewed-link-mismatch")
                if item.is_dir(follow_symlinks=False):
                    pending.append((Path(item.path), rel))
                elif item.is_file(follow_symlinks=False):
                    if (label, rel) not in EXCLUDED:
                        files.append((label, rel))
                else:
                    raise ValueError("snapshot-entry-unsafe")
                if len(directories) + len(files) > 1000000:
                    raise ValueError("snapshot-entry-budget")
    if seen != set(allowed):
        raise ValueError("snapshot-reviewed-link-missing")
    return sorted(directories), sorted(files)


def inspect_reparse(sources: dict[str, Path], output: Path) -> dict:
    """Record link metadata without following a target or reading profile contents."""
    safe_directory(output)
    roots = {label: normal(root) for label, root in sources.items()}
    links, visited, regular_files = [], 0, 0
    link_tags = {0xA0000003: "junction", 0xA000000C: "symlink"}
    for label, root in sources.items():
        safe_directory(root)
        pending = [(root, "")]
        while pending:
            directory, relative = pending.pop()
            safe_directory(directory)
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda item: item.name.casefold())
            for item in entries:
                visited += 1
                if visited > 1000000:
                    raise ValueError("snapshot-entry-budget")
                rel = f"{relative}/{item.name}".lstrip("/")
                info = item.stat(follow_symlinks=False)
                if getattr(info, "st_file_attributes", 0) & REPARSE or item.is_symlink():
                    tag = getattr(info, "st_reparse_tag", 0)
                    kind = link_tags.get(tag, "other-reparse")
                    target, relation = None, "unclassified"
                    if kind in ("junction", "symlink"):
                        target = os.readlink(item.path)
                        lexical = Path(target)
                        if not lexical.is_absolute():
                            lexical = directory / lexical
                        candidate = normal(lexical)
                        destination = next((name for name, path in roots.items()
                            if candidate == path or candidate.startswith(path + os.sep)), None)
                        relation = "same-root" if destination == label else "other-secondary-root" if destination else "outside-secondary-roots"
                    links.append({"root": label, "path": rel, "tag": f"0x{tag:08x}",
                                  "kind": kind, "target": target, "relation": relation})
                    if len(links) > 10000:
                        raise ValueError("snapshot-reparse-budget")
                    continue
                if item.is_dir(follow_symlinks=False):
                    pending.append((Path(item.path), rel))
                elif item.is_file(follow_symlinks=False):
                    regular_files += 1
                else:
                    raise ValueError("snapshot-entry-unsafe")
    report = {"schema": 1, "mode": "secondary-reparse-metadata-only", "complete": True,
              "profileFileContentsRead": False, "targetsFollowed": False, "entries": links,
              "entriesScanned": visited, "regularFilesSeen": regular_files}
    with (output / "reparse-report.private.json").open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(report, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
    return {"entries": len(links), "internal": sum(item["relation"] in ("same-root", "other-secondary-root") for item in links),
            "external": sum(item["relation"] == "outside-secondary-roots" for item in links),
            "other": sum(item["kind"] == "other-reparse" for item in links)}


def digest_file(path: Path) -> tuple[str, int]:
    digest, size = hashlib.sha256(), 0
    with locked_file(path) as source:
        while block := source.read(CHUNK):
            digest.update(block)
            size += len(block)
            pace(len(block))
    return digest.hexdigest(), size


def copy_one(source: Path, target: Path) -> tuple[str, int]:
    digest, size = hashlib.sha256(), 0
    with locked_file(source) as src, target.open("xb") as dst:
        while block := src.read(CHUNK):
            dst.write(block)
            digest.update(block)
            size += len(block)
            pace(len(block))
            if size > MAX_SNAPSHOT_BYTES:
                raise ValueError("snapshot-byte-budget")
            if size % (32 * CHUNK) == 0 and shutil.disk_usage(target.parent).free < FREE_RESERVE_BYTES:
                raise ValueError("snapshot-disk-reserve")
        dst.flush()
        os.fsync(dst.fileno())
    return digest.hexdigest(), size


def validate_sqlite(snapshot: Path, records: list[dict]) -> int:
    count = 0
    for record in records:
        path = snapshot / "profiles" / record["root"] / record["path"]
        with path.open("rb") as source:
            if source.read(16) != b"SQLite format 3\x00":
                continue
        target_dir = snapshot / "validation" / f"sqlite-{count:05d}"
        target_dir.mkdir(parents=True)
        target = target_dir / "database"
        copy_one(path, target)
        for suffix in ("-wal", "-shm", "-journal"):
            sibling = Path(str(path) + suffix)
            if sibling.is_file():
                copy_one(sibling, Path(str(target) + suffix))
        connection = sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)
        try:
            rows = connection.execute("PRAGMA quick_check").fetchall()
            if rows != [("ok",)]:
                raise ValueError("snapshot-sqlite-check-failed")
        finally:
            connection.close()
        count += 1
    return count


def snapshot_profiles(sources: dict[str, Path], output: Path, reviewed_links=None) -> dict:
    safe_directory(output)
    if set(sources) != {"roaming", "local"}:
        raise ValueError("snapshot-source-labels-invalid")
    allowed = validate_reviewed_links(reviewed_links or [])
    links = [allowed[key] for key in sorted(allowed)]
    directories, files = inventory(sources, reviewed_links=links)
    if not files:
        raise ValueError("snapshot-empty")
    estimated = sum((sources[label] / relative).stat(follow_symlinks=False).st_size for label, relative in files)
    # Validation may make a second copy of SQLite files. Reserve ample free
    # space for the separately owned Main build; never fill its volume.
    if estimated > MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot-byte-budget")
    if shutil.disk_usage(output).free < FREE_RESERVE_BYTES + 2 * estimated:
        raise ValueError("snapshot-disk-reserve")
    base = output / "profiles"
    base.mkdir()
    for label, relative in directories:
        (base / label / relative).mkdir(parents=True, exist_ok=True)
    records, total = [], 0
    for label, relative in files:
        source, target = sources[label] / relative, base / label / relative
        sha, size = copy_one(source, target)
        if digest_file(target) != (sha, size):
            raise ValueError("snapshot-copy-mismatch")
        records.append({"root": label, "path": relative, "bytes": size, "sha256": sha})
        total += size
        if total > MAX_SNAPSHOT_BYTES or shutil.disk_usage(output).free < FREE_RESERVE_BYTES:
            raise ValueError("snapshot-disk-reserve")
        if len(records) % 5000 == 0:
            print(f"SECONDARY_SNAPSHOT_COPYING files={len(records)}", flush=True)
    if inventory(sources, reviewed_links=links) != (directories, files):
        raise ValueError("snapshot-source-inventory-changed")
    for item in records:
        if digest_file(sources[item["root"]] / item["path"]) != (item["sha256"], item["bytes"]):
            raise ValueError("snapshot-source-bytes-changed")
    sqlite_checked = validate_sqlite(output, records)
    receipt = {"schema": 1, "mode": "secondary-offline-profile-snapshot", "files": records,
               "directories": directories, "totalBytes": total, "sqliteQuickChecks": sqlite_checked,
               "excluded": [{"root": root, "path": path, "reason": "held OS writer lock"}
                            for root, path in sorted(EXCLUDED)]}
    if links:
        receipt.update({"schema": 2, "reparseLinks": links, "reparseStorage": "metadata-only-not-followed",
                        "externalLinkTargetsIncluded": False})
    with (output / "manifest.json").open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(receipt, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    return {"files": len(records), "bytes": total, "sqlite": sqlite_checked, "links": len(links)}


if __name__ == "__main__":
    inspect_only = len(sys.argv) == 5 and sys.argv[4] == "--inspect-reparse"
    reviewed = len(sys.argv) == 6 and sys.argv[4] == "--reviewed-code-links"
    if len(sys.argv) != 4 and not inspect_only and not reviewed:
        raise SystemExit("secondary-snapshot-arguments-invalid")
    try:
        sources, output = {"roaming": Path(sys.argv[1]), "local": Path(sys.argv[2])}, Path(sys.argv[3])
        if inspect_only:
            result = inspect_reparse(sources, output)
        else:
            links = load_reviewed_links(Path(sys.argv[5])) if reviewed else []
            result = snapshot_profiles(sources, output, reviewed_links=links)
    except Exception as error:
        # Private paths and contents must not be copied to console/logs.
        detail = str(error) if isinstance(error, ValueError) and str(error).startswith("snapshot-") else type(error).__name__
        print(f"SECONDARY_SNAPSHOT_FAILED category={detail}", file=sys.stderr)
        raise SystemExit(1)
    if inspect_only:
        print(f"SECONDARY_LSH_REPARSE_INSPECTION_OK entries={result['entries']} internal={result['internal']} external={result['external']} other={result['other']} targets_followed=false profile_contents_read=false")
    else:
        print(f"SECONDARY_LSH_CURRENT_SNAPSHOT_OK files={result['files']} bytes={result['bytes']} sqlite_quick_check={result['sqlite']} reviewed_link_metadata={result['links']} external_targets_copied=false restore_performed=false")
