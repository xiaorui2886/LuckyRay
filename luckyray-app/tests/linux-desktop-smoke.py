"""Drive the real Linux Tauri binary using WebKitWebDriver and synthetic data.

No embedded test plugin, command mocks, user profile or model credential is used.
Run under a disposable Xvfb/D-Bus session; this is not Wayland/hardware QA.
"""
import argparse
import base64
import hashlib
import http.client
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


def webdriver_value(opener, request, timeout):
    # urllib raises HTTP failures. A successful WebDriver value may itself be
    # our {ok: false, error: ...} production-command result.
    for attempt in range(2):
        try:
            with opener.open(request, timeout=timeout) as response:
                return json.load(response).get("value")
        except (http.client.RemoteDisconnected, ConnectionResetError):
            # A read has no uncertain mutation to duplicate. POST/DELETE and
            # HTTP protocol errors retain their original failure behavior.
            if request.get_method() != "GET" or attempt:
                raise
            time.sleep(0.2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--application", required=True, type=Path)
    parser.add_argument("--driver", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--lsh", action="store_true", help="exercise the real LSH UI instead of the notes/catalog flow")
    parser.add_argument("--lsh-resource-root", type=Path)
    parser.add_argument("--user-integration", action="store_true", help="exercise production autostart IPC in a synthetic profile")
    args = parser.parse_args()
    if args.lsh and args.user_integration:
        raise RuntimeError("select one focused native flow")
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
              "smokeScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "commit": os.environ.get("GITHUB_SHA"), "scope": "native Tauri startup and production IPC with synthetic data",
              "lshAi": "NOT_RUN", "installer": "NOT_RUN", "waylandHardware": "NOT_RUN",
              "imageDecode": "NOT_RUN", "editorUiInteraction": "NOT_RUN", "quitRequests": []}

    def wd(method, path, body=None, timeout=45):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{port}" + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        return webdriver_value(http, request, timeout)

    def ready():
        try:
            value = wd("GET", "/status", timeout=1)
            return isinstance(value, dict) and bool(value.get("ready"))
        except (OSError, ValueError):
            return False

    def invoke(command, arguments=None, allow_error=False, timeout=45):
        value = wd("POST", f"/session/{session}/execute/async", {
            "script": "const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(v=>done({ok:true,value:v}),e=>done({ok:false,error:String(e)}));",
            "args": [command, arguments or {}]}, timeout=timeout)
        if not value.get("ok") and not allow_error:
            raise RuntimeError(f"production command {command} failed: {value.get('error')}")
        return value

    def start():
        nonlocal session
        value = wd("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(binary)}}}})
        session = value["sessionId"]
        wd("POST", f"/session/{session}/timeouts", {"script": 180000 if args.lsh else 30000})
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
            raise RuntimeError("native app disappeared before the quit request")
        reply_observed = False
        try:
            invoke("close_window")
            reply_observed = True
        except (OSError, RuntimeError):
            # Exit may close WebDriver before its async reply arrives.
            pass
        if not wait_until(lambda: all(live_identity(pid) != identity for pid, identity in identities.items()), 15):
            raise RuntimeError("application process remained after the quit request")
        report["quitRequests"].append({"ipcReplyObserved": reply_observed,
            "observedApplicationCount": len(identities), "priorProcessIdentitiesGone": True,
            "exitStatus": "NOT_OBSERVED"})
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
        if args.user_integration:
            report["scope"] = "real Tauri autostart production IPC with synthetic per-user state"
            report["noteFlows"] = "NOT_RUN"
            report["materialImportCatalogRead"] = "NOT_RUN"
            entry = profile / "config/autostart/com.luckyray.desktop.desktop"
            if invoke("get_auto_launch_enabled")["value"] or entry.exists():
                raise RuntimeError("autostart query created or enabled an absent entry")
            invoke("set_auto_launch_enabled", {"enabled": True})
            enabled = entry.read_bytes()
            inode = entry.stat().st_ino
            if not invoke("get_auto_launch_enabled")["value"] or b"Hidden=true" in enabled:
                raise RuntimeError("production autostart enable did not take effect")
            if str(binary).encode() not in enabled:
                raise RuntimeError("autostart did not bind the running executable")
            invoke("set_auto_launch_enabled", {"enabled": False})
            if invoke("get_auto_launch_enabled")["value"] or entry.read_bytes() != enabled + b"Hidden=true\n":
                raise RuntimeError("production autostart disable did not retain a hidden entry")
            if not any(path.stat().st_ino == inode for path in entry.parent.glob(".lrk-*.displaced")):
                raise RuntimeError("autostart did not retain the prior inode")
            if not any(path.read_bytes() == enabled and path.stat().st_ino != inode for path in entry.parent.glob(".lrk-*.backup")):
                raise RuntimeError("autostart did not retain an independent backup")
            invoke("set_auto_launch_enabled", {"enabled": True})
            if entry.read_bytes() != enabled or not invoke("get_auto_launch_enabled")["value"]:
                raise RuntimeError("production autostart re-enable failed")
            invoke("set_auto_launch_enabled", {"enabled": False})
            stop()
            start()
            if invoke("get_auto_launch_enabled")["value"] or entry.read_bytes() != enabled + b"Hidden=true\n":
                raise RuntimeError("disabled autostart state did not survive native restart")
            stop()
            report["autostartEnableDisableReenablePersistence"] = "PASS"
            report["independentBackupAndOldInode"] = "PASS"
            report["quitRequestProcessDisappearance"] = "PASS"
            return
        if args.lsh:
            if args.lsh_resource_root is None:
                raise RuntimeError("the actual LSH resource root is required")
            node = (args.lsh_resource_root / "lr-lsh/199-1/deepseek-harness/node/node").resolve(strict=True)
            report["scope"] = "real Tauri AI navigation, official LSH client and native host with synthetic private state"
            report["noteFlows"] = "NOT_RUN"
            report["materialImportCatalogRead"] = "NOT_RUN"
            report["realAccountAuthorization"] = "NOT_RUN"
            report["mediaRuntime"] = "NOT_RUN"

            def click_route(route):
                element = wd("POST", f"/session/{session}/element", {
                    "using": "css selector", "value": f'.nav-item[data-control-id="{route}"]'})
                key = element["element-6066-11e4-a52e-4f735466cecf"]
                try:
                    wd("POST", f"/session/{session}/element/{key}/click", {})
                except (http.client.RemoteDisconnected, ConnectionResetError):
                    # Do not repeat an uncertain click. A read-only URL check
                    # may prove the requested route already became current.
                    url = wd("GET", f"/session/{session}/url")
                    if "#" not in url or url.split("#", 1)[1].split("?", 1)[0].lstrip("/") != route:
                        raise
                    report.setdefault("routeClicksWithLostReplyButObservedRoute", []).append(route)

            click_route("ai")
            last = None

            def client_ready():
                nonlocal last
                last = invoke("dsh_native_surface_status")["value"]
                # Generation reset publishes unavailable while the host's
                # verified startup/probe is still in flight. Require positive
                # client readiness; a transient reset is not a final verdict.
                report["lastSurfaceStage"] = last["stage"]
                return last["ready"] and last["stage"] in ("client-ready", "session-open")

            if not wait_until(client_ready, 180):
                report["lastHostStage"] = invoke("dsh_host_status", timeout=180)["value"]["stage"]
                raise RuntimeError("official LSH client readiness was not observed")
            host = invoke("dsh_host_status", timeout=180)["value"]
            if host["stage"] != "probe-completed" or not host["latestProbePassed"]:
                raise RuntimeError("fresh native LSH probe evidence was not observed")
            identities = app_pids(node)
            if len(identities) < 2:
                raise RuntimeError("actual Node host and official DSH carrier were not observed")
            report["lshAi"] = {"officialClientReady": "PASS", "nativeProbe": "PASS",
                               "stage": last["stage"], "nodeProcessCount": len(identities)}
            main_handle = wd("GET", f"/session/{session}/window")
            child_handle = None

            def official_ui_settled():
                nonlocal child_handle
                handles = wd("GET", f"/session/{session}/window/handles")
                report["lshAi"]["automatedWebviewCount"] = len(handles)
                try:
                    for handle in handles:
                        if handle == main_handle:
                            continue
                        wd("POST", f"/session/{session}/window", {"handle": handle})
                        dom = wd("POST", f"/session/{session}/execute/sync", {
                            "script": "return {loopback:location.hostname==='127.0.0.1',boot:Boolean(document.querySelector('[data-dsh-boot]')),textLength:document.body.innerText.length,controls:document.querySelectorAll('button,input,textarea,[contenteditable=true]').length,width:innerWidth,height:innerHeight};", "args": []})
                        if dom["loopback"]:
                            report["lshAi"]["officialDom"] = dom
                            child_handle = handle
                            return not dom["boot"] and dom["textLength"] > 30 and dom["controls"] > 0
                finally:
                    wd("POST", f"/session/{session}/window", {"handle": main_handle})
                return False

            if not wait_until(official_ui_settled, 60):
                raise RuntimeError("official LSH UI did not finish its plugin loader")
            mount = wd("POST", f"/session/{session}/execute/sync", {
                "script": "const r=document.querySelector('.dsh-native-surface-mount').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};", "args": []})
            dom = report["lshAi"]["officialDom"]
            if abs(dom["width"] - mount["width"]) > 2 or abs(dom["height"] - mount["height"]) > 2:
                raise RuntimeError("LSH native child viewport does not match its main-window mount")
            report["lshAi"]["mount"] = mount
            report["lshAi"]["officialDomSettled"] = "PASS"
            report["lshAi"]["composedUiReview"] = "MANUAL_REQUIRED"
            try:
                wd("POST", f"/session/{session}/window", {"handle": child_handle})
                wd("POST", f"/session/{session}/execute/async", {
                    "script": "const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));", "args": []})
                continue_button = wd("POST", f"/session/{session}/element", {
                    "using": "xpath", "value": "//button[normalize-space(.)='Continue']"})
                key = continue_button["element-6066-11e4-a52e-4f735466cecf"]
                wd("POST", f"/session/{session}/element/{key}/click", {})
                # Upstream renders the no-session/workspace composer inert.
                # Observe its actual guard instead of altering editability or
                # pretending this fresh-profile case exercised a chat draft.
                guard = wd("POST", f"/session/{session}/execute/sync", {
                    "script": "const e=document.querySelector('[data-composer-input]');return {present:Boolean(e),editable:Boolean(e?.isContentEditable)};", "args": []})
                if not guard["present"] or guard["editable"]:
                    raise RuntimeError("official initial no-workspace composer guard was unexpected")
                report["lshAi"]["initialNoWorkspaceGuard"] = "PASS"
                report["lshAi"]["draftTyping"] = "NOT_RUN_NO_WORKSPACE_SESSION"
                report["lshAi"]["messageSubmission"] = "NOT_RUN"
                screenshot("native-lsh-direct.png")
                refusal = wd("POST", f"/session/{session}/execute/async", {
                    "script": "const done=arguments[arguments.length-1];if(!window.__TAURI__?.core){done({surfaceAbsent:true});return;}window.__TAURI__.core.invoke('dsh_host_status').then(()=>done({refused:false}),()=>done({refused:true}));", "args": []})
                if not refusal.get("surfaceAbsent") and not refusal.get("refused"):
                    raise RuntimeError("remote child acquired a main-only production command")
                report["lshAi"]["remoteMainIpc"] = "ABSENT" if refusal.get("surfaceAbsent") else "REFUSED"
            finally:
                wd("POST", f"/session/{session}/window", {"handle": main_handle})
            screenshot("native-lsh-client.png")
            # Capture the composited private Xvfb screen, including native
            # child views that WebDriver's individual-webview screenshot omits.
            import gi
            gi.require_version("Gdk", "3.0")
            from gi.repository import Gdk
            screen = Gdk.get_default_root_window()
            pixels = Gdk.pixbuf_get_from_window(screen, 0, 0, screen.get_width(), screen.get_height())
            if pixels is None:
                raise RuntimeError("composited native screenshot was unavailable")
            pixels.savev(str(output / "native-lsh-composited.png"), "png", [], [])
            click_route("materials")
            if not wait_until(lambda: invoke("dsh_native_surface_status")["value"]["ready"], 10):
                raise RuntimeError("route hide lost the live carrier")
            click_route("ai")
            if not wait_until(client_ready, 15):
                raise RuntimeError("route return lost the live client")
            click_route("materials")
            closed = invoke("dsh_native_surface_close")["value"]
            if closed["stage"] != "closed" or closed["ready"]:
                raise RuntimeError("native surface close did not revoke its binding")
            report["lshAi"]["routeHideReturnAndClose"] = "PASS"
            stop()
            if not wait_until(lambda: all(live_identity(pid) != identity for pid, identity in identities.items()), 15):
                raise RuntimeError("a previously observed LSH Node process remained after app quit")
            report["lshAi"]["priorNodeProcessIdentitiesGone"] = True
            report["quitRequestProcessDisappearance"] = "PASS"
            return
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
            raise RuntimeError("imported PNG catalog entry was not returned")
        report["materialImportCatalogRead"] = "PASS"
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
        report["quitRequestProcessDisappearance"] = "PASS"
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        if session and app_pids(binary):
            try:
                stop()
            except (OSError, RuntimeError):
                report["cleanupQuitRequest"] = "UNCONFIRMED"
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
