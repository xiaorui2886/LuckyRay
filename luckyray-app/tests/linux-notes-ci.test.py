"""Offline evidence-gate and owned fixture tests. No GUI/Runner PASS is implied."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("notes_ci", Path(__file__).with_name("linux-notes-ci.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.source = {"commit": "1" * 40, "tree": "2" * 40}
        self.build = {"application": {"sha256": "3" * 64}}
        self.scripts = {"smoke": "4" * 64, "webdriver": "5" * 64}
        self.raw = {"schemaVersion": 1, "status": "PASS", "scope": ci.SCOPE, "commit": self.source["commit"],
            "applicationSha256": "3" * 64, "scriptSha256": "4" * 64, "helperSha256": "5" * 64,
            "flowCount": 1, "appSessions": 2, "checks": {name: "PASS" for name in ci.smoke.CHECKS},
            "drop": {"transport": "TAURI_EVENT_IPC", "nativePointerDrag": "NOT_RUN", "gestures": 1,
                "inputNotes": 2, "retainedNotes": 2, "collisionRenameObserved": True,
                "originalCaseSpellingsBothRetained": False, "destinationNames": ["Note.md", "note (1).md"]},
            "dropHit": {"insideNotes": True, "rootTarget": True},
            "dropTargets": {"upperExists": True, "lowerExists": True},
            "dropTrace": {"state": "NOT_OBSERVED", "readBytes": 0, "truncated": False, "records": []},
            "previews": [{"session": n, "naturalWidth": 32, "naturalHeight": 24, "sampled": 5, "matched": 5,
                "visible": True, "method": "WEBVIEW_SCREENSHOT_PIXELS"} for n in (1, 2)],
            "clipboard": {"source": "REAL_NOTE_CONTEXT_MENU", "systemRead": "XCLIP", "exactAbsolutePath": True},
            "handoff": {"kind": "OWNED_XDG_RECEIVER_READBACK", "exactExpectedFile": True,
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
            lambda r: r["quitRequests"].append(r["quitRequests"][0]), lambda r: r.update(externalApplicationDisplay="PASS"),
            lambda r: r.update(trimmedFilenameEndToEnd="PASS"), lambda r: r.update(cleanup="UNCONFIRMED")]
        changes.append(lambda r: r["dropTargets"].update(lowerExists=False))
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
        projected = ci.bounded_report(raw)
        self.assertNotIn(canary, json.dumps(projected))
        self.assertEqual(projected["failure"], {"phase": "unknown", "code": "unexpected-error"})
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
                                    observations=ci.bounded_report(self.raw))
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
                    b"[notes-drop] stage=hunter2 count=2 hit=true\n"
                    b"[notes-drop] stage=drop count=999999 hit=true\n"
                    b"error hunter2 /private/personal-file\n"
                    b"[notes-drop] stage=drop count=2 hit=true")
            log.write_bytes(prefix + body)
            report = ci.smoke.read_drop_trace(log, len(prefix))
            self.assertEqual([item["stage"] for item in report["records"]],
                ["listener-ready", "drop", "native-source-active", "native-error-source-inactive"])
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
            self.assertEqual(raw["failure"], {"phase": "desktop-association", "code": "unexpected-error"})
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
        for stage in ("init", "binaries", "resources", "notes", "finish"):
            self.assertIn("linux-notes-ci.py " + stage, text)


if __name__ == "__main__":
    unittest.main()
