#!/usr/bin/env python3
"""Pins stdout is eval'd by CI: it must be only KEY=VALUE assignments."""
import contextlib, io, json, os, subprocess, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle


class PinsOutput(unittest.TestCase):
    def test_pins_stdout_is_only_assignments_and_status_is_stderr(self):
        with tempfile.TemporaryDirectory() as root:
            m = {"files": [{"path": bundle.LIBMPV, "sha256": "a" * 64, "size": 42}]}
            json.dump(m, open(os.path.join(root, bundle.MANIFEST), "w"))
            bundle.verify = lambda r: (print("bundle ok: 1 files", file=sys.stderr), m)[1]
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                bundle.pins(root)
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        for line in lines:
            self.assertRegex(line, bundle.PIN_LINE)
        self.assertIn("bundle ok", err.getvalue())
        script = "set -euo pipefail\neval \"$PINS\"\necho \"$LUCKYRAY_LINUX_LIBMPV_SIZE\""
        run = subprocess.run(["bash", "-c", script], env={"PINS": out.getvalue(), "PATH": os.environ["PATH"]},
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), "42")

    def test_unsafe_value_is_refused(self):
        m = {"files": [{"path": bundle.LIBMPV, "sha256": "x; rm -rf /", "size": 1}]}
        with self.assertRaises(SystemExit):
            bundle.pin_lines(m, "b" * 64)


if __name__ == "__main__":
    unittest.main()
