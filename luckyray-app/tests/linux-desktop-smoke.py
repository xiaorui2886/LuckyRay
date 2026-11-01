"""Drive the real Linux Tauri binary using WebKitWebDriver and synthetic data.

No embedded test plugin, command mocks, user profile or model credential is used.
Run under a disposable Xvfb/D-Bus session; this is not Wayland/hardware QA.
"""
import argparse
import base64
import hashlib
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib
from pathlib import Path


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def live_identity(pid):
    try:
        tail = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if tail[0] in ("Z", "X") else tail[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def app_pids(binary):
    result = {}
    for item in Path("/proc").iterdir():
        if not item.name.isdigit():
            continue
        try:
            if item.joinpath("exe").samefile(binary):
                identity = live_identity(item.name)
                if identity is not None:
                    result[item.name] = identity
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return result


def wait_until(condition, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.1)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--application", required=True, type=Path)
    parser.add_argument("--driver", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != "linux":
        raise RuntimeError("Linux native test required")
    binary = args.application.resolve(strict=True)
    with binary.open("rb") as stream:
        elf = stream.read(4)
    if elf != b"\x7fELF":
        raise RuntimeError("actual ELF application required")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="luckyray-native-smoke-", dir=os.environ["RUNNER_TEMP"]))
    profile = root / "profile"
    profile.mkdir(mode=0o700)
    vault = root / "Notes 目录 #100%"
    vault.mkdir(mode=0o700)
    image = root / "素材 image #100%.png"
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                      + chunk(b"IDAT", zlib.compress(b"\0\x20\x80\xc0")) + chunk(b"IEND", b""))
    env = {key: value for key, value in os.environ.items() if key in
           ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "XAUTHORITY")}
    env.update(HOME=str(profile), XDG_CONFIG_HOME=str(profile / "config"),
               XDG_DATA_HOME=str(profile / "data"), XDG_CACHE_HOME=str(profile / "cache"),
               LUCKYRAY_APP_PROFILE="development", PATH="/usr/bin:/bin", GDK_BACKEND="x11")
    port, native_port = free_port(), free_port()
    while native_port == port:
        native_port = free_port()
    log = (output / "driver.log").open("wb")
    driver = subprocess.Popen([str(args.driver.resolve(strict=True)), "--port", str(port),
                               "--native-port", str(native_port), "--native-driver", "/usr/bin/WebKitWebDriver"],
                              env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    session = None
    binary_hash = hashlib.sha256()
    with binary.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            binary_hash.update(part)
    report = {"applicationSha256": binary_hash.hexdigest(),
              "commit": os.environ.get("GITHUB_SHA"), "scope": "native Tauri startup and production IPC with synthetic data",
              "lshAi": "NOT_RUN", "installer": "NOT_RUN", "waylandHardware": "NOT_RUN"}

    def wd(method, path, body=None, timeout=45):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{port}" + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        with http.open(request, timeout=timeout) as response:
            value = json.load(response).get("value")
        if isinstance(value, dict) and value.get("error"):
            raise RuntimeError(value["error"])
        return value

    def ready():
        try:
            value = wd("GET", "/status", timeout=1)
            return isinstance(value, dict) and bool(value.get("ready"))
        except (OSError, ValueError):
            return False

    def invoke(command, arguments=None, allow_error=False):
        value = wd("POST", f"/session/{session}/execute/async", {
            "script": "const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(v=>done({ok:true,value:v}),e=>done({ok:false,error:String(e)}));",
            "args": [command, arguments or {}]})
        if not value.get("ok") and not allow_error:
            raise RuntimeError(f"production command {command} failed: {value.get('error')}")
        return value

    def start():
        nonlocal session
        value = wd("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(binary)}}}})
        session = value["sessionId"]
        wd("POST", f"/session/{session}/timeouts", {"script": 30000})
        def loaded():
            try:
                return wd("POST", f"/session/{session}/execute/sync", {"script":
                    "return Boolean(window.__TAURI__ && document.querySelector('#root')?.children.length && document.body.innerText.length);", "args": []})
            except (OSError, RuntimeError):
                return False
        if not wait_until(loaded, 30):
            raise RuntimeError("native frontend did not load")
        if not app_pids(binary):
            raise RuntimeError("native application process identity not observed")

    def screenshot(name):
        encoded = wd("GET", f"/session/{session}/screenshot")
        png = base64.b64decode(encoded, validate=True)
        if not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("native screenshot missing")
        (output / name).write_bytes(png)

    def stop():
        nonlocal session
        identities = app_pids(binary)
        if not identities:
            raise RuntimeError("native app disappeared before normal quit")
        try:
            invoke("close_window")
        except (OSError, RuntimeError):
            # Exit may close WebDriver before its async reply arrives.
            pass
        if not wait_until(lambda: all(live_identity(pid) != identity for pid, identity in identities.items()), 15):
            raise RuntimeError("normal quit did not stop the native application")
        try:
            wd("DELETE", f"/session/{session}")
        except OSError:
            pass
        session = None

    try:
        if not wait_until(ready, 15):
            raise RuntimeError("native WebDriver did not become ready")
        start()
        invoke("get_backend_bootstrap_status")
        report["nativeStartup"] = "PASS"
        screenshot("native-startup.png")
        invoke("create_notes_vault", {"rootPath": str(vault)})
        active = invoke("knowledge_activate_current_ui_source")["value"]
        epoch = active["sourceEpoch"]
        created = invoke("knowledge_create_document", {"sourceEpoch": epoch, "input":
            {"title": "合成 note #100%", "content": "synthetic original", "parentRelativePath": None}})["value"]
        document_ref = created["documentRef"]
        changed = invoke("knowledge_replace_document", {"sourceEpoch": epoch, "input":
            {"documentRef": document_ref, "content": "synthetic updated", "expectedRevision": created["revision"]}})["value"]
        if changed["document"]["content"] != "synthetic updated":
            raise RuntimeError("note save returned unexpected content")
        stale = invoke("knowledge_replace_document", {"sourceEpoch": epoch, "input":
            {"documentRef": document_ref, "content": "stale", "expectedRevision": created["revision"]}}, allow_error=True)
        if stale.get("ok") or "knowledge-revision-conflict" not in stale.get("error", ""):
            raise RuntimeError("stale note write was not rejected")
        report["noteCreateSaveConflict"] = "PASS"
        imported = invoke("material_catalog_import_paths", {"paths": [str(image)], "options": {"storageMode": "source"}})["value"]
        if imported["importedCount"] != 1 or imported["failedCount"] != 0:
            raise RuntimeError("synthetic PNG import failed")
        asset_id = imported["assets"][0]["id"]
        if len(invoke("material_catalog_get_assets", {"assetIds": [asset_id]})["value"]) != 1:
            raise RuntimeError("imported PNG not readable")
        report["materialImportRead"] = "PASS"
        screenshot("native-after-core-flows.png")
        stop()
        start()
        if invoke("knowledge_read_document", {"documentRef": document_ref})["value"]["content"] != "synthetic updated":
            raise RuntimeError("note did not survive native restart")
        if len(invoke("material_catalog_get_assets", {"assetIds": [asset_id]})["value"]) != 1:
            raise RuntimeError("material did not survive native restart")
        report["nativeReopenPersistence"] = "PASS"
        screenshot("native-reopened.png")
        stop()
        report["normalQuit"] = "PASS"
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        if session:
            try:
                wd("DELETE", f"/session/{session}", timeout=5)
            except (OSError, RuntimeError):
                pass
        if driver.poll() is None:
            os.killpg(driver.pid, signal.SIGTERM)
            try:
                driver.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(driver.pid, signal.SIGKILL)
                driver.wait(timeout=3)
        log.close()


if __name__ == "__main__":
    main()
