"""One real Chromium consent flow; old matrices and protocol fixtures are excluded."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("runtime_ci", Path(__file__).with_name("linux-runtime-ci.py"))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
require, digest, read_json, write_json = runtime.require, runtime.digest, runtime.read_json, runtime.write_json
SCOPE = "real-chromium-browser-consent-only"
EXCLUDED = {name: "NOT_RUN" for name in (
    "oldRustMatrix", "nativeHostCliMatrix", "lshUiProbe", "core", "gio", "autostart", "protocolFixtures", "materialFixtures")}
STEPS = ("CHECKOUT", "INIT", "NODE", "PREFLIGHT", "DEPENDENCIES", "RUST", "FRONTEND",
         "BUILD", "DRIVER", "RUNTIME", "RESOURCES", "BROWSER")
EXPORTS = ("source.json", "preflight.json", "build.json", "resources.json", "browser.json", "result.json")
runtime.SCOPE, runtime.EXCLUDED = SCOPE, EXCLUDED
CHECKS = ("explicitRequestDenialRetryApproval", "staleDecisionRejected", "realProtectedRead",
          "revocationStopsNativeAndCachedConnection", "oldCredentialAndBindingRemainInvalidAfterReapproval",
          "applicationReopenConsentPersistence", "finalRevocationPersisted", "realConsentButtons", "credentialMode")
COMMANDS = (("connect", False, "extension-connection-approval-required"), ("connect", False, "extension-connection-denied"),
            ("connect", False, "extension-connection-approval-required"), ("connect", True, None), ("read", True, None),
            ("connect", False, "extension-connection-revoked"), ("read-first", False, "extension-connection-revoked"),
            ("connect", False, "extension-connection-approval-required"), ("connect", True, None),
            ("read-first", False, "binding-identity-mismatch"), ("read", True, None),
            ("connect", True, None), ("read", True, None), ("connect", False, "extension-connection-revoked"))


PREFLIGHT_PHASES = frozenset(("ordinary-user", "user-namespace", "browser-layout", "node-selection",
    "chromium-subprocess", "chromium-output", "source-verification", "complete", "unknown",
    "browser-identity", "extension-identity", "synthetic-profile", "browser-arguments", "browser-start",
    "cdp-connect", "sandbox-page", "sandbox-observation", "sandbox-assertion", "browser-cleanup"))
PREFLIGHT_FAILURE_CODES = frozenset(("ordinary-user-required", "user-namespace-failed", "user-namespace-timeout",
    "browser-layout-invalid", "node-unavailable", "chromium-execution-failed", "chromium-timeout",
    "child-output-invalid", "child-report-invalid", "child-exit-status-mismatch", "sandbox-evidence-invalid",
    "source-verification-failed", "browser-identity-invalid", "extension-identity-invalid", "synthetic-profile-invalid",
    "browser-arguments-invalid", "browser-start-failed", "browser-exited-before-devtools", "devtools-start-timeout",
    "cdp-connect-failed", "sandbox-page-failed", "sandbox-observation-failed", "sandbox-observation-timeout",
    "sandbox-assertion-failed", "namespace-sandbox-required", "pid-namespaces-required", "network-namespaces-required",
    "seccomp-bpf-required", "adequate-sandbox-required", "browser-cleanup-failed", "unclassified-client-failure"))
PREFLIGHT_OS_ERRORS = frozenset(("ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"))
PREFLIGHT_SIGNALS = frozenset(("SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGKILL",
                             "SIGSEGV", "SIGSYS", "SIGTERM", "SIGTRAP"))


def browser_identity(value):
    if (not isinstance(value, dict) or not isinstance(value.get("version"), str)
            or len(value["version"]) > 80 or re.fullmatch(r"Chromium [0-9]+(?:\.[0-9]+)+", value["version"]) is None
            or not isinstance(value.get("sha256"), str) or re.fullmatch(r"[0-9a-f]{64}", value["sha256"]) is None
            or type(value.get("bytes")) is not int or not 0 < value["bytes"] <= 2**53 - 1):
        return None
    return {key: value[key] for key in ("version", "sha256", "bytes")}


def preflight_failure(value):
    value = value if isinstance(value, dict) else {}
    result = {"phase": value.get("phase") if isinstance(value.get("phase"), str) and value["phase"] in PREFLIGHT_PHASES else "unknown",
              "code": value.get("code") if isinstance(value.get("code"), str) and value["code"] in PREFLIGHT_FAILURE_CODES else "unclassified-client-failure"}
    if isinstance(value.get("osError"), str) and value["osError"] in PREFLIGHT_OS_ERRORS:
        result["osError"] = value["osError"]
    code = value.get("browserExitCode")
    if "browserExitCode" in value and (code is None or type(code) is int and -65535 <= code <= 65535):
        result["browserExitCode"] = code
    if isinstance(value.get("browserSignal"), str) and value["browserSignal"] in PREFLIGHT_SIGNALS:
        result["browserSignal"] = value["browserSignal"]
    return result


def preflight_diagnostic(value):
    """Bounded projection: never forward child text, log output, paths or extra keys."""
    if not isinstance(value, dict):
        return {"status": "NOT_RUN"}
    result = {"status": value.get("status") if value.get("status") in ("PASS", "FAIL") else "INVALID",
              "phase": value.get("phase") if isinstance(value.get("phase"), str) and value["phase"] in PREFLIGHT_PHASES else "unknown"}
    browser = browser_identity(value.get("browser"))
    if browser:
        result["browser"] = browser
    if "failure" in value:
        result["failure"] = preflight_failure(value["failure"])
    probe = value.get("userNamespaceProbe")
    if isinstance(probe, dict):
        code = probe.get("exitCode")
        result["userNamespaceProbe"] = {"exitCode": code if type(code) is int and -65535 <= code <= 65535 else None}
    child = value.get("child")
    if isinstance(child, dict):
        code = child.get("exitCode")
        result["child"] = {"exitCode": code if type(code) is int and -65535 <= code <= 65535 else None,
                           "status": child.get("status") if child.get("status") in ("PASS", "FAIL", "INVALID", "TIMEOUT") else "INVALID"}
        if "failure" in child:
            result["child"]["failure"] = preflight_failure(child["failure"])
    return result


def extension_identity(app):
    root = app / "browser-extension-prototype"
    manifest = json.loads((root / "manifest.json").read_text())
    key_hash = hashlib.sha256(base64.b64decode(manifest["key"], validate=True)).hexdigest()[:32]
    origin = "chrome-extension://" + "".join(chr(97 + int(c, 16)) for c in key_hash)
    files = []
    for path in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
        require(not path.is_symlink(), "link in extension source")
        if path.is_dir():
            continue
        require(stat.S_ISREG(path.stat().st_mode), "non-file in extension source")
        files.append((path.relative_to(root).as_posix(), path.stat().st_size, digest(path)))
    closure = "".join(f"{name}\0{size}\0{sha}\n" for name, size, sha in files).encode()
    return {"origin": origin, "manifestSha256": digest(root / "manifest.json"),
            "files": len(files), "closureSha256": hashlib.sha256(closure).hexdigest()}


def validate_sandbox(value):
    require(isinstance(value, dict) and value.get("status") == "PASS"
            and all(value.get(key) == "Yes" for key in ("namespace", "pidNamespaces", "networkNamespaces", "seccompBpf"))
            and value.get("adequatelySandboxed") is True and value.get("securityDisablingFlags") == []
            and value.get("source") == "ACTUAL_CHROME_SANDBOX_PAGE", "real namespace and seccomp sandbox required")


def validate_browser(raw, build, source, scripts, extension, preflight):
    require(isinstance(raw, dict) and raw.get("status") == "PASS" and "failure" not in raw, "browser flow incomplete")
    require(raw.get("commit") == source["commit"] and raw.get("applicationSha256") == build["application"]["sha256"]
            and raw.get("nativeHostSha256") == build["nativeHost"]["sha256"], "browser source or ELF identity mismatch")
    require(raw.get("scriptSha256") == scripts["smoke"] and raw.get("clientScriptSha256") == scripts["chromium"],
            "browser scripts changed")
    require(raw.get("realChromium") == "PASS" and raw.get("browserApi") == "REAL_CHROMIUM_NO_API_SUBSTITUTION",
            "a protocol fixture is not real Chromium")
    require(raw.get("checks") == {key: "PASS" for key in CHECKS}, "required consent assertions missing")
    commands = raw.get("clientCommands")
    require(isinstance(commands, list) and len(commands) == len(COMMANDS), "observed browser command sequence incomplete")
    for value, (command, ok, code) in zip(commands, COMMANDS):
        require(value.get("command") == command and value.get("ok") is ok and value.get("code") == code
                and value.get("counters", {}).get("anonymousBootstrap") == 0, "unexpected browser command result")
        if command == "read":
            require(value.get("httpStatus") == 200, "real protected read did not succeed")
    sessions = raw.get("browserSessions")
    require(isinstance(sessions, list) and len(sessions) == 2
            and len({s.get("session") for s in sessions}) == 2, "two fresh browser sessions required")
    for session in sessions:
        require(session.get("browser") == preflight["browser"] and session.get("extension") == extension,
                "browser or unchanged extension identity mismatch")
        validate_sandbox(session.get("sandbox"))
    quits = raw.get("quitRequests")
    require(isinstance(quits, list) and len(quits) == 2 and all(
        q.get("ipcReplyObserved") is True and q.get("priorProcessIdentitiesGone") is True
        and q.get("exitStatus") == "NOT_OBSERVED" for q in quits), "application lifecycle incomplete")


class Run(runtime.Run):
    def scripts(self):
        paths = {"collector": "linux-browser-ci.py", "resourceCollector": "linux-runtime-ci.py",
                 "smoke": "linux-browser-connection-smoke.py", "webdriver": "linux-desktop-smoke.py",
                 "chromium": "lib/linux-browser-chromium-client.mjs",
                 "cdp": "browser-extension-runtime/lib/cdp-client.mjs"}
        return {name: digest(self.app / "tests" / path) for name, path in paths.items()}

    def init(self):
        super().init()
        extension = extension_identity(self.app)
        write_json(self.private / "extension.json", extension)
        require(re.fullmatch(r"chrome-extension://[a-p]{32}", extension["origin"]), "invalid manifest-derived origin")
        if os.environ.get("GITHUB_ENV"):
            with open(os.environ["GITHUB_ENV"], "a") as stream:
                stream.write("LUCKYRAY_EXTENSION_ORIGINS=" + extension["origin"] + "\n")

    def preflight(self):
        source = self.source()
        (self.private / "preflight.attempt").open("x").close()
        report = {"status": "FAIL", "scope": SCOPE, "source": source, "attempts": 1,
                  "supportedEnvironment": "standard GitHub Ubuntu 22.04 VM, ordinary user, preinstalled unbranded Chromium",
                  "securityOrPolicyChanges": "NONE"}
        def phase(name, code):
            report["phase"] = name
            return {"phase": name, "code": code}
        failure = phase("ordinary-user", "ordinary-user-required")
        try:
            require(os.geteuid() != 0, "ordinary user required")
            failure = phase("user-namespace", "user-namespace-failed")
            result = subprocess.run(["/usr/bin/unshare", "--user", "--map-root-user", "/bin/true"],
                                    env=self.env(), capture_output=True, timeout=10)
            (self.private / "userns.log").write_bytes(result.stdout + result.stderr)
            report["userNamespaceProbe"] = {"exitCode": result.returncode, "logSha256": digest(self.private / "userns.log")}
            require(result.returncode == 0, "user namespaces unavailable; stop before builds, no sandbox fallback")
            failure = phase("browser-layout", "browser-layout-invalid")
            browser = Path("/usr/bin/chromium").resolve(strict=True)
            require(browser == Path("/usr/local/share/chromium/chrome-linux/chrome"), "runner Chromium layout changed")
            failure = phase("node-selection", "node-unavailable")
            node = str(Path(shutil.which("node")).resolve(strict=True))
            command = [node, str(self.app / "tests/lib/linux-browser-chromium-client.mjs"),
                       "--browser", str(browser), "--mode", "preflight"]
            failure = phase("chromium-subprocess", "chromium-execution-failed")
            report["child"] = {"exitCode": None, "status": "INVALID"}
            result = subprocess.run(command, env=self.env(), text=True, capture_output=True, timeout=90)
            report["child"]["exitCode"] = result.returncode
            (self.private / "preflight.log").write_text(result.stdout + result.stderr)
            failure = phase("chromium-output", "child-output-invalid")
            require(len(result.stdout.encode("utf8")) <= 16 * 1024, "bounded child report required")
            value = json.loads(result.stdout)
            failure = phase("chromium-output", "child-report-invalid")
            require(isinstance(value, dict), "child report must be an object")
            identity = browser_identity(value.get("browser"))
            if identity:
                report["browser"] = identity
            report["child"]["status"] = value.get("status") if value.get("status") in ("PASS", "FAIL") else "INVALID"
            if "failure" in value:
                report["child"]["failure"] = preflight_failure(value["failure"])
            failure = phase("chromium-output", "child-exit-status-mismatch")
            if value.get("status") == "FAIL":
                failure = preflight_failure(value.get("failure"))
                report["phase"] = failure["phase"]
            require(result.returncode == 0 and value.get("status") == "PASS" and "failure" not in value,
                    "normal browser sandbox preflight failed")
            failure = phase("browser-identity", "browser-identity-invalid")
            require(identity is not None, "verified browser identity required")
            failure = phase("sandbox-assertion", "sandbox-evidence-invalid")
            validate_sandbox(value.get("sandbox"))
            report["sandbox"] = {key: value["sandbox"][key] for key in ("status", "namespace", "pidNamespaces",
                "networkNamespaces", "seccompBpf", "adequatelySandboxed", "securityDisablingFlags", "source")}
            write_json(self.private / "browser-layout.json", {"browser": str(browser), "node": node})
            failure = phase("source-verification", "source-verification-failed")
            self.source()
            report["status"] = "PASS"
            report["phase"] = "complete"
        except Exception as error:
            if isinstance(error, subprocess.TimeoutExpired):
                code = "user-namespace-timeout" if report["phase"] == "user-namespace" else "chromium-timeout"
                failure = {"phase": report["phase"], "code": code}
                if "child" in report:
                    report["child"]["status"] = "TIMEOUT"
            report["failure"] = failure
            report["error"] = "preflight failed: " + failure["code"]
            raise RuntimeError(report["error"]) from None
        finally:
            write_json(self.evidence / "preflight.json", report)

    def binaries(self):
        require(os.environ.get("LUCKYRAY_EXTENSION_ORIGINS") == extension_identity(self.app)["origin"],
                "both real binaries must compile the public extension origin")
        messages = (self.private / "native-artifacts.jsonl").read_text()
        host = runtime.select_artifact(messages, self.app / "src-tauri/src/sidecars/luckyray-native-host.rs", False, self.target)
        host_identity = runtime.regular_elf(host)
        selected_sources = {str(self.app / "src-tauri/src" / path) for path in ("main.rs", "sidecars/luckyray-native-host.rs")}
        selected = [item for item in map(json.loads, messages.splitlines()) if item.get("reason") == "compiler-artifact"
                    and item["target"]["src_path"] in selected_sources and item.get("executable")]
        require(len(selected) == 2 and all(item.get("fresh") is False for item in selected), "both source-bound executables must be freshly built")
        super().binaries()
        report = read_json(self.evidence / "build.json")
        report.update(nativeHost=host_identity, compiledExtensionOrigin=extension_identity(self.app)["origin"], cargoArtifactsFresh=False)
        layout = read_json(self.private / "layout.json")
        layout["nativeHost"] = str(host)
        (self.private / "layout.json").write_text(json.dumps(layout) + "\n")
        (self.evidence / "build.json").write_text(json.dumps(report, indent=2) + "\n")

    def browser(self):
        source = self.source()
        (self.private / "browser.attempt").open("x").close()
        build = read_json(self.evidence / "build.json")
        layout = read_json(self.private / "layout.json")
        browser_layout = read_json(self.private / "browser-layout.json")
        preflight = read_json(self.evidence / "preflight.json")
        require(preflight.get("status") == "PASS", "normal sandbox preflight must pass before application startup")
        validate_sandbox(preflight.get("sandbox"))
        resources = read_json(self.evidence / "resources.json")
        require(resources.get("status") == "PASS" and resources.get("scope") == SCOPE, "complete genuine startup resources required")
        for key, name in (("application", "application"), ("nativeHost", "nativeHost")):
            require(runtime.regular_elf(Path(layout[key])) == build[name], "native executable changed before use")
        require(digest(Path(browser_layout["browser"])) == preflight["browser"]["sha256"], "preflight Chromium changed")
        output = self.private / "browser-flow"
        command = ["dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1440x900x24",
                   "/usr/bin/python3", str(self.app / "tests/linux-browser-connection-smoke.py"),
                   "--application", layout["application"], "--native-host", layout["nativeHost"],
                   "--driver", str(self.args.driver), "--node", browser_layout["node"],
                   "--chromium", browser_layout["browser"], "--output", str(output)]
        report = {"status": "FAIL", "scope": SCOPE, "source": source, "flowCount": 1, "attempts": 1,
                  "driver": {"versionPin": "2.1.0", **runtime.regular_elf(self.args.driver)}}
        try:
            result = subprocess.run(command, env=self.env(), text=True, capture_output=True, timeout=780)
            (self.private / "browser-flow.log").write_text(result.stdout + result.stderr)
            if (output / "report.json").is_file():
                report["rawReport"] = read_json(output / "report.json")
                report["rawReportSha256"] = digest(output / "report.json")
            require(result.returncode == 0, "real Chromium consent flow failed; no replay")
            validate_browser(report.get("rawReport"), build, source, self.scripts(), extension_identity(self.app), preflight)
            self.source()
            report["status"] = "PASS"
        except Exception as error:
            report["error"] = str(error)
            raise
        finally:
            write_json(self.evidence / "browser.json", report)

    def finish(self):
        outcomes = {name: os.environ.get("CI_" + name, "missing") for name in STEPS}
        bodies, reports = {}, {}
        for name in EXPORTS[:-1]:
            try:
                bodies[name] = read_json(self.evidence / name)
                reports[name] = bodies[name].get("status", "missing")
            except (OSError, ValueError, RuntimeError):
                reports[name] = "INVALID" if os.path.lexists(self.evidence / name) else "NOT_RUN"
        passed = all(v == "success" for v in outcomes.values()) and all(v == "PASS" for v in reports.values())
        source = {"commit": os.environ.get("GITHUB_SHA"), "sourceVerification": "FAILED"}
        try:
            source = self.source()
            require(all(b.get("source") == source and b.get("scope") == SCOPE for b in bodies.values()), "stale report identity")
            require(bodies["build.json"].get("scripts") == self.scripts(), "build scripts changed")
            preflight, browser = bodies["preflight.json"], bodies["browser.json"]
            require(preflight.get("attempts") == 1 and preflight["userNamespaceProbe"]["exitCode"] == 0, "preflight incomplete")
            validate_sandbox(preflight.get("sandbox"))
            require(browser.get("attempts") == 1 and browser.get("flowCount") == 1, "flow missing or replayed")
            validate_browser(browser.get("rawReport"), bodies["build.json"], source, self.scripts(), extension_identity(self.app), preflight)
        except (OSError, KeyError, TypeError, ValueError, RuntimeError):
            passed = False
        export_safe = (set(p.name for p in self.evidence.iterdir()).issubset(EXPORTS)
                       and all(p.is_file() and not p.is_symlink() for p in self.evidence.iterdir()))
        passed = passed and export_safe
        write_json(self.evidence / "result.json", {"status": "PASS" if passed else "FAIL", "scope": SCOPE,
                   "source": source, "stepOutcomes": outcomes, "reports": reports, "artifactAllowlist": list(EXPORTS),
                   "preflightDiagnostic": preflight_diagnostic(bodies.get("preflight.json")),
                   "exportPolicy": "PASS" if export_safe else "FAIL", "included": {"realChromiumConsentFlows": 1},
                   "excluded": EXCLUDED, "limits": ["synthetic profile and explicit temporary consent only",
                   "diagnostic ELFs, not installed personal-browser or package acceptance",
                   "OS login, Wayland/hardware, media/attachments and embedded browser host NOT_RUN",
                   "quit IPC and process disappearance, clean exit status NOT_OBSERVED"]})
        require(passed, "required Chromium acceptance failed or did not run")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("init", "preflight", "binaries", "resources", "browser", "finish"))
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--driver", type=Path)
    args = parser.parse_args()
    getattr(Run(args), args.phase)()


if __name__ == "__main__":
    main()
