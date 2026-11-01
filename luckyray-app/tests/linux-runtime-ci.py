"""Scoped CI orchestration. Only explicitly selected synthetic reports are exported."""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

GROUPS = {
    "linux_managed_record::tests::": (5, 0),
    "auto_launch_linux::tests::": (11, 2),
    "native_messaging_linux::tests::": (8, 0),
}
RECOVERY_TEST = "linux_managed_record::tests::linux_managed_recovery_rejects_unsafe_metadata_before_restoring_or_accepting"
VALIDATOR_TEST = "auto_launch_linux::tests::generated_entry_passes_desktop_file_validate_when_supplied"
RECORDS = ("runtime-authority.json", "runtime-manifest.json", "dependency-audit.json", "THIRD-PARTY-NOTICES.txt")
EXPORTS = ("source.json", "build.json", "resources.json", "units.json",
           "native-host.json", "autostart.json", "lsh.json", "result.json")


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


def validate_smoke(flow, raw, build, source, script_sha):
    expected = build["nativeHost" if flow == "native-host" else "application"]["sha256"]
    require(raw.get("applicationSha256") == expected, "smoke ELF identity mismatch")
    require(raw.get("scriptSha256" if flow == "native-host" else "smokeScriptSha256") == script_sha,
            "smoke script identity mismatch")
    require("failure" not in raw, "smoke reported failure")
    if flow == "native-host":
        for name in ("registration", "revocation", "reenable", "sourceIdentity",
                     "conflictAndSymlinkPreservation", "independentBackupAndOldInode",
                     "credentialNamespaceUnchanged"):
            require(raw.get(name) == "PASS", "native-host assertion missing: " + name)
    else:
        require(raw.get("commit") == source["commit"], "smoke source SHA mismatch")
        require(raw.get("nativeStartup") == "PASS"
                and raw.get("quitRequestProcessDisappearance") == "PASS", "native lifecycle incomplete")
        if flow == "autostart":
            require(raw.get("autostartEnableDisableReenablePersistence") == "PASS"
                    and raw.get("independentBackupAndOldInode") == "PASS", "autostart flow incomplete")
        else:
            lsh = raw.get("lshAi", {})
            for name in ("officialClientReady", "nativeProbe", "officialDomSettled", "routeHideReturnAndClose"):
                require(lsh.get(name) == "PASS", "LSH assertion missing: " + name)
            require(lsh.get("priorNodeProcessIdentitiesGone") is True, "LSH process identities remain")


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
        require(current == original["source"], "source changed between CI phases")
        return current

    def env(self):
        home = self.private / "synthetic-home"
        temporary = self.private / "tmp"
        for path in (home, temporary):
            path.mkdir(mode=0o700, exist_ok=True)
        return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(home),
                "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
                "XDG_CACHE_HOME": str(home / "cache"), "TMPDIR": str(temporary),
                "RUNNER_TEMP": str(temporary), "GITHUB_SHA": self.source()["commit"],
                "LUCKYRAY_APP_PROFILE": "development"}

    def init(self):
        require(not self.work.is_relative_to(self.repo) and self.work != Path("/"),
                "separate runner temporary workspace required")
        self.work.mkdir(mode=0o700)
        self.private.mkdir(mode=0o700)
        self.evidence.mkdir(mode=0o700)
        write_json(self.evidence / "source.json", {"status": "PASS", "source": source_identity(self.repo)})

    def binaries(self):
        source = self.source()
        root = self.app / "src-tauri/src"
        native_messages = (self.private / "native-artifacts.jsonl").read_text()
        test_messages = (self.private / "test-artifacts.jsonl").read_text()
        app = select_artifact(native_messages, root / "main.rs", False, self.target)
        host = select_artifact(native_messages, root / "sidecars/luckyray-native-host.rs", False, self.target)
        tests = select_artifact(test_messages, root / "lib.rs", True, self.target)
        debug = self.target / "x86_64-unknown-linux-gnu/debug"
        require(app.parent == debug and self.target.name == "target"
                and (debug / ".cargo-lock").is_file(), "actual Tauri Cargo resource directory required")
        identities = {name: regular_elf(path) for name, path in
                      (("application", app), ("nativeHost", host), ("testBinary", tests))}
        # Cargo may hardlink its normal binary to deps/. Admission is tested on
        # a byte-identical regular single-link copy, with every product check intact.
        staged = debug / "luckyray-app-integration"
        with app.open("rb") as old, staged.open("xb") as new:
            shutil.copyfileobj(old, new)
        staged.chmod(0o755)
        require(staged.stat().st_nlink == 1 and digest(staged) == identities["application"]["sha256"],
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
        write_json(self.private / "layout.json", {"application": str(staged), "nativeHost": str(host),
                   "testBinary": str(tests), "resourceRoot": str(debug)})
        write_json(self.evidence / "build.json", {"status": "PASS", "source": source, **identities,
                   "adapterFingerprint": expected, "kind": "DIAGNOSTIC_NOT_RELEASE_IDENTITY"})

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
        write_json(self.evidence / "resources.json", {"status": "PASS", "source": source,
                   "runtime": authority["runtimePackage"], "node": authority["nodeRuntime"],
                   "closure": actual, "compiledRecords": pins, "hostFiles": host_files,
                   "inputDescriptorSha256": digest(self.work / "inputs/inputs.json"),
                   "assemblyNetwork": fences,
                   "archives": {name: {"bytes": path.stat().st_size, "sha256": digest(path)}
                                for name, path in archives.items()},
                   "resourceDirectory": "ACTUAL_TAURI_CARGO_OUTPUT",
                   "distributionReadiness": "NOT_VERIFIED"})

    def units(self):
        source = self.source()
        binary = read_json(self.private / "layout.json")["testBinary"]
        env = self.env()
        listing = subprocess.check_output([binary, "--list"], env=env, text=True)
        names = {line[:-6] for line in listing.splitlines() if line.endswith(": test")}
        require(RECOVERY_TEST in names and VALIDATOR_TEST in names, "required named test missing")
        report = {"status": "FAIL", "source": source, "groups": [],
                  "newRecoveryRegression": {"rustTestCount": 1, "parameterCombinations": 4}}
        try:
            selections = [(prefix, counts, []) for prefix, counts in GROUPS.items()]
            selections.append((VALIDATOR_TEST, (1, 0), ["--ignored", "--exact"]))
            for index, (selection, expected, flags) in enumerate(selections):
                report["currentSelection"] = selection
                selected = sorted(name for name in names if name == selection or name.startswith(selection))
                require(len(selected) == sum(expected), "selected test count changed")
                result = subprocess.run([binary, selection, *flags, "--test-threads=1"], env={
                    **env, "LUCKYRAY_DESKTOP_FILE_VALIDATE": "/usr/bin/desktop-file-validate"},
                    text=True, capture_output=True, timeout=120)
                log = self.private / ("unit-" + str(index) + ".log")
                log.write_text(result.stdout + result.stderr)
                print(result.stdout, flush=True)
                match = re.search(r"test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;", result.stdout)
                require(result.returncode == 0 and match is not None, "directed tests failed")
                actual = tuple(map(int, (match[1], match[3])))
                require(actual == expected and int(match[2]) == 0, "directed result count mismatch")
                report["groups"].append({"selection": selection, "passed": actual[0], "ignored": actual[1],
                                         "failed": 0, "names": selected, "logSha256": digest(log)})
            report["status"] = "PASS"
        except Exception as error:
            report["error"] = str(error)
            raise
        finally:
            write_json(self.evidence / "units.json", report)

    def smoke(self):
        source = self.source()
        flow = self.args.flow
        build = read_json(self.evidence / "build.json")
        layout = read_json(self.private / "layout.json")
        script = self.app / "tests" / ("linux-native-registration-smoke.py"
                 if flow == "native-host" else "linux-desktop-smoke.py")
        output = self.private / flow
        command = ["/usr/bin/python3", str(script), "--application",
                   layout["nativeHost" if flow == "native-host" else "application"], "--output", str(output)]
        if flow != "native-host":
            require(read_json(self.evidence / "resources.json")["status"] == "PASS", "actual resources required")
            regular_elf(self.args.driver)
            command += ["--driver", str(self.args.driver)]
            command += (["--user-integration"] if flow == "autostart" else
                        ["--lsh", "--lsh-resource-root", layout["resourceRoot"]])
            command = ["dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1440x900x24", *command]
        report = {"status": "FAIL", "source": source, "scope": flow, "rawReport": None}
        if flow != "native-host":
            report["driver"] = {"versionPin": "2.1.0", **regular_elf(self.args.driver)}
        try:
            result = subprocess.run(command, env=self.env(), text=True, capture_output=True, timeout=780)
            (self.private / (flow + ".log")).write_text(result.stdout + result.stderr)
            report["diagnosticTail"] = (result.stdout + result.stderr)[-16000:]
            if (output / "report.json").is_file():
                report["rawReport"] = read_json(output / "report.json")
                report["rawReportSha256"] = digest(output / "report.json")
            require(result.returncode == 0, "focused smoke command failed; no retry")
            validate_smoke(flow, report["rawReport"] or {}, build, source, digest(script))
            report["status"] = "PASS"
        except Exception as error:
            report["error"] = str(error)
            raise
        finally:
            write_json(self.evidence / (flow + ".json"), report)

    def finish(self):
        outcomes = {name: os.environ.get("CI_" + name, "missing") for name in (
            "CHECKOUT", "INIT", "DEPENDENCIES", "RUST", "NODE", "FRONTEND", "BUILD",
            "DRIVER", "RUNTIME", "RESOURCES", "UNITS", "NATIVE_HOST", "AUTOSTART", "LSH")}
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
        if any(body.get("source") != source for body in bodies.values()):
            passed = False
        export_safe = (set(path.name for path in self.evidence.iterdir()).issubset(EXPORTS)
                       and all(path.is_file() and not path.is_symlink() for path in self.evidence.iterdir()))
        passed = passed and export_safe
        result = {"status": "PASS" if passed else "FAIL", "source": source, "stepOutcomes": outcomes,
                  "reports": reports, "artifactAllowlist": list(EXPORTS),
                  "exportPolicy": "PASS" if export_safe else "FAIL",
                  "limits": ["diagnostic ELF, not a package or release identity",
                             "no real browser connection or account authorization",
                             "no clean-exit status, hardware/Wayland or full editor acceptance"]}
        write_json(self.evidence / "result.json", result)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write("## Linux runtime and user-integration diagnostics\n\n")
                stream.write("- Source: " + str(source.get("commit")) + "\n")
                for name, outcome in reports.items():
                    stream.write("- " + name + ": " + outcome + "\n")
                stream.write("- One recovery regression covers four parameter combinations.\n")
                stream.write("- Package, release identity, real browser/account and hardware: NOT_VERIFIED.\n")
        require(passed, "required new coverage failed or did not run")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("init", "binaries", "resources", "units", "smoke", "finish"))
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--flow", choices=("native-host", "autostart", "lsh"))
    parser.add_argument("--driver", type=Path)
    args = parser.parse_args()
    run = Run(args)
    getattr(run, args.phase)()


if __name__ == "__main__":
    main()
