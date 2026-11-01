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
        good = {"applicationSha256": "b" * 64, "smokeScriptSha256": "c" * 64,
                "commit": source["commit"], "nativeStartup": "PASS",
                "quitRequestProcessDisappearance": "PASS",
                "autostartEnableDisableReenablePersistence": "PASS",
                "independentBackupAndOldInode": "PASS"}
        ci.validate_smoke("autostart", good, build, source, "c" * 64)
        for key, value in (("failure", "connection reset"), ("commit", "d" * 40),
                           ("applicationSha256", "e" * 64),
                           ("autostartEnableDisableReenablePersistence", "NOT_RUN")):
            bad = {**good, key: value}
            with self.subTest(field=key), self.assertRaises(RuntimeError):
                ci.validate_smoke("autostart", bad, build, source, "c" * 64)

    def run_finish(self, bad_step=None, missing=None, extra=False, wrong_source=False):
        with tempfile.TemporaryDirectory() as directory:
            run = ci.Run(SimpleNamespace(work=Path(directory), node="node"))
            run.private.mkdir()
            run.evidence.mkdir()
            source = {"commit": "a" * 40, "tree": "b" * 40}
            run.source = lambda: source
            for name in ci.EXPORTS[:-1]:
                if name != missing:
                    ci.write_json(run.evidence / name, {"status": "PASS", "source": source})
            if wrong_source:
                path = run.evidence / "lsh.json"
                path.write_text(json.dumps({"status": "PASS", "source": {"commit": "foreign"}}))
            (run.private / "synthetic-credential.json").write_text("synthetic non-exported marker")
            if extra:
                (run.evidence / "unexpected.txt").write_text("must not be exported")
            environment = {"CI_" + name: "success" for name in (
                "CHECKOUT", "INIT", "DEPENDENCIES", "RUST", "NODE", "FRONTEND", "BUILD",
                "DRIVER", "RUNTIME", "RESOURCES", "UNITS", "NATIVE_HOST", "AUTOSTART", "LSH")}
            if bad_step:
                environment["CI_" + bad_step] = "failure"
            with patch.dict(os.environ, environment, clear=True):
                if bad_step or missing or extra or wrong_source:
                    with self.assertRaises(RuntimeError):
                        run.finish()
                else:
                    run.finish()
            result = json.loads((run.evidence / "result.json").read_text())
            self.assertNotIn("synthetic-credential.json", result["artifactAllowlist"])
            return result

    def test_summary_rejects_masked_failure_missing_report_and_stale_source(self):
        self.assertEqual(self.run_finish()["status"], "PASS")
        self.assertEqual(self.run_finish(bad_step="AUTOSTART")["status"], "FAIL")
        self.assertEqual(self.run_finish(missing="lsh.json")["status"], "FAIL")
        self.assertEqual(self.run_finish(wrong_source=True)["status"], "FAIL")
        self.assertEqual(self.run_finish(extra=True)["exportPolicy"], "FAIL")


if __name__ == "__main__":
    unittest.main()
