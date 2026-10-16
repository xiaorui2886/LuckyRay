"""LuckyRay's bounded yt-dlp entry point.

The parent passes the target through stdin and app-owned paths through a
sanitized environment. This module intentionally emits no stdout/stderr and
atomically publishes only one verified media file to the parent staging path.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_REQUEST_BYTES = 16 * 1024
MAX_PROBE_OUTPUT_BYTES = 64 * 1024
MAX_EXTRACTOR_JSON_BYTES = 2 * 1024 * 1024
STATUS_PREFIX = "luckyray-media-status-v1:"


class SafeDiagnosticSink:
    """Classify yt-dlp failures without retaining or publishing raw output."""

    def __init__(self) -> None:
        self.code = "resolver-failed"
        self.priority = 0

    @property
    def buffer(self) -> "SafeDiagnosticSink":
        return self

    @property
    def encoding(self) -> str:
        return "utf-8"

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def _set(self, code: str, priority: int) -> None:
        if priority > self.priority:
            self.code = code
            self.priority = priority

    def write(self, value: object) -> int:
        if isinstance(value, bytes):
            text = value[:8_192].decode("utf-8", errors="ignore").lower()
        else:
            text = str(value or "")[:8_192].lower()
        if "drm" in text or "digital rights management" in text:
            self._set("drm-protected", 50)
        elif any(marker in text for marker in (
            "not available in your country",
            "not available in your region",
            "geo-restricted",
            "geographic restriction",
        )):
            self._set("region-restricted", 45)
        elif any(marker in text for marker in (
            "sign in",
            "login required",
            "authentication required",
            "registered users",
            "members only",
            "premium members",
            "private video",
        )):
            self._set("authentication-required", 40)
        elif any(marker in text for marker in (
            "http error 403",
            "http error 412",
            "http error 429",
            "confirm you're not a bot",
            "confirm you’re not a bot",
            "request is blocked",
        )):
            self._set("site-blocked", 35)
        elif any(marker in text for marker in (
            "no video formats",
            "no downloadable formats",
            "requested format is not available",
            "only images are available",
            "video unavailable",
        )):
            self._set("no-formats", 30)
        return len(value) if isinstance(value, bytes) else len(str(value or ""))

    def flush(self) -> None:
        return None


class BoundedTextSink:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.parts: list[str] = []
        self.size = 0

    @property
    def buffer(self) -> "BoundedTextSink":
        return self

    @property
    def encoding(self) -> str:
        return "utf-8"

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def write(self, value: object) -> int:
        text = value.decode("utf-8", errors="strict") if isinstance(value, bytes) else str(value or "")
        size = len(text.encode("utf-8"))
        if self.size + size > self.limit:
            fail()
        self.parts.append(text)
        self.size += size
        return len(value) if isinstance(value, bytes) else len(text)

    def flush(self) -> None:
        return None

    def text(self) -> str:
        return "".join(self.parts)


def emit_status(stream: object, code: str) -> None:
    if code not in {
        "authentication-required",
        "site-blocked",
        "region-restricted",
        "drm-protected",
        "no-formats",
    }:
        return
    try:
        stream.write(f"{STATUS_PREFIX}{code}\n")
        stream.flush()
    except Exception:
        pass


def fail() -> "NoReturn":
    raise SystemExit(70)


def required_path(name: str, *, file: bool = False, directory: bool = False) -> Path:
    raw = os.environ.get(name, "")
    if not raw or "\x00" in raw:
        fail()
    path = Path(raw).resolve(strict=False)
    if file and not path.is_file():
        fail()
    if directory and not path.is_dir():
        fail()
    return path


def allowed_track_hosts(referer: str) -> tuple[str, ...]:
    source = (urlsplit(referer).hostname or "").lower().rstrip(".")
    if source == "youtube.com" or source.endswith(".youtube.com") or source == "youtu.be":
        return ("googlevideo.com",)
    if source == "bilibili.com" or source.endswith(".bilibili.com") or source == "b23.tv":
        return ("bilivideo.com", "bilivideo.cn", "hdslb.com")
    if source == "x.com" or source.endswith(".x.com") or source == "twitter.com" or source.endswith(".twitter.com"):
        return ("twimg.com",)
    if source == "pinterest.com" or source.endswith(".pinterest.com"):
        return ("pinimg.com",)
    return ()


def validate_track_url(value: object, suffixes: tuple[str, ...], allow_loopback: bool = False) -> str:
    if not isinstance(value, str) or not 1 <= len(value.encode("utf-8")) <= 4096:
        fail()
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        fail()
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    loopback = allow_loopback and host in {"127.0.0.1", "::1"} and parsed.scheme == "http"
    allowed = any(host == suffix or host.endswith(f".{suffix}") for suffix in suffixes)
    if (parsed.scheme != "https" and not loopback) or parsed.username is not None or parsed.password is not None or not (allowed or loopback):
        fail()
    return value


class BoundedRedirectHandler(HTTPRedirectHandler):
    def __init__(self, suffixes: tuple[str, ...], allow_loopback: bool) -> None:
        super().__init__()
        self.suffixes = suffixes
        self.allow_loopback = allow_loopback
        self.redirects = 0

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        self.redirects += 1
        if self.redirects > 5:
            fail()
        validate_track_url(new_url, self.suffixes, self.allow_loopback)
        return super().redirect_request(request, file_pointer, code, message, headers, new_url)


def download_track(
    url: str,
    output: Path,
    suffixes: tuple[str, ...],
    allow_loopback: bool,
    user_agent: str,
    referer: str,
    deadline_at: float,
    remaining_bytes: int,
) -> int:
    validate_track_url(url, suffixes, allow_loopback)
    timeout = max(1.0, min(30.0, deadline_at - time.monotonic()))
    opener = build_opener(ProxyHandler({}), BoundedRedirectHandler(suffixes, allow_loopback))
    request = Request(url, headers={
        "Accept": "video/*,audio/*,application/octet-stream",
        "Accept-Encoding": "identity",
        "User-Agent": user_agent,
        "Referer": referer,
    })
    total = 0
    try:
        with opener.open(request, timeout=timeout) as response, output.open("xb") as stream:
            validate_track_url(response.geturl(), suffixes, allow_loopback)
            length = response.headers.get("Content-Length")
            if length and (not length.isdigit() or int(length) > remaining_bytes):
                fail()
            while True:
                if time.monotonic() >= deadline_at:
                    fail()
                chunk = response.read(min(64 * 1024, remaining_bytes - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > remaining_bytes:
                    fail()
                stream.write(chunk)
    except (HTTPError, URLError, OSError, TimeoutError):
        fail()
    if total <= 0:
        fail()
    return total


def merge_track_pair(
    video_url: str,
    audio_url: str,
    output: Path,
    work: Path,
    ffmpeg_dir: Path,
    user_agent: str,
    referer: str,
    max_bytes: int,
    deadline: int,
) -> None:
    allow_loopback = os.environ.get("LUCKYRAY_MEDIA_ALLOW_LOOPBACK_TEST") == "1"
    suffixes = allowed_track_hosts(referer)
    if not suffixes and not allow_loopback:
        fail()
    video_url = validate_track_url(video_url, suffixes, allow_loopback)
    audio_url = validate_track_url(audio_url, suffixes, allow_loopback)
    if video_url == audio_url:
        fail()
    deadline_at = time.monotonic() + deadline
    video_path = work / "video.track"
    audio_path = work / "audio.track"
    merged_path = work / "merged.mp4"
    used = download_track(
        video_url, video_path, suffixes, allow_loopback, user_agent, referer, deadline_at, max_bytes,
    )
    download_track(
        audio_url, audio_path, suffixes, allow_loopback, user_agent, referer, deadline_at, max_bytes - used,
    )
    ffmpeg = (ffmpeg_dir / "ffmpeg.exe").resolve(strict=True)
    remaining = max(1.0, deadline_at - time.monotonic())
    try:
        result = subprocess.run([
            str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(video_path), "-i", str(audio_path),
            "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart",
            "-fs", str(max_bytes), str(merged_path),
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=remaining, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail()
    if result.returncode != 0 or not merged_path.is_file() or merged_path.stat().st_size <= 0 or merged_path.stat().st_size > max_bytes:
        fail()
    os.replace(merged_path, output)


def safe_number(value: object, maximum: int) -> int:
    try:
        number = int(float(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0
    return number if 0 < number <= maximum else 0


def _positive_duration(value: object) -> float | None:
    try:
        duration = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(duration) or duration <= 0 or duration > 7 * 24 * 60 * 60:
        return None
    return duration


def validate_muxed_candidate(path: Path, ffmpeg_dir: Path, expect_audio: bool = False) -> bool:
    """Reject resolver output whose audio and video timelines do not match.

    Some sites expose short preview video formats beside full-length audio. A
    successful mux is therefore not proof of a complete media file. This check
    intentionally reads only bounded codec/duration metadata and emits nothing.
    """
    try:
        ffprobe = (ffmpeg_dir / "ffprobe.exe").resolve(strict=True)
        candidate = path.resolve(strict=True)
        result = subprocess.run([
            str(ffprobe), "-v", "error", "-show_entries",
            "stream=codec_type,duration:format=duration", "-of", "json", str(candidate),
        ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0 or len(result.stdout) > 256 * 1024:
        return False
    try:
        metadata = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(metadata, dict):
        return False
    streams = metadata.get("streams")
    if not isinstance(streams, list) or len(streams) > 128:
        return False
    video_durations: list[float] = []
    audio_durations: list[float] = []
    has_video = False
    has_audio = False
    for stream in streams:
        if not isinstance(stream, dict):
            return False
        kind = stream.get("codec_type")
        duration = _positive_duration(stream.get("duration"))
        if kind == "video":
            has_video = True
            if duration is not None:
                video_durations.append(duration)
        elif kind == "audio":
            has_audio = True
            if duration is not None:
                audio_durations.append(duration)
    if not has_video or (expect_audio and not has_audio):
        return False
    if has_audio:
        if not video_durations or not audio_durations:
            return False
        video_duration = max(video_durations)
        audio_duration = max(audio_durations)
        tolerance = max(3.0, max(video_duration, audio_duration) * 0.03)
        if abs(video_duration - audio_duration) > tolerance:
            return False
    return True


def project_format_catalog(info: object) -> list[dict[str, object]]:
    if not isinstance(info, dict):
        fail()
    projected: dict[tuple[int, str], dict[str, object]] = {}
    overall_duration = _positive_duration(info.get("duration"))
    for item in list(info.get("formats") or [])[:512]:
        if not isinstance(item, dict):
            continue
        format_id = str(item.get("format_id") or "")
        if not re.fullmatch(r"[A-Za-z0-9._+-]{1,128}", format_id):
            continue
        height = safe_number(item.get("height"), 16_384)
        width = safe_number(item.get("width"), 16_384)
        if not height:
            continue
        raw_vcodec = item.get("vcodec")
        if raw_vcodec == "none":
            continue
        item_duration = _positive_duration(item.get("duration"))
        if overall_duration is not None and item_duration is not None:
            tolerance = max(3.0, overall_duration * 0.03)
            if item_duration + tolerance < overall_duration:
                continue
        vcodec = str(raw_vcodec or "unknown")[:48]
        raw_acodec = item.get("acodec")
        acodec = str(raw_acodec or "unknown")[:48]
        ext = str(item.get("ext") or "").lower()
        if ext not in {"mp4", "webm", "mkv", "mov", "m4v"}:
            continue
        bitrate = safe_number(item.get("tbr"), 1_000_000) * 1_000
        fps = safe_number(item.get("fps"), 1_000)
        size = safe_number(item.get("filesize") or item.get("filesize_approx"), 2_147_483_648)
        has_audio = raw_acodec != "none"
        selector = format_id if has_audio else f"{format_id}+bestaudio/{format_id}"
        candidate = {
            "selector": selector,
            "label": f"{height}p · {ext.upper()} · {'含音频' if has_audio else '合并音频'}",
            "width": width,
            "height": height,
            "fps": fps,
            "extension": ext,
            "videoCodec": vcodec,
            "audioCodec": acodec if has_audio else "merge",
            "estimatedBytes": size,
            "bitrate": bitrate,
        }
        key = (height, ext)
        previous = projected.get(key)
        previous_score = int(previous.get("bitrate", 0)) + (1 if previous.get("audioCodec") != "merge" else 0) if previous else -1
        score = bitrate + (1 if has_audio else 0)
        if previous is None or score > previous_score:
            projected[key] = candidate
    values = list(projected.values())
    values.sort(key=lambda item: (int(item["height"]), int(item["bitrate"]), item["extension"] == "mp4"), reverse=True)
    return values[:16]


def probe_catalog(
    yt_dlp: object,
    url: str,
    deadline: int,
    deno: Path,
    cookie_file: Path | None,
    user_agent: str,
    referer: str,
    protocol_stdout: object,
    protocol_stderr: object,
) -> None:
    arguments = [
        "--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-update",
        "--no-playlist", "--skip-download", "--dump-single-json",
        "--socket-timeout", str(min(deadline, 30)), "--retries", "0",
        "--fragment-retries", "0", "--extractor-retries", "0", "--proxy", "",
        "--quiet", "--no-warnings", "--no-cache-dir", "--js-runtimes", f"deno:{deno}",
    ]
    if cookie_file is not None:
        arguments.extend(["--cookies", str(cookie_file)])
    if user_agent:
        arguments.extend(["--user-agent", user_agent, "--referer", referer])
    arguments.extend(["--", url])
    diagnostics = SafeDiagnosticSink()
    capture = BoundedTextSink(MAX_EXTRACTOR_JSON_BYTES)
    failed = False
    try:
        sys.stdout = capture
        sys.stderr = diagnostics
        yt_dlp.main(arguments)
    except SystemExit as result:
        failed = result.code not in (None, 0)
    except BaseException:
        failed = True
    finally:
        sys.stdout = protocol_stdout
        sys.stderr = protocol_stderr
    if failed:
        emit_status(protocol_stdout, diagnostics.code)
        fail()
    lines = [line for line in capture.text().splitlines() if line.strip()]
    if len(lines) != 1:
        fail()
    try:
        info = json.loads(lines[0])
    except Exception:
        fail()
    payload = json.dumps({"formats": project_format_catalog(info)}, ensure_ascii=True, separators=(",", ":"))
    if not payload or len(payload.encode("utf-8")) > MAX_PROBE_OUTPUT_BYTES:
        fail()
    protocol_stdout.write(payload)
    protocol_stdout.flush()


def download_with_ytdlp(
    yt_dlp: object,
    url: str,
    selector: str,
    attempt: Path,
    ffmpeg_dir: Path,
    deno: Path,
    cookie_file: Path | None,
    user_agent: str,
    referer: str,
    max_bytes: int,
    deadline: int,
) -> tuple[Path | None, str]:
    attempt.mkdir()
    template = str(attempt / "resolved.%(ext)s")
    arguments = [
        "--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-update",
        "--no-playlist", "--max-filesize", str(max_bytes),
        "--socket-timeout", str(min(deadline, 30)), "--retries", "0",
        "--fragment-retries", "0", "--extractor-retries", "0",
        "--file-access-retries", "0", "--concurrent-fragments", "1",
        "--proxy", "", "--quiet", "--no-warnings", "--no-progress",
        "--no-write-info-json", "--no-write-playlist-metafiles", "--no-write-subs",
        "--no-write-auto-subs", "--no-write-thumbnail", "--no-cache-dir",
        "--no-overwrites", "--no-continue", "--restrict-filenames",
        "--format", selector, "--merge-output-format", "mp4",
        "--ffmpeg-location", str(ffmpeg_dir), "--js-runtimes", f"deno:{deno}",
        "--output", template,
    ]
    if cookie_file is not None:
        arguments.extend(["--cookies", str(cookie_file)])
    if user_agent:
        arguments.extend(["--user-agent", user_agent, "--referer", referer])
    arguments.extend(["--", url])
    diagnostics = SafeDiagnosticSink()
    protocol_stdout = sys.stdout
    protocol_stderr = sys.stderr
    failed = False
    try:
        sys.stdout = diagnostics
        sys.stderr = diagnostics
        yt_dlp.main(arguments)
    except SystemExit as result:
        failed = result.code not in (None, 0)
    except BaseException:
        failed = True
    finally:
        sys.stdout = protocol_stdout
        sys.stderr = protocol_stderr
    if failed:
        return None, diagnostics.code
    candidates = [
        path
        for path in attempt.iterdir()
        if path.is_file()
        and not path.name.endswith((".part", ".ytdl", ".temp"))
        and path.stat().st_size > 0
    ]
    if len(candidates) != 1 or candidates[0].stat().st_size > max_bytes:
        return None, "resolver-failed"
    return candidates[0], diagnostics.code


def main() -> None:
    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "YTDLP_CONFIG_HOME",
    ):
        os.environ.pop(name, None)

    body = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(body) > MAX_REQUEST_BYTES:
        fail()
    try:
        request = json.loads(body.decode("utf-8"))
    except Exception:
        fail()
    operation = request.get("operation", "download")
    expected_keys = ({"operation", "url", "maxBytes", "deadlineSeconds", "userAgent", "referer"}
        if operation == "probe" else {
            "operation", "url", "audioUrl", "formatSelector", "maxBytes",
            "deadlineSeconds", "userAgent", "referer",
        })
    if set(request) != expected_keys:
        fail()
    url = request.get("url")
    audio_url = request.get("audioUrl")
    format_selector = request.get("formatSelector")
    max_bytes = request.get("maxBytes")
    deadline = request.get("deadlineSeconds")
    user_agent = request.get("userAgent")
    referer = request.get("referer")
    allow_loopback_test = os.environ.get("LUCKYRAY_MEDIA_ALLOW_LOOPBACK_TEST") == "1"
    if (
        not isinstance(url, str)
        or not 1 <= len(url.encode("utf-8")) <= 4096
        or any(ord(character) < 32 for character in url)
        or (audio_url is not None and not isinstance(audio_url, str))
        or (format_selector is not None and (
            not isinstance(format_selector, str)
            or not re.fullmatch(r"[A-Za-z0-9._+\-/]{1,256}", format_selector)
        ))
        or not isinstance(max_bytes, int)
        or not 1 <= max_bytes <= 2 * 1024 * 1024 * 1024
        or not isinstance(deadline, int)
        or not 1 <= deadline <= 30 * 60
        or not isinstance(user_agent, str)
        or len(user_agent.encode("utf-8")) > 512
        or any(ord(character) < 32 or ord(character) == 127 for character in user_agent)
        or not isinstance(referer, str)
        or len(referer.encode("utf-8")) > 2048
        or any(ord(character) < 32 or ord(character) == 127 for character in referer)
        or bool(user_agent) != bool(referer)
    ):
        fail()
    if referer:
        parsed_referer = urlsplit(referer)
        referer_host = (parsed_referer.hostname or "").lower().rstrip(".")
        loopback_referer = allow_loopback_test and referer_host in {"127.0.0.1", "::1"}
        if (
            (parsed_referer.scheme != "https" and not (loopback_referer and parsed_referer.scheme == "http"))
            or not parsed_referer.hostname
            or parsed_referer.username is not None
            or parsed_referer.password is not None
        ):
            fail()

    wheel = required_path("LUCKYRAY_MEDIA_WHEEL", file=True)
    ejs_wheel = required_path("LUCKYRAY_MEDIA_EJS_WHEEL", file=True)
    ffmpeg_dir = required_path("LUCKYRAY_MEDIA_FFMPEG_DIR", directory=True)
    deno = required_path("LUCKYRAY_MEDIA_DENO", file=True)
    cookie_file_raw = os.environ.get("LUCKYRAY_MEDIA_COOKIE_FILE", "")
    cookie_file = required_path("LUCKYRAY_MEDIA_COOKIE_FILE", file=True) if cookie_file_raw else None
    sys.path[:0] = [str(wheel), str(ejs_wheel)]
    try:
        import yt_dlp
    except Exception:
        fail()

    protocol_stdout = sys.stdout
    protocol_stderr = sys.stderr
    if operation == "probe":
        probe_catalog(
            yt_dlp, url, deadline, deno, cookie_file, user_agent, referer,
            protocol_stdout, protocol_stderr,
        )
        return

    output = required_path("LUCKYRAY_MEDIA_OUTPUT")
    output_parent = output.parent.resolve(strict=True)
    if output.exists() or output_parent != output.parent.resolve(strict=True):
        fail()
    work = Path(tempfile.mkdtemp(prefix="lr-media-", dir=str(output_parent)))
    try:
        if audio_url:
            merge_track_pair(
                url, audio_url, output, work, ffmpeg_dir, user_agent, referer, max_bytes, deadline,
            )
            return
        selectors = [format_selector or "bv*+ba/b"]
        if format_selector is not None and format_selector != "bv*+ba/b":
            selectors.append("bv*+ba/b")
        for index, selector in enumerate(selectors):
            candidate, status = download_with_ytdlp(
                yt_dlp, url, selector, work / f"attempt-{index}", ffmpeg_dir, deno,
                cookie_file, user_agent, referer, max_bytes, deadline,
            )
            if candidate is None:
                if index + 1 < len(selectors):
                    continue
                emit_status(sys.stdout, status)
                fail()
            if validate_muxed_candidate(candidate, ffmpeg_dir):
                os.replace(candidate, output)
                return
            if index + 1 == len(selectors):
                emit_status(sys.stdout, "resolver-failed")
                fail()
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        raise SystemExit(70)
