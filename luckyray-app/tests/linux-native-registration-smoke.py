"""Run the actual native-host ELF against an isolated synthetic browser config.

This tests registration files and source identity, not Chrome itself or an
extension's data-access grants. It never launches a browser or a real profile.
"""
import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


ROUND_TRIP_ORIGIN = "chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid"
ROUND_TRIP_VERSION = 1


def round_trip(program, env, report):
    """One real Native Messaging exchange with the host ELF.

    The browser passes the extension origin as argv[1] and then speaks
    4-byte-native-endian length + JSON over stdin/stdout. No application is
    running in this synthetic profile, so the host must answer with a framed
    refusal rather than a bootstrap config; what this proves is that the
    built host reads our frame, dispatches it and writes a well-formed reply.
    """
    request = json.dumps({"type": "bootstrap", "protocolVersion": ROUND_TRIP_VERSION}).encode()
    frame = len(request).to_bytes(4, byteorder=sys.byteorder) + request
    result = subprocess.run([str(program), ROUND_TRIP_ORIGIN], input=frame, env=env,
                            capture_output=True, timeout=15)
    if result.returncode != 0:
        raise RuntimeError("round-trip host exited non-zero: " + result.stderr.decode("utf-8", "replace").strip())
    if len(result.stdout) < 5:
        raise RuntimeError("round-trip host wrote no framed reply")
    declared = int.from_bytes(result.stdout[:4], byteorder=sys.byteorder)
    body = result.stdout[4:]
    if declared != len(body):
        raise RuntimeError("round-trip frame length does not match the body")
    envelope = json.loads(body)
    if envelope.get("ok") is not False:
        raise RuntimeError("round-trip reply must be the refusal this profile produces")
    error = envelope.get("error") or {}
    code, message = error.get("code"), error.get("message")
    if not (isinstance(code, str) and code and isinstance(message, str) and message):
        raise RuntimeError("round-trip refusal has no code/message")
    report["roundTrip"] = True
    report["roundTripFrames"] = 1
    report["roundTripRefusalCode"] = code

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--application", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    original = args.application.resolve(strict=True)
    if original.read_bytes()[:4] != b"\x7fELF":
        raise RuntimeError("actual Linux native-host ELF required")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="native-registration-", dir=output))
    program = root / "程序 Source #100%" / "luckyray-native-host"
    program.parent.mkdir(mode=0o700)
    shutil.copy2(original, program)
    profile = root / "个人 Profile #100%"
    profile.mkdir(mode=0o700)
    config = profile / "config"
    config.mkdir(mode=0o700)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(profile), "XDG_CONFIG_HOME": str(config),
           "XDG_DATA_HOME": str(profile / "data"), "LUCKYRAY_APP_PROFILE": "development"}
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    report = {"applicationSha256": sha(program), "scriptSha256": sha(Path(__file__)),
              "scope": "real native-host CLI, synthetic per-user registration files",
              "realBrowser": "NOT_RUN", "dataAccessGrantRevocation": "NOT_RUN", "releaseIdentity": "NOT_VERIFIED"}

    def run(*arguments, expected=None, extra=None):
        result = subprocess.run([str(program), *arguments], env={**env, **(extra or {})},
                                capture_output=True, text=True, timeout=15)
        if expected is None:
            if result.returncode == 0:
                raise RuntimeError("a forbidden registration command succeeded")
        elif result.returncode != 0 or result.stdout.strip() != expected:
            raise RuntimeError(f"native registration command failed: {result.stderr.strip()}")

    try:
        assert sha(original) == report["applicationSha256"]
        run("--install-linux-manifest", "../../foreign")
        run("--install-manifest", str(root / "unscoped.json"))
        assert not (root / "unscoped.json").exists()
        assert not list(config.iterdir())
        run("--revoke-linux-registration", "chromium", expected="registration-absent")
        assert not list(config.iterdir())
        run("--install-linux-manifest", "chromium", expected="installed")
        path = config / "chromium/NativeMessagingHosts/com.luckyray.desktop.json"
        active = path.read_bytes()
        manifest = json.loads(active)
        assert manifest["path"] == str(program)
        assert manifest["allowed_origins"]
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        inode = path.stat().st_ino
        run("--install-linux-manifest", "chromium", expected="already-installed")
        assert len(list(path.parent.iterdir())) == 1
        run("--revoke-linux-registration", "chromium", expected="registration-revoked")
        assert json.loads(path.read_bytes())["allowed_origins"] == []
        old = [p for p in path.parent.iterdir() if p.suffix == ".displaced"]
        copies = [p for p in path.parent.iterdir() if p.suffix == ".backup"]
        assert len(old) == len(copies) == 1
        assert old[0].stat().st_ino == inode and old[0].read_bytes() == active
        assert copies[0].stat().st_ino != inode and copies[0].read_bytes() == active
        run("--revoke-linux-registration", "chromium", expected="registration-already-revoked")
        run("--install-linux-manifest", "chromium", expected="re-enabled")
        assert path.read_bytes() == active
        path.write_bytes(b"foreign registration")
        run("--revoke-linux-registration", "chromium")
        assert path.read_bytes() == b"foreign registration"
        path.unlink()  # Only this synthetic fixture is removed by the test.
        outside = root / "outside"
        outside.write_bytes(b"preserve")
        path.symlink_to(outside)
        run("--install-linux-manifest", "chromium")
        assert outside.read_bytes() == b"preserve" and path.is_symlink()
        run("--install-linux-manifest", "chrome", extra={"APPIMAGE": str(root / "unverified.AppImage")})
        assert not (config / "google-chrome").exists()
        assert not (profile / "data").exists(), "registration must not issue or persist credentials"
        report.update(registration="PASS", revocation="PASS", reenable="PASS", sourceIdentity="PASS",
                      conflictAndSymlinkPreservation="PASS", independentBackupAndOldInode="PASS",
                      credentialNamespaceUnchanged="PASS")
        round_trip(program, env, report)
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
