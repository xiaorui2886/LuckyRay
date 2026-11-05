#!/usr/bin/env python3
"""Offline tests for engine.py (synthetic files only, no network)."""
import hashlib, json, os, shutil, subprocess, sys, tempfile, unittest, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402

ELF_STUB = b"\x7fELF" + b"\0" * 60


def build_synthetic(root):
    """A runtime with the production layout, stub ELF files and a real manifest."""
    sources, shared = engine.load_sources()
    files = {
        "runner.py": engine.RUNNER.read_bytes(),
        engine.PYTHON: ELF_STUB, engine.LIBPYTHON: ELF_STUB, engine.DENO: ELF_STUB,
        engine.FFMPEG: ELF_STUB, engine.FFPROBE: ELF_STUB,
        engine.STDLIB_ZIP: b"PK\5\6" + b"\0" * 18, engine.LANDMARK: b"# landmark\n",
        engine.DYNLOAD + "/_crypt.cpython-311-x86_64-linux-gnu.so": b"so",
        "wheels/" + shared["ytDlp"]["fileName"]: b"wheel",
        "wheels/" + shared["ytDlpEjs"]["fileName"]: b"ejs",
        "licenses/cpython/LICENSE.cpython.txt": b"PSF",
        "licenses/linux-lgpl-media/SOURCE-OFFER.txt": b"offer",
    }
    for lic in shared["licenseFiles"]:
        files["licenses/" + lic["fileName"]] = b"licence"
    for rel, data in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        os.chmod(p, 0o755 if rel in engine.EXECUTABLES else 0o644)
    write_manifest(root)


def write_manifest(root, **override):
    sources, shared = engine.load_sources()
    m = {
        "schemaVersion": 1, "sourceManifestSha256": engine.sha256(engine.SOURCES),
        "pythonVersion": "3.11.8", "python": engine.PYTHON, "ytDlpVersion": shared["ytDlp"]["version"],
        "ytDlpWheel": "wheels/" + shared["ytDlp"]["fileName"],
        "ytDlpEjsWheel": "wheels/" + shared["ytDlpEjs"]["fileName"],
        "deno": engine.DENO, "ffmpeg": engine.FFMPEG,
        "files": [{"path": r, "size": os.path.getsize(root / r), "sha256": engine.sha256(root / r)}
                  for r in engine.walk(root)],
    }
    m.update(override)
    (root / engine.MANIFEST).write_text(json.dumps(m))
    os.chmod(root / engine.MANIFEST, 0o644)


class Engine(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "media-engine"
        build_synthetic(self.root)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def refused(self):
        with self.assertRaises(SystemExit) as caught:
            engine.verify(self.root)
        self.assertTrue(str(caught.exception.code).startswith("linux-media-engine:"))

    def test_synthetic_runtime_verifies_and_pins(self):
        engine.verify(self.root)
        self.assertRegex(engine.sha256(self.root / engine.MANIFEST), "^[0-9a-f]{64}$")

    def test_changed_byte_is_refused(self):
        with open(self.root / engine.DENO, "ab") as f:
            f.write(b"x")
        self.refused()

    def test_undeclared_file_is_refused(self):
        (self.root / "wheels/extra.whl").write_bytes(b"x")
        os.chmod(self.root / "wheels/extra.whl", 0o644)
        self.refused()

    def test_symlink_is_refused_even_when_declared(self):
        os.unlink(self.root / engine.FFPROBE)
        os.symlink("ffmpeg", self.root / engine.FFPROBE)
        write_manifest(self.root)
        self.refused()

    def test_group_writable_or_wrong_mode_is_refused(self):
        os.chmod(self.root / engine.PYTHON, 0o775)
        self.refused()
        os.chmod(self.root / engine.PYTHON, 0o644)
        self.refused()

    def test_non_elf_executable_is_refused(self):
        (self.root / engine.FFMPEG).write_bytes(b"#!/bin/sh\n")
        write_manifest(self.root)
        self.refused()

    def test_other_runner_is_refused(self):
        os.chmod(self.root / "runner.py", 0o644)
        (self.root / "runner.py").write_bytes(b"print('other')\n")
        write_manifest(self.root)
        self.refused()

    def test_unknown_manifest_field_and_wrong_pins_are_refused(self):
        write_manifest(self.root, extra=1)
        self.refused()
        write_manifest(self.root, pythonVersion="3.12.0")
        self.refused()
        write_manifest(self.root, ffmpeg="ffmpeg/ffmpeg.exe")
        self.refused()

    def test_more_than_512_files_is_refused(self):
        for i in range(engine.MAX_FILES):
            p = self.root / f"licenses/pad/{i}.txt"
            p.parent.mkdir(exist_ok=True)
            p.write_bytes(b"x")
        write_manifest(self.root)
        self.refused()

    def test_hard_link_is_refused(self):
        os.unlink(self.root / engine.FFPROBE)
        os.link(self.root / engine.FFMPEG, self.root / engine.FFPROBE)
        write_manifest(self.root)
        self.refused()

    def test_stdlib_zip_drops_tests_tk_and_bytecode_and_is_deterministic(self):
        lib = self.tmp / "stdlib"
        for rel in ("os.py", "json/__init__.py", "test/test_x.py", "tkinter/__init__.py",
                    "idlelib/a.py", "__pycache__/os.cpython-311.pyc", "json/__pycache__/x.pyc",
                    "site-packages/p.py", "lib-dynload/x.so"):
            (lib / rel).parent.mkdir(parents=True, exist_ok=True)
            (lib / rel).write_text("x = 1\n")
        a, b = self.tmp / "a.zip", self.tmp / "b.zip"
        engine.write_stdlib_zip(lib, a)
        engine.write_stdlib_zip(lib, b)
        self.assertEqual(a.read_bytes(), b.read_bytes())
        self.assertEqual(zipfile.ZipFile(a).namelist(), ["json/__init__.py", "os.py"])

    def test_unsafe_archive_member_names(self):
        for bad in ("/etc/passwd", "python/../x", "python//x", "./python"):
            self.assertFalse(engine.safe_member(bad), bad)
        self.assertTrue(engine.safe_member("python/bin/python3.11"))


class Pins(unittest.TestCase):
    def test_sources_bind_the_shared_windows_manifest(self):
        sources, shared = engine.load_sources()
        self.assertEqual(sources["python"]["version"], shared["python"]["version"])
        self.assertEqual(shared["ytDlp"]["version"], "2026.7.4")
        for key in ("python", "pythonLicenses", "deno"):
            entry = sources[key]
            self.assertRegex(entry["sha256"], "^[0-9a-f]{64}$")
            self.assertTrue(entry["url"].startswith("https://github.com/"), key)
            self.assertGreater(entry["size"], 0)

    def test_layout_matches_the_rust_resolver_and_t51_bundle(self):
        rust = (engine.APP / "src-tauri/src/media_transfer.rs").read_text()
        self.assertIn('option_env!("LUCKYRAY_MEDIA_ENGINE_MANIFEST_SHA256")', rust)
        self.assertIn("runtime-manifest.json", rust)
        bundle = (engine.BUNDLE_PY).read_text()
        self.assertIn('FFMPEG = "media-engine/' + engine.FFMPEG + '"', bundle)
        self.assertIn('FFPROBE = "media-engine/' + engine.FFPROBE + '"', bundle)
        self.assertEqual(engine.sha256(engine.WINDOWS_RUNNER), engine.WINDOWS_RUNNER_SHA256)
        self.assertEqual(
            engine.RUNNER.read_bytes(),
            engine.linux_runner_bytes(engine.WINDOWS_RUNNER.read_bytes()),
        )
        self.assertIn('(ffmpeg_dir / "ffmpeg")', engine.RUNNER.read_text())
        self.assertNotIn('"ffmpeg.exe"', engine.RUNNER.read_text())

    def test_linux_runner_is_windows_runner_with_only_ffmpeg_name_changes(self):
        engine.assert_runners_in_sync()
        win = engine.WINDOWS_RUNNER.read_text().splitlines()
        linux = engine.RUNNER.read_text().splitlines()
        diffs = [(a, b) for a, b in zip(win, linux) if a != b]
        self.assertEqual(len(win), len(linux))
        self.assertEqual(
            diffs,
            [
                ('    ffmpeg = (ffmpeg_dir / "ffmpeg.exe").resolve(strict=True)',
                 '    ffmpeg = (ffmpeg_dir / "ffmpeg").resolve(strict=True)'),
                ('        ffprobe = (ffmpeg_dir / "ffprobe.exe").resolve(strict=True)',
                 '        ffprobe = (ffmpeg_dir / "ffprobe").resolve(strict=True)'),
            ],
        )

    def test_cli_rejects_unknown_commands(self):
        r = subprocess.run([sys.executable, str(engine.HERE / "engine.py"), "sign", "x"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
