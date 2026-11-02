"""Source-bound single Main notes/PNG CI; reuse real build/resource collectors."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


runtime = module("notes_runtime_ci", "linux-runtime-ci.py")
smoke = module("notes_smoke", "linux-notes-attachments-smoke.py")
require, digest, read_json, write_json = runtime.require, runtime.digest, runtime.read_json, runtime.write_json
SCOPE = smoke.SCOPE
EXCLUDED = {name: "NOT_RUN" for name in ("chromiumConsent", "nativeMessaging", "nativePointerDrag",
    "externalApplicationDisplay", "trimmedFilenameEndToEnd", "videoCodecMatrix", "personalBrowserHost",
    "installer", "release", "waylandHardware", "oldMatrices", "lshFunctionalFlow")}
STEPS = ("CHECKOUT", "INIT", "NODE", "OFFLINE", "DEPENDENCIES", "RUST", "FRONTEND", "BUILD", "DRIVER", "RUNTIME", "RESOURCES", "NOTES")
EXPORTS = ("source.json", "build.json", "resources.json", "notes.json", "result.json")
runtime.SCOPE, runtime.EXCLUDED = SCOPE, EXCLUDED
PHASES = frozenset(("synthetic-setup", "desktop-association", "driver-start", "main-start", "drop-import", "edit-save", "copy-absolute-path",
                    "image-preview", "attachment-open", "reopen", "quit", "unknown"))
FAILURES = frozenset(("owned-desktop-association-unavailable", "driver-not-ready", "backend-not-ready", "production-ipc-rejected", "visible-control-missing",
    "ui-observation-timeout", "drop-target-unavailable", "both-input-notes-not-retained", "case-distinct-content-mismatch",
    "special-name-png-not-retained", "ui-edit-not-saved", "copy-path-menu-missing", "absolute-path-clipboard-mismatch",
    "preview-not-visible", "preview-pixels-mismatch", "screenshot-invalid", "screenshot-size-invalid",
    "image-outside-screenshot", "attachment-receiver-not-observed", "attachment-handoff-mismatch",
    "reopen-file-content-mismatch", "quit-process-remained", "unexpected-error"))


def bounded_drop_trace(raw):
    raw = raw if isinstance(raw, dict) else {}
    count = raw.get("readBytes")
    result = {"state": "UNAVAILABLE" if raw.get("state") == "UNAVAILABLE" else "NOT_OBSERVED",
              "readBytes": count if type(count) is int and 0 <= count <= 65536 else 0,
              "truncated": raw.get("truncated") is True, "records": []}
    for item in raw["records"][:32] if isinstance(raw.get("records"), list) else []:
        if (not isinstance(item, dict) or not isinstance(item.get("stage"), str)
                or item["stage"] not in smoke.DROP_STAGES or type(item.get("count")) is not int
                or not 0 <= item["count"] <= 100000 or type(item.get("hit")) is not bool):
            continue
        result["records"].append({"stage": item["stage"], "count": min(item["count"], 2),
                                  "overflow": item.get("overflow") is True or item["count"] > 2, "hit": item["hit"]})
    if result["records"]:
        result["state"] = "OBSERVED"
    if isinstance(raw.get("records"), list) and len(raw["records"]) > 32:
        result["truncated"] = True
    return result


def bounded_report(raw):
    """Closed projection. No child text, path, clipboard value, log or environment."""
    raw = raw if isinstance(raw, dict) else {}
    result = {"schemaVersion": 1 if type(raw.get("schemaVersion")) is int and raw["schemaVersion"] == 1 else None,
              "scope": SCOPE if raw.get("scope") == SCOPE else "INVALID",
              "status": raw.get("status") if raw.get("status") in ("PASS", "FAIL") else "INVALID"}
    for key, length in (("commit", 40), ("applicationSha256", 64), ("scriptSha256", 64), ("helperSha256", 64)):
        value = raw.get(key)
        result[key] = value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{" + str(length) + r"}", value) else None
    for key in ("flowCount", "appSessions"):
        value = raw.get(key)
        result[key] = value if type(value) is int and 0 <= value <= 2 else None
    checks = raw.get("checks") if isinstance(raw.get("checks"), dict) else {}
    result["checks"] = {name: checks.get(name) if checks.get(name) in ("PASS", "FAIL", "NOT_RUN") else "INVALID" for name in smoke.CHECKS}
    drop = raw.get("drop") if isinstance(raw.get("drop"), dict) else {}
    result["drop"] = {"transport": "TAURI_EVENT_IPC" if drop.get("transport") == "TAURI_EVENT_IPC" else "INVALID",
                      "nativePointerDrag": "NOT_RUN" if drop.get("nativePointerDrag") == "NOT_RUN" else "INVALID"}
    for name in ("gestures", "inputNotes", "retainedNotes"):
        value = drop.get(name)
        result["drop"][name] = value if type(value) is int and 0 <= value <= 2 else None
    for name in ("collisionRenameObserved", "originalCaseSpellingsBothRetained"):
        result["drop"][name] = drop.get(name) if type(drop.get(name)) is bool else None
    result["drop"]["destinationNames"] = ["Note.md", "note (1).md"] if drop.get("destinationNames") == ["Note.md", "note (1).md"] else []
    for name, keys in (("dropHit", ("insideNotes", "rootTarget")), ("dropTargets", ("upperExists", "lowerExists"))):
        value = raw.get(name) if isinstance(raw.get(name), dict) else {}
        result[name] = {key: value.get(key) if type(value.get(key)) is bool else None for key in keys}
    result["dropTrace"] = bounded_drop_trace(raw.get("dropTrace"))
    result["previews"] = []
    for probe in raw["previews"] if isinstance(raw.get("previews"), list) and len(raw["previews"]) <= 2 else []:
        if not isinstance(probe, dict):
            continue
        item = {name: probe.get(name) if type(probe.get(name)) is int and 0 <= probe[name] <= 4096 else None
                for name in ("session", "naturalWidth", "naturalHeight", "sampled", "matched")}
        item.update(visible=probe.get("visible") is True,
                    method="WEBVIEW_SCREENSHOT_PIXELS" if probe.get("method") == "WEBVIEW_SCREENSHOT_PIXELS" else "INVALID")
        result["previews"].append(item)
    clipboard = raw.get("clipboard") if isinstance(raw.get("clipboard"), dict) else {}
    result["clipboard"] = {"source": "REAL_NOTE_CONTEXT_MENU" if clipboard.get("source") == "REAL_NOTE_CONTEXT_MENU" else "INVALID",
                           "systemRead": "XCLIP" if clipboard.get("systemRead") == "XCLIP" else "INVALID",
                           "exactAbsolutePath": clipboard.get("exactAbsolutePath") is True}
    handoff = raw.get("handoff") if isinstance(raw.get("handoff"), dict) else {}
    expected_sha = hashlib.sha256(smoke.png_bytes()).hexdigest()
    result["handoff"] = {"kind": "OWNED_XDG_RECEIVER_READBACK" if handoff.get("kind") == "OWNED_XDG_RECEIVER_READBACK" else "INVALID",
                         "exactExpectedFile": handoff.get("exactExpectedFile") is True,
                         "bytes": handoff.get("bytes") if type(handoff.get("bytes")) is int and handoff["bytes"] == len(smoke.png_bytes()) else None,
                         "sha256": expected_sha if handoff.get("sha256") == expected_sha else None,
                         "externalApplicationDisplay": "NOT_RUN" if handoff.get("externalApplicationDisplay") == "NOT_RUN" else "INVALID"}
    result["quitRequests"] = []
    for item in raw["quitRequests"] if isinstance(raw.get("quitRequests"), list) and len(raw["quitRequests"]) <= 2 else []:
        if isinstance(item, dict):
            result["quitRequests"].append({"ipcReplyObserved": item.get("ipcReplyObserved") is True,
                "priorProcessIdentitiesGone": item.get("priorProcessIdentitiesGone") is True,
                "exitStatus": "NOT_OBSERVED" if item.get("exitStatus") == "NOT_OBSERVED" else "INVALID"})
    for name in ("externalApplicationDisplay", "trimmedFilenameEndToEnd", "waylandHardware", "installer"):
        result[name] = "NOT_RUN" if raw.get(name) == "NOT_RUN" else "INVALID"
    if "failure" in raw:
        failure = raw["failure"] if isinstance(raw["failure"], dict) else {}
        result["failure"] = {"phase": failure.get("phase") if isinstance(failure.get("phase"), str) and failure["phase"] in PHASES else "unknown",
                             "code": failure.get("code") if isinstance(failure.get("code"), str) and failure["code"] in FAILURES else "unexpected-error"}
    if "cleanup" in raw:
        result["cleanup"] = "UNCONFIRMED"
    return result


def validate_notes(raw, build, source, scripts):
    require(isinstance(raw, dict) and raw == bounded_report(raw), "notes-report-shape-invalid")
    require(isinstance(raw, dict) and raw.get("schemaVersion") == 1 and raw.get("status") == "PASS" and "failure" not in raw and "cleanup" not in raw,
            "notes-flow-not-complete")
    require(raw.get("scope") == SCOPE and raw.get("commit") == source["commit"]
            and raw.get("applicationSha256") == build["application"]["sha256"]
            and raw.get("scriptSha256") == scripts["smoke"] and raw.get("helperSha256") == scripts["webdriver"], "notes-source-identity-mismatch")
    require(raw.get("flowCount") == 1 and raw.get("appSessions") == 2
            and all(raw.get("checks", {}).get(name) == "PASS" for name in smoke.CHECKS), "required-notes-check-missing")
    require(raw.get("drop") == {"transport": "TAURI_EVENT_IPC", "nativePointerDrag": "NOT_RUN", "gestures": 1,
            "inputNotes": 2, "retainedNotes": 2, "collisionRenameObserved": True,
            "originalCaseSpellingsBothRetained": False, "destinationNames": ["Note.md", "note (1).md"]}, "drop-boundary-or-retention-mismatch")
    require(raw.get("dropTargets") == {"upperExists": True, "lowerExists": True}, "synthetic-drop-targets-missing")
    expected_preview = lambda session: {"session": session, "naturalWidth": 32, "naturalHeight": 24,
        "sampled": 5, "matched": 5, "visible": True, "method": "WEBVIEW_SCREENSHOT_PIXELS"}
    require(raw.get("previews") == [expected_preview(1), expected_preview(2)], "real-preview-pixel-evidence-missing")
    require(raw.get("clipboard") == {"source": "REAL_NOTE_CONTEXT_MENU", "systemRead": "XCLIP", "exactAbsolutePath": True}, "real-clipboard-evidence-missing")
    handoff = raw.get("handoff", {})
    require(handoff.get("kind") == "OWNED_XDG_RECEIVER_READBACK" and handoff.get("exactExpectedFile") is True
            and handoff.get("bytes") == len(smoke.png_bytes())
            and handoff.get("sha256") == hashlib.sha256(smoke.png_bytes()).hexdigest()
            and handoff.get("externalApplicationDisplay") == "NOT_RUN", "os-handoff-readback-missing")
    require(raw.get("quitRequests") == [{"ipcReplyObserved": True, "priorProcessIdentitiesGone": True, "exitStatus": "NOT_OBSERVED"}] * 2,
            "application-quit-evidence-incomplete")
    require(all(raw.get(name) == "NOT_RUN" for name in
            ("externalApplicationDisplay", "trimmedFilenameEndToEnd", "waylandHardware", "installer")), "unverified-coverage-claimed")


class Run(runtime.Run):
    def scripts(self):
        paths = {"collector": "luckyray-app/tests/linux-notes-ci.py", "resourceCollector": "luckyray-app/tests/linux-runtime-ci.py",
                 "smoke": "luckyray-app/tests/linux-notes-attachments-smoke.py", "webdriver": "luckyray-app/tests/linux-desktop-smoke.py",
                 "workflow": ".github/workflows/linux-desktop-preflight.yml", "dropPaths": "luckyray-app/src/features/notes/externalDropPaths.ts",
                 "notesPage": "luckyray-app/src/features/notes/NotesPage.tsx"}
        return {name: digest(self.repo / path) for name, path in paths.items()}

    def notes(self):
        source = self.source()
        (self.private / "notes.attempt").open("x").close()
        build, resources = read_json(self.evidence / "build.json"), read_json(self.evidence / "resources.json")
        layout = read_json(self.private / "layout.json")
        require(build.get("status") == "PASS" and resources.get("status") == "PASS"
                and build.get("source") == source and resources.get("source") == source
                and resources.get("scope") == SCOPE, "source-bound-main-and-resources-required")
        require(runtime.regular_elf(Path(layout["application"])) == build["application"], "main-elf-changed")
        command = ["dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1440x900x24",
            "/usr/bin/python3", str(self.app / "tests/linux-notes-attachments-smoke.py"),
            "--application", layout["application"], "--driver", str(self.args.driver), "--output", str(self.private / "notes-flow")]
        report = {"status": "FAIL", "scope": SCOPE, "source": source, "attempts": 1, "flowCount": 1,
                  "driver": {"versionPin": "2.1.0", **runtime.regular_elf(self.args.driver)}}
        try:
            result = subprocess.run(command, env=self.env(), text=True, capture_output=True, timeout=720)
            (self.private / "notes-flow.log").write_text(result.stdout + result.stderr)
            report["childExitCode"] = result.returncode
            raw_path = self.private / "notes-flow/report.json"
            require(raw_path.is_file(), "child-report-unavailable")
            report["observations"] = bounded_report(read_json(raw_path))
            require(result.returncode == 0, "notes-child-failed")
            validate_notes(report["observations"], build, source, self.scripts())
            self.source()
            report["status"] = "PASS"
        except subprocess.TimeoutExpired:
            report["failure"] = "notes-child-timeout"
            raise
        except Exception:
            report["failure"] = "notes-child-or-evidence-incomplete"
            raise
        finally:
            write_json(self.evidence / "notes.json", report)

    def finish(self):
        outcomes = {name: os.environ.get("CI_" + name, "missing") for name in STEPS}
        bodies, statuses = {}, {}
        for name in EXPORTS[:-1]:
            try:
                bodies[name] = read_json(self.evidence / name)
                statuses[name] = bodies[name].get("status", "INVALID")
            except (OSError, ValueError, RuntimeError):
                statuses[name] = "INVALID" if os.path.lexists(self.evidence / name) else "NOT_RUN"
        passed = all(value == "success" for value in outcomes.values()) and all(value == "PASS" for value in statuses.values())
        source = {"commit": os.environ.get("GITHUB_SHA"), "sourceVerification": "FAILED"}
        try:
            source = self.source()
            require(all(body.get("source") == source and body.get("scope") == SCOPE for body in bodies.values()), "stale-report")
            require(bodies["build.json"].get("scripts") == self.scripts(), "build-script-identity-changed")
            notes = bodies["notes.json"]
            require(notes.get("attempts") == 1 and notes.get("flowCount") == 1 and notes.get("childExitCode") == 0
                    and "failure" not in notes, "missing-or-repeated-flow")
            validate_notes(notes.get("observations"), bodies["build.json"], source, self.scripts())
        except (OSError, ValueError, KeyError, TypeError, RuntimeError):
            passed = False
        safe = ({path.name for path in self.evidence.iterdir()} == set(EXPORTS[:-1])
                and all(path.is_file() and not path.is_symlink() for path in self.evidence.iterdir()))
        passed = passed and safe
        write_json(self.evidence / "result.json", {"status": "PASS" if passed else "FAIL", "scope": SCOPE,
            "source": source, "stepOutcomes": outcomes, "reports": statuses, "artifactAllowlist": list(EXPORTS),
            "exportPolicy": "PASS" if safe else "FAIL", "included": {"notesPngFlows": 1}, "excluded": EXCLUDED,
            "productAcceptance": "NOTES_PATH_ATTACHMENTS_PASS_ONLY" if passed else "NOT_RUN",
            "limits": ["drop is one declared Tauri event IPC injection; native pointer drag NOT_RUN",
                       "case-distinct input contents retained; existing importer collision rename preserved",
                       "PNG decoded and sampled in Main WebDriver screenshot, not physical-display QA",
                       "owned isolated XDG receiver readback; external application display NOT_RUN",
                       "trailing-whitespace filenames, video codecs, embedded browser and packages NOT_RUN",
                       "quit IPC and process disappearance; clean exit status NOT_OBSERVED"]})
        require(passed, "required-notes-product-flow-failed-or-not-run")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("init", "binaries", "resources", "notes", "finish"))
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--driver", type=Path)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    getattr(Run(args), args.phase)()


if __name__ == "__main__":
    main()
