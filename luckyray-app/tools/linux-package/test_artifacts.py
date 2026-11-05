#!/usr/bin/env python3
"""Offline tests for artifacts.py on synthetic staged and packaged trees (no tauri, no network)."""
import os, shutil, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import artifacts as a  # noqa: E402

APP = Path(__file__).resolve().parents[2]


class Artifacts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.app = self.tmp / "app"
        src = self.src = self.app / "src-tauri"
        for rel in ("dsh/node/node", "dsh-host/h.mjs", "agent-browser/s/shell", "media-engine/runtime-manifest.json",
                    "linux/apparmor/luckyray-agent-browser"):
            self.write(src / rel, rel.encode(), rel.endswith(("node", "shell")))
        self.write(self.app / "third-party-notices/README.md", b"n")
        for r in a.RECORDS:
            self.write(self.app / "dsh-host/linux-x64" / r, r.encode())
        for s in a.SIDECARS:
            self.write(src / "binaries" / f"{s}-{a.TARGET}", s.encode(), True)
        shutil.copy(APP / "src-tauri/tauri.conf.json", src / "tauri.conf.json")
        self.ver = a.version(src)
        self.bundle = self.tmp / "bundle"
        self.write(self.bundle / f"deb/LuckyRay_{self.ver}_amd64.deb", b"d")
        self.write(self.bundle / f"appimage/LuckyRay_{self.ver}_amd64.AppImage", b"a")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def write(self, path, data, exe=False):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        os.chmod(path, 0o755 if exe else 0o644)

    def package(self, into, deb=True):
        into = Path(into)
        res = into / "usr/lib/LuckyRay"
        maps = {"dsh": "lr-lsh/199-1/deepseek-harness", "dsh-host": "lr-lsh/199-1/dsh-host",
                "agent-browser": "agent-browser", "media-engine": "media-engine"}
        for s, t in maps.items():
            shutil.copytree(self.src / s, res / t)
        shutil.copytree(self.app / "third-party-notices", res / "third-party-notices")
        shutil.copytree(self.app / "dsh-host/linux-x64", res / "licenses/lsh-linux")
        for s in a.SIDECARS:
            self.write(into / "usr/bin" / s, s.encode(), True)
        self.write(into / "usr/bin/luckyray-app", b"main", True)
        if deb:
            self.write(into / a.APPARMOR, b"linux/apparmor/luckyray-agent-browser")
        return into

    def run_verify(self, mutate=None):
        def deb(_p, into):
            root = self.package(into)
            if mutate:
                mutate(root)
            return root
        return a.verify(self.bundle, self.src, (deb, lambda _p, into: self.package(into, deb=False)))

    def test_exact_packages_pass_and_names_are_exact(self):
        s = self.run_verify()
        self.assertEqual(s["deb"], f"LuckyRay_{self.ver}_amd64.deb")
        self.assertEqual(s["appimage"], f"LuckyRay_{self.ver}_amd64.AppImage")
        self.assertEqual(s["debContents"]["sidecars"], 4)
        self.assertEqual(s["appimageContents"]["licenses/lsh-linux"], 4)

    def test_missing_or_misnamed_package_is_refused(self):
        os.rename(self.bundle / f"deb/LuckyRay_{self.ver}_amd64.deb", self.bundle / "deb/luckyray.deb")
        with self.assertRaisesRegex(a.Refused, "deb/LuckyRay_.*_amd64.deb: missing"):
            self.run_verify()

    def test_changed_missing_extra_or_linked_contents_are_refused(self):
        lsh = "usr/lib/LuckyRay/lr-lsh/199-1/deepseek-harness"
        cases = [
            (lambda r: (r / lsh / "node/node").write_bytes(b"x"), "bytes differ"),
            (lambda r: os.chmod(r / lsh / "node/node", 0o644), "not executable"),
            (lambda r: (r / "usr/lib/LuckyRay/agent-browser/extra").write_bytes(b"x"), "file set differs"),
            (lambda r: os.remove(r / "usr/lib/LuckyRay/licenses/lsh-linux/THIRD-PARTY-NOTICES.txt"), "missing"),
            (lambda r: (r / "usr/bin/luckyray-mcp").write_bytes(b"x"), "usr/bin/luckyray-mcp: bytes differ"),
            (lambda r: os.remove(r / "usr/bin/luckyray-app"), "luckyray-app: missing"),
            (lambda r: os.remove(r / a.APPARMOR), "apparmor"),
            (lambda r: os.symlink("README.md", r / "usr/lib/LuckyRay/third-party-notices/link"), "not a plain file"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(a.Refused, message):
                    self.run_verify(mutate)

    def test_cli_usage(self):
        self.assertEqual(a.main(["artifacts.py"]), 2)


if __name__ == "__main__":
    unittest.main()
