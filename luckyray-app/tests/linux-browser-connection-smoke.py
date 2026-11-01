"""Real Tauri consent controls in synthetic state, with an explicit client mode.

--chromium uses the full unchanged extension and OS Native Messaging lookup;
the default --node mode is only a declared browser-API protocol fixture.
Keep complete genuine startup resources. Run under Xvfb/D-Bus.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_helpers", Path(__file__).with_name("linux-desktop-smoke.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ("application", "native-host", "driver", "node", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--chromium", type=Path)
    args = parser.parse_args()
    binary = args.application.resolve(strict=True)
    host_source = args.native_host.resolve(strict=True)
    require(binary.read_bytes()[:4] == b"\x7fELF" and host_source.read_bytes()[:4] == b"\x7fELF", "real Linux ELFs required")
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="linux-browser-connection-", dir=output))
    profile = root / "Synthetic profile"
    profile.mkdir(mode=0o700)
    if args.chromium:
        marker = profile / ".luckyray-linux-browser-fixture"
        with marker.open("x") as stream:
            stream.write("isolated-linux-browser-consent-v1\n")
        marker.chmod(0o600)
    for name in ("config", "data", "cache"):
        (profile / name).mkdir(mode=0o700)
    program = root / "owned program" / "luckyray-native-host"
    program.parent.mkdir(mode=0o700)
    shutil.copyfile(host_source, program)
    program.chmod(0o755)
    env = {key: value for key, value in os.environ.items() if key in
           ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "XAUTHORITY")}
    env.update(HOME=str(profile), XDG_CONFIG_HOME=str(profile / "config"), XDG_DATA_HOME=str(profile / "data"),
               XDG_CACHE_HOME=str(profile / "cache"), PATH="/usr/bin:/bin", LUCKYRAY_APP_PROFILE="development", GDK_BACKEND="x11")
    register = subprocess.run([str(program), "--install-linux-manifest", "chromium"], env=env, capture_output=True, timeout=15)
    require(register.returncode == 0 and register.stdout.strip() == b"installed", "synthetic scoped registration failed")
    manifest_path = profile / "config/chromium/NativeMessagingHosts/com.luckyray.desktop.json"
    manifest = json.loads(manifest_path.read_text())
    require(manifest["path"] == str(program) and manifest["allowed_origins"], "registered source mismatch")
    origin = manifest["allowed_origins"][0].removesuffix("/")
    port, native_port = helpers.free_port(), helpers.free_port()
    while native_port == port:
        native_port = helpers.free_port()
    log = (output / "driver.log").open("wb")
    driver = subprocess.Popen([str(args.driver.resolve(strict=True)), "--port", str(port), "--native-port", str(native_port),
                               "--native-driver", "/usr/bin/WebKitWebDriver"], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    session = None
    client = None
    report = {"commit": os.environ.get("GITHUB_SHA"), "scope": "real Tauri Main consent UI and real Native Messaging stdio + production JS adapter, synthetic profile",
              "applicationSha256": digest(binary), "nativeHostSha256": digest(program), "scriptSha256": digest(Path(__file__)),
              "clientScriptSha256": digest(Path(__file__).parent / "lib/linux-browser-connection-client.mjs"),
              "realChromium": "NOT_RUN", "browserApi": "DECLARED_NODE_PROTOCOL_SEAM", "installer": "NOT_RUN", "osLoginOrReboot": "NOT_RUN", "checks": {}, "quitRequests": [], "clientCommands": []}
    if args.chromium:
        report.update(scope="real Tauri Main consent UI and full unchanged Chromium extension with OS Native Messaging lookup, synthetic profile",
                      realChromium="REQUIRED", browserApi="REAL_CHROMIUM_NO_API_SUBSTITUTION")
        report["clientScriptSha256"] = digest(Path(__file__).parent / "lib/linux-browser-chromium-client.mjs")
        report["browserSessions"] = []

    def wd(method, path, body=None, timeout=45):
        request = urllib.request.Request(f"http://127.0.0.1:{port}" + path,
            data=None if body is None else json.dumps(body).encode(), method=method, headers={"Content-Type": "application/json"})
        return helpers.webdriver_value(opener, request, timeout)

    def invoke(command, arguments=None, allow_error=False):
        value = wd("POST", f"/session/{session}/execute/sync", {"script":
            "return window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));",
            "args": [command, arguments or {}]})
        require(isinstance(value, dict) and type(value.get("ok")) is bool, "invalid IPC envelope")
        if not allow_error:
            require(value["ok"], "production IPC rejected: " + command)
        return value

    def row():
        rows = invoke("linux_browser_connection_status")["value"]["extensions"]
        return next(item for item in rows if item["origin"] == origin)

    def execute(script, args=None):
        return wd("POST", f"/session/{session}/execute/sync", {"script": script, "args": args or []})

    def show_settings():
        selector = ".sidebar-footer > div.nav-item:last-child"
        require(helpers.wait_until(lambda: execute("return !!document.querySelector(arguments[0]);", [selector]), 30), "real application sidebar did not load")
        element = wd("POST", f"/session/{session}/element", {"using": "css selector", "value": selector})
        element_id = element["element-6066-11e4-a52e-4f735466cecf"]
        wd("POST", f"/session/{session}/element/{element_id}/click", {})
        opened = helpers.wait_until(lambda: execute("return !!document.querySelector('[data-linux-browser-connection]');"), 15)
        if not opened:
            report["settingsNavigation"] = execute("return {route:location.hash,linuxPresentation:/Linux/.test(navigator.userAgent),tauriPresentation:!!window.__TAURI_INTERNALS__,settingsVisible:!!document.querySelector('.settings-content')};")
        require(opened, "real settings connection panel did not open")

    def click(decision, status):
        selector = f'[data-browser-origin="{origin}"] [data-browser-decision="{decision}"]'
        require(helpers.wait_until(lambda: execute("const button=document.querySelector(arguments[0]); return !!button&&!button.disabled;", [selector]), 12), "real consent button missing: " + decision)
        element = wd("POST", f"/session/{session}/element", {"using": "css selector", "value": selector})
        element_id = element["element-6066-11e4-a52e-4f735466cecf"]
        wd("POST", f"/session/{session}/element/{element_id}/click", {})
        require(helpers.wait_until(lambda: row()["status"] == status, 12), "consent action did not reach observed state: " + decision)

    def start_app():
        nonlocal session
        value = wd("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(binary)}}}})
        session = value["sessionId"]
        wd("POST", f"/session/{session}/timeouts", {"script": 60000})
        require(helpers.wait_until(lambda: execute("return !!window.__TAURI__?.core?.invoke;"), 30), "application IPC did not boot")
        require(helpers.wait_until(lambda: invoke("get_backend_bootstrap_status", allow_error=True).get("value", {}).get("ready") is True, 30), "production backend not ready")
        show_settings()

    def stop_app():
        nonlocal session
        old = helpers.app_pids(binary)
        response = invoke("close_window")
        require(response["ok"] and old, "quit reply or process identity missing")
        require(helpers.wait_until(lambda: all(helpers.live_identity(pid) != identity for pid, identity in old.items()), 20), "prior app process identity remained")
        report["quitRequests"].append({"ipcReplyObserved": True, "priorProcessIdentitiesGone": True, "exitStatus": "NOT_OBSERVED"})
        wd("DELETE", f"/session/{session}")
        session = None

    def start_client():
        nonlocal client
        target = invoke("get_collection_server_base_url")["value"]
        target_port = int(target.rsplit(":", 1)[1])
        command = [str(args.node.resolve(strict=True))]
        if args.chromium:
            command += [str(Path(__file__).parent / "lib/linux-browser-chromium-client.mjs"),
                        "--browser", str(args.chromium.resolve(strict=True)), "--origin", origin, "--port", str(target_port)]
        else:
            command += [str(Path(__file__).parent / "lib/linux-browser-connection-client.mjs"), str(manifest_path), origin, str(target_port)]
        client = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def stop_client():
        nonlocal client
        if client:
            client.stdin.close()
            client.wait(timeout=10)
            require(client.returncode == 0, "browser client did not stop successfully")
            client = None

    def extension(command, expected=None):
        client.stdin.write(json.dumps({"type": command}) + "\n")
        client.stdin.flush()
        require(select.select([client.stdout], [], [], 60 if args.chromium else 20)[0], "browser client reply timeout")
        value = json.loads(client.stdout.readline())
        report["clientCommands"].append({"command": command, **{key: value[key] for key in
            ("ok", "code", "httpStatus", "counters", "phase") if key in value}})
        if expected:
            require(value.get("ok") is False and value.get("code") == expected, "wrong extension rejection: " + command)
        else:
            require(value.get("ok") is True, "extension command failed: " + command + ":" + str(value.get("code")))
        require(value["counters"]["anonymousBootstrap"] == 0, "Linux adapter used anonymous bootstrap")
        if args.chromium:
            require(value.get("browserApi") == "REAL_CHROMIUM_NO_API_SUBSTITUTION", "real Chromium required")
            require(value.get("sandbox", {}).get("status") == "PASS", "actual browser sandbox required")
            require(value.get("extension", {}).get("origin") == origin, "actual extension origin mismatch")
            if not report["browserSessions"] or report["browserSessions"][-1]["session"] != value["session"]:
                report["browserSessions"].append({key: value[key] for key in ("session", "browser", "sandbox", "extension")})
        return value

    try:
        def ready():
            try:
                return wd("GET", "/status", timeout=1).get("ready") is True
            except OSError:
                return False
        require(helpers.wait_until(ready, 15), "WebDriver did not start")
        start_app()
        require(row()["status"] == "not-requested", "unexpected initial consent")
        start_client()
        extension("connect", "extension-connection-approval-required")
        first_request = row()["requestId"]
        click("reject", "denied")
        extension("connect", "extension-connection-denied")
        click("retry", "not-requested")
        extension("connect", "extension-connection-approval-required")
        require(row()["requestId"] != first_request, "denied request identity reused")
        stale = invoke("linux_browser_connection_decide", {"requestId": first_request, "decision": "approve"}, allow_error=True)
        require(stale["ok"] is False and "request-stale" in stale["error"], "stale consent decision accepted")
        click("approve", "approved")
        first_binding = extension("connect")["binding"]
        require(extension("read")["httpStatus"] == 200, "real protected read failed")
        first_grant = row()["grantId"]
        click("revoke", "revoked")
        extension("connect", "extension-connection-revoked")
        extension("read-first", "extension-connection-revoked")
        click("retry", "not-requested")
        extension("connect", "extension-connection-approval-required")
        click("approve", "approved")
        require(row()["grantId"] != first_grant, "revoked grant identity reused")
        second_binding = extension("connect")["binding"]
        require(second_binding["fingerprint"] != first_binding["fingerprint"], "old extension credential reactivated")
        extension("read-first", "binding-identity-mismatch")
        extension("read")
        report["checks"].update(explicitRequestDenialRetryApproval="PASS", staleDecisionRejected="PASS",
            realProtectedRead="PASS", revocationStopsNativeAndCachedConnection="PASS", oldCredentialAndBindingRemainInvalidAfterReapproval="PASS")
        stop_client()
        stop_app()
        start_app()
        require(row()["status"] == "approved", "explicit consent did not persist on reopen")
        start_client()
        reopened = extension("connect")["binding"]
        require(reopened["fingerprint"] == second_binding["fingerprint"], "persisted consent changed unexpectedly")
        extension("read")
        click("revoke", "revoked")
        extension("connect", "extension-connection-revoked")
        auth = profile / "data/com.luckyray.desktop.dev/local-transport-auth-v1.json"
        record = json.loads(auth.read_text())
        require(origin not in record["approvedOrigins"] and origin not in record.get("linuxOriginGrants", {}), "final revocation not persisted")
        require(auth.stat().st_mode & 0o777 == 0o600, "credential permissions changed")
        report["checks"].update(applicationReopenConsentPersistence="PASS", finalRevocationPersisted="PASS", realConsentButtons="PASS", credentialMode="PASS")
        stop_client()
        stop_app()
        if args.chromium:
            require(len(report["browserSessions"]) == 2, "two actual browser sessions required")
            report["realChromium"] = "PASS"
        report["status"] = "PASS"
    except Exception as failure:
        report["status"] = "FAIL"
        report["failure"] = str(failure)
        raise
    finally:
        if client and client.poll() is None:
            client.terminate()
            client.wait(timeout=10)
        if session:
            try:
                wd("DELETE", f"/session/{session}")
            except Exception:
                pass
        try:
            os.killpg(driver.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        driver.wait(timeout=10)
        log.close()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
