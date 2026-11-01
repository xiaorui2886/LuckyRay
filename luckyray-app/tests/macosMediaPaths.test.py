import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

app = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("synthetic_media_runner", app / "third_party/media-engine/runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class MediaToolPaths(unittest.TestCase):
    def test_platform_paths_and_no_fallback(self):
        checks = Path(os.environ.get("LUCKYRAY_MACOS_TEST_TMP", app.parent.parent / "checks")).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="macos-media-path-", dir=checks) as temp:
            root = Path(temp).resolve(strict=True)
            self.assertEqual(root.parent, checks)
            for name in ("ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe"):
                (root / name).write_bytes(b"synthetic path fixture, never executed")
            with patch.object(runner.sys, "platform", "darwin"):
                self.assertEqual(runner.required_media_tool(root, "ffmpeg"), root / "ffmpeg")
                self.assertEqual(runner.required_media_tool(root, "ffprobe"), root / "ffprobe")
                (root / "ffmpeg").unlink()
                with self.assertRaises(FileNotFoundError):
                    runner.required_media_tool(root, "ffmpeg")
            with patch.object(runner.sys, "platform", "win32"):
                self.assertEqual(runner.required_media_tool(root, "ffmpeg"), root / "ffmpeg.exe")
                self.assertEqual(runner.required_media_tool(root, "ffprobe"), root / "ffprobe.exe")
                with self.assertRaises(ValueError):
                    runner.required_media_tool(root, "other")


if __name__ == "__main__":
    unittest.main()
