"""Evidence admission checks; these tests never launch a browser or application."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("browser_ci", Path(__file__).with_name("linux-browser-ci.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class EvidenceAdmission(unittest.TestCase):
    def setUp(self):
        self.source = {"commit": "a" * 40, "tree": "b" * 40}
        self.scripts = {"smoke": "c" * 64, "chromium": "d" * 64}
        self.build = {"application": {"sha256": "e" * 64}, "nativeHost": {"sha256": "f" * 64}, "scripts": self.scripts}
        self.extension = {"origin": "chrome-extension://" + "a" * 32, "closureSha256": "1" * 64}
        sandbox = {"status": "PASS", "namespace": "Yes", "pidNamespaces": "Yes", "networkNamespaces": "Yes",
                   "seccompBpf": "Yes", "adequatelySandboxed": True, "securityDisablingFlags": [],
                   "source": "ACTUAL_CHROME_SANDBOX_PAGE"}
        self.preflight = {"browser": {"sha256": "2" * 64}, "sandbox": sandbox,
                          "attempts": 1, "userNamespaceProbe": {"exitCode": 0}}
        self.raw = {"status": "PASS", "commit": self.source["commit"], "applicationSha256": "e" * 64,
                    "nativeHostSha256": "f" * 64, "scriptSha256": "c" * 64, "clientScriptSha256": "d" * 64,
                    "realChromium": "PASS", "browserApi": "REAL_CHROMIUM_NO_API_SUBSTITUTION",
                    "checks": {key: "PASS" for key in ci.CHECKS}, "browserSessions": [
                        {"session": str(i), "browser": self.preflight["browser"], "sandbox": copy.deepcopy(sandbox),
                         "extension": self.extension} for i in range(2)],
                    "quitRequests": [{"ipcReplyObserved": True, "priorProcessIdentitiesGone": True,
                                      "exitStatus": "NOT_OBSERVED"} for _ in range(2)]}
        self.raw["clientCommands"] = [{"command": command, "ok": ok, "code": code,
            "counters": {"anonymousBootstrap": 0}, **({"httpStatus": 200} if command == "read" else {})}
            for command, ok, code in ci.COMMANDS]

    def validate(self, raw):
        ci.validate_browser(raw, self.build, self.source, self.scripts, self.extension, self.preflight)

    def test_complete_real_report_is_admitted(self):
        self.validate(self.raw)

    def test_seam_stale_identity_missing_consent_and_disabled_sandbox_are_rejected(self):
        mutations = [
            lambda r: r.update(browserApi="DECLARED_NODE_PROTOCOL_SEAM"),
            lambda r: r.update(commit="0" * 40),
            lambda r: r.update(nativeHostSha256="0" * 64),
            lambda r: r.update(clientScriptSha256="0" * 64),
            lambda r: r["checks"].pop("oldCredentialAndBindingRemainInvalidAfterReapproval"),
            lambda r: r["browserSessions"][0]["sandbox"].update(seccompBpf="No"),
            lambda r: r["browserSessions"][0]["sandbox"].update(securityDisablingFlags=["--no-sandbox"]),
            lambda r: r["browserSessions"][0].update(extension={"origin": "different"}),
            lambda r: r["quitRequests"][0].update(ipcReplyObserved=False),
            lambda r: r["clientCommands"].pop(),
            lambda r: r["clientCommands"][0]["counters"].update(anonymousBootstrap=1),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                raw = copy.deepcopy(self.raw)
                mutate(raw)
                with self.assertRaises(RuntimeError):
                    self.validate(raw)

    def test_strict_finish_rejects_skipped_step_and_preserves_not_run(self):
        with tempfile.TemporaryDirectory() as root:
            run = ci.Run(SimpleNamespace(work=Path(root)))
            run.evidence.mkdir()
            run.source = lambda: self.source
            run.scripts = lambda: self.scripts
            reports = {"source.json": {}, "preflight.json": self.preflight, "build.json": self.build,
                       "resources.json": {}, "browser.json": {"flowCount": 1, "attempts": 1, "rawReport": self.raw}}
            for name, body in reports.items():
                ci.write_json(run.evidence / name, {**body, "status": "PASS", "source": self.source, "scope": ci.SCOPE})
            env = {"CI_" + name: "success" for name in ci.STEPS}
            env["CI_BROWSER"] = "skipped"
            with patch.dict(os.environ, env), self.assertRaises(RuntimeError):
                run.finish()
            result = json.loads((run.evidence / "result.json").read_text())
            self.assertEqual(result["status"], "FAIL")
            self.assertEqual(set(result["excluded"].values()), {"NOT_RUN"})

    def test_namespace_denial_stops_before_browser_or_build(self):
        with tempfile.TemporaryDirectory() as root:
            run = ci.Run(SimpleNamespace(work=Path(root)))
            run.evidence.mkdir()
            run.private.mkdir()
            run.source = lambda: self.source
            run.env = lambda: {}
            result = subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"Operation not permitted")
            with patch.object(ci.os, "geteuid", return_value=1000), patch.object(ci.subprocess, "run", return_value=result) as calls:
                with self.assertRaisesRegex(RuntimeError, "user namespaces unavailable"):
                    run.preflight()
            self.assertEqual(calls.call_count, 1)
            self.assertEqual(calls.call_args.args[0], ["/usr/bin/unshare", "--user", "--map-root-user", "/bin/true"])
            report = json.loads((run.evidence / "preflight.json").read_text())
            self.assertEqual(report["status"], "FAIL")
            self.assertEqual(report["userNamespaceProbe"]["exitCode"], 1)
            self.assertFalse((run.private / "browser-layout.json").exists())


if __name__ == "__main__":
    unittest.main()
