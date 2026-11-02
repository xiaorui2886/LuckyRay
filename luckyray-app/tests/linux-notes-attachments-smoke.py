"""One real Main notes/PNG flow, using the existing native WebDriver harness.

The drop is a declared Tauri event IPC injection, not an OS pointer drag. The
owned XDG receiver proves file handoff/readback, not an external viewer display.
No application command, bridge, media source or clipboard API is substituted.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_helpers", Path(__file__).with_name("linux-desktop-smoke.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
SCOPE = "real-main-notes-paths-and-png-attachments-only"
COLOR = (32, 128, 192)
CHECKS = ("nativeStartup", "caseDistinctInputContentsRetained", "specialNameImagePreserved",
          "uiSavePersisted", "reopenPersisted", "absolutePathClipboard", "imagePreviewPixels",
          "attachmentSystemHandoff", "quitProcessDisappearance")


class SmokeFailure(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise SmokeFailure(code)


def png_bytes():
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
    pixels = (b"\0" + bytes(COLOR) * 32) * 24
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 24, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(part)
    return value.hexdigest()


def receive_image(config_path, target):
    """An isolated desktop association, not an opener or application mock."""
    config_path, target = Path(config_path), Path(target)
    metadata = config_path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.geteuid()
            and stat.S_IMODE(metadata.st_mode) == 0o600 and metadata.st_size < 16384, "receiver-config-invalid")
    config = json.loads(config_path.read_text())
    expected = Path(config["expected"])
    require(target.is_absolute() and not target.is_symlink() and target.resolve(strict=True) == expected,
            "receiver-target-mismatch")
    require(expected.is_relative_to(config_path.parent / "Vault 中文 #100%"), "receiver-outside-owned-vault")
    content = target.read_bytes()
    require(content == png_bytes(), "receiver-content-mismatch")
    receipt = {"kind": "OWNED_XDG_RECEIVER_READBACK", "exactExpectedFile": True,
               "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
               "externalApplicationDisplay": "NOT_RUN"}
    with config_path.with_name("receiver.json").open("x") as stream:
        json.dump(receipt, stream)


def desktop_arg(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$").replace("%", "%%") + '"'


def screenshot_pixels(encoded, rect):
    require(isinstance(encoded, str) and len(encoded) <= 16 * 1024 * 1024, "screenshot-invalid")
    data = base64.b64decode(encoded, validate=True)
    require(data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) <= 12 * 1024 * 1024, "screenshot-invalid")
    width, height = struct.unpack(">II", data[16:24])
    require(128 <= width <= 4096 and 128 <= height <= 4096 and width * height <= 8 * 1024 * 1024,
            "screenshot-size-invalid")
    import gi
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf
    loader = GdkPixbuf.PixbufLoader.new_with_type("png")
    loader.write(data)
    loader.close()
    image = loader.get_pixbuf()
    pixels, stride, channels = image.get_pixels(), image.get_rowstride(), image.get_n_channels()
    scale_x, scale_y = width / rect["viewportWidth"], height / rect["viewportHeight"]
    matched = 0
    for dx, dy in ((0, 0), (-2, 0), (2, 0), (0, -2), (0, 2)):
        x, y = round(rect["centerX"] * scale_x) + dx, round(rect["centerY"] * scale_y) + dy
        require(0 <= x < width and 0 <= y < height, "image-outside-screenshot")
        offset = y * stride + x * channels
        matched += all(abs(pixels[offset + index] - expected) <= 2 for index, expected in enumerate(COLOR))
    return {"method": "WEBVIEW_SCREENSHOT_PIXELS", "sampled": 5, "matched": matched}


def main():
    os.umask(0o077)
    if len(sys.argv) == 4 and sys.argv[1] == "--receive-image":
        receive_image(sys.argv[2], sys.argv[3])
        return
    parser = argparse.ArgumentParser()
    for name in ("application", "driver", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    binary, driver_binary = args.application.resolve(strict=True), args.driver.resolve(strict=True)
    with binary.open("rb") as stream:
        require(sys.platform == "linux" and stream.read(4) == b"\x7fELF", "real-linux-main-required")
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    socket_root = log = driver = None
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    session, phase = None, "synthetic-setup"
    report = {"schemaVersion": 1, "status": "FAIL", "scope": SCOPE, "commit": os.environ.get("GITHUB_SHA"),
              "applicationSha256": digest(binary), "scriptSha256": digest(Path(__file__)),
              "helperSha256": digest(Path(__file__).with_name("linux-desktop-smoke.py")),
              "flowCount": 1, "appSessions": 0, "checks": {name: "NOT_RUN" for name in CHECKS},
              "drop": {"transport": "TAURI_EVENT_IPC", "nativePointerDrag": "NOT_RUN", "gestures": 0},
              "previews": [], "quitRequests": [], "externalApplicationDisplay": "NOT_RUN",
              "trimmedFilenameEndToEnd": "NOT_RUN", "waylandHardware": "NOT_RUN", "installer": "NOT_RUN"}

    def wd(method, suffix, body=None, timeout=45):
        request = urllib.request.Request(f"http://127.0.0.1:{port}" + suffix, method=method,
            data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        return helpers.webdriver_value(http, request, timeout)

    def execute(script, arguments=None):
        return wd("POST", f"/session/{session}/execute/sync", {"script": script, "args": arguments or []})

    def invoke(command, arguments=None):
        value = execute("return window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(value=>({ok:true,value}),()=>({ok:false}));",
                        [command, arguments or {}])
        require(isinstance(value, dict) and value.get("ok") is True, "production-ipc-rejected")
        return value.get("value")

    def element(selector):
        value = execute("return [...document.querySelectorAll(arguments[0])].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)||null;", [selector])
        require(isinstance(value, dict) and "element-6066-11e4-a52e-4f735466cecf" in value, "visible-control-missing")
        return value["element-6066-11e4-a52e-4f735466cecf"]

    def click(selector):
        wd("POST", f"/session/{session}/element/{element(selector)}/click", {})

    def until(script, arguments=None, seconds=20):
        require(helpers.wait_until(lambda: execute(script, arguments), seconds), "ui-observation-timeout")

    def start():
        nonlocal session
        session = wd("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(binary)}}}})["sessionId"]
        wd("POST", f"/session/{session}/timeouts", {"script": 45000})
        until("return !!window.__TAURI__?.core?.invoke;", seconds=30)
        require(helpers.wait_until(lambda: invoke("get_backend_bootstrap_status").get("ready") is True, 30), "backend-not-ready")
        report["appSessions"] += 1

    def stop():
        nonlocal session
        old = helpers.app_pids(binary)
        invoke("close_window")
        require(old and helpers.wait_until(lambda: all(helpers.live_identity(pid) != identity for pid, identity in old.items()), 20), "quit-process-remained")
        report["quitRequests"].append({"ipcReplyObserved": True, "priorProcessIdentitiesGone": True, "exitStatus": "NOT_OBSERVED"})
        wd("DELETE", f"/session/{session}")
        session = None

    def note_selector(relative):
        return "#page-notes [data-folder-document-id=" + json.dumps("real-vault:" + relative) + "]"

    def source_mode():
        if not execute("return [...document.querySelectorAll('#page-notes .note-editor-area textarea')].some(e=>e.getBoundingClientRect().width>0);"):
            click("#page-notes .note-editor-area .editor-status-right > button:last-child")
        until("return [...document.querySelectorAll('#page-notes .note-editor-area textarea')].some(e=>e.getBoundingClientRect().width>0&&!e.disabled&&!e.readOnly);")

    def preview():
        click("#page-notes .note-editor-area .editor-status-right > button:first-of-type")
        until("return [...document.querySelectorAll('#page-notes .note-preview .note-media[data-kind=image] img')].some(e=>e.complete&&e.naturalWidth===32&&e.naturalHeight===24&&e.getBoundingClientRect().width>0);")
        rect = execute("const e=[...document.querySelectorAll('#page-notes .note-preview .note-media[data-kind=image] img')].find(e=>e.getBoundingClientRect().width>0);e.scrollIntoView({block:'center'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;resolve({centerX:x,centerY:y,viewportWidth:innerWidth,viewportHeight:innerHeight,naturalWidth:e.naturalWidth,naturalHeight:e.naturalHeight,visible:document.elementFromPoint(x,y)===e});}))); ")
        require(rect["visible"] and 0 < rect["centerX"] < rect["viewportWidth"] and 0 < rect["centerY"] < rect["viewportHeight"], "preview-not-visible")
        probe = screenshot_pixels(wd("GET", f"/session/{session}/screenshot"), rect)
        require(probe["matched"] == 5, "preview-pixels-mismatch")
        report["previews"].append({"session": report["appSessions"], "naturalWidth": rect["naturalWidth"],
                                   "naturalHeight": rect["naturalHeight"], "visible": True, **probe})

    try:
        root = Path(tempfile.mkdtemp(prefix="notes-", dir=output))
        socket_root = Path(tempfile.mkdtemp(prefix="lrn-", dir="/tmp"))
        home, vault, incoming = root / "profile", root / "Vault 中文 #100%", root / "incoming"
        for directory in (home, vault, incoming, home / "config", home / "data", home / "cache"):
            directory.mkdir(mode=0o700)
        image = incoming / "素材 图 #100%.png"
        image.write_bytes(png_bytes())
        reference = "![synthetic PNG](<" + urllib.parse.quote(image.name) + ">)"
        originals = {"Note.md": "SYNTHETIC_UPPER_v1\n\n" + reference + "\n", "note.md": "SYNTHETIC_LOWER_v1\n"}
        for name, content in originals.items():
            (incoming / name).write_text(content)
        env = {key: value for key, value in os.environ.items() if key in
               ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "XAUTHORITY")}
        env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / "config"), XDG_DATA_HOME=str(home / "data"),
                   XDG_CACHE_HOME=str(home / "cache"), TMPDIR=str(socket_root), PATH="/usr/bin:/bin",
                   LUCKYRAY_APP_PROFILE="development", GDK_BACKEND="x11")
        applications = home / "data/applications"
        applications.mkdir(mode=0o700, parents=True)
        phase = "desktop-association"
        entry = applications / "luckyray-notes-fixture.desktop"
        config = root / "receiver-config.json"
        entry.write_text("[Desktop Entry]\nType=Application\nName=LuckyRay owned PNG handoff receiver\nTerminal=false\n"
                         "MimeType=image/png;\nExec=/usr/bin/python3 " + desktop_arg(Path(__file__).resolve())
                         + " --receive-image " + desktop_arg(config) + " %f\n")
        (home / "config/mimeapps.list").write_text("[Default Applications]\nimage/png=luckyray-notes-fixture.desktop\n")
        subprocess.run(["update-desktop-database", str(applications)], env=env, check=True, capture_output=True, timeout=10)
        selected = subprocess.run(["xdg-mime", "query", "default", "image/png"], env=env, capture_output=True, timeout=10)
        require(selected.returncode == 0 and selected.stdout.strip() == entry.name.encode(), "owned-desktop-association-unavailable")
        port, native_port = helpers.free_port(), helpers.free_port()
        while native_port == port:
            native_port = helpers.free_port()
        log = (output / "driver.log").open("wb")
        phase = "driver-start"
        driver = subprocess.Popen([str(driver_binary), "--port", str(port), "--native-port", str(native_port),
                                   "--native-driver", "/usr/bin/WebKitWebDriver"], env=env, stdout=log,
                                  stderr=subprocess.STDOUT, start_new_session=True)
        def ready():
            try:
                return wd("GET", "/status", timeout=1).get("ready") is True
            except (OSError, ValueError):
                return False
        require(helpers.wait_until(ready, 20), "driver-not-ready")
        phase = "main-start"
        start()
        invoke("create_notes_vault", {"rootPath": str(vault)})
        # Reload discards any pre-bootstrap frontend snapshot. The real app
        # then activates its persisted vault through the normal startup path.
        execute("location.hash='#notes';location.reload();return true;")
        until("return !!document.querySelector('#page-notes .notes-vault-entry');", seconds=45)
        until("return document.querySelector('#page-notes .notes-vault-meta')?.textContent===arguments[0];", [str(vault)])
        report["checks"]["nativeStartup"] = "PASS"
        phase = "drop-import"
        position = execute("const e=document.querySelector('#page-notes .notes-index-folder-section');const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+Math.min(30,r.height/2);return {x:x*devicePixelRatio,y:y*devicePixelRatio};")
        require(position["x"] > 0 and position["y"] > 0, "drop-target-unavailable")
        execute("return new Promise(resolve=>setTimeout(resolve,500));")
        for kind in ("enter", "drop"):
            execute("return window.__TAURI__.event.emitTo({kind:'Webview',label:'main'},arguments[0],arguments[1]);",
                    ["tauri://drag-" + kind, {"paths": [str(incoming / name) for name in originals], "position": position}])
            if kind == "enter":
                execute("return new Promise(resolve=>setTimeout(resolve,100));")
        report["drop"]["gestures"] = 1
        require(helpers.wait_until(lambda: (vault / "Note.md").is_file() and (vault / "note (1).md").is_file(), 30), "both-input-notes-not-retained")
        upper, lower = vault / "Note.md", vault / "note (1).md"
        require("SYNTHETIC_UPPER_v1" in upper.read_text() and lower.read_text() == originals["note.md"], "case-distinct-content-mismatch")
        report["drop"].update(inputNotes=2, retainedNotes=2, collisionRenameObserved=True,
                              originalCaseSpellingsBothRetained=False, destinationNames=["Note.md", "note (1).md"])
        report["checks"]["caseDistinctInputContentsRetained"] = "PASS"
        images = [path for path in vault.rglob("*.png") if not path.is_symlink() and digest(path) == digest(image)]
        require(len(images) == 1 and all(char in images[0].name for char in ("素材", " ", "#", "%")), "special-name-png-not-retained")
        with config.open("x") as stream:
            json.dump({"expected": str(images[0].resolve())}, stream)
        report["checks"]["specialNameImagePreserved"] = "PASS"
        phase = "edit-save"
        until("return !!document.querySelector(arguments[0]);", [note_selector("Note.md")])
        click(note_selector("Note.md"))
        source_mode()
        expected = upper.read_text() + "\nSYNTHETIC_UI_SAVED_v1\n"
        textarea = element("#page-notes .note-editor-area textarea")
        wd("POST", f"/session/{session}/element/{textarea}/value", {"text": "\ue009\ue010\ue000\nSYNTHETIC_UI_SAVED_v1\n"})
        wd("POST", f"/session/{session}/element/{textarea}/value", {"text": "\ue009s\ue000"})
        require(helpers.wait_until(lambda: upper.read_text() == expected, 20), "ui-edit-not-saved")
        report["checks"]["uiSavePersisted"] = "PASS"
        phase = "copy-absolute-path"
        row = element(note_selector("Note.md"))
        wd("POST", f"/session/{session}/actions", {"actions": [{"type": "pointer", "id": "context", "parameters": {"pointerType": "mouse"},
           "actions": [{"type": "pointerMove", "origin": {"element-6066-11e4-a52e-4f735466cecf": row}, "x": 0, "y": 0},
                       {"type": "pointerDown", "button": 2}, {"type": "pointerUp", "button": 2}]}]})
        menu = execute("return [...document.querySelectorAll('.note-ctx-react .note-ctx-item-react')].find(e=>/^(复制绝对路径|Copy absolute path)$/.test(e.textContent.trim()));")
        require(isinstance(menu, dict), "copy-path-menu-missing")
        wd("POST", f"/session/{session}/element/{menu['element-6066-11e4-a52e-4f735466cecf']}/click", {})
        def clipboard_matches():
            result = subprocess.run(["xclip", "-selection", "clipboard", "-o"], env=env, capture_output=True, timeout=3)
            return result.returncode == 0 and result.stdout.decode() == str(upper)
        require(helpers.wait_until(clipboard_matches, 10), "absolute-path-clipboard-mismatch")
        report["clipboard"] = {"source": "REAL_NOTE_CONTEXT_MENU", "systemRead": "XCLIP", "exactAbsolutePath": True}
        report["checks"]["absolutePathClipboard"] = "PASS"
        phase = "image-preview"
        preview()
        phase = "attachment-open"
        click('#page-notes .note-preview .note-media[data-kind=image] button[aria-label="打开素材详情"]')
        receiver = root / "receiver.json"
        require(helpers.wait_until(receiver.is_file, 15), "attachment-receiver-not-observed")
        handoff = json.loads(receiver.read_text())
        require(handoff.get("sha256") == digest(image) and handoff.get("exactExpectedFile") is True, "attachment-handoff-mismatch")
        report["handoff"] = handoff
        report["checks"]["attachmentSystemHandoff"] = "PASS"
        phase = "reopen"
        stop()
        start()
        execute("location.hash='#notes';return true;")
        until("return !!document.querySelector(arguments[0]);", [note_selector("Note.md")], seconds=40)
        click(note_selector("Note.md"))
        source_mode()
        until("return [...document.querySelectorAll('#page-notes .note-editor-area textarea')].some(e=>e.getBoundingClientRect().width>0&&e.value===arguments[0]);", [expected])
        require(upper.read_text() == expected and lower.read_text() == originals["note.md"] and digest(images[0]) == digest(image), "reopen-file-content-mismatch")
        report["checks"]["reopenPersisted"] = "PASS"
        preview()
        report["checks"]["imagePreviewPixels"] = "PASS"
        phase = "quit"
        stop()
        report["checks"]["quitProcessDisappearance"] = "PASS"
        report["status"] = "PASS"
    except Exception as error:
        # No arbitrary native error, URL, clipboard contents or user path is exported.
        report["failure"] = {"phase": phase, "code": str(error) if isinstance(error, SmokeFailure) else "unexpected-error"}
        raise
    finally:
        if session:
            try:
                stop()
            except Exception:
                report["cleanup"] = "UNCONFIRMED"
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        if driver is not None:
            try:
                os.killpg(driver.pid, signal.SIGTERM)
                driver.wait(timeout=10)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if driver.poll() is None:
                    os.killpg(driver.pid, signal.SIGKILL)
                    driver.wait(timeout=5)
        if log is not None:
            log.close()
        if socket_root is not None:
            shutil.rmtree(socket_root)


if __name__ == "__main__":
    main()
