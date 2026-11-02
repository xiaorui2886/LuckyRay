"""Offline evidence-gate and owned fixture tests. No GUI/Runner PASS is implied."""
import ast
import copy
import errno
import hashlib
import importlib.util
import io
import http.client
import json
import os
import re
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zlib
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("notes_ci", Path(__file__).with_name("linux-notes-ci.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def component_unit_payload(source, scripts):
    """Contract input only: never a rendered/native result."""
    raw = {"schemaVersion": 1, "scope": ci.media_layout.SCOPE, "status": "PASS", "source": source,
        "attempts": 1, "browserLaunches": 1, "userNamespaceExitCode": 0, "scriptSha256": scripts["layoutAudit"],
        "fixtureSha256": "a" * 64, "fixtureSourceMatches": True, "mainProductAcceptance": "NOT_RUN", "javascriptError": "NONE",
        "browser": {"version": "Chromium 156.0.8078.0", "sha256": "b" * 64, "bytes": 526511200, "elf": True},
        "sandbox": {"status": "PASS", "namespace": "Yes", "pidNamespaces": "Yes", "networkNamespaces": "Yes", "seccompBpf": "Yes",
            "adequatelySandboxed": True, "securityDisablingFlags": [], "source": "ACTUAL_CHROME_SANDBOX_PAGE"},
        "cleanup": {"processGone": True, "exitCode": 0, "signal": None}, "observations": [], "observationOverflow": False}
    for case in ci.media_layout.CASES:
        for viewport in ci.media_layout.VIEWPORTS:
            for mode in ci.media_layout.MODES:
                raw["observations"].append({"case": case, "mode": mode, "viewport": viewport,
                    "naturalWidth": 32 if case.endswith("small") else 320, "naturalHeight": 24 if case.endswith("small") else 240,
                    "displayWidth": 32 if case.endswith("small") else 320, "displayHeight": 24 if case.endswith("small") else 240,
                    "displaySizeValid": True, "hoverApplied": mode == "hover", "focusWithin": mode == "focus", "controlFocused": mode == "focus",
                    **{name: True for name in ci.media_layout.FLAGS}, "clickedOnce": True, "clickAttempts": 1})
    return {"status": "PASS", "source": source, "scripts": scripts, "attempts": 1, "childExitCode": 0,
            "fixtureSha256": "a" * 64, "observations": raw}


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.source = {"commit": "1" * 40, "tree": "2" * 40}
        self.build = {"application": {"sha256": "3" * 64}}
        self.scripts = {"smoke": "4" * 64, "webdriver": "5" * 64, "layoutAudit": "6" * 64}
        self.raw = {"schemaVersion": 1, "status": "PASS", "scope": ci.SCOPE, "commit": self.source["commit"],
            "applicationSha256": "3" * 64, "scriptSha256": "4" * 64, "helperSha256": "5" * 64,
            "flowCount": 1, "appSessions": 2, "checks": {name: "PASS" for name in ci.smoke.CHECKS},
            "drop": {"transport": "TAURI_EVENT_IPC", "nativePointerDrag": "NOT_RUN", "gestures": 1,
                "inputNotes": 2, "retainedNotes": 2, "collisionRenameObserved": True,
                "originalCaseSpellingsBothRetained": False, "destinationNames": ["Note.md", "note (1).md"]},
            "dropHit": {"insideNotes": True, "rootTarget": True},
            "dropTargets": {"upperExists": True, "lowerExists": True},
            "dropTrace": {"state": "OBSERVED", "readBytes": 1200, "truncated": False,
                "records": [{"stage": stage, "count": count, "overflow": False, "hit": True}
                    for stage, count in (("native-import-start", 2), ("native-source-active", 0), ("native-import-ok", 2), ("native-import-failed", 0))]},
            "attachmentPolicy": {"selected": "copy", "readBack": "copy", "method": "PRODUCTION_PREFERENCE_IPC"},
            "mediaOpen": {"method": "WEBDRIVER_POINTER_MOVE", "clickAttempts": 1, **{name: True for name in ci.smoke.MEDIA_OPEN_FLAGS}},
            "imageCopies": [{"session": n, "pngCount": 1, "matchingDigestCount": 1,
                "pngOverflow": False, "matchingDigestOverflow": False, "scanComplete": True, "nameMatchesPolicy": True,
                "noteLinkRewritten": True, "sourceImageUnchanged": True, "sourceNotesUnchanged": True, "productionResolved": True} for n in (1, 2)],
            "previews": [{"session": n, "naturalWidth": 32, "naturalHeight": 24, "sampled": 5, "matched": 5,
                "visible": True, "method": "WEBVIEW_SCREENSHOT_PIXELS"} for n in (1, 2)],
            "clipboard": {"source": "REAL_NOTE_CONTEXT_MENU", "systemRead": "XCLIP", "exactAbsolutePath": True},
            "handoff": {"kind": "OWNED_XDG_RECEIVER_READBACK", "exactExpectedFile": True,
                "uiRoute": "NOTE_PREVIEW_OPEN",
                "bytes": len(ci.smoke.png_bytes()), "sha256": hashlib.sha256(ci.smoke.png_bytes()).hexdigest(),
                "externalApplicationDisplay": "NOT_RUN"},
            "quitRequests": [{"ipcReplyObserved": True, "priorProcessIdentitiesGone": True, "exitStatus": "NOT_OBSERVED"}] * 2,
            **{name: "NOT_RUN" for name in ("externalApplicationDisplay", "trimmedFilenameEndToEnd", "waylandHardware", "installer")}}

    def validate(self, raw):
        ci.validate_notes(ci.bounded_report(raw), self.build, self.source, self.scripts)

    def test_complete_unit_payload_is_accepted(self):
        self.validate(self.raw)

    def test_missing_required_observation_cannot_pass(self):
        for name in ci.smoke.CHECKS:
            with self.subTest(name=name):
                raw = copy.deepcopy(self.raw)
                raw["checks"][name] = "NOT_RUN"
                with self.assertRaises(RuntimeError):
                    self.validate(raw)

    def test_false_coverage_pixels_handoff_and_stale_identity_are_rejected(self):
        changes = [lambda r: r.update(commit="6" * 40), lambda r: r.update(scope="another-flow"),
            lambda r: r.update(appSessions=3), lambda r: r["drop"].update(nativePointerDrag="PASS"),
            lambda r: r["drop"].update(retainedNotes=1), lambda r: r["drop"].update(originalCaseSpellingsBothRetained=True),
            lambda r: r["previews"][0].update(matched=0), lambda r: r["previews"].append(r["previews"][0]),
            lambda r: r["handoff"].update(kind="OPENER_RETURNED_OK"), lambda r: r["handoff"].pop("sha256"),
            lambda r: r["handoff"].update(uiRoute="INSPECTOR_OPENED_ONLY"),
            lambda r: r["quitRequests"].append(r["quitRequests"][0]), lambda r: r.update(externalApplicationDisplay="PASS"),
            lambda r: r.update(trimmedFilenameEndToEnd="PASS"), lambda r: r.update(cleanup="UNCONFIRMED")]
        changes.append(lambda r: r["dropTargets"].update(lowerExists=False))
        changes.append(lambda r: r["attachmentPolicy"].update(readBack=None))
        changes.extend([lambda r: r["mediaOpen"].update(method="JS_CLICK"), lambda r: r["mediaOpen"].update(clickAttempts=2)])
        for field in ci.smoke.MEDIA_OPEN_FLAGS:
            changes.append(lambda r, field=field: r["mediaOpen"].update({field: False}))
        changes.extend([lambda r: r.pop("imageCopies"), lambda r: r["imageCopies"].pop(),
                        lambda r: r["imageCopies"][1].update(session=1)])
        for field in ("pngCount", "matchingDigestCount", "pngOverflow", "matchingDigestOverflow", "scanComplete", "nameMatchesPolicy",
                      "noteLinkRewritten", "sourceImageUnchanged", "sourceNotesUnchanged", "productionResolved"):
            changes.append(lambda r, field=field: r["imageCopies"][0].update({field: None}))
        changes.extend([lambda r: r["dropTrace"]["records"][2].update(stage="native-import-partial"),
                        lambda r: r["dropTrace"].update(state="NOT_OBSERVED", records=[]),
                        lambda r: r["dropTrace"].update(truncated=True)])
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                raw = copy.deepcopy(self.raw)
                change(raw)
                with self.assertRaises(RuntimeError):
                    self.validate(raw)

    def test_projection_exports_no_free_text_private_canary(self):
        canary = "hunter2"
        raw = copy.deepcopy(self.raw)
        raw.update(profile=canary, environment={"secret": canary}, failure={"phase": canary, "code": canary})
        raw["clipboard"]["value"] = canary
        raw["handoff"]["path"] = canary
        raw["previews"][0]["src"] = canary
        raw["imageCopies"][0]["path"] = canary
        raw["imageCopies"][0]["name"] = canary
        raw["mediaOpen"]["path"] = canary
        raw["mediaOpen"]["rectangle"] = canary
        projected = ci.bounded_report(raw)
        self.assertNotIn(canary, json.dumps(projected))
        self.assertEqual(projected["failure"], {"phase": "unknown", "action": "unknown", "code": "unexpected-error"})
        for failure in ({"phase": [], "code": {}}, "arbitrary error"):
            raw["failure"] = failure
            self.assertNotIn(canary, json.dumps(ci.bounded_report(raw)))

    def test_finish_rejects_missing_step_nonzero_child_and_extra_artifact(self):
        for case in ("complete-unit-payload", "step-skipped", "child-failed", "extra-artifact"):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="notes-gate-offline-") as temporary:
                run = ci.Run.__new__(ci.Run)
                run.evidence = Path(temporary)
                run.source = lambda: self.source
                run.scripts = lambda: self.scripts
                for name in ci.EXPORTS[:-1]:
                    body = {"status": "PASS", "source": self.source, "scope": ci.SCOPE}
                    if name == "build.json":
                        body.update(**self.build, scripts=self.scripts)
                    if name == "notes.json":
                        body.update(attempts=1, flowCount=1, childExitCode=1 if case == "child-failed" else 0,
                                    observations=ci.bounded_report(self.raw), componentLayout=component_unit_payload(self.source, self.scripts))
                    ci.write_json(run.evidence / name, body)
                if case == "extra-artifact":
                    (run.evidence / "private.log").write_text("unit-only")
                env = {"CI_" + name: "success" for name in ci.STEPS}
                if case == "step-skipped":
                    env["CI_NOTES"] = "skipped"
                with mock.patch.dict(os.environ, env):
                    if case == "complete-unit-payload":
                        run.finish()
                    else:
                        with self.assertRaises(RuntimeError):
                            run.finish()
                result = ci.read_json(run.evidence / "result.json")
                self.assertEqual(result["status"], "PASS" if case == "complete-unit-payload" else "FAIL")
                self.assertEqual(result["excluded"]["chromiumConsent"], "NOT_RUN")

    def test_a_second_flow_attempt_is_rejected_before_any_process_launch(self):
        with tempfile.TemporaryDirectory(prefix="notes-attempt-offline-") as temporary:
            run = ci.Run.__new__(ci.Run)
            run.private = run.evidence = Path(temporary)
            run.source = lambda: self.source
            run.scripts = lambda: self.scripts
            ci.write_json(run.evidence / "notes.json", {"componentLayout": component_unit_payload(self.source, self.scripts)})
            with self.assertRaises(RuntimeError):
                run.notes()
            with mock.patch.object(ci.subprocess, "run") as process, self.assertRaises(FileExistsError):
                run.notes()
            process.assert_not_called()

    def test_drop_log_projection_is_closed_and_never_exports_free_text(self):
        with tempfile.TemporaryDirectory(prefix="notes-trace-offline-") as temporary:
            log = Path(temporary) / "owned-driver.log"
            prefix = b"hunter2 /private/not-a-trace\n"
            body = (b"[notes-drop] stage=listener-ready count=0 hit=true\n"
                    b"[notes-drop] stage=drop count=2 hit=false\n"
                    b"[notes-drop] stage=native-source-active count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-source-inactive count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-write-unsupported count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-name-conflict count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-revision-conflict count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-permissions-unsupported count=0 hit=false\n"
                    b"[notes-drop] stage=hunter2 count=2 hit=true\n"
                    b"[notes-drop] stage=drop count=999999 hit=true\n"
                    b"error hunter2 /private/personal-file\n"
                    b"[notes-drop] stage=drop count=2 hit=true")
            log.write_bytes(prefix + body)
            report = ci.smoke.read_drop_trace(log, len(prefix))
            self.assertEqual([item["stage"] for item in report["records"]],
                ["listener-ready", "drop", "native-source-active", "native-error-source-inactive", "native-error-write-unsupported",
                 "native-error-name-conflict", "native-error-revision-conflict", "native-error-permissions-unsupported"])
            self.assertNotIn("hunter2", json.dumps(report))
            self.assertNotIn("/private", json.dumps(report))
            self.assertEqual(ci.bounded_drop_trace(report), report)
            raw = copy.deepcopy(self.raw)
            raw["dropTrace"] = {**report, "path": "hunter2", "records": report["records"] + [{"stage": "hunter2", "count": 0, "hit": True}]}
            raw["dropHit"]["arbitrary"] = "hunter2"
            raw["dropTargets"]["path"] = "hunter2"
            self.assertNotIn("hunter2", json.dumps(ci.bounded_report(raw)))

    def test_drop_trace_read_and_record_counts_are_bounded(self):
        with tempfile.TemporaryDirectory(prefix="notes-trace-limit-offline-") as temporary:
            log = Path(temporary) / "owned-driver.log"
            log.write_bytes(b"[notes-drop] stage=classified count=100000 hit=true\n" * 2000)
            report = ci.smoke.read_drop_trace(log, 0)
            self.assertEqual(report["readBytes"], 65536)
            self.assertEqual(len(report["records"]), 32)
            self.assertTrue(report["truncated"])
            self.assertTrue(all(item["count"] == 2 and item["overflow"] for item in report["records"]))
            self.assertEqual(ci.smoke.read_drop_trace(log, None)["state"], "UNAVAILABLE")
            self.assertEqual(ci.smoke.read_drop_trace(log, -1)["state"], "UNAVAILABLE")

    def test_drop_target_probe_reads_only_the_two_owned_targets(self):
        with tempfile.TemporaryDirectory(prefix="notes-targets-offline-") as temporary:
            vault = Path(temporary)
            (vault / "Note.md").write_text("synthetic")
            self.assertEqual(ci.smoke.drop_targets(vault), {"upperExists": True, "lowerExists": False})
            (vault / "note (1).md").write_text("synthetic lower")
            self.assertEqual(ci.smoke.drop_targets(vault), {"upperExists": True, "lowerExists": True})

    def test_editor_actions_release_modifiers_before_text_and_emit_one_save(self):
        text, cursor, held, saves = "existing\n", 0, set(), 0
        for command in ("append", "save"):
            sequence = ci.smoke.editor_key_actions(command)["actions"]
            self.assertEqual(len(sequence), 1)
            self.assertEqual(sequence[0]["type"], "key")
            for event in sequence[0]["actions"]:
                key = event["value"]
                self.assertEqual(len(key), 1)
                self.assertNotEqual(key, "\ue000")
                if event["type"] == "keyUp":
                    self.assertIn(key, held)
                    held.remove(key)
                    continue
                self.assertEqual(event["type"], "keyDown")
                self.assertNotIn(key, held)
                held.add(key)
                if key == "\ue009":
                    continue
                if key == "\ue010":
                    self.assertIn("\ue009", held)
                    cursor = len(text)
                elif "\ue009" in held:
                    self.assertEqual(key, "s")
                    saves += 1
                else:
                    char = "\n" if key == "\ue007" else key
                    text = text[:cursor] + char + text[cursor:]
                    cursor += len(char)
            self.assertEqual(held, set())
        self.assertEqual(text, "existing\n" + ci.smoke.EDITOR_APPEND)
        self.assertEqual(saves, 1)

    def test_driver_http_classification_is_bounded_closed_and_does_not_retry_post(self):
        for body, expected in (({"value": {"error": "element click intercepted", "message": "hunter2", "stacktrace": "private/path"}}, "element click intercepted"),
                               ({"value": {"error": "invalid element state", "message": "hunter2"}}, "invalid element state"),
                               ({"value": {"error": "hunter2", "message": "private/path"}}, "unknown-standard-error"),
                               ({"value": {"error": ["hunter2"]}}, "unknown-standard-error")):
            stream = io.BytesIO(json.dumps(body).encode())
            error = urllib.error.HTTPError("http://127.0.0.1/session/owned/element/owned/click", 400, "hunter2", {}, stream)
            opener = mock.Mock()
            opener.open.side_effect = error
            request = urllib.request.Request(error.url, data=b"{}", method="POST")
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.webdriver_command(opener, request, 1)
            self.assertEqual(opener.open.call_count, 1)
            observed = raised.exception.observation
            self.assertEqual({key: value for key, value in observed.items() if key != "elapsedMs"},
                             {"kind": "HTTP_ERROR", "operation": "click", "error": expected, "httpStatus": 400,
                              "transport": "NOT_APPLICABLE", "responseState": "HTTP_ERROR_RECEIVED"})
            self.assertTrue(type(observed["elapsedMs"]) is int and 0 <= observed["elapsedMs"] <= 60000)
            self.assertNotIn("hunter2", str(raised.exception))
            raw = copy.deepcopy(self.raw)
            raw["failure"] = {"phase": "edit-save", "action": "source-toggle", "code": str(raised.exception),
                              "webdriver": {**raised.exception.observation, "message": "hunter2", "body": "private/path"}}
            projected = ci.bounded_report(raw)
            self.assertNotIn("hunter2", json.dumps(projected))
            self.assertNotIn("private/path", json.dumps(projected))
            self.assertEqual(projected["failure"]["action"], "source-toggle")
        body = io.BytesIO(b"x" * 100000)
        reads = []
        original_read = body.read
        def read(limit=-1):
            reads.append(limit)
            return original_read(limit)
        body.read = read
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError("http://127.0.0.1/session/owned/actions", 500, "hunter2", {}, body)
        with self.assertRaises(ci.smoke.DriverFailure) as raised:
            ci.smoke.webdriver_command(opener, urllib.request.Request(opener.open.side_effect.url, data=b"{}", method="POST"), 1)
        self.assertEqual(reads, [65537])
        self.assertEqual(raised.exception.observation["error"], "unknown-standard-error")
        self.assertEqual(opener.open.call_count, 1)

    def test_uncertain_driver_mutations_are_not_replayed_and_invalid_response_is_closed(self):
        for method in ("POST", "DELETE"):
            opener = mock.Mock()
            opener.open.side_effect = http.client.RemoteDisconnected("hunter2")
            request = urllib.request.Request("http://127.0.0.1/session/owned/actions", method=method)
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.webdriver_command(opener, request, 1)
            self.assertEqual(opener.open.call_count, 1)
            self.assertEqual(raised.exception.observation["kind"], "TRANSPORT_ERROR")
            self.assertNotIn("hunter2", str(raised.exception))
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(b"hunter2")
        with self.assertRaises(ci.smoke.DriverFailure) as raised:
            ci.smoke.webdriver_command(opener, urllib.request.Request("http://127.0.0.1/session/owned/execute/sync", data=b"{}", method="POST"), 1)
        self.assertEqual(raised.exception.observation["kind"], "INVALID_RESPONSE")

    def test_failure_action_and_protocol_projection_reject_arbitrary_fields(self):
        raw = copy.deepcopy(self.raw)
        raw["failure"] = {"phase": "edit-save", "action": "hunter2", "code": "webdriver-command-failed",
                          "webdriver": {"kind": "hunter2", "operation": "hunter2", "error": "hunter2", "httpStatus": "hunter2"}}
        failure = ci.bounded_report(raw)["failure"]
        self.assertNotIn("hunter2", json.dumps(failure))
        self.assertEqual(failure["action"], "unknown")
        self.assertEqual(failure["webdriver"], {"kind": "UNKNOWN", "operation": "other", "error": "unknown-standard-error", "httpStatus": None,
                                                "transport": "UNKNOWN", "responseState": "UNKNOWN", "elapsedMs": None})

    def test_image_copy_probe_distinguishes_missing_duplicate_digest_name_and_link_failures(self):
        for case in ("complete", "missing", "duplicate", "different-extra", "digest", "name", "link", "source"):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="notes-image-copy-offline-") as temporary:
                root = Path(temporary)
                vault, incoming = root / "vault", root / "incoming"
                (vault / "attachments").mkdir(parents=True)
                incoming.mkdir()
                source = incoming / ci.smoke.SOURCE_IMAGE_NAME
                source.write_bytes(ci.smoke.png_bytes())
                copied = vault / ci.smoke.COPIED_IMAGE_RELATIVE
                copied.write_bytes(ci.smoke.png_bytes())
                expected = "SYNTHETIC_UPPER_v1\n\n" + ci.smoke.COPIED_IMAGE_REFERENCE + "\n"
                actual = expected
                if case == "missing":
                    copied.unlink()
                elif case in ("duplicate", "different-extra"):
                    copied.with_name("duplicate.png").write_bytes(ci.smoke.png_bytes() if case == "duplicate" else b"other")
                elif case == "digest":
                    copied.write_bytes(b"changed")
                elif case == "name":
                    copied.rename(copied.with_name(ci.smoke.SOURCE_IMAGE_NAME))
                elif case == "link":
                    actual = expected.replace(ci.smoke.COPIED_IMAGE_REFERENCE, ci.smoke.SOURCE_IMAGE_REFERENCE)
                elif case == "source":
                    source.write_bytes(b"source changed")
                observed = ci.smoke.image_copy_probe(vault, source, actual, expected)
                observed["sourceNotesUnchanged"] = True
                self.assertEqual(ci.smoke.image_copy_retained(observed), case == "complete")
                if case == "missing":
                    self.assertEqual((observed["pngCount"], observed["matchingDigestCount"]), (0, 0))
                elif case == "duplicate":
                    self.assertEqual((observed["pngCount"], observed["matchingDigestCount"]), (2, 2))
                elif case == "different-extra":
                    self.assertEqual((observed["pngCount"], observed["matchingDigestCount"]), (2, 1))
                elif case == "digest":
                    self.assertEqual((observed["pngCount"], observed["matchingDigestCount"]), (1, 0))
                elif case == "name":
                    self.assertFalse(observed["nameMatchesPolicy"])
                elif case == "link":
                    self.assertFalse(observed["noteLinkRewritten"])
                elif case == "source":
                    self.assertFalse(observed["sourceImageUnchanged"])

    def test_owned_receiver_checks_the_exact_png_and_rejects_other_files(self):
        with tempfile.TemporaryDirectory(prefix="notes-receiver-offline-") as temporary:
            root = Path(temporary)
            vault = root / "Vault 中文 #100%"
            vault.mkdir(mode=0o700)
            image = vault / "素材 图 #100%.png"
            image.write_bytes(ci.smoke.png_bytes())
            config = root / "receiver-config.json"
            config.write_text(json.dumps({"expected": str(image)}))
            config.chmod(0o600)
            ci.smoke.receive_image(config, image)
            receipt = json.loads((root / "receiver.json").read_text())
            self.assertEqual(receipt["sha256"], hashlib.sha256(ci.smoke.png_bytes()).hexdigest())
            self.assertEqual(receipt["externalApplicationDisplay"], "NOT_RUN")
            (root / "receiver.json").unlink()
            image.write_bytes(b"wrong image")
            with self.assertRaises(ci.smoke.SmokeFailure):
                ci.smoke.receive_image(config, image)
            self.assertFalse((root / "receiver.json").exists())
            outside = root / "outside.png"
            outside.write_bytes(ci.smoke.png_bytes())
            with self.assertRaises(ci.smoke.SmokeFailure):
                ci.smoke.receive_image(config, outside)

    def test_production_media_action_geometry_and_cleanup_contract(self):
        result = subprocess.run(["node", "--experimental-strip-types", "--test", str(Path(__file__).with_name("noteMediaActions.test.mjs"))],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_setup_failure_is_reported_without_raw_text_or_starting_main(self):
        with tempfile.TemporaryDirectory(prefix="notes-setup-failure-offline-") as temporary:
            root = Path(temporary)
            fake = root / "never-executed-unit-elf"
            fake.write_bytes(b"\x7fELF")
            output = root / "output"
            arguments = [ci.smoke.__file__, "--application", str(fake), "--driver", str(fake), "--output", str(output)]
            previous_mask = os.umask(0o077)
            try:
                with mock.patch.object(sys, "argv", arguments), mock.patch.object(ci.smoke.subprocess, "run", side_effect=OSError("hunter2")), mock.patch.object(ci.smoke.subprocess, "Popen") as launcher:
                    with self.assertRaises(OSError):
                        ci.smoke.main()
                launcher.assert_not_called()
            finally:
                os.umask(previous_mask)
            raw = json.loads((output / "report.json").read_text())
            self.assertEqual(raw["failure"], {"phase": "desktop-association", "action": "setup", "code": "unexpected-error"})
            self.assertNotIn("hunter2", json.dumps(raw))
            self.assertEqual(raw["status"], "FAIL")

    def test_png_fixture_and_embedded_webdriver_javascript_are_valid_offline(self):
        image = ci.smoke.png_bytes()
        self.assertEqual(struct.unpack(">II", image[16:24]), (32, 24))
        offset, blocks = 8, {}
        while offset < len(image):
            count = struct.unpack(">I", image[offset:offset + 4])[0]
            kind, body = image[offset + 4:offset + 8], image[offset + 8:offset + 8 + count]
            self.assertEqual(struct.unpack(">I", image[offset + 8 + count:offset + 12 + count])[0], zlib.crc32(kind + body))
            blocks[kind] = body
            offset += 12 + count
        self.assertEqual(zlib.decompress(blocks[b"IDAT"]), (b"\0" + bytes(ci.smoke.COLOR) * 32) * 24)
        source = Path(ci.smoke.__file__).read_text()
        scripts = [node.args[0].value for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
                   and isinstance(node.func, ast.Name) and node.func.id in ("execute", "until") and node.args
                   and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)]
        self.assertGreater(len(scripts), 10)
        scripts.append(ci.smoke.MEDIA_OPEN_PROBE)
        result = subprocess.run(["node", "-e", "for(const s of JSON.parse(require('fs').readFileSync(0,'utf8')))new Function(s)"],
                                input=json.dumps(scripts), text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_existing_workflow_selects_only_this_flow_and_exact_json_files(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/linux-desktop-preflight.yml"
        text = workflow.read_text()
        jobs = re.findall(r"^  ([a-z0-9-]+):$", text.split("jobs:\n", 1)[1], re.M)
        self.assertEqual(jobs, ["linux-notes-attachments-validation"])
        self.assertNotIn("linux-browser-ci.py", text)
        self.assertNotIn("--bin luckyray-native-host", text)
        self.assertNotIn("--no-sandbox", text)
        self.assertEqual(re.findall(r"/evidence/([a-z.]+)", text), list(ci.EXPORTS))
        for stage in ("init", "layout", "binaries", "resources", "notes", "finish"):
            self.assertIn("linux-notes-ci.py " + stage, text)
        self.assertLess(text.index("        id: frontend"), text.index("        id: layout"))
        self.assertLess(text.index("        id: layout"), text.index("        id: dependencies"))
        self.assertLess(text.index("        id: layout"), text.index("        id: build"))
        self.assertIn("CI_LAYOUT: ${{ steps.layout.outcome }}", text)
        self.assertEqual(text.count("if: ${{ success() && steps.layout.outcome == 'success' }}"), 2)


class TransportEvidenceTests(unittest.TestCase):
    def test_typed_transport_categories_never_read_private_reason_text(self):
        cases = [(TimeoutError("hunter2"), "TIMEOUT"), (http.client.RemoteDisconnected("hunter2"), "REMOTE_DISCONNECT"),
            (ConnectionResetError("hunter2"), "CONNECTION_RESET"), (ConnectionRefusedError("hunter2"), "CONNECTION_REFUSED"),
            (ConnectionAbortedError("hunter2"), "CONNECTION_ABORTED"), (BrokenPipeError("hunter2"), "BROKEN_PIPE"),
            (http.client.IncompleteRead(b"hunter2"), "INCOMPLETE_RESPONSE"), (http.client.BadStatusLine("hunter2"), "HTTP_PROTOCOL_ERROR"),
            (OSError(errno.ENETUNREACH, "hunter2"), "NETWORK_UNREACHABLE"),
            (urllib.error.URLError("hunter2"), "UNKNOWN"), (OSError("hunter2"), "IO_ERROR")]
        for error, expected in cases:
            for wrapped in (error, urllib.error.URLError(error)):
                with self.subTest(category=expected):
                    opener = mock.Mock()
                    opener.open.side_effect = wrapped
                    request = urllib.request.Request("http://127.0.0.1/session/owned/element/owned/click", method="POST", data=b"{}")
                    with self.assertRaises(ci.smoke.DriverFailure) as raised:
                        ci.smoke.webdriver_command(opener, request, 1)
                    self.assertEqual(opener.open.call_count, 1)
                    self.assertEqual(raised.exception.observation["transport"], expected)
                    self.assertEqual(raised.exception.observation["responseState"], "UNCONFIRMED")
                    self.assertEqual(ci.bounded_driver(raised.exception.observation), raised.exception.observation)
                    self.assertNotIn("hunter2", json.dumps(raised.exception.observation))

    def test_real_loopback_post_disconnect_reset_and_timeout_are_not_replayed(self):
        for mode, expected in (("close", "REMOTE_DISCONNECT"), ("reset", "CONNECTION_RESET"), ("delay", "TIMEOUT")):
            requests = []
            class Handler(BaseHTTPRequestHandler):
                def do_POST(self):
                    requests.append(self.command)
                    if mode == "delay":
                        threading.Event().wait(.2)
                    elif mode == "reset":
                        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    self.close_connection = True
                    self.connection.close()
                def log_message(self, *args):
                    pass
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
            worker.start()
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/session/owned/element/owned/click", method="POST", data=b"{}")
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with self.assertRaises(ci.smoke.DriverFailure) as raised:
                    ci.smoke.webdriver_command(opener, request, .05)
                self.assertEqual(raised.exception.observation["transport"], expected)
                self.assertEqual(raised.exception.observation["responseState"], "UNCONFIRMED")
                self.assertEqual(requests, ["POST"])
            finally:
                server.shutdown(); server.server_close(); worker.join(timeout=1)

    def test_single_read_clipboard_probe_is_bounded_readonly_and_never_returns_contents(self):
        expected = "/owned/SyntheticNote.md"
        real_popen = subprocess.Popen
        for mode in ("match", "different", "oversize", "timeout", "missing"):
            with self.subTest(mode=mode):
                def launch(command, **kwargs):
                    self.assertEqual(command, ["xclip", "-selection", "clipboard", "-o"])
                    if mode == "missing":
                        raise FileNotFoundError("hunter2")
                    program = {"match": "import sys;sys.stdout.buffer.write(" + repr(expected.encode()) + ")",
                        "different": "import sys;sys.stdout.buffer.write(b'hunter2')",
                        "oversize": "import sys;sys.stdout.buffer.write(b'x'*9000)",
                        "timeout": "import time;time.sleep(1)"}[mode]
                    return real_popen([sys.executable, "-c", program], **kwargs)
                with mock.patch.object(ci.smoke.subprocess, "Popen", side_effect=launch) as process:
                    value = ci.smoke.clipboard_read_once({}, expected, timeout=.1)
                self.assertEqual(process.call_count, 1)
                self.assertEqual(value["attempts"], 1)
                self.assertEqual(value["state"], {"match": "READ", "different": "READ", "oversize": "SIZE_LIMIT", "timeout": "TIMEOUT", "missing": "IO_ERROR"}[mode])
                self.assertEqual(value["exactAbsolutePath"], True if mode == "match" else False if mode == "different" else None)
                self.assertLessEqual(value["readBytes"], 8193)
                self.assertEqual(value, ci.bounded_clipboard_probe(value))
                self.assertNotIn("hunter2", json.dumps(value))
                self.assertNotIn(expected, json.dumps(value))

    def test_uncertain_copy_effect_match_does_not_confirm_response_or_pass_the_flow(self):
        fixture = EvidenceTests(methodName="runTest")
        fixture.setUp()
        anchors = {"driver": None, "app": {}, "nativeDriver": {}}
        report = copy.deepcopy(fixture.raw)
        failure = ci.smoke.DriverFailure("TRANSPORT_ERROR", "click", transport="REMOTE_DISCONNECT", elapsed=1)
        wd = mock.Mock(side_effect=failure)
        probe = {"attempts": 1, "method": "XCLIP_READONLY_ONCE", "state": "READ", "exactAbsolutePath": True, "readBytes": 23,
                 "overflow": False, "exit": {"state": "EXITED", "exitCode": 0, "signal": None}}
        with mock.patch.object(ci.smoke, "clipboard_read_once", return_value=probe) as reader:
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.copy_click_once(wd, "/session/owned/element/owned/click", {}, Path("/owned/SyntheticNote.md"), None, anchors, report)
        self.assertIs(raised.exception, failure)
        wd.assert_called_once_with("POST", "/session/owned/element/owned/click", {})
        reader.assert_called_once()
        self.assertEqual(report["unconfirmedCopy"]["responseState"], "UNCONFIRMED")
        self.assertTrue(report["unconfirmedCopy"]["clipboard"]["exactAbsolutePath"])
        self.assertEqual(report["unconfirmedCopy"], ci.bounded_unconfirmed_copy(report["unconfirmedCopy"]))
        # Even spoofing all success checks cannot turn an unconfirmed response green.
        with self.assertRaisesRegex(RuntimeError, "copy-response-not-confirmed"):
            ci.validate_notes(ci.bounded_report(report), fixture.build, fixture.source, fixture.scripts)
        for kind in ("HTTP_ERROR", "INVALID_RESPONSE"):
            wd = mock.Mock(side_effect=ci.smoke.DriverFailure(kind, "click"))
            report = {}
            with mock.patch.object(ci.smoke, "clipboard_read_once", return_value=probe) as reader:
                with self.assertRaises(ci.smoke.DriverFailure):
                    ci.smoke.copy_click_once(wd, "/session/owned/element/owned/click", {}, Path("/owned/SyntheticNote.md"), None, anchors, report)
            self.assertEqual(reader.call_count, 0 if kind == "HTTP_ERROR" else 1)
            self.assertEqual(wd.call_count, 1)

    def test_diagnostic_failure_never_masks_original_uncertain_command(self):
        wd = mock.Mock(side_effect=ci.smoke.DriverFailure("TRANSPORT_ERROR", "click", transport="TIMEOUT"))
        report = {}
        with mock.patch.object(ci.smoke, "clipboard_read_once", side_effect=RuntimeError("hunter2")):
            with self.assertRaises(ci.smoke.DriverFailure):
                ci.smoke.copy_click_once(wd, "/session/owned/element/owned/click", {}, Path("/owned/SyntheticNote.md"), None,
                                        {"driver": None, "app": {}, "nativeDriver": {}}, report)
        self.assertEqual(report["unconfirmedCopy"]["state"], "UNAVAILABLE")
        self.assertEqual(wd.call_count, 1)
        self.assertNotIn("hunter2", json.dumps(ci.bounded_unconfirmed_copy(report["unconfirmedCopy"])))

    def test_uncertain_quit_is_marked_before_dispatch_and_cannot_be_replayed(self):
        for effect in (ci.smoke.DriverFailure("TRANSPORT_ERROR", "execute", transport="CONNECTION_RESET"), None):
            state = {"attempted": False, "ipcReplyObserved": False}
            close = mock.Mock(side_effect=effect)
            if effect is not None:
                with self.assertRaises(ci.smoke.DriverFailure):
                    ci.smoke.quit_once(state, close)
            else:
                ci.smoke.quit_once(state, close)
            with self.assertRaisesRegex(ci.smoke.SmokeFailure, "quit-already-attempted"):
                ci.smoke.quit_once(state, close)
            self.assertEqual(close.call_count, 1)
            self.assertEqual(state, {"attempted": True, "ipcReplyObserved": effect is None})

    def test_owned_process_snapshot_distinguishes_cleanup_signal_without_exporting_ids(self):
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(10)"], start_new_session=True)
        try:
            identity = ci.smoke.helpers.live_identity(child.pid)
            self.assertIsNotNone(identity)
            anchors = {"driver": identity, "app": {str(child.pid): identity}, "nativeDriver": {}}
            before = ci.smoke.observe_processes(child, anchors)
            self.assertEqual(before["driver"]["state"], "RUNNING")
            self.assertEqual(before["app"]["running"], 1)
            stopped = ci.smoke.terminate_driver(child)
            after = ci.smoke.observe_processes(child, anchors)
            self.assertTrue(stopped["termRequested"])
            self.assertFalse(stopped["killRequested"])
            self.assertEqual(stopped["exit"], {"state": "SIGNALED", "exitCode": None, "signal": signal.SIGTERM})
            self.assertEqual(after["app"]["gone"], 1)
            self.assertEqual(after["app"]["exitStatus"], "NOT_OBSERVED")
            self.assertEqual(after, ci.bounded_processes(after))
            self.assertNotIn(str(child.pid), json.dumps(after))
            fake = mock.Mock(pid=child.pid)
            fake.poll.return_value = None
            with mock.patch.object(ci.smoke.helpers, "live_identity", return_value="new-private-identity"):
                changed = ci.smoke.observe_processes(fake, anchors)
            self.assertEqual(changed["driver"]["state"], "IDENTITY_CHANGED")
            self.assertEqual(changed["app"]["identityChanged"], 1)
            self.assertNotIn("new-private-identity", json.dumps(changed))
        finally:
            if child.poll() is None:
                child.kill(); child.wait(timeout=2)

    def test_backend_exit_during_capture_does_not_discard_independent_app_identity(self):
        driver = mock.Mock(pid=123)
        with mock.patch.object(ci.smoke.helpers, "live_identity", return_value="owned-driver"), \
             mock.patch.object(ci.smoke.helpers, "app_pids", side_effect=[{"456": "owned-backend"}, {"789": "owned-app"}]), \
             mock.patch.object(ci.smoke.os, "getpgid", side_effect=ProcessLookupError):
            anchors = ci.smoke.capture_processes(driver, Path("/owned/Main"))
        self.assertEqual(anchors, {"driver": "owned-driver", "nativeDriver": {}, "app": {"789": "owned-app"}})

    def test_all_new_transport_process_clipboard_and_cleanup_projections_are_closed(self):
        value = {"kind": "TRANSPORT_ERROR", "transport": "hunter2", "responseState": "hunter2", "elapsedMs": True,
                 "pid": "hunter2", "path": "hunter2", "stdout": "hunter2", "reason": "hunter2"}
        for project in (ci.bounded_driver, ci.bounded_exit, ci.bounded_processes, ci.bounded_clipboard_probe, ci.bounded_unconfirmed_copy, ci.bounded_cleanup):
            self.assertNotIn("hunter2", json.dumps(project(value)))
            self.assertNotIn("hunter2", json.dumps(project(["hunter2"])))
        fixture = EvidenceTests(methodName="runTest"); fixture.setUp()
        fixture.raw.update(unconfirmedCopy={"action": "context-copy", "clipboard": {**value, "exactAbsolutePath": True},
            "atUnconfirmedResponse": {"driver": value, "app": value}, "afterClipboardRead": {"nativeDriver": value}},
            cleanupEvidence={"quitFailure": value, "driverTermination": {**value, "exit": value}, "beforeDriverTermination": {"app": value}})
        self.assertNotIn("hunter2", json.dumps(ci.bounded_report(fixture.raw)))


class ComponentLayoutGateTests(unittest.TestCase):
    def setUp(self):
        self.source = {"commit": "1" * 40, "tree": "2" * 40}
        self.scripts = {"layoutAudit": "3" * 64}
        self.wrapper = component_unit_payload(self.source, self.scripts)

    def test_complete_component_unit_payload_is_canonical(self):
        self.assertEqual(self.wrapper["observations"], ci.media_layout.bounded(self.wrapper["observations"]))
        ci.media_layout.validate(self.wrapper, self.source, self.scripts)

    def test_actual_display_dimensions_are_finite_bounded_numbers_only(self):
        for value in ("hunter2", True, {}, -1, 4097, 10**1000, float("inf"), float("nan")):
            with self.subTest(value=repr(value)):
                raw = copy.deepcopy(self.wrapper["observations"])
                raw["observations"][4].update(displayWidth=value, displayHeight=value)
                exported = ci.media_layout.bounded(raw)
                self.assertIsNone(exported["observations"][4]["displayWidth"])
                self.assertIsNone(exported["observations"][4]["displayHeight"])
                self.assertNotIn("hunter2", json.dumps(exported))
        raw = copy.deepcopy(self.wrapper["observations"])
        raw["observations"][4].update(displayWidth=20, displayHeight=15)
        self.assertEqual(ci.media_layout.bounded(raw)["observations"][4]["displayWidth"], 20)
        raw["observations"][4].update(displayWidth=31.984375, displayHeight=23.984375)
        self.assertEqual(ci.media_layout.bounded(raw)["observations"][4]["displayHeight"], 23.984375)

    def test_reported_success_cannot_hide_small_image_resizing_or_aspect_distortion(self):
        for width, height in ((20, 15), (32, 15), (180, 135), (0, 0)):
            with self.subTest(width=width, height=height):
                value = copy.deepcopy(self.wrapper)
                small = next(row for row in value["observations"]["observations"] if row["case"] == "live-small")
                small.update(displayWidth=width, displayHeight=height)
                self.assertTrue(small["displaySizeValid"])
                with self.assertRaises(RuntimeError):
                    ci.media_layout.validate(value, self.source, self.scripts)
        value = copy.deepcopy(self.wrapper)
        # Ordinary images may fit a narrower pane without changing aspect.
        regular = next(row for row in value["observations"]["observations"] if row["case"] == "live-regular")
        regular.update(displayWidth=160, displayHeight=120)
        ci.media_layout.validate(value, self.source, self.scripts)
        regular.update(displayHeight=80)
        with self.assertRaises(RuntimeError):
            ci.media_layout.validate(value, self.source, self.scripts)

    def test_native_audit_helpers_validate_geometry_short_socket_and_released_keys_without_launch(self):
        audit = Path(ci.__file__).with_name("linux-media-layout-audit.mjs").as_uri()
        program = """
          import assert from 'node:assert/strict';
          const {displaySizeValid,socketPathBytes,nativeBackTab} = await import(process.argv[1]);
          assert(displaySizeValid({naturalWidth:32,naturalHeight:24,width:32,height:24},true));
          assert(!displaySizeValid({naturalWidth:32,naturalHeight:24,width:180,height:135},true));
          assert(displaySizeValid({naturalWidth:320,naturalHeight:240,width:160,height:120},false));
          assert(!displaySizeValid({naturalWidth:320,naturalHeight:240,width:160,height:80},false));
          assert(socketPathBytes('/tmp/lrl-AbC123/tmp')<108);
          assert.throws(()=>socketPathBytes('/tmp/'+ 'x'.repeat(108)));
          const sent=[]; await nativeBackTab(async (method,event)=>sent.push({method,...event}));
          assert.deepEqual(sent.map(e=>e.method),Array(4).fill('Input.dispatchKeyEvent'));
          assert.deepEqual(sent.map(e=>[e.type,e.key,e.modifiers]),[
            ['keyDown','Shift',8],['keyDown','Tab',8],['keyUp','Tab',8],['keyUp','Shift',0]]);
        """
        result = subprocess.run(["node", "--input-type=module", "-e", program, audit], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_incomplete_dimensions_native_input_hit_identity_or_cleanup_cannot_pass(self):
        changes = [lambda w: w.update(childExitCode=1), lambda w: w.update(attempts=2), lambda w: w.update(attempts=True),
            lambda w: w.update(source={}), lambda w: w.update(scripts={}), lambda w: w.update(fixtureSha256="9" * 64),
            lambda w: w["observations"].update(source={}), lambda w: w["observations"].update(scriptSha256="9" * 64),
            lambda w: w["observations"].update(fixtureSourceMatches=False), lambda w: w["observations"].update(browserLaunches=2),
            lambda w: w["observations"].update(userNamespaceExitCode=1), lambda w: w["observations"].update(javascriptError="TypeError"),
            lambda w: w["observations"].update(mainProductAcceptance="PASS"), lambda w: w["observations"]["browser"].update(elf=False),
            lambda w: w["observations"]["sandbox"].update(seccompBpf=None), lambda w: w["observations"]["sandbox"].update(securityDisablingFlags=["INVALID"]),
            lambda w: w["observations"]["cleanup"].update(processGone=False), lambda w: w["observations"]["cleanup"].update(signal="SIGTERM"),
            lambda w: w["observations"]["observations"].pop(),
            lambda w: w["observations"]["observations"].append(copy.deepcopy(w["observations"]["observations"][0])),
            lambda w: w["observations"]["observations"][1].update(mode="hover"),
            lambda w: w["observations"]["observations"][0].update(viewport=560),
            lambda w: w["observations"]["observations"][0].update(naturalWidth=320),
            lambda w: w["observations"]["observations"][0].update(clickAttempts=2)]
        for key in ("displaySizeValid", "hoverApplied", "clickedOnce", *ci.media_layout.FLAGS):
            changes.append(lambda w, key=key: w["observations"]["observations"][0].update({key: False}))
        for key in ("focusWithin", "controlFocused"):
            changes.append(lambda w, key=key: w["observations"]["observations"][1].update({key: False}))
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                value = copy.deepcopy(self.wrapper)
                change(value)
                with self.assertRaises(RuntimeError):
                    ci.media_layout.validate(value, self.source, self.scripts)

    def test_closed_layout_projection_drops_paths_logs_and_unlabelled_secrets(self):
        value = copy.deepcopy(self.wrapper["observations"])
        value.update(error="hunter2", path="/private/hunter2", fixture="hunter2", environment={"x": "hunter2"})
        value["browser"].update(version="hunter2", path="hunter2")
        value["cleanup"].update(signal="hunter2", stderr="hunter2")
        value["observations"][0].update(case="hunter2", rectangle="hunter2", button="hunter2")
        value["sandbox"].update(evaluation="hunter2", securityDisablingFlags=["hunter2"])
        value["failure"] = {"phase": "hunter2", "code": "hunter2", "reason": "Failed hunter2"}
        exported = ci.media_layout.bounded(value)
        self.assertNotIn("hunter2", json.dumps(exported))
        self.assertEqual(exported["failure"], {"phase": "unknown", "code": "unknown"})
        for key in ("browser", "sandbox", "cleanup", "failure"):
            value[key] = ["hunter2"]
        self.assertNotIn("hunter2", json.dumps(ci.media_layout.bounded(value)))

    def test_failed_or_missing_layout_stops_main_before_attempt_or_process_launch(self):
        for wrapper in (None, {"status": "FAIL"}, self.wrapper):
            with self.subTest(wrapper=wrapper is None), tempfile.TemporaryDirectory(prefix="layout-block-unit-") as temporary:
                run = ci.Run.__new__(ci.Run)
                run.private = run.evidence = Path(temporary)
                run.source = lambda: self.source
                run.scripts = lambda: self.scripts
                value = copy.deepcopy(wrapper)
                if value and value.get("status") == "PASS":
                    value["observations"]["observations"][1]["allButtonCentersHit"] = False
                ci.write_json(run.evidence / "notes.json", {"componentLayout": value})
                with mock.patch.object(ci.subprocess, "run") as launcher, self.assertRaises(RuntimeError):
                    run.notes()
                launcher.assert_not_called()
                self.assertFalse((run.private / "notes.attempt").exists())

    def test_failed_fixture_is_closed_and_never_launches_the_browser_child(self):
        with tempfile.TemporaryDirectory(prefix="layout-setup-unit-") as temporary:
            run = ci.Run.__new__(ci.Run)
            run.private = Path(temporary) / "private"
            run.evidence = Path(temporary) / "evidence"
            run.private.mkdir(); run.evidence.mkdir()
            run.app = Path(ci.__file__).resolve().parents[1]
            run.args = type("Args", (), {"node": "node"})()
            run.source = lambda: self.source
            run.scripts = lambda: self.scripts
            run.env = lambda: {}
            with mock.patch.object(ci.subprocess, "run", side_effect=OSError("hunter2")), mock.patch.object(ci.subprocess, "Popen") as launcher:
                with self.assertRaisesRegex(RuntimeError, "^component-layout-precondition-failed$"):
                    run.layout()
            launcher.assert_not_called()
            report = ci.read_json(run.evidence / "notes.json")
            self.assertNotIn("hunter2", json.dumps(report))
            self.assertEqual((report["status"], report["flowCount"], report["attempts"]), ("NOT_RUN", 0, 0))
            self.assertEqual(report["componentLayout"]["failure"], "fixture-build-failed")

    def test_layout_block_exports_same_five_json_with_native_reports_not_run(self):
        with tempfile.TemporaryDirectory(prefix="layout-finish-unit-") as temporary:
            run = ci.Run.__new__(ci.Run)
            run.evidence = Path(temporary)
            run.source = lambda: self.source
            run.scripts = lambda: self.scripts
            ci.write_json(run.evidence / "source.json", {"status": "PASS", "scope": ci.SCOPE, "source": self.source})
            ci.write_json(run.evidence / "notes.json", {"status": "NOT_RUN", "scope": ci.SCOPE, "source": self.source,
                "attempts": 0, "flowCount": 0, "componentLayout": {"status": "FAIL", "failure": "layout-child-failed"}})
            outcomes = {"CI_" + key: "success" if key in ("CHECKOUT", "INIT", "NODE", "OFFLINE", "FRONTEND") else "skipped" for key in ci.STEPS}
            outcomes["CI_LAYOUT"] = "failure"
            with mock.patch.dict(os.environ, outcomes), self.assertRaises(RuntimeError):
                run.finish()
            result = ci.read_json(run.evidence / "result.json")
            self.assertEqual(set(path.name for path in run.evidence.iterdir()), set(ci.EXPORTS))
            self.assertEqual(result["reports"], {"source.json": "PASS", "build.json": "NOT_RUN", "resources.json": "NOT_RUN", "notes.json": "NOT_RUN"})
            self.assertEqual(result["included"], {"notesPngFlows": 0, "componentLayout": "FAIL"})
            self.assertEqual((result["status"], result["exportPolicy"], result["productAcceptance"]), ("FAIL", "PASS", "NOT_RUN"))

    def test_unavailable_sandbox_browser_or_clipped_controls_stay_closed_and_block_main(self):
        for phase in ("user-namespace", "browser-identity", "native-focus"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix="layout-child-unit-") as temporary:
                run = ci.Run.__new__(ci.Run)
                run.private, run.evidence = Path(temporary) / "private", Path(temporary) / "evidence"
                run.private.mkdir(); run.evidence.mkdir()
                run.app = Path(ci.__file__).resolve().parents[1]
                run.args = type("Args", (), {"node": "node"})()
                run.source, run.scripts, run.env = lambda: self.source, lambda: self.scripts, lambda: {}
                def build_fixture(*args, **kwargs):
                    (run.private / "component-layout/fixture/index.html").write_text("owned-unit-not-rendered")
                    return type("Result", (), {"returncode": 0})()
                def finish_child(*args, **kwargs):
                    value = copy.deepcopy(self.wrapper["observations"])
                    value.update(status="FAIL", failure={"phase": phase, "code": phase + "-failed", "reason": "hunter2"}, log="hunter2")
                    ci.write_json(run.private / "component-layout/report.json", value)
                    return 1
                child = mock.Mock()
                child.wait.side_effect = finish_child
                with mock.patch.object(ci.subprocess, "run", side_effect=build_fixture), mock.patch.object(ci.subprocess, "Popen", return_value=child) as process:
                    with self.assertRaisesRegex(RuntimeError, "^component-layout-precondition-failed$"):
                        run.layout()
                self.assertEqual(process.call_count, 1)
                self.assertTrue(process.call_args.kwargs["start_new_session"])
                saved = ci.read_json(run.evidence / "notes.json")
                self.assertEqual(saved["componentLayout"]["observations"]["failure"], {"phase": phase, "code": phase + "-failed"})
                self.assertEqual(saved["componentLayout"]["childExitCode"], 1)
                self.assertEqual((saved["status"], saved["flowCount"]), ("NOT_RUN", 0))
                self.assertNotIn("hunter2", json.dumps(saved))
                with mock.patch.object(ci.subprocess, "run") as launcher, self.assertRaises(RuntimeError):
                    run.notes()
                launcher.assert_not_called()
                self.assertFalse((run.private / "notes.attempt").exists())


if __name__ == "__main__":
    unittest.main()
