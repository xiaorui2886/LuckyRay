"""Reject false CI passes and keep private synthetic state out of the export set."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("runtime_ci", Path(__file__).with_name("linux-runtime-ci.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def autostart_report(source, application_sha, script_sha):
    return {"applicationSha256": application_sha, "smokeScriptSha256": script_sha,
            "commit": source["commit"], "nativeStartup": "PASS",
            "quitRequestProcessDisappearance": "PASS",
            "autostartEnableDisableReenablePersistence": "PASS", "independentBackupAndOldInode": "PASS",
            "lshAi": "NOT_RUN", "noteFlows": "NOT_RUN", "materialImportCatalogRead": "NOT_RUN",
            "quitRequests": [{"priorProcessIdentitiesGone": True}] * 2,
            "autostartReads": [{"stage": stage, "value": value, "status": "PASS", "attempts": 1,
                               "ipcReply": "OBSERVED", "adapter": "execute-sync-returned-promise"}
                              for stage, value in [("initial", False), ("enabled", True), ("disabled", False),
                                                   ("reenabled", True), ("reopened", False)]]}


class EvidenceBoundaryTests(unittest.TestCase):
    def test_cargo_test_harness_or_foreign_artifact_cannot_replace_production_elf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "main.rs"
            target = root / "target"
            record = {"reason": "compiler-artifact", "target": {"src_path": str(source)},
                      "profile": {"test": True}, "executable": str(target / "debug/program")}
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                ci.select_artifact(json.dumps(record), source, False, target)
            record["profile"]["test"] = False
            self.assertEqual(ci.select_artifact(json.dumps(record), source, False, target),
                             target / "debug/program")
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                ci.select_artifact("\n".join([json.dumps(record)] * 2), source, False, target)
            record["executable"] = str(root / "foreign")
            with self.assertRaisesRegex(RuntimeError, "outside"):
                ci.select_artifact(json.dumps(record), source, False, target)

    def test_partial_or_wrong_identity_smoke_is_never_a_pass(self):
        source = {"commit": "a" * 40}
        build = {"application": {"sha256": "b" * 64}}
        good = autostart_report(source, "b" * 64, "c" * 64)
        ci.validate_autostart(good, build, source, "c" * 64)
        for key, value in (("failure", "connection reset"), ("commit", "d" * 40),
                           ("applicationSha256", "e" * 64),
                           ("autostartEnableDisableReenablePersistence", "NOT_RUN"),
                           ("autostartReads", []), ("autostartReads", [None] * 5),
                           ("lshAi", "PASS")):
            bad = {**good, key: value}
            with self.subTest(field=key), self.assertRaises(RuntimeError):
                ci.validate_autostart(bad, build, source, "c" * 64)
        bad = json.loads(json.dumps(good))
        bad["autostartReads"][0]["value"] = None
        with self.assertRaises(RuntimeError):
            ci.validate_autostart(bad, build, source, "c" * 64)
        bad["autostartReads"][0].update(value=False, attempts=2)
        with self.assertRaises(RuntimeError):
            ci.validate_autostart(bad, build, source, "c" * 64)

    def run_finish(self, bad_step=None, missing=None, extra=False, wrong_source=False, wrong_scope=False, wrong_script=False):
        with tempfile.TemporaryDirectory() as directory:
            run = ci.Run(SimpleNamespace(work=Path(directory), node="node"))
            run.private.mkdir()
            run.evidence.mkdir()
            source = {"commit": "a" * 40, "tree": "b" * 40}
            run.source = lambda: source
            scripts = run.scripts()
            payloads = {
                "source.json": {"scripts": scripts},
                "build.json": {"scripts": scripts, "application": {"sha256": "c" * 64}},
                "resources.json": {},
                "http.json": {"scriptSha256": scripts["http"], "passed": 6, "failed": 0, "skipped": 0, "attempts": 1},
                "autostart.json": {"flowCount": 1, "rawReport": autostart_report(source, "c" * 64, scripts["smoke"])},
            }
            for name, payload in payloads.items():
                if name != missing:
                    ci.write_json(run.evidence / name, {"status": "PASS", "scope": ci.SCOPE,
                                                       "source": source, **payload})
            if wrong_source:
                path = run.evidence / "resources.json"
                path.write_text(json.dumps({"status": "PASS", "scope": ci.SCOPE, "source": {"commit": "foreign"}}))
            if wrong_scope:
                path = run.evidence / "resources.json"
                path.write_text(json.dumps({"status": "PASS", "scope": "full-runtime", "source": source}))
            if wrong_script:
                path = run.evidence / "http.json"
                value = json.loads(path.read_text())
                value["scriptSha256"] = "foreign"
                path.write_text(json.dumps(value))
            (run.private / "synthetic-credential.json").write_text("synthetic non-exported marker")
            if extra:
                (run.evidence / "lsh.json").write_text('{"status":"PASS"}')
            environment = {"CI_" + name: "success" for name in ci.STEPS}
            if bad_step:
                environment["CI_" + bad_step] = "failure"
            with patch.dict(os.environ, environment, clear=True):
                if bad_step or missing or extra or wrong_source or wrong_scope or wrong_script:
                    with self.assertRaises(RuntimeError):
                        run.finish()
                else:
                    run.finish()
            result = json.loads((run.evidence / "result.json").read_text())
            self.assertNotIn("synthetic-credential.json", result["artifactAllowlist"])
            self.assertEqual(result["scope"], "autostart-only")
            self.assertTrue(all(value == "NOT_RUN" for value in result["excluded"].values()))
            return result

    def test_summary_rejects_masked_failure_missing_report_and_stale_source(self):
        self.assertEqual(self.run_finish()["status"], "PASS")
        self.assertEqual(self.run_finish(bad_step="AUTOSTART")["status"], "FAIL")
        self.assertEqual(self.run_finish(missing="http.json")["status"], "FAIL")
        self.assertEqual(self.run_finish(missing="autostart.json")["status"], "FAIL")
        self.assertEqual(self.run_finish(wrong_source=True)["status"], "FAIL")
        self.assertEqual(self.run_finish(wrong_scope=True)["status"], "FAIL")
        self.assertEqual(self.run_finish(wrong_script=True)["status"], "FAIL")
        self.assertEqual(self.run_finish(extra=True)["exportPolicy"], "FAIL")

    def test_http_phase_requires_all_six_and_refuses_a_second_attempt(self):
        names = "".join(f"test_{i} (__main__.Case) ... ok\n" for i in range(6))
        complete = names + "\nRan 6 tests in 0.1s\n\nOK\n"
        for output, code, passed in (
                (complete, 0, True), ("Ran 0 tests in 0.1s\n\nOK\n", 0, False),
                (complete.replace("\nOK\n", "\nOK (skipped=1)\n"), 0, False),
                (complete, 1, False)):
            with self.subTest(code=code, complete=output == complete), tempfile.TemporaryDirectory() as directory:
                run = ci.Run(SimpleNamespace(work=Path(directory), node="node"))
                run.private.mkdir()
                run.evidence.mkdir()
                run.source = lambda: {"commit": "a" * 40, "tree": "b" * 40}
                result = SimpleNamespace(stdout="", stderr=output, returncode=code)
                with patch.object(ci.subprocess, "run", return_value=result) as command:
                    if passed:
                        run.http()
                    else:
                        with self.assertRaises(RuntimeError):
                            run.http()
                    with self.assertRaises(FileExistsError):
                        run.http()
                    self.assertEqual(command.call_count, 1)
                report = json.loads((run.evidence / "http.json").read_text())
                self.assertEqual(report["status"], "PASS" if passed else "FAIL")


if __name__ == "__main__":
    unittest.main()
