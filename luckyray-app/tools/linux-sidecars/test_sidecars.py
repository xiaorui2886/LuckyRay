#!/usr/bin/env python3
"""Offline tests for sidecars.py (synthetic ELF stubs only, no cargo, no network)."""
import json, os, re, shutil, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sidecars  # noqa: E402

APP = Path(__file__).resolve().parents[2]
SRC = APP / "src-tauri"
ELF = b"\x7fELF\x02\x01\x01" + b"\0" * 11 + b"\x3e\x00" + b"\0" * 44


class Sidecars(unittest.TestCase):
    def setUp(self):
        os.environ.pop("LUCKYRAY_EXTENSION_ORIGINS", None)
        self.tmp = Path(tempfile.mkdtemp())
        self.bin = self.tmp / "binaries"
        self.bin.mkdir()
        for n in sidecars.SIDECARS:
            p = self.bin / sidecars.name_for(n)
            p.write_bytes(ELF + n.encode())
            os.chmod(p, 0o755)
        self.identity = lambda _cli: sidecars.cli_contract_identity(SRC)

    def tearDown(self):
        shutil.rmtree(self.tmp)
        os.environ.pop("LUCKYRAY_EXTENSION_ORIGINS", None)

    def attest(self):
        return sidecars.attest(SRC, self.bin, identity_of=self.identity, head="0" * 40)

    def test_attest_writes_records_build_rs_accepts_and_verify_agrees(self):
        shas = self.attest()
        cli = json.loads((self.bin / "luckyray-cli-x86_64-unknown-linux-gnu.identity.json").read_text())
        self.assertEqual(tuple(cli), sidecars.CLI_FIELDS)
        self.assertEqual((cli["protocol"], cli["profile"], cli["hardening"], cli["target"]),
                         ("luckyray-cli-contract-v1", "release", "release-path-remap-v1", "x86_64-unknown-linux-gnu"))
        rec = json.loads((self.bin / sidecars.ORIGIN_RECORD).read_text())
        self.assertEqual(tuple(rec), sidecars.ORIGIN_FIELDS)
        self.assertEqual([b["name"] for b in rec["binaries"]], sorted(sidecars.SIDECARS))
        self.assertEqual(sidecars.verify(SRC, self.bin), shas)

    def test_linux_names_carry_no_exe_suffix(self):
        self.assertEqual(sidecars.name_for("luckyray-cli"), "luckyray-cli-x86_64-unknown-linux-gnu")

    def test_one_byte_change_to_any_sidecar_is_refused(self):
        self.attest()
        for n in sidecars.SIDECARS:
            p = self.bin / sidecars.name_for(n)
            original = p.read_bytes()
            p.write_bytes(original + b"x")
            with self.assertRaises(sidecars.Refused):
                sidecars.verify(SRC, self.bin)
            p.write_bytes(original)
        sidecars.verify(SRC, self.bin)

    def test_non_elf_or_non_executable_sidecar_is_refused(self):
        p = self.bin / sidecars.name_for("luckyray-mcp")
        p.write_bytes(b"MZ" + b"\0" * 62)
        with self.assertRaises(sidecars.Refused):
            self.attest()
        p.write_bytes(ELF)
        os.chmod(p, 0o644)
        with self.assertRaises(sidecars.Refused):
            self.attest()

    def test_aarch64_elf_is_refused(self):
        p = self.bin / sidecars.name_for("luckyray-mcp")
        p.write_bytes(ELF[:18] + b"\xb7\x00" + ELF[20:])
        with self.assertRaises(sidecars.Refused):
            self.attest()

    def test_cli_carrying_the_build_root_path_is_refused(self):
        p = self.bin / sidecars.name_for("luckyray-cli")
        p.write_bytes(ELF + str(APP.resolve()).encode())
        with self.assertRaises(sidecars.Refused):
            self.attest()

    def test_cli_with_a_stale_contract_identity_is_refused(self):
        with self.assertRaises(sidecars.Refused):
            sidecars.attest(SRC, self.bin, identity_of=lambda _c: "f" * 64, head="0" * 40)

    def test_origin_override_is_refused(self):
        os.environ["LUCKYRAY_EXTENSION_ORIGINS"] = "chrome-extension://" + "a" * 32
        with self.assertRaises(sidecars.Refused):
            self.attest()
        with self.assertRaises(sidecars.Refused):
            sidecars.build_env(APP)

    def test_extra_file_or_added_record_field_is_refused(self):
        self.attest()
        (self.bin / "stray").write_bytes(b"x")
        with self.assertRaises(sidecars.Refused):
            sidecars.verify(SRC, self.bin)
        (self.bin / "stray").unlink()
        rec = json.loads((self.bin / sidecars.ORIGIN_RECORD).read_text())
        rec["extra"] = 1
        (self.bin / sidecars.ORIGIN_RECORD).write_text(json.dumps(rec))
        with self.assertRaises(sidecars.Refused):
            sidecars.verify(SRC, self.bin)

    def test_origins_match_the_committed_canonical_config(self):
        o = sidecars.release_origins(APP)
        cfg = json.loads((APP / "config/release-extension-origins.json").read_text())
        self.assertEqual(o["origins"], cfg["origins"])
        self.assertEqual(o["manifestPublicKeySha256"], cfg["publicKeySha256"])

    def test_tampered_origin_config_is_refused(self):
        app = self.tmp / "app"
        (app / "config").mkdir(parents=True)
        (app / "browser-extension-prototype").mkdir()
        shutil.copy(APP / "browser-extension-prototype/manifest.json", app / "browser-extension-prototype")
        cfg = json.loads((APP / "config/release-extension-origins.json").read_text())
        cfg["origins"] = ["chrome-extension://" + "a" * 32]
        (app / "config/release-extension-origins.json").write_text(json.dumps(cfg))
        with self.assertRaises(sidecars.Refused):
            sidecars.release_origins(app)

    def test_digest_inputs_mirror_build_rs(self):
        rs = (SRC / "build.rs").read_text()
        body = rs[rs.index("fn cli_contract_identity"):rs.index("fn validate_registered_cli_contract")]
        self.assertIn('b"luckyray-cli-contract-v1\\0"', body)
        self.assertEqual(tuple(re.findall(r'^\s+"([^"]+)",$', body, re.M)), sidecars.CLI_INPUTS)
        self.assertIn(f'const CLI_RELEASE_HARDENING: &str = "{sidecars.HARDENING}";', rs)
        for n in sidecars.SIDECARS:
            self.assertIn(f'    "{n}",\n', rs)

    def test_build_env_hardens_and_only_this_compilation_skips_the_preflight(self):
        env = sidecars.build_env(APP, {"HOME": "/home/someone"})
        flags = env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")
        self.assertEqual(flags[:2], ["-C", "strip=symbols"])
        self.assertEqual(flags[-1], f"--remap-path-prefix={APP.resolve()}=.")
        self.assertIn("--remap-path-prefix=/home/someone=.", flags)
        self.assertIn("-DNDEBUG", env["CFLAGS"])
        self.assertEqual(env["LUCKYRAY_SIDECAR_PREPARE"], "1")
        self.assertNotIn("--no-sandbox", " ".join(sidecars.cargo_args()))
        self.assertEqual(sidecars.cargo_args()[:8], ["cargo", "build", "--locked", "--release", "--features",
                                                     "sidecar-binaries", "--target", "x86_64-unknown-linux-gnu"])

    def test_build_refuses_without_the_prepared_media_engine(self):
        fake = self.tmp / "src-tauri"
        fake.mkdir()
        with self.assertRaises(sidecars.Refused):
            sidecars.build(fake, self.bin)


if __name__ == "__main__":
    unittest.main()
