"""Autostart-only CI. Resource preparation is not LSH functional acceptance."""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

SCOPE = "autostart-only"
EXCLUDED = {name: "NOT_RUN" for name in (
    "rustModuleTests", "desktopValidator", "nativeHostCli", "lshUiProbe", "core", "gio")}
STEPS = ("CHECKOUT", "INIT", "HTTP", "DEPENDENCIES", "RUST", "NODE", "FRONTEND",
         "BUILD", "DRIVER", "RUNTIME", "RESOURCES", "AUTOSTART")
RECORDS = ("runtime-authority.json", "runtime-manifest.json", "dependency-audit.json", "THIRD-PARTY-NOTICES.txt")
EXPORTS = ("source.json", "build.json", "resources.json", "http.json", "autostart.json", "result.json")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def read_json(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 128 * 1024,
            "report missing or invalid: " + path.name)
    value = json.loads(path.read_text())
    require(isinstance(value, dict), "object report required: " + path.name)
    return value


def write_json(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def git(repo, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=repo, text=True).strip()


def source_identity(repo):
    require(not git(repo, "status", "--porcelain"), "checkout changed")
    commit = git(repo, "rev-parse", "HEAD")
    require(re.fullmatch(r"[0-9a-f]{40}", os.environ.get("GITHUB_SHA", "")) is not None,
            "explicit source SHA required")
    require(commit == os.environ["GITHUB_SHA"], "checkout SHA mismatch")
    return {"commit": commit, "tree": git(repo, "rev-parse", "HEAD^{tree}")}


def regular_elf(path):
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.geteuid()
            and not metadata.st_mode & 0o7022 and metadata.st_mode & 0o111,
            "unsafe native build artifact")
    require(not os.listxattr(path), "unsupported native artifact attributes")
    with path.open("rb") as stream:
        header = stream.read(20)
    require(header[:6] == b"\x7fELF\x02\x01" and header[18:20] == b"\x3e\x00",
            "actual x86-64 Linux ELF required")
    return {"bytes": metadata.st_size, "sha256": digest(path)}


def select_artifact(messages, source, is_test, target):
    found = []
    for line in messages.splitlines():
        item = json.loads(line)
        if (item.get("reason") == "compiler-artifact"
                and item["target"]["src_path"] == str(source)
                and item["profile"]["test"] is is_test
                and item.get("executable")):
            path = Path(item["executable"])
            require(path.is_absolute() and path.resolve().is_relative_to(target.resolve()),
                    "artifact outside selected target")
            found.append(path)
    require(len(found) == 1, "exactly one selected Cargo artifact required")
    return found[0]


def validate_autostart(raw, build, source, script_sha):
    require(isinstance(raw, dict), "autostart report must be an object")
    expected = build["application"]["sha256"]
    require(raw.get("applicationSha256") == expected, "smoke ELF identity mismatch")
    require(raw.get("smokeScriptSha256") == script_sha, "smoke script identity mismatch")
    require("failure" not in raw, "smoke reported failure")
    require(raw.get("commit") == source["commit"], "smoke source SHA mismatch")
    for name in ("nativeStartup", "quitRequestProcessDisappearance",
                 "autostartEnableDisableReenablePersistence", "independentBackupAndOldInode"):
        require(raw.get(name) == "PASS", "autostart assertion missing: " + name)
    for name in ("lshAi", "noteFlows", "materialImportCatalogRead"):
        require(raw.get(name) == "NOT_RUN", "excluded flow was not excluded: " + name)
    expected_reads = [("initial", False), ("enabled", True), ("disabled", False),
                      ("reenabled", True), ("reopened", False)]
    reads = raw.get("autostartReads")
    require(isinstance(reads, list) and len(reads) == len(expected_reads), "autostart reads incomplete")
    for read, (stage, value) in zip(reads, expected_reads):
        require(isinstance(read, dict), "read result must be an object")
        require(read.get("stage") == stage and read.get("status") == "PASS"
                and read.get("adapter") == "execute-sync-returned-promise"
                and read.get("ipcReply") == "OBSERVED" and read.get("attempts") == 1
                and type(read.get("value")) is bool and read["value"] is value,
                "read result missing, invalid or retried")
    quits = raw.get("quitRequests")
    require(isinstance(quits, list) and len(quits) == 2
            and all(isinstance(item, dict) and item.get("priorProcessIdentitiesGone") is True for item in quits),
            "quit and reopen lifecycle incomplete")


class Run:
    def __init__(self, args):
        self.args = args
        self.repo = Path(__file__).resolve().parents[2]
        self.app = self.repo / "luckyray-app"
        self.work = args.work.resolve()
        self.private = self.work / "private"
        self.evidence = self.work / "evidence"
        self.target = self.work / "target"

    def source(self):
        current = source_identity(self.repo)
        original = read_json(self.evidence / "source.json")
        require(original.get("scope") == SCOPE and current == original["source"],
                "source or scope changed between CI phases")
        require(original.get("scripts") == self.scripts(), "CI scripts changed between phases")
        return current

    def scripts(self):
        return {name: digest(self.app / "tests" / path) for name, path in (
            ("collector", "linux-runtime-ci.py"), ("smoke", "linux-desktop-smoke.py"),
            ("http", "linux-webdriver-response.test.py"))}

    def env(self):
        home = self.private / "synthetic-home"
        temporary = self.private / "tmp"
        for path in (home, temporary):
            path.mkdir(mode=0o700, exist_ok=True)
        return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(home),
                "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
                "XDG_CACHE_HOME": str(home / "cache"), "TMPDIR": str(temporary),
                "RUNNER_TEMP": str(temporary), "GITHUB_SHA": self.source()["commit"],
                "LUCKYRAY_APP_PROFILE": "development", "PYTHONDONTWRITEBYTECODE": "1"}

    def init(self):
        require(not self.work.is_relative_to(self.repo) and self.work != Path("/"),
                "separate runner temporary workspace required")
        self.work.mkdir(mode=0o700)
        self.private.mkdir(mode=0o700)
        self.evidence.mkdir(mode=0o700)
        write_json(self.evidence / "source.json", {"status": "PASS", "scope": SCOPE,
                   "source": source_identity(self.repo), "scripts": self.scripts(), "excluded": EXCLUDED})

    def binaries(self):
        source = self.source()
        root = self.app / "src-tauri/src"
        native_messages = (self.private / "native-artifacts.jsonl").read_text()
        app = select_artifact(native_messages, root / "main.rs", False, self.target)
        debug = self.target / "x86_64-unknown-linux-gnu/debug"
        require(app.parent == debug and self.target.name == "target"
                and (debug / ".cargo-lock").is_file(), "actual Tauri Cargo resource directory required")
        identity = regular_elf(app)
        # Cargo may hardlink its normal binary to deps/. Admission is tested on
        # a byte-identical regular single-link copy, with every product check intact.
        staged = debug / "luckyray-app-integration"
        with app.open("rb") as old, staged.open("xb") as new:
            shutil.copyfileobj(old, new)
        staged.chmod(0o755)
        require(staged.stat().st_nlink == 1 and digest(staged) == identity["sha256"],
                "single-link application copy mismatch")
        fingerprint = hashlib.sha256(b"luckyray-dsh-host-adapter-v1\0")
        for name in ("src-tauri/dsh-host/luckyray-dsh-host.mjs", "src-tauri/src/dsh_host.rs",
                     "src-tauri/src/lib.rs", "src-tauri/src/dsh_resource_broker.rs"):
            data = (self.app / name).read_bytes()
            fingerprint.update(name.encode() + b"\0" + len(data).to_bytes(8, "little") + data)
        expected = fingerprint.hexdigest()
        outputs = list((debug / "build").glob("luckyray-app-*/output"))
        require(any("cargo:rustc-env=LUCKYRAY_DSH_ADAPTER_FINGERPRINT=" + expected in p.read_text().splitlines()
                    for p in outputs), "fresh build adapter fingerprint mismatch")
        require(expected.encode() in staged.read_bytes(), "application missing current adapter fingerprint")
        write_json(self.private / "layout.json", {"application": str(staged), "resourceRoot": str(debug)})
        write_json(self.evidence / "build.json", {"status": "PASS", "scope": SCOPE, "source": source,
                   "application": identity, "scripts": self.scripts(), "adapterFingerprint": expected,
                   "kind": "DIAGNOSTIC_NOT_RELEASE_IDENTITY"})

    def resources(self):
        source = self.source()
        layout = read_json(self.private / "layout.json")
        records = self.app / "dsh-host/linux-x64"
        pins = {}
        for name in RECORDS:
            expected = digest(records / name)
            require(digest(self.work / "records" / name) == expected, "assembled record differs from compiled input")
            pins[name] = {"bytes": (records / name).stat().st_size, "sha256": expected}
        authority = read_json(records / "runtime-authority.json")
        require(digest(self.work / "inputs/inputs.json") == authority["inputsSha256"], "input descriptor mismatch")
        fences = []
        for line in (self.private / "lsh-assembly.log").read_text().splitlines():
            if line.startswith("{"):
                value = json.loads(line)
                if value.get("outcome") == "ASSEMBLY_NETWORK_FENCE":
                    fences.append(value)
        require({value["phase"] for value in fences} == {"verified-loopback-cache", "offline"}
                and len(fences) == 2
                and all(value["contexts"] >= 1 and value["blockedSockets"] == 0
                        and value["blockedDns"] == 0 for value in fences)
                and all(value["allowedSockets"] == 0 for value in fences if value["phase"] == "offline")
                and all(value["allowedSockets"] > 0 for value in fences if value["phase"] == "verified-loopback-cache"),
                "offline assembly network accounting incomplete")
        archives = {"node": self.work / "node.tar.gz", "pnpm": self.work / "pnpm.tgz"}
        require(digest(archives["node"]) == authority["nodeRuntime"]["archiveSha256"], "Node archive mismatch")
        inputs = json.loads((self.work / "inputs/inputs.json").read_text())
        require(digest(archives["pnpm"]) == inputs["packageManager"]["archiveSha256"], "pnpm archive mismatch")
        debug = Path(layout["resourceRoot"])
        for name in ("lr-lsh", "licenses"):
            origin, destination = self.work / "resources" / name, debug / name
            require(origin.is_dir() and not origin.is_symlink() and not os.path.lexists(destination),
                    "resource staging must not replace an existing destination")
            origin.rename(destination)
        for name in RECORDS:
            require(digest(debug / "licenses/lsh-linux" / name) == pins[name]["sha256"], "staged record mismatch")
        runtime = debug / "lr-lsh/199-1/deepseek-harness"
        script = ("const {auditLinuxClosure}=await import(process.argv[1]);"
                  "const {fileCount,byteCount,closureSha256}=await auditLinuxClosure(process.argv[2]);"
                  "console.log(JSON.stringify({fileCount,byteCount,closureSha256}));")
        result = subprocess.run([self.args.node, "--input-type=module", "-e", script,
                                 (self.app / "scripts/linux/lsh-closure.mjs").as_uri(), str(runtime)],
                                text=True, capture_output=True, check=True, timeout=180)
        actual = json.loads(result.stdout)
        require(actual == {"fileCount": authority["closure"]["fileCount"],
                           "byteCount": authority["closure"]["byteCount"],
                           "closureSha256": authority["closure"]["sha256"]}, "actual resource closure mismatch")
        host = debug / "lr-lsh/199-1/dsh-host"
        host_files = []
        for path in sorted(host.rglob("*")):
            require(not path.is_symlink(), "link in staged host")
            if path.is_dir():
                continue
            relative = path.relative_to(host).as_posix()
            data = (self.app / "src-tauri/dsh-host" / relative).read_bytes()
            if not relative.endswith(".webp"):
                data = data.replace(b"\r\n", b"\n")
            require(digest(path) == hashlib.sha256(data).hexdigest(), "staged host asset changed")
            host_files.append({"path": relative, "bytes": path.stat().st_size, "sha256": digest(path)})
        require(len(host_files) == 18, "complete host asset set required")
        write_json(self.evidence / "resources.json", {"status": "PASS", "scope": SCOPE, "source": source,
                   "purpose": "startup resource parity; LSH functional flow NOT_RUN",
                   "runtime": authority["runtimePackage"], "node": authority["nodeRuntime"],
                   "closure": actual, "compiledRecords": pins, "hostFiles": host_files,
                   "inputDescriptorSha256": digest(self.work / "inputs/inputs.json"),
                   "assemblyNetwork": fences,
                   "archives": {name: {"bytes": path.stat().st_size, "sha256": digest(path)}
                                for name, path in archives.items()},
                   "resourceDirectory": "ACTUAL_TAURI_CARGO_OUTPUT",
                   "distributionReadiness": "NOT_VERIFIED"})

    def http(self):
        source = self.source()
        (self.private / "http.attempt").open("x").close()
        script = self.app / "tests/linux-webdriver-response.test.py"
        report = {"status": "FAIL", "scope": SCOPE, "source": source, "scriptSha256": digest(script),
                  "expectedTests": 6, "attempts": 1}
        try:
            result = subprocess.run(["/usr/bin/python3", str(script), "-v"], env=self.env(),
                                    text=True, capture_output=True, timeout=30)
            text = result.stdout + result.stderr
            (self.private / "http.log").write_text(text)
            print(text, flush=True)
            names = re.findall(r"^(test_\w+) \(.*\) \.\.\. ok$", text, re.MULTILINE)
            require(result.returncode == 0 and len(names) == 6
                    and re.search(r"^Ran 6 tests in ", text, re.MULTILINE)
                    and re.search(r"^OK$", text, re.MULTILINE), "six HTTP regressions did not all pass")
            report.update(passed=6, failed=0, skipped=0, names=names,
                          logSha256=digest(self.private / "http.log"))
            self.source()
            report["status"] = "PASS"
        except Exception as error:
            report["error"] = str(error)
            raise
        finally:
            write_json(self.evidence / "http.json", report)

    def smoke(self):
        source = self.source()
        (self.private / "autostart.attempt").open("x").close()
        build = read_json(self.evidence / "build.json")
        layout = read_json(self.private / "layout.json")
        script = self.app / "tests/linux-desktop-smoke.py"
        output = self.private / "autostart"
        require(regular_elf(Path(layout["application"])) == build["application"], "application changed before use")
        resource_report = read_json(self.evidence / "resources.json")
        require(resource_report.get("status") == "PASS" and resource_report.get("scope") == SCOPE,
                "actual startup resources required")
        command = ["/usr/bin/python3", str(script), "--application",
                   layout["application"], "--output", str(output), "--user-integration",
                   "--driver", str(self.args.driver)]
        command = ["dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1440x900x24", *command]
        report = {"status": "FAIL", "source": source, "scope": SCOPE, "flowCount": 1, "rawReport": None,
                  "driver": {"versionPin": "2.1.0", **regular_elf(self.args.driver)}}
        try:
            result = subprocess.run(command, env=self.env(), text=True, capture_output=True, timeout=780)
            (self.private / "autostart.log").write_text(result.stdout + result.stderr)
            report["diagnosticTail"] = (result.stdout + result.stderr)[-16000:]
            if (output / "report.json").is_file():
                report["rawReport"] = read_json(output / "report.json")
                report["rawReportSha256"] = digest(output / "report.json")
            if result.returncode != 0:
                raw = report["rawReport"] or {}
                # Only selected synthetic diagnostics; no environment or user files.
                detail = {"failure": raw.get("failure"), "autostartReads": raw.get("autostartReads"),
                          "quitRequests": raw.get("quitRequests")}
                raise RuntimeError("focused smoke command failed; no retry: " + json.dumps(detail)[:8000])
            validate_autostart(report["rawReport"] or {}, build, source, digest(script))
            self.source()
            report["status"] = "PASS"
        except Exception as error:
            report["error"] = str(error)
            raise
        finally:
            write_json(self.evidence / "autostart.json", report)

    def finish(self):
        outcomes = {name: os.environ.get("CI_" + name, "missing") for name in STEPS}
        reports, bodies = {}, {}
        for name in EXPORTS[:-1]:
            try:
                bodies[name] = read_json(self.evidence / name)
                reports[name] = bodies[name].get("status", "missing")
            except (OSError, ValueError, RuntimeError):
                reports[name] = "INVALID" if os.path.lexists(self.evidence / name) else "NOT_RUN"
        passed = all(value == "success" for value in outcomes.values()) and all(value == "PASS" for value in reports.values())
        try:
            source = self.source()
        except Exception:
            source, passed = {"commit": os.environ.get("GITHUB_SHA"), "changed": True}, False
        if any(body.get("source") != source or body.get("scope") != SCOPE for body in bodies.values()):
            passed = False
        try:
            scripts = self.scripts()
            require(bodies["source.json"]["scripts"] == scripts
                    and bodies["build.json"]["scripts"] == scripts, "script bindings changed")
            http = bodies["http.json"]
            require(http["scriptSha256"] == scripts["http"] and http.get("passed") == 6
                    and http.get("failed") == 0 and http.get("skipped") == 0
                    and http.get("attempts") == 1, "HTTP result incomplete or stale")
            auto = bodies["autostart.json"]
            require(auto.get("flowCount") == 1, "exactly one autostart flow required")
            validate_autostart(auto["rawReport"], bodies["build.json"], source, scripts["smoke"])
        except (KeyError, TypeError, ValueError, RuntimeError):
            passed = False
        export_safe = (set(path.name for path in self.evidence.iterdir()).issubset(EXPORTS)
                       and all(path.is_file() and not path.is_symlink() for path in self.evidence.iterdir()))
        passed = passed and export_safe
        result = {"status": "PASS" if passed else "FAIL", "scope": SCOPE, "source": source, "stepOutcomes": outcomes,
                  "reports": reports, "artifactAllowlist": list(EXPORTS),
                  "included": {"httpRegressions": 6, "autostartFlows": 1}, "excluded": EXCLUDED,
                  "exportPolicy": "PASS" if export_safe else "FAIL",
                  "limits": ["diagnostic ELF, not a package or release identity",
                             "no real browser connection or account authorization",
                             "no clean-exit status, hardware/Wayland or full editor acceptance"]}
        write_json(self.evidence / "result.json", result)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write("## Linux autostart-only diagnostics\n\n")
                stream.write("- Source: " + str(source.get("commit")) + "\n")
                for name, outcome in reports.items():
                    stream.write("- " + name + ": " + outcome + "\n")
                for name, outcome in EXCLUDED.items():
                    stream.write("- " + name + ": " + outcome + "\n")
                stream.write("- Package, release identity, real browser/account and hardware: NOT_VERIFIED.\n")
        require(passed, "required new coverage failed or did not run")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("init", "binaries", "resources", "http", "smoke", "finish"))
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--driver", type=Path)
    args = parser.parse_args()
    run = Run(args)
    getattr(run, args.phase)()


if __name__ == "__main__":
    main()
