"""One real Main notes/PNG flow, using the existing native WebDriver harness.

The drop is a declared Tauri event IPC injection, not an OS pointer drag. The
owned XDG receiver proves file handoff/readback, not an external viewer display.
No application command, bridge, media source or clipboard API is substituted.
"""
import argparse
import base64
import errno
import hashlib
import http.client
import importlib.util
import json
import os
import re
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.error
import urllib.request
import zlib
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_helpers", Path(__file__).with_name("linux-desktop-smoke.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
SCOPE = "real-main-notes-paths-and-png-attachments-only"
COLOR = (32, 128, 192)
# The fixed Windows v1.9.9 copy policy normalizes '#' to '_'. Keep the
# difficult source spelling and URI encoding; verify the exact policy output.
SOURCE_IMAGE_NAME = "素材 图 #100%.png"
COPIED_IMAGE_RELATIVE = "attachments/素材 图 _100%.png"
SOURCE_IMAGE_REFERENCE = "![synthetic PNG](<" + urllib.parse.quote(SOURCE_IMAGE_NAME) + ">)"
COPIED_IMAGE_TARGET = "./" + urllib.parse.quote(COPIED_IMAGE_RELATIVE)
COPIED_IMAGE_REFERENCE = "![synthetic PNG](<" + COPIED_IMAGE_TARGET + ">)"
SOURCE_EDITOR = "#page-notes .note-editor-area > .note-content-area > textarea"
EDITOR_APPEND = "\nSYNTHETIC_UI_SAVED_v1\n"
ACTIONS = frozenset(("setup", "session-start", "backend-ready", "vault-setup", "notes-ready", "drop-dispatch", "drop-retained",
    "image-copy-check", "image-copy-resolve", "select-note", "source-inspect", "source-toggle", "source-ready", "editor-focus",
    "editor-append", "editor-value-check", "editor-save", "editor-save-readback", "context-open", "context-menu-ready", "context-copy",
    "clipboard-readback", "preview-toggle", "preview-ready", "preview-geometry", "preview-screenshot", "attachment-hover", "attachment-hit-check", "attachment-open",
    "attachment-ui-ready", "attachment-detail-check", "attachment-system-open", "attachment-receiver", "reopen-value-check",
    "reopen-files", "quit-request", "quit-processes", "session-delete", "driver-cleanup", "unknown"))
DRIVER_ERRORS = frozenset(("element click intercepted", "element not interactable", "invalid argument", "invalid element state", "invalid selector",
    "invalid session id", "javascript error", "no such element", "no such window", "stale element reference", "script timeout",
    "timeout", "unknown command", "unknown error", "unsupported operation", "unexpected alert open", "move target out of bounds"))
DRIVER_OPERATIONS = frozenset(("session-start", "session-delete", "timeouts", "execute", "click", "actions", "release-actions", "screenshot", "other"))
TRANSPORT_CODES = frozenset(("TIMEOUT", "REMOTE_DISCONNECT", "CONNECTION_RESET", "CONNECTION_REFUSED", "CONNECTION_ABORTED",
    "BROKEN_PIPE", "INCOMPLETE_RESPONSE", "HTTP_PROTOCOL_ERROR", "NETWORK_UNREACHABLE", "ADDRESS_UNREACHABLE", "IO_ERROR", "UNKNOWN", "NOT_APPLICABLE"))
FORWARD_HYPER = ("NONE", "INCOMPLETE_MESSAGE", "CANCELED", "CLOSED", "TIMEOUT", "PARSE", "BODY_WRITE_ABORTED", "USER", "OTHER")
FORWARD_IO = ("NONE", "CONNECTION_REFUSED", "CONNECTION_RESET", "CONNECTION_ABORTED", "BROKEN_PIPE", "TIMEOUT", "NOT_CONNECTED", "UNEXPECTED_EOF", "WOULD_BLOCK", "OTHER")
MEDIA_OPEN_FLAGS = ("hoverApplied", "toolbarVisible", "toolbarFullyVisible", "buttonEnabled", "controlsFullyVisible", "buttonCenterHit", "allButtonCentersHit")
MEDIA_OPEN_PROBE = """
const button=[...document.querySelectorAll(arguments[0])].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);
const empty={hoverApplied:false,toolbarVisible:false,toolbarFullyVisible:false,buttonEnabled:false,controlsFullyVisible:false,buttonCenterHit:false,allButtonCentersHit:false};
if(!button)return empty;
const media=button.closest('.note-media'),bar=button.closest('.note-media-actions,.lr-live-asset-actions');
if(!media||!bar)return empty;
const clip={left:0,top:0,right:Math.min(innerWidth,document.documentElement.clientWidth||innerWidth),bottom:Math.min(innerHeight,document.documentElement.clientHeight||innerHeight)};
for(let p=bar.parentElement;p;p=p.parentElement){
 const s=getComputedStyle(p),x=/^(auto|scroll|hidden|clip)$/.test(s.overflowX),y=/^(auto|scroll|hidden|clip)$/.test(s.overflowY);
 if(!x&&!y)continue;
 const r=p.getBoundingClientRect(),sx=p.offsetWidth?r.width/p.offsetWidth:1,sy=p.offsetHeight?r.height/p.offsetHeight:1;
 if(x){clip.left=Math.max(clip.left,r.left+p.clientLeft*sx);clip.right=Math.min(clip.right,r.left+(p.clientLeft+p.clientWidth)*sx);}
 if(y){clip.top=Math.max(clip.top,r.top+p.clientTop*sy);clip.bottom=Math.min(clip.bottom,r.top+(p.clientTop+p.clientHeight)*sy);}
}
const full=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=clip.left-.5&&r.top>=clip.top-.5&&r.right<=clip.right+.5&&r.bottom<=clip.bottom+.5;};
const hit=e=>{const r=e.getBoundingClientRect(),p=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return p===e||e.contains(p);};
const buttons=[...bar.querySelectorAll('button')],style=getComputedStyle(bar);
return {hoverApplied:media.matches(':hover'),toolbarVisible:Number(style.opacity)>.99&&style.pointerEvents!=='none'&&style.visibility==='visible',
 toolbarFullyVisible:full(bar),buttonEnabled:buttons.length>0&&buttons.every(e=>!e.disabled&&getComputedStyle(e).pointerEvents!=='none'),
 controlsFullyVisible:buttons.length>0&&buttons.every(full),buttonCenterHit:hit(button),allButtonCentersHit:buttons.length>0&&buttons.every(hit)};
"""
CHECKS = ("nativeStartup", "caseDistinctInputContentsRetained", "specialNameImagePreserved",
          "uiSavePersisted", "reopenPersisted", "absolutePathClipboard", "imagePreviewPixels",
          "attachmentSystemHandoff", "quitProcessDisappearance")
DROP_STAGES = frozenset(("listener-ready", "listener-failed", "listener-disabled", "enter", "drop", "classified", "import", "failed",
    "classify-start", "classified-files", "classified-dirs", "owner-stale", "import-route-start", "import-route-complete", "drop-rejected",
    "source-stale", "activation-start", "activation-error", "activation-ready", "native-import-start", "native-source-active",
    "native-import-ok", "native-import-partial", "native-import-failed", "native-error-source-inactive", "native-error-vault-denied",
    "native-error-path-denied", "native-error-policy-denied", "native-error-write-unsupported", "native-error-permissions-unsupported",
    "native-error-name-conflict", "native-error-revision-conflict", "native-error-other", "native-result-incomplete", "native-result-readback-failed",
    "native-result-readback-changed", "native-result-partial", "native-result-other"))


def read_drop_trace(path, offset):
    """At most 64 KiB from the owned log's notes-reload boundary; no raw text."""
    report = {"state": "UNAVAILABLE", "readBytes": 0, "truncated": False, "records": []}
    if type(offset) is not int or offset < 0:
        return report
    try:
        with path.open("rb") as stream:
            size = stream.seek(0, 2)
            if offset > size:
                return report
            stream.seek(offset)
            data = stream.read(65536)
    except OSError:
        return report
    report.update(state="NOT_OBSERVED", readBytes=len(data), truncated=size - offset > len(data))
    for line in data.decode("utf8", errors="replace").splitlines(keepends=True):
        if not line.endswith("\n"):
            continue
        line = line.rstrip("\r\n")
        match = re.fullmatch(r"\[notes-drop\] stage=([a-z-]{1,48}) count=([0-9]{1,6}) hit=(true|false)", line)
        if not match or match[1] not in DROP_STAGES or int(match[2]) > 100000:
            continue
        if len(report["records"]) == 32:
            report["truncated"] = True
            break
        count = int(match[2])
        report["records"].append({"stage": match[1], "count": min(count, 2), "overflow": count > 2, "hit": match[3] == "true"})
    if report["records"]:
        report["state"] = "OBSERVED"
    return report


def drop_targets(vault):
    result = {}
    for key, name in (("upperExists", "Note.md"), ("lowerExists", "note (1).md")):
        try:
            result[key] = (vault / name).is_file()
        except OSError:
            result[key] = None
    return result


class SmokeFailure(RuntimeError):
    pass


class DriverFailure(SmokeFailure):
    def __init__(self, kind, operation, error="unknown-standard-error", status=None, transport="NOT_APPLICABLE", elapsed=None):
        super().__init__("webdriver-command-failed")
        self.observation = {"kind": kind, "operation": operation, "error": error, "httpStatus": status,
            "transport": transport, "responseState": "HTTP_ERROR_RECEIVED" if kind == "HTTP_ERROR" else "UNCONFIRMED",
            "elapsedMs": elapsed}


def read_forwarding_trace(path, offset):
    """At most64KiB of this request's owned log; only exact closed SDK tags."""
    result = {"state": "UNAVAILABLE", "readBytes": 0, "truncated": False, "typed": [], "legacy": []}
    if type(offset) is not int or offset < 0:
        return result
    descriptor = None
    try:
        metadata = path.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1
                or metadata.st_mode & 0o077 or offset > metadata.st_size):
            return result
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            return result
        data = os.pread(descriptor, 65536, offset)
        result.update(state="NOT_OBSERVED", readBytes=len(data), truncated=opened.st_size - offset > len(data))
        pattern = (r"\[luckyray-forward-v1\] connect=(true|false) hyper=(" + "|".join(FORWARD_HYPER)
                   + r") io=(" + "|".join(FORWARD_IO) + r") depth=([1-8]) truncated=(true|false)")
        kinds = {"Connect": "CONNECT", "SendRequest": "SEND_REQUEST", "Canceled": "CANCELED", "ChannelClosed": "CHANNEL_CLOSED"}
        for line in data.decode("utf8", errors="replace").splitlines(keepends=True):
            if not line.endswith("\n"):
                continue
            line = line.rstrip("\r\n")
            typed = re.fullmatch(pattern, line)
            legacy = re.fullmatch(r"Error serving connection: hyper::Error\(User\(Service\), client error \((Connect|SendRequest|Canceled|ChannelClosed)\)\)", line)
            if typed:
                if len(result["typed"]) == 2:
                    result["truncated"] = True
                    continue
                result["typed"].append({"connect": typed[1] == "true", "hyper": typed[2], "io": typed[3],
                                        "depth": int(typed[4]), "truncated": typed[5] == "true"})
            if legacy:
                if len(result["legacy"]) == 2:
                    result["truncated"] = True
                else:
                    result["legacy"].append(kinds[legacy[1]])
        if result["typed"] or result["legacy"]:
            result["state"] = "OBSERVED"
    except OSError:
        pass
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return result


def observe_unconfirmed_failure(error, path, offset, driver, anchors):
    if error.observation["responseState"] != "UNCONFIRMED":
        return
    try:
        error.observation["processesAtResponse"] = observe_processes(driver, anchors)
    except Exception:
        error.observation["processesAtResponse"] = None
    try:
        error.observation["forwarding"] = read_forwarding_trace(path, offset)
    except Exception:
        error.observation["forwarding"] = {"state": "UNAVAILABLE", "readBytes": 0, "truncated": False, "typed": [], "legacy": []}


def transport_code(error):
    # URLError.reason can itself be an exception or arbitrary private text.
    # Inspect only known types/errno, never its message or class name.
    for _ in range(4):
        if not isinstance(error, urllib.error.URLError) or not isinstance(error.reason, BaseException):
            break
        error = error.reason
    if isinstance(error, http.client.RemoteDisconnected):
        return "REMOTE_DISCONNECT"
    if isinstance(error, TimeoutError):
        return "TIMEOUT"
    for kind, code in ((ConnectionResetError, "CONNECTION_RESET"), (ConnectionRefusedError, "CONNECTION_REFUSED"),
                       (ConnectionAbortedError, "CONNECTION_ABORTED"), (BrokenPipeError, "BROKEN_PIPE")):
        if isinstance(error, kind):
            return code
    if isinstance(error, http.client.IncompleteRead):
        return "INCOMPLETE_RESPONSE"
    if isinstance(error, http.client.HTTPException):
        return "HTTP_PROTOCOL_ERROR"
    return {errno.ETIMEDOUT: "TIMEOUT", errno.ECONNRESET: "CONNECTION_RESET", errno.ECONNREFUSED: "CONNECTION_REFUSED",
        errno.ECONNABORTED: "CONNECTION_ABORTED", errno.EPIPE: "BROKEN_PIPE", errno.ENETUNREACH: "NETWORK_UNREACHABLE",
        errno.EHOSTUNREACH: "ADDRESS_UNREACHABLE"}.get(getattr(error, "errno", None),
            "IO_ERROR" if isinstance(error, OSError) and not isinstance(error, urllib.error.URLError) else "UNKNOWN")


def driver_operation(request):
    path = urllib.parse.urlsplit(request.full_url).path
    for suffix, name in (("/execute/sync", "execute"), ("/click", "click"), ("/timeouts", "timeouts"), ("/screenshot", "screenshot")):
        if path.endswith(suffix):
            return name
    if path.endswith("/actions"):
        return "release-actions" if request.get_method() == "DELETE" else "actions"
    if path == "/session":
        return "session-start"
    if request.get_method() == "DELETE" and re.fullmatch(r"/session/[^/]+", path):
        return "session-delete"
    return "other"


def webdriver_command(opener, request, timeout):
    """Never retry a mutation or retain a raw WebDriver response/error message."""
    operation = driver_operation(request)
    began = time.monotonic()
    def elapsed():
        return min(60000, max(0, round((time.monotonic() - began) * 1000)))
    try:
        if request.get_method() == "GET" and urllib.parse.urlsplit(request.full_url).path == "/status":
            # Startup polling owns its one deadline. Do not add the helper's
            # second GET attempt and sleep inside an individual status probe.
            with opener.open(request, timeout=timeout) as response:
                body = json.load(response)
                if not isinstance(body, dict):
                    raise ValueError("invalid-status-response")
                return body.get("value")
        return helpers.webdriver_value(opener, request, timeout)
    except urllib.error.HTTPError as error:
        code = "unknown-standard-error"
        try:
            data = error.read(65537)
            if len(data) <= 65536:
                body = json.loads(data)
                value = body.get("value") if isinstance(body, dict) else None
                candidate = value.get("error") if isinstance(value, dict) else None
                if isinstance(candidate, str) and candidate in DRIVER_ERRORS:
                    code = candidate
        except (ValueError, OSError):
            pass
        finally:
            error.close()
        status = error.code if type(error.code) is int and 400 <= error.code <= 599 else None
        raise DriverFailure("HTTP_ERROR", operation, code, status, elapsed=elapsed()) from None
    except (OSError, http.client.HTTPException) as error:
        raise DriverFailure("TRANSPORT_ERROR", operation, transport=transport_code(error), elapsed=elapsed()) from None
    except (ValueError, UnicodeError):
        raise DriverFailure("INVALID_RESPONSE", operation, elapsed=elapsed()) from None


def startup_refusal(error):
    """The two known not-listening cases, for the current GET/status only."""
    value = error.observation
    if (value["kind"] != "TRANSPORT_ERROR" or value["operation"] != "other"
            or value["responseState"] != "UNCONFIRMED"):
        return False
    if value["transport"] == "CONNECTION_REFUSED":
        return True
    if value["transport"] != "REMOTE_DISCONNECT":
        return False
    trace = value.get("forwarding")
    if (not isinstance(trace, dict) or trace.get("state") != "OBSERVED"
            or trace.get("truncated") is not False or type(trace.get("readBytes")) is not int
            or not 0 < trace["readBytes"] <= 65536 or trace.get("legacy") not in ([], ["CONNECT"])):
        return False
    typed = trace.get("typed")
    if not isinstance(typed, list) or len(typed) != 1 or not isinstance(typed[0], dict):
        return False
    tag = typed[0]
    return (set(tag) == {"connect", "hyper", "io", "depth", "truncated"}
            and tag["connect"] is True and tag["hyper"] == "NONE" and tag["io"] == "CONNECTION_REFUSED"
            and type(tag["depth"]) is int and tag["depth"] == 3 and tag["truncated"] is False)


def wait_driver_ready(wd, driver, seconds=20, native_alive=None):
    """Only known direct/typed upstream startup refusal is temporarily not ready."""
    def alive():
        return driver.poll() is None and (native_alive is None or native_alive())
    deadline = time.monotonic() + seconds
    while True:
        if time.monotonic() >= deadline or not alive():
            return False
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        try:
            value = wd("GET", "/status", timeout=min(1, remaining))
        except DriverFailure as error:
            if not startup_refusal(error):
                raise
        else:
            if not isinstance(value, dict) or type(value.get("ready")) is not bool:
                raise DriverFailure("INVALID_RESPONSE", "other")
            if value["ready"]:
                return alive() and time.monotonic() < deadline
        if not alive():
            return False
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(.1, remaining))


def process_exit(code):
    if code is None:
        return {"state": "RUNNING", "exitCode": None, "signal": None}
    if type(code) is int and 0 <= code <= 255:
        return {"state": "EXITED", "exitCode": code, "signal": None}
    if type(code) is int and -64 <= code < 0:
        return {"state": "SIGNALED", "exitCode": None, "signal": -code}
    return {"state": "UNOBSERVED", "exitCode": None, "signal": None}


def capture_processes(driver, binary):
    """Hold private identities from this actual driver session, never export PIDs."""
    anchors = {"driver": None, "app": {}, "nativeDriver": {}}
    if driver is not None:
        try:
            anchors["driver"] = helpers.live_identity(driver.pid)
        except OSError:
            pass
        try:
            native = helpers.app_pids(Path("/usr/bin/WebKitWebDriver"))
        except OSError:
            native = {}
        for pid, identity in native.items():
            try:
                if os.getpgid(int(pid)) == driver.pid:
                    anchors["nativeDriver"][pid] = identity
            except OSError:
                pass
    try:
        anchors["app"] = helpers.app_pids(binary)
    except OSError:
        pass
    return anchors


def observe_processes(driver, anchors):
    def group(identities):
        counts = {"tracked": len(identities), "running": 0, "gone": 0, "identityChanged": 0, "unobserved": 0}
        for pid, identity in identities.items():
            try:
                current = helpers.live_identity(pid)
                counts["running" if current == identity else "gone" if current is None else "identityChanged"] += 1
            except OSError:
                counts["unobserved"] += 1
        return {**{name: min(value, 2) for name, value in counts.items()}, "overflow": any(value > 2 for value in counts.values()),
                "exitStatus": "NOT_OBSERVED"}
    state = {"state": "UNOBSERVED", "exitCode": None, "signal": None}
    try:
        if driver is not None:
            state = process_exit(driver.poll())
            if state["state"] == "RUNNING":
                current = helpers.live_identity(driver.pid)
                if current is None or anchors["driver"] is None:
                    state["state"] = "UNOBSERVED"
                elif current != anchors["driver"]:
                    state["state"] = "IDENTITY_CHANGED"
    except OSError:
        pass
    return {"driver": state, **{name: group(anchors[name]) for name in ("app", "nativeDriver")}}


def startup_processes_alive(driver, binary, anchors):
    # Reuse owned process identities, retaining the first native identity even
    # if it exits. Missing discovery is not evidence that native has exited.
    fresh = capture_processes(driver, binary)
    if anchors["driver"] is None:
        anchors["driver"] = fresh["driver"]
    if not anchors["nativeDriver"]:
        anchors["nativeDriver"].update(fresh["nativeDriver"])
    state = observe_processes(driver, anchors)
    native = state["nativeDriver"]
    return (state["driver"]["state"] not in ("EXITED", "SIGNALED", "IDENTITY_CHANGED")
            and not native["gone"] and not native["identityChanged"] and not native["unobserved"] and not native["overflow"])


def clipboard_read_once(environment, expected, timeout=3):
    """One read-only xclip process, <=8193 bytes, no polling or clipboard write."""
    result = {"attempts": 1, "method": "XCLIP_READONLY_ONCE", "state": "UNAVAILABLE", "exactAbsolutePath": None,
              "readBytes": 0, "overflow": False, "exit": {"state": "UNOBSERVED", "exitCode": None, "signal": None}}
    child = None
    try:
        child = subprocess.Popen(["xclip", "-selection", "clipboard", "-o"], env=environment,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        data = bytearray()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    result["state"] = "TIMEOUT"
                    break
                part = os.read(child.stdout.fileno(), min(4096, 8193 - len(data)))
                data.extend(part)
                result["readBytes"] = len(data)
                if len(data) > 8192:
                    result.update(state="SIZE_LIMIT", overflow=True)
                    break
                if not part:
                    code = child.wait(timeout=max(.001, deadline - time.monotonic()))
                    result["state"] = "READ" if code == 0 else "EXIT_ERROR"
                    if code == 0:
                        result["exactAbsolutePath"] = bytes(data) == str(expected).encode("utf8")
                    break
    except subprocess.TimeoutExpired:
        result["state"] = "TIMEOUT"
    except OSError:
        result["state"] = "IO_ERROR"
    finally:
        if child is not None:
            try:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=.5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=.5)
                result["exit"] = process_exit(child.poll())
            except (OSError, subprocess.TimeoutExpired):
                result["state"] = "CLEANUP_UNCONFIRMED"
            finally:
                child.stdout.close()
    return result


def copy_click_once(wd, suffix, environment, expected, driver, anchors, report):
    before = observe_processes(driver, anchors)
    try:
        wd("POST", suffix, {})
    except DriverFailure as error:
        if error.observation["operation"] == "click" and error.observation["responseState"] == "UNCONFIRMED":
            observation = {"action": "context-copy", "writeAttempts": 1, "responseState": "UNCONFIRMED", "state": "OBSERVED",
                           "beforeRequest": before, "atUnconfirmedResponse": observe_processes(driver, anchors)}
            report["unconfirmedCopy"] = observation
            try:
                observation["clipboard"] = clipboard_read_once(environment, expected)
                observation["afterClipboardRead"] = observe_processes(driver, anchors)
            except Exception:
                observation["state"] = "UNAVAILABLE"
        # Effect readback is diagnostic only, even if it matches. Never replay this POST.
        raise


def quit_once(state, close):
    # Mark before dispatch, including when the response is lost. finally must
    # never replay this product command or the subsequent session DELETE.
    require(not state["attempted"], "quit-already-attempted")
    state["attempted"] = True
    close()
    state["ipcReplyObserved"] = True


def terminate_driver(driver):
    result = {"termRequested": False, "killRequested": False, "error": "NONE",
              "exit": {"state": "UNOBSERVED", "exitCode": None, "signal": None}}
    if driver is None:
        return result
    try:
        result["termRequested"] = True
        os.killpg(driver.pid, signal.SIGTERM)
        driver.wait(timeout=10)
    except ProcessLookupError:
        result["error"] = "PROCESS_GROUP_GONE"
    except subprocess.TimeoutExpired:
        result["error"] = "TIMEOUT"
        if driver.poll() is None:
            try:
                result["killRequested"] = True
                os.killpg(driver.pid, signal.SIGKILL)
                driver.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                result["error"] = "IO_ERROR"
    except OSError:
        result["error"] = "IO_ERROR"
    try:
        result["exit"] = process_exit(driver.poll())
    except OSError:
        result["error"] = "IO_ERROR"
    return result


def editor_key_actions(command):
    # WebKitGTK 2.50.4 Element Send Keys does not release modifiers for NULL.
    # Standard Actions explicitly release every key; no text/shortcut is retried.
    if command == "append":
        pairs = [("keyDown", "\ue009"), ("keyDown", "\ue010"), ("keyUp", "\ue010"), ("keyUp", "\ue009")]
        for char in EDITOR_APPEND:
            key = "\ue007" if char == "\n" else char
            pairs.extend((("keyDown", key), ("keyUp", key)))
    elif command == "save":
        pairs = [("keyDown", "\ue009"), ("keyDown", "s"), ("keyUp", "s"), ("keyUp", "\ue009")]
    else:
        raise ValueError("unknown fixed editor command")
    return {"actions": [{"type": "key", "id": "notes-editor", "actions": [{"type": kind, "value": key} for kind, key in pairs]}]}


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


def image_copy_probe(vault, source_image, note_content, expected_note_content):
    """Only fixed counts/booleans leave this owned synthetic filesystem probe."""
    result = {"pngCount": 0, "pngOverflow": False, "matchingDigestCount": 0, "matchingDigestOverflow": False,
              "scanComplete": False, "nameMatchesPolicy": False, "noteLinkRewritten": False, "sourceImageUnchanged": False}
    expected_sha = hashlib.sha256(png_bytes()).hexdigest()
    try:
        images = [path for path in vault.rglob("*.png") if path.is_file() and not path.is_symlink()]
        matching = [path for path in images if digest(path) == expected_sha]
        result.update(pngCount=min(len(images), 2), pngOverflow=len(images) > 2,
                      matchingDigestCount=min(len(matching), 2), matchingDigestOverflow=len(matching) > 2,
                      scanComplete=True, nameMatchesPolicy=len(images) == 1 and images[0] == vault / COPIED_IMAGE_RELATIVE,
                      noteLinkRewritten=note_content == expected_note_content
                          and note_content.count(COPIED_IMAGE_REFERENCE) == 1 and SOURCE_IMAGE_REFERENCE not in note_content,
                      sourceImageUnchanged=source_image.read_bytes() == png_bytes())
    except OSError:
        pass
    return result


def image_copy_retained(observation):
    return (type(observation.get("pngCount")) is int and observation["pngCount"] == 1
            and type(observation.get("matchingDigestCount")) is int and observation["matchingDigestCount"] == 1
            and observation.get("pngOverflow") is False and observation.get("matchingDigestOverflow") is False
            and all(observation.get(name) is True for name in
                    ("scanComplete", "nameMatchesPolicy", "noteLinkRewritten", "sourceImageUnchanged", "sourceNotesUnchanged")))


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
    # Generic xdg-open splits Exec arguments without removing literal quotes.
    # These two launcher arguments are owned CI paths, not the image passed
    # through %f. Fail on unsupported launcher paths instead of shell quoting
    # them; Unicode/space/#/% image paths still use the real desktop field.
    value = str(value)
    require(Path(value).is_absolute() and re.fullmatch(r"[A-Za-z0-9_./-]+", value) is not None,
            "owned-desktop-association-unavailable")
    return value


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
    socket_root = log = driver = trace_offset = vault = None
    process_anchors = {"driver": None, "app": {}, "nativeDriver": {}}
    quit_state = {"attempted": False, "ipcReplyObserved": False}
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    session, phase, action = None, "synthetic-setup", "setup"
    image_identity = {"materialAssetId": None}
    report = {"schemaVersion": 1, "status": "FAIL", "scope": SCOPE, "commit": os.environ.get("GITHUB_SHA"),
              "applicationSha256": digest(binary), "scriptSha256": digest(Path(__file__)),
              "helperSha256": digest(Path(__file__).with_name("linux-desktop-smoke.py")),
              "flowCount": 1, "appSessions": 0, "checks": {name: "NOT_RUN" for name in CHECKS},
              "drop": {"transport": "TAURI_EVENT_IPC", "nativePointerDrag": "NOT_RUN", "gestures": 0},
              "previews": [], "imageCopies": [], "quitRequests": [], "externalApplicationDisplay": "NOT_RUN",
              "trimmedFilenameEndToEnd": "NOT_RUN", "waylandHardware": "NOT_RUN", "installer": "NOT_RUN"}

    def wd(method, suffix, body=None, timeout=45):
        request = urllib.request.Request(f"http://127.0.0.1:{port}" + suffix, method=method,
            data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        path = output / "driver.log"
        try:
            offset = path.stat().st_size
        except OSError:
            offset = None
        try:
            return webdriver_command(http, request, timeout)
        except DriverFailure as error:
            if error.observation["responseState"] == "UNCONFIRMED":
                # Capture before finally can send any quit or termination signal.
                observe_unconfirmed_failure(error, path, offset, driver, process_anchors)
            raise

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
        nonlocal session, action, process_anchors
        action = "session-start"
        quit_state.update(attempted=False, ipcReplyObserved=False)
        session = wd("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(binary)}}}})["sessionId"]
        wd("POST", f"/session/{session}/timeouts", {"script": 45000})
        until("return !!window.__TAURI__?.core?.invoke;", seconds=30)
        action = "backend-ready"
        require(helpers.wait_until(lambda: invoke("get_backend_bootstrap_status").get("ready") is True, 30), "backend-not-ready")
        report["appSessions"] += 1
        process_anchors = capture_processes(driver, binary)

    def stop():
        nonlocal session, action
        action = "quit-request"
        old = helpers.app_pids(binary)
        quit_once(quit_state, lambda: invoke("close_window"))
        action = "quit-processes"
        require(old and helpers.wait_until(lambda: all(helpers.live_identity(pid) != identity for pid, identity in old.items()), 20), "quit-process-remained")
        report["quitRequests"].append({"ipcReplyObserved": True, "priorProcessIdentitiesGone": True, "exitStatus": "NOT_OBSERVED"})
        action = "session-delete"
        wd("DELETE", f"/session/{session}")
        session = None

    def note_selector(relative):
        return "#page-notes [data-folder-document-id=" + json.dumps("real-vault:" + relative) + "]"

    def source_mode():
        nonlocal action
        action = "source-inspect"
        if not execute("return [...document.querySelectorAll(arguments[0])].some(e=>e.getBoundingClientRect().width>0);", [SOURCE_EDITOR]):
            action = "source-toggle"
            click("#page-notes .note-editor-area .editor-status-right > button:last-child")
        action = "source-ready"
        until("return [...document.querySelectorAll(arguments[0])].some(e=>e.getBoundingClientRect().width>0&&!e.disabled&&!e.readOnly);", [SOURCE_EDITOR])

    def preview():
        nonlocal action
        action = "preview-toggle"
        click("#page-notes .note-editor-area .editor-status-right > button:first-of-type")
        action = "preview-ready"
        until("return [...document.querySelectorAll('#page-notes .note-preview .note-media[data-kind=image] img')].some(e=>e.complete&&e.naturalWidth===32&&e.naturalHeight===24&&e.getBoundingClientRect().width>0);")
        action = "preview-geometry"
        rect = execute("const e=[...document.querySelectorAll('#page-notes .note-preview .note-media[data-kind=image] img')].find(e=>e.complete&&e.naturalWidth===32&&e.naturalHeight===24&&e.getBoundingClientRect().width>0);e.scrollIntoView({block:'center'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;resolve({centerX:x,centerY:y,viewportWidth:innerWidth,viewportHeight:innerHeight,naturalWidth:e.naturalWidth,naturalHeight:e.naturalHeight,visible:document.elementFromPoint(x,y)===e});}))); ")
        require(rect["visible"] and 0 < rect["centerX"] < rect["viewportWidth"] and 0 < rect["centerY"] < rect["viewportHeight"], "preview-not-visible")
        action = "preview-screenshot"
        probe = screenshot_pixels(wd("GET", f"/session/{session}/screenshot"), rect)
        require(probe["matched"] == 5, "preview-pixels-mismatch")
        report["previews"].append({"session": report["appSessions"], "naturalWidth": rect["naturalWidth"],
                                   "naturalHeight": rect["naturalHeight"], "visible": True, **probe})

    def verify_image_copy(expected_note_content):
        nonlocal action
        action = "image-copy-check"
        observation = image_copy_probe(vault, image, upper.read_text(), expected_note_content)
        observation.update(session=report["appSessions"],
                           sourceNotesUnchanged=all((incoming / name).read_text() == content for name, content in originals.items()),
                           productionResolved=False)
        report["imageCopies"].append(observation)
        require(image_copy_retained(observation), "special-name-png-not-retained")
        target = vault / COPIED_IMAGE_RELATIVE
        action = "image-copy-resolve"
        resolved = invoke("knowledge_resolve_attachment", {"documentRef": {"vaultId": created_vault["id"], "relativePath": "Note.md"},
                                                            "destination": COPIED_IMAGE_TARGET, "wiki": False})
        observation["productionResolved"] = (isinstance(resolved, dict) and resolved.get("status") == "resolved"
            and resolved.get("relativePath") == COPIED_IMAGE_RELATIVE and resolved.get("absolutePath") == str(target.resolve(strict=True))
            and resolved.get("fragment") == "")
        require(observation["productionResolved"], "imported-image-resolution-mismatch")
        image_identity["materialAssetId"] = resolved.get("materialAssetId")
        return target

    try:
        root = Path(tempfile.mkdtemp(prefix="notes-", dir=output))
        socket_root = Path(tempfile.mkdtemp(prefix="lrn-", dir="/tmp"))
        home, vault, incoming = root / "profile", root / "Vault 中文 #100%", root / "incoming"
        for directory in (home, vault, incoming, home / "config", home / "data", home / "cache"):
            directory.mkdir(mode=0o700)
        image = incoming / SOURCE_IMAGE_NAME
        image.write_bytes(png_bytes())
        originals = {"Note.md": "SYNTHETIC_UPPER_v1\n\n" + SOURCE_IMAGE_REFERENCE + "\n", "note.md": "SYNTHETIC_LOWER_v1\n"}
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
        require(wait_driver_ready(wd, driver, 20,
                native_alive=lambda: startup_processes_alive(driver, binary, process_anchors)), "driver-not-ready")
        phase = "main-start"
        start()
        action = "vault-setup"
        created_vault = invoke("create_notes_vault", {"rootPath": str(vault)})
        # Set up the copied-attachment scenario through the existing preference
        # before reload, so the frontend starts with its own fresh source epoch.
        activation = invoke("knowledge_activate_ui_source", {"vaultId": created_vault["id"]})
        selected_policy = invoke("knowledge_set_attachment_handling_policy", {"vaultId": created_vault["id"],
            "sourceEpoch": activation["sourceEpoch"], "policy": "copy"})
        # Reload discards any pre-bootstrap frontend snapshot. The real app
        # then activates its persisted vault through the normal startup path.
        trace_offset = (output / "driver.log").stat().st_size
        action = "notes-ready"
        execute("sessionStorage.setItem('luckyray-notes-drop-diagnostic','1');location.hash='#notes';location.reload();return true;")
        until("return !!document.querySelector('#page-notes .notes-vault-entry');", seconds=45)
        until("return document.querySelector('#page-notes .notes-vault-meta')?.textContent===arguments[0];", [str(vault)])
        report["checks"]["nativeStartup"] = "PASS"
        # Read the persisted production choice after reload; reference remains
        # the product default, and no importer is invoked by this setup.
        observed_policy = invoke("knowledge_get_attachment_handling_policy", {"vaultId": created_vault["id"]})
        require(selected_policy == observed_policy == "copy", "attachment-copy-policy-not-confirmed")
        report["attachmentPolicy"] = {"selected": "copy", "readBack": "copy", "method": "PRODUCTION_PREFERENCE_IPC"}
        phase = "drop-import"
        position = execute("const e=document.querySelector('#page-notes .notes-index-folder-section');const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+Math.min(30,r.height/2),hit=document.elementFromPoint(x,y),root=document.getElementById('page-notes');return {x:x*devicePixelRatio,y:y*devicePixelRatio,insideNotes:!!hit&&!!root?.contains(hit),rootTarget:hit?.closest('[data-folder-drop-id]')?.dataset.folderDropId==='__root__'};")
        report["dropHit"] = {name: position.get(name) is True for name in ("insideNotes", "rootTarget")}
        require(position["x"] > 0 and position["y"] > 0, "drop-target-unavailable")
        execute("return new Promise(resolve=>setTimeout(resolve,500));")
        report["drop"]["inputNotes"] = len(originals)
        action = "drop-dispatch"
        for kind in ("enter", "drop"):
            execute("return window.__TAURI__.event.emitTo({kind:'Webview',label:'main'},arguments[0],arguments[1]);",
                    ["tauri://drag-" + kind, {"paths": [str(incoming / name) for name in originals], "position": {name: position[name] for name in ("x", "y")}}])
            if kind == "enter":
                execute("return new Promise(resolve=>setTimeout(resolve,100));")
        report["drop"]["gestures"] = 1
        action = "drop-retained"
        targets_ready = helpers.wait_until(lambda: (vault / "Note.md").is_file() and (vault / "note (1).md").is_file(), 30)
        report["dropTargets"] = drop_targets(vault)
        values = report["dropTargets"].values()
        report["drop"]["retainedNotes"] = sum(values) if all(type(value) is bool for value in values) else None
        require(targets_ready, "both-input-notes-not-retained")
        upper, lower = vault / "Note.md", vault / "note (1).md"
        require("SYNTHETIC_UPPER_v1" in upper.read_text() and lower.read_text() == originals["note.md"], "case-distinct-content-mismatch")
        report["drop"].update(inputNotes=2, retainedNotes=2, collisionRenameObserved=True,
                              originalCaseSpellingsBothRetained=False, destinationNames=["Note.md", "note (1).md"])
        report["checks"]["caseDistinctInputContentsRetained"] = "PASS"
        imported_content = originals["Note.md"].replace(SOURCE_IMAGE_REFERENCE, COPIED_IMAGE_REFERENCE)
        copied_image = verify_image_copy(imported_content)
        with config.open("x") as stream:
            json.dump({"expected": str(copied_image.resolve())}, stream)
        report["checks"]["specialNameImagePreserved"] = "PASS"
        phase = "edit-save"
        action = "select-note"
        until("return !!document.querySelector(arguments[0]);", [note_selector("Note.md")])
        click(note_selector("Note.md"))
        source_mode()
        expected = imported_content + EDITOR_APPEND
        action = "editor-focus"
        textarea = element(SOURCE_EDITOR)
        wd("POST", f"/session/{session}/element/{textarea}/click", {})
        require(execute("const e=document.activeElement;return e?.matches(arguments[0])&&!e.disabled&&!e.readOnly&&e.value===arguments[1];",
                        [SOURCE_EDITOR, imported_content]), "editor-not-ready")
        save_deadline = time.monotonic() + 20
        action = "editor-append"
        wd("POST", f"/session/{session}/actions", editor_key_actions("append"))
        action = "editor-value-check"
        require(helpers.wait_until(lambda: execute("return document.activeElement?.matches(arguments[0])&&document.activeElement.value===arguments[1];",
                                                    [SOURCE_EDITOR, expected]), max(0, save_deadline - time.monotonic())), "editor-input-mismatch")
        action = "editor-save"
        wd("POST", f"/session/{session}/actions", editor_key_actions("save"))
        action = "editor-save-readback"
        require(helpers.wait_until(lambda: upper.read_text() == expected, max(0, save_deadline - time.monotonic())), "ui-edit-not-saved")
        report["checks"]["uiSavePersisted"] = "PASS"
        phase = "copy-absolute-path"
        action = "context-open"
        row = element(note_selector("Note.md"))
        wd("POST", f"/session/{session}/actions", {"actions": [{"type": "pointer", "id": "context", "parameters": {"pointerType": "mouse"},
           "actions": [{"type": "pointerMove", "origin": {"element-6066-11e4-a52e-4f735466cecf": row}, "x": 0, "y": 0},
                       {"type": "pointerDown", "button": 2}, {"type": "pointerUp", "button": 2}]}]})
        action = "context-menu-ready"
        until("return [...document.querySelectorAll('.note-ctx-react .note-ctx-item-react')].some(e=>/^(复制绝对路径|Copy absolute path)$/.test(e.textContent.trim())&&e.getBoundingClientRect().width>0);", seconds=5)
        menu = execute("return [...document.querySelectorAll('.note-ctx-react .note-ctx-item-react')].find(e=>/^(复制绝对路径|Copy absolute path)$/.test(e.textContent.trim())&&e.getBoundingClientRect().width>0);")
        require(isinstance(menu, dict) and isinstance(menu.get('element-6066-11e4-a52e-4f735466cecf'), str), "copy-path-menu-missing")
        action = "context-copy"
        process_anchors = capture_processes(driver, binary)
        copy_click_once(wd, f"/session/{session}/element/{menu['element-6066-11e4-a52e-4f735466cecf']}/click",
                        env, upper, driver, process_anchors, report)
        def clipboard_matches():
            result = subprocess.run(["xclip", "-selection", "clipboard", "-o"], env=env, capture_output=True, timeout=3)
            return result.returncode == 0 and result.stdout.decode() == str(upper)
        action = "clipboard-readback"
        require(helpers.wait_until(clipboard_matches, 10), "absolute-path-clipboard-mismatch")
        report["clipboard"] = {"source": "REAL_NOTE_CONTEXT_MENU", "systemRead": "XCLIP", "exactAbsolutePath": True}
        report["checks"]["absolutePathClipboard"] = "PASS"
        phase = "image-preview"
        preview()
        phase = "attachment-open"
        action = "attachment-hover"
        preview_image = element('#page-notes .note-preview .note-media[data-kind=image] img')
        wd("POST", f"/session/{session}/actions", {"actions": [{"type": "pointer", "id": "context", "parameters": {"pointerType": "mouse"},
            "actions": [{"type": "pointerMove", "origin": {"element-6066-11e4-a52e-4f735466cecf": preview_image}, "x": 0, "y": 0}]}]})
        open_selector = '#page-notes .note-preview .note-media[data-kind=image] button[aria-label="打开素材详情"]'
        action = "attachment-hit-check"
        def open_button_ready():
            value = execute(MEDIA_OPEN_PROBE, [open_selector])
            value = value if isinstance(value, dict) else {}
            report["mediaOpen"] = {"method": "WEBDRIVER_POINTER_MOVE", "clickAttempts": 0,
                                   **{name: value.get(name) is True for name in MEDIA_OPEN_FLAGS}}
            return all(report["mediaOpen"][name] for name in MEDIA_OPEN_FLAGS)
        require(helpers.wait_until(open_button_ready, 5), "attachment-open-not-interactable")
        action = "attachment-open"
        report["mediaOpen"]["clickAttempts"] = 1
        click(open_selector)
        receiver = root / "receiver.json"
        handoff_deadline = time.monotonic() + 15
        detail_selector = ".material-viewer-react.detail[data-material-native-asset]"
        # A catalog-backed note preview opens the real material inspector. Its
        # Open action performs the system handoff; opening the inspector alone
        # does not. An uncatalogued note reference opens the file directly.
        action = "attachment-ui-ready"
        require(helpers.wait_until(lambda: receiver.is_file() or execute(
            "const e=document.querySelector(arguments[0]);return !!e&&e.getBoundingClientRect().width>0;", [detail_selector]), 15),
            "attachment-open-ui-not-observed")
        route = "NOTE_PREVIEW_OPEN"
        if not receiver.is_file():
            action = "attachment-detail-check"
            observed_asset = execute("return document.querySelector(arguments[0])?.dataset.materialNativeAsset||null;", [detail_selector])
            require(isinstance(image_identity["materialAssetId"], str) and observed_asset == image_identity["materialAssetId"],
                    "attachment-detail-target-mismatch")
            opener_selector = detail_selector + " .detail-action-grid-react > button:first-child"
            require(execute("return ['打开','Open'].includes(document.querySelector(arguments[0])?.textContent.trim());", [opener_selector]),
                    "attachment-open-control-mismatch")
            action = "attachment-system-open"
            click(opener_selector)
            route = "MATERIAL_DETAIL_OPEN"
        action = "attachment-receiver"
        require(helpers.wait_until(receiver.is_file, max(0, handoff_deadline - time.monotonic())), "attachment-receiver-not-observed")
        handoff = json.loads(receiver.read_text())
        require(handoff.get("sha256") == digest(image) and handoff.get("exactExpectedFile") is True, "attachment-handoff-mismatch")
        handoff["uiRoute"] = route
        report["handoff"] = handoff
        report["checks"]["attachmentSystemHandoff"] = "PASS"
        phase = "reopen"
        stop()
        start()
        action = "select-note"
        execute("location.hash='#notes';return true;")
        until("return !!document.querySelector(arguments[0]);", [note_selector("Note.md")], seconds=40)
        click(note_selector("Note.md"))
        source_mode()
        action = "reopen-value-check"
        until("return [...document.querySelectorAll(arguments[0])].some(e=>e.getBoundingClientRect().width>0&&e.value===arguments[1]);", [SOURCE_EDITOR, expected])
        action = "reopen-files"
        require(upper.read_text() == expected and lower.read_text() == originals["note.md"], "reopen-file-content-mismatch")
        verify_image_copy(expected)
        report["checks"]["reopenPersisted"] = "PASS"
        preview()
        report["checks"]["imagePreviewPixels"] = "PASS"
        phase = "quit"
        stop()
        report["checks"]["quitProcessDisappearance"] = "PASS"
        report["status"] = "PASS"
    except Exception as error:
        # No arbitrary native error, URL, clipboard contents or user path is exported.
        report["failure"] = {"phase": phase, "action": action, "code": str(error) if isinstance(error, SmokeFailure) else "unexpected-error"}
        if isinstance(error, DriverFailure):
            report["failure"]["webdriver"] = error.observation
        raise
    finally:
        cleanup = {"quitAttemptedInFinally": False, "quitSkippedAlreadyAttempted": bool(session and quit_state["attempted"])}
        report["cleanupEvidence"] = cleanup
        if session and not quit_state["attempted"]:
            cleanup["quitAttemptedInFinally"] = True
            try:
                stop()
            except Exception as error:
                report["cleanup"] = "UNCONFIRMED"
                if isinstance(error, DriverFailure):
                    cleanup["quitFailure"] = error.observation
        cleanup["quitCommand"] = dict(quit_state)
        if vault is not None:
            report["dropTargets"] = drop_targets(vault)
            values = report["dropTargets"].values()
            report["drop"]["retainedNotes"] = sum(values) if all(type(value) is bool for value in values) else None
        report["dropTrace"] = read_drop_trace(output / "driver.log", trace_offset)
        cleanup["beforeDriverTermination"] = observe_processes(driver, process_anchors)
        cleanup["driverTermination"] = terminate_driver(driver)
        cleanup["afterDriverTermination"] = observe_processes(driver, process_anchors)
        if driver is not None and cleanup["driverTermination"]["exit"]["state"] not in ("EXITED", "SIGNALED"):
            report["cleanup"] = "UNCONFIRMED"
        try:
            if log is not None:
                log.close()
            if socket_root is not None:
                shutil.rmtree(socket_root)
        except OSError:
            report["cleanup"] = "UNCONFIRMED"
        cleanup_failed_after_success = report["status"] == "PASS" and "cleanup" in report
        if cleanup_failed_after_success:
            report.update(status="FAIL", failure={"phase": "quit", "action": "driver-cleanup", "code": "driver-cleanup-incomplete"})
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        if cleanup_failed_after_success:
            raise SmokeFailure("driver-cleanup-incomplete")


if __name__ == "__main__":
    main()
