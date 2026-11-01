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
                with self.assertRaisesRegex(RuntimeError, "user-namespace-failed"):
                    run.preflight()
            self.assertEqual(calls.call_count, 1)
            self.assertEqual(calls.call_args.args[0], ["/usr/bin/unshare", "--user", "--map-root-user", "/bin/true"])
            report = json.loads((run.evidence / "preflight.json").read_text())
            self.assertEqual(report["status"], "FAIL")
            self.assertEqual(report["userNamespaceProbe"]["exitCode"], 1)
            self.assertFalse((run.private / "browser-layout.json").exists())


class PreflightDiagnostics(unittest.TestCase):
    CANARY = "PRIVATE_CANARY_cookie_bearer_profile_f5499d"
    SOURCE = {"commit": "a" * 40, "tree": "b" * 40}
    BROWSER = {"version": "Chromium 146.0.1.2", "sha256": "c" * 64, "bytes": 123456}
    SANDBOX = {"status": "PASS", "namespace": "Yes", "pidNamespaces": "Yes", "networkNamespaces": "Yes",
               "seccompBpf": "Yes", "adequatelySandboxed": True, "securityDisablingFlags": [],
               "source": "ACTUAL_CHROME_SANDBOX_PAGE"}

    def simulate(self, child, namespace=None):
        """Only mock process results: no unshare, browser, application or build runs."""
        with tempfile.TemporaryDirectory() as root:
            run = ci.Run(SimpleNamespace(work=Path(root)))
            run.evidence.mkdir()
            run.private.mkdir()
            run.source = lambda: self.SOURCE
            run.scripts = lambda: {}
            run.env = lambda: {}
            ci.write_json(run.evidence / "source.json", {"status": "PASS", "source": self.SOURCE,
                          "scope": ci.SCOPE, "scripts": {}})
            namespace = namespace or subprocess.CompletedProcess([], 0, stdout=b"", stderr=self.CANARY.encode())
            original_resolve = Path.resolve

            def resolve(path, *args, **kwargs):
                if str(path) == "/usr/bin/chromium":
                    return Path("/usr/local/share/chromium/chrome-linux/chrome")
                if str(path) == "/offline/node":
                    return path
                return original_resolve(path, *args, **kwargs)

            with patch.object(ci.os, "geteuid", return_value=1000), patch.object(ci.Path, "resolve", resolve), \
                    patch.object(ci.shutil, "which", return_value="/offline/node"), \
                    patch.object(ci.subprocess, "run", side_effect=[namespace, child]) as calls:
                try:
                    run.preflight()
                except RuntimeError as error:
                    self.assertNotIn(self.CANARY, str(error))
            report = json.loads((run.evidence / "preflight.json").read_text())
            env = {"CI_" + name: "skipped" for name in ci.STEPS}
            env.update(CI_CHECKOUT="success", CI_INIT="success", CI_NODE="success",
                       CI_PREFLIGHT="success" if report["status"] == "PASS" else "failure")
            with patch.dict(os.environ, env), self.assertRaises(RuntimeError):
                run.finish()
            result = json.loads((run.evidence / "result.json").read_text())
            self.assertEqual(result["status"], "FAIL", "diagnostics cannot admit skipped coverage")
            self.assertEqual(set(result["excluded"].values()), {"NOT_RUN"})
            self.assertEqual(set(p.name for p in run.evidence.iterdir()), {"source.json", "preflight.json", "result.json"})
            self.assertNotIn(self.CANARY, json.dumps([report, result]))
            self.assertLess(len(json.dumps(result["preflightDiagnostic"])), 2048)
            self.assertEqual(result["preflightDiagnostic"], ci.preflight_diagnostic(report))
            logs = (run.private / "preflight.log").read_text() if (run.private / "preflight.log").exists() else ""
            return report, result, calls.call_count, logs

    def child(self, value, code=1):
        return subprocess.CompletedProcess([], code, stdout=json.dumps(value), stderr=self.CANARY)

    def test_child_failure_phase_identity_and_exit_survive_both_reports_without_raw_fields(self):
        cases = [("browser-start", "browser-start-failed"), ("browser-start", "devtools-start-timeout"),
                 ("cdp-connect", "cdp-connect-failed"), ("sandbox-page", "sandbox-page-failed"),
                 ("sandbox-observation", "sandbox-observation-timeout"),
                 ("sandbox-assertion", "namespace-sandbox-required"),
                 ("sandbox-assertion", "pid-namespaces-required"),
                 ("sandbox-assertion", "network-namespaces-required"),
                 ("sandbox-assertion", "seccomp-bpf-required"),
                 ("sandbox-assertion", "adequate-sandbox-required"), ("browser-cleanup", "browser-cleanup-failed")]
        for phase, code in cases:
            with self.subTest(phase=phase, code=code):
                payload = {"status": "FAIL", "browser": {**self.BROWSER, "profile": self.CANARY},
                           "failure": {"phase": phase, "code": code, "message": self.CANARY,
                                       "stack": self.CANARY, "osError": self.CANARY}, "raw": self.CANARY}
                report, result, calls, logs = self.simulate(self.child(payload))
                self.assertEqual(report["status"], "FAIL")
                self.assertEqual(report["phase"], phase)
                self.assertEqual(report["failure"], {"phase": phase, "code": code})
                self.assertEqual(report["browser"], self.BROWSER)
                self.assertEqual(report["child"], {"exitCode": 1, "status": "FAIL", "failure": report["failure"]})
                self.assertEqual(report["userNamespaceProbe"]["exitCode"], 0)
                self.assertEqual(result["preflightDiagnostic"]["userNamespaceProbe"]["exitCode"], 0)
                self.assertEqual(calls, 2)
                self.assertIn(self.CANARY, logs, "raw child output must remain private")

    def test_malformed_missing_oversized_and_multiple_outputs_remain_fail(self):
        for output in ("", self.CANARY, "{}\n{}", self.CANARY * 1000, "null", "[]"):
            with self.subTest(kind=output[:10]):
                report, _, calls, _ = self.simulate(subprocess.CompletedProcess([], 7, stdout=output, stderr=self.CANARY))
                self.assertEqual(report["status"], "FAIL")
                self.assertEqual(report["phase"], "chromium-output")
                self.assertIn(report["failure"]["code"], ("child-output-invalid", "child-report-invalid"))
                self.assertEqual(report["child"]["exitCode"], 7)
                self.assertEqual(calls, 2)

    def test_timeout_and_execution_errors_have_bounded_codes_and_unknown_exit(self):
        for error, code in ((subprocess.TimeoutExpired([self.CANARY], 90, output=self.CANARY), "chromium-timeout"),
                            (FileNotFoundError(self.CANARY), "chromium-execution-failed")):
            with self.subTest(code=code):
                report, _, calls, _ = self.simulate(error)
                self.assertEqual(report["failure"], {"phase": "chromium-subprocess", "code": code})
                self.assertIsNone(report["child"]["exitCode"])
                self.assertEqual(calls, 2)
        report, _, calls, _ = self.simulate(None, namespace=subprocess.TimeoutExpired([self.CANARY], 10))
        self.assertEqual(report["failure"]["code"], "user-namespace-timeout")
        self.assertNotIn("child", report)
        self.assertEqual(calls, 1)

    def test_report_exit_disagreement_and_unverified_browser_never_pass(self):
        good = {"status": "PASS", "browser": self.BROWSER, "sandbox": self.SANDBOX}
        cases = [(good, 3, "child-exit-status-mismatch"),
                 ({"status": "FAIL", "failure": {"phase": "cdp-connect", "code": "cdp-connect-failed"}}, 0, "cdp-connect-failed"),
                 ({**good, "browser": {**self.BROWSER, "version": "Chromium 146.0.1.2 " + self.CANARY}}, 0, "browser-identity-invalid"),
                 ({**good, "sandbox": {**self.SANDBOX, "seccompBpf": "No"}}, 0, "sandbox-evidence-invalid"),
                 ({**good, "failure": self.CANARY}, 0, "child-exit-status-mismatch")]
        for payload, exit_code, code in cases:
            with self.subTest(code=code):
                report, _, _, _ = self.simulate(self.child(payload, exit_code))
                self.assertEqual(report["status"], "FAIL")
                self.assertEqual(report["failure"]["code"], code)

    def test_unknown_and_mistyped_failure_fields_are_redacted(self):
        for failure in (self.CANARY, {"phase": self.CANARY, "code": self.CANARY},
                        {"phase": [], "code": {}, "osError": [self.CANARY]}):
            with self.subTest(failure_type=type(failure).__name__):
                report, _, _, _ = self.simulate(self.child({"status": "FAIL", "browser": self.BROWSER, "failure": failure}))
                self.assertEqual(report["failure"], {"phase": "unknown", "code": "unclassified-client-failure"})

    def test_observed_browser_exit_and_allowed_signal_survive_without_arbitrary_signal_text(self):
        failure = {"phase": "browser-start", "code": "devtools-start-timeout", "browserExitCode": None,
                   "browserSignal": "SIGTRAP", "signalText": self.CANARY}
        report, result, _, _ = self.simulate(self.child({"status": "FAIL", "browser": self.BROWSER, "failure": failure}))
        self.assertEqual(report["failure"]["browserSignal"], "SIGTRAP")
        self.assertIsNone(result["preflightDiagnostic"]["failure"]["browserExitCode"])
        self.assertEqual(ci.preflight_failure({**failure, "browserSignal": self.CANARY}).get("browserSignal"), None)

    def test_successful_preflight_projects_sandbox_but_cannot_pass_missing_builds(self):
        payload = {"status": "PASS", "browser": {**self.BROWSER, "profile": self.CANARY},
                   "sandbox": {**self.SANDBOX, "rawPage": self.CANARY}}
        report, result, calls, _ = self.simulate(self.child(payload, 0))
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["phase"], "complete")
        self.assertEqual(report["sandbox"], self.SANDBOX)
        self.assertNotIn("failure", report)
        self.assertEqual(calls, 2)
        self.assertEqual(result["reports"]["build.json"], "NOT_RUN")
        self.assertEqual(result["reports"]["browser.json"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
